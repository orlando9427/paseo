import { describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import type { AgentRunOptions } from "../agent-sdk-types.js";
import {
  OpenCodeSubmissionOutcomeError,
  supportsOpenCodeSubmissionTracking,
  type OpenCodeSubmissionReceipt,
} from "./opencode/native-submissions.js";
import {
  ManualObservationTiming,
  flushObservation,
  observationDeferred,
} from "./opencode/test-utils/manual-observation-timing.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

function admission(): AgentRunOptions {
  return {
    admission: {
      id: "attempt",
      signal: new AbortController().signal,
      assertCurrent() {},
      markRequestSent() {},
    },
  };
}

async function setup(native = new TestOpenCodeClient()) {
  const runtime = new TestOpenCodeHarness();
  runtime.enqueueClient(native);
  const client = new OpenCodeAgentClient(
    createTestLogger(),
    { serverUrl: runtime.server.url },
    {
      serverManager: runtime,
      createClient: runtime.createClient,
      observationTiming: new ManualObservationTiming(),
    },
  );
  const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
  if (!supportsOpenCodeSubmissionTracking(session))
    throw new Error("Missing submission observation port");
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { native, runtime, client, session, events };
}

async function outcomeError(operation: Promise<unknown>): Promise<OpenCodeSubmissionOutcomeError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof OpenCodeSubmissionOutcomeError) return error;
    throw error;
  }
  throw new Error("Expected an unresolved native submission");
}

function completedNativeTurn(messageId: string) {
  return [
    {
      info: { id: messageId, sessionID: "session-1", role: "user", time: { created: 1 } },
      parts: [],
    },
    {
      info: {
        id: "native-assistant",
        sessionID: "session-1",
        role: "assistant",
        parentID: messageId,
        time: { created: 2, completed: 3 },
      },
      parts: [],
    },
  ];
}

describe("OpenCode ambiguous native submission outcomes", () => {
  test("preserves exact native identity after a lost acknowledgement instead of declaring the turn failed", async () => {
    const ctx = await setup();
    ctx.native.sessionPromptAsyncImplementation = async () => {
      throw new Error("acknowledgement lost");
    };
    try {
      const error = await outcomeError(ctx.session.startTurn("possibly delivered", admission()));
      const request = ctx.native.calls.sessionPromptAsync[0] as { messageID: string };
      expect(error.submission).toEqual({
        version: 1,
        id: request.messageID,
        admissionId: "attempt",
        endpoint: ctx.runtime.server.url,
        sessionId: "session-1",
        turnId: "opencode-turn-0",
        messageId: request.messageID,
        operation: "prompt",
        delivery: "uncertain",
        callerInterrupted: true,
        error: "acknowledgement lost",
      });
      expect(ctx.session.getNativeSubmissions()).toEqual([error.submission]);
      expect(ctx.session.describePersistence()?.metadata?.openCodeNativeSubmissions).toEqual([
        error.submission,
      ]);
      expect((await ctx.session.getRuntimeInfo()).extra?.openCodeNativeSubmissions).toEqual([
        error.submission,
      ]);
      expect(Object.keys(request).sort()).toEqual(["directory", "messageID", "parts", "sessionID"]);
      expect(
        ctx.events.filter(
          (event) =>
            event.type === "turn_failed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_completed",
        ),
      ).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("pre-POST cancellation produces no native submission receipt", async () => {
    const ctx = await setup();
    const controller = new AbortController();
    controller.abort(new Error("cancel before POST"));
    const options = admission();
    options.admission!.signal = controller.signal;
    try {
      await expect(ctx.session.startTurn("not sent", options)).rejects.toThrow(
        "cancel before POST",
      );
      expect(ctx.session.getNativeSubmissions()).toEqual([]);
      expect(ctx.native.calls.sessionPromptAsync).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("an AbortError followed by explicit idle abort still does not make a delayed POST safe to resend", async () => {
    const ctx = await setup();
    const entered = observationDeferred<void>();
    ctx.native.sessionPromptAsyncImplementation = (_parameters, options) =>
      new Promise((_resolve, reject) => {
        const signal = (options as { signal: AbortSignal }).signal;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("transport abandoned", "AbortError")),
          { once: true },
        );
        entered.resolve();
      });
    const controller = new AbortController();
    const options = admission();
    options.admission!.signal = controller.signal;
    try {
      const pending = ctx.session.startTurn("may arrive later", options);
      await entered.promise;
      controller.abort(new Error("Stop requested"));
      const error = await outcomeError(pending);
      expect(error.submission.delivery).toBe("uncertain");
      await ctx.session.interrupt();
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      ctx.native.sessionMessagesResponse = { data: [] };
      ctx.native.sessionStatusResponse = { data: {} };
      expect(await ctx.session.reconcileNativeSubmissions()).toEqual([error.submission]);
      const blocked = await outcomeError(ctx.session.startTurn("do not resend", admission()));
      expect(blocked.submission.messageId).toBe(error.submission.messageId);
      expect(ctx.native.calls.sessionPromptAsync).toHaveLength(1);
      expect(ctx.native.calls.sessionAbort).toHaveLength(1);
    } finally {
      await ctx.session.close();
    }
  });

  test("cancelling the client signal after acknowledgement does not retract native work or report completion", async () => {
    const ctx = await setup();
    ctx.native.sessionPromptAsyncEvents = [];
    const controller = new AbortController();
    const options = admission();
    options.admission!.signal = controller.signal;
    try {
      await ctx.session.startTurn("acknowledged input", options);
      const receipt = ctx.session.getNativeSubmissions()[0];
      expect(receipt.delivery).toBe("acknowledged");
      controller.abort(new Error("local disconnect after 204"));
      await flushObservation();
      expect(ctx.session.getNativeSubmissions()[0].terminal).toBeUndefined();
      expect(ctx.native.calls.sessionAbort).toEqual([]);
      expect(
        ctx.events.filter(
          (event) =>
            event.type === "turn_failed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_completed",
        ),
      ).toEqual([]);
      ctx.native.sessionMessagesResponse = { data: completedNativeTurn(receipt.messageId!) };
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.session.getNativeSubmissions()[0]).toMatchObject({
        delivery: "observed",
        terminal: "turn_completed",
      });
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    } finally {
      await ctx.session.close();
    }
  });

  test("restores uncertainty from persistence and clears it only after matching native completion", async () => {
    const ctx = await setup();
    ctx.native.sessionPromptAsyncImplementation = async () => {
      throw new Error("lost response");
    };
    const error = await outcomeError(ctx.session.startTurn("original input", admission()));
    const handle = ctx.session.describePersistence()!;
    await ctx.session.close();
    const resumedNative = new TestOpenCodeClient();
    ctx.runtime.enqueueClient(resumedNative);
    const resumed = await ctx.client.resumeSession(handle);
    if (!supportsOpenCodeSubmissionTracking(resumed))
      throw new Error("Missing submission observation port");
    try {
      expect(resumed.getNativeSubmissions()).toEqual([error.submission]);
      await outcomeError(resumed.startTurn("blocked until reconciled", admission()));
      expect(resumedNative.calls.sessionPromptAsync).toEqual([]);
      resumedNative.sessionMessagesResponse = {
        data: completedNativeTurn(error.submission.messageId!),
      };
      const reconciled = await resumed.reconcileNativeSubmissions();
      expect(reconciled[0]).toMatchObject({
        id: error.submission.id,
        delivery: "observed",
        terminal: "turn_completed",
      });
      expect(resumedNative.calls.sessionPromptAsync).toEqual([]);
      await resumed.startTurn("explicit new input", admission());
      expect(resumedNative.calls.sessionPromptAsync).toHaveLength(1);
      expect(
        (resumedNative.calls.sessionPromptAsync[0] as { messageID: string }).messageID,
      ).not.toBe(error.submission.messageId);
    } finally {
      await resumed.close();
    }
  });

  test("a persisted in-flight request restores as uncertain rather than unsent", async () => {
    const ctx = await setup();
    const entered = observationDeferred<void>();
    const gate = observationDeferred<{ data: {} }>();
    ctx.native.sessionPromptAsyncImplementation = async () => {
      entered.resolve();
      return gate.promise;
    };
    const pending = ctx.session.startTurn("in-flight at detach", admission());
    await entered.promise;
    const handle = ctx.session.describePersistence()!;
    const original = ctx.session.getNativeSubmissions()[0];
    expect(original.delivery).toBe("in_flight");
    await ctx.session.close();
    gate.resolve({ data: {} });
    const interrupted = await outcomeError(pending);
    expect(interrupted.submission.delivery).toBe("acknowledged");
    const restoredNative = new TestOpenCodeClient();
    ctx.runtime.enqueueClient(restoredNative);
    const restored = await ctx.client.resumeSession(handle);
    if (!supportsOpenCodeSubmissionTracking(restored))
      throw new Error("Missing submission observation port");
    try {
      expect(restored.getNativeSubmissions()[0]).toMatchObject({
        id: original.id,
        messageId: original.messageId,
        delivery: "uncertain",
        error: "Adapter resumed before the native submission outcome was confirmed",
      });
      await outcomeError(restored.startTurn("do not replay after restart", admission()));
      expect(restoredNative.calls.sessionPromptAsync).toEqual([]);
    } finally {
      await restored.close();
    }
  });

  test("history read failure retains the receipt and does not become empty history", async () => {
    const ctx = await setup();
    ctx.native.sessionPromptAsyncImplementation = async () => {
      throw new Error("lost response");
    };
    try {
      const error = await outcomeError(ctx.session.startTurn("input", admission()));
      ctx.native.sessionMessagesResponse = { error: { message: "history unavailable" } };
      await expect(ctx.session.reconcileNativeSubmissions()).rejects.toThrow("history unavailable");
      expect(ctx.session.getNativeSubmissions()).toEqual([error.submission]);
      expect(ctx.native.calls.sessionPromptAsync).toHaveLength(1);
    } finally {
      await ctx.session.close();
    }
  });

  test("a rejected compaction transport is not a successful compaction acknowledgement", async () => {
    const ctx = await setup();
    ctx.native.sessionSummarizeImplementation = async () => {
      throw new DOMException("compaction transport abandoned", "AbortError");
    };
    try {
      const error = await outcomeError(ctx.session.startTurn("/compact", admission()));
      expect(error.submission).toMatchObject({
        operation: "compact",
        messageId: null,
        delivery: "uncertain",
      });
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(
        ctx.events.filter(
          (event) =>
            event.type === "turn_completed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_failed",
        ),
      ).toEqual([]);
      expect((await ctx.session.reconcileNativeSubmissions())[0].terminal).toBeUndefined();
    } finally {
      await ctx.session.close();
    }
  });

  test("rejects a persisted receipt for another endpoint rather than redirecting reconciliation", async () => {
    const ctx = await setup();
    ctx.native.sessionPromptAsyncImplementation = async () => {
      throw new Error("lost response");
    };
    await outcomeError(ctx.session.startTurn("input", admission()));
    const handle = ctx.session.describePersistence()!;
    const receipts = handle.metadata!.openCodeNativeSubmissions as OpenCodeSubmissionReceipt[];
    receipts[0].endpoint = "https://other-native.example.test";
    await ctx.session.close();
    ctx.runtime.enqueueClient(new TestOpenCodeClient());
    await expect(ctx.client.resumeSession(handle)).rejects.toThrow("mismatched endpoint/session");
    expect(ctx.native.calls.sessionPromptAsync).toHaveLength(1);
  });
});
