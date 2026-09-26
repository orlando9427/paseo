import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import type { AgentRunOptions } from "../agent-sdk-types.js";
import {
  ManualObservationTiming,
  flushObservation,
  observationDeferred,
} from "./opencode/test-utils/manual-observation-timing.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

function admission() {
  const controller = new AbortController();
  let current = true;
  const options: AgentRunOptions = {
    admission: {
      id: "queue-attempt-1",
      signal: controller.signal,
      markRequestSent() {},
      assertCurrent() {
        if (!current) throw new Error("stale manager admission");
      },
    },
  };
  return {
    controller,
    options,
    revoke() {
      current = false;
    },
  };
}

async function setup(native = new TestOpenCodeClient(), config: Partial<AgentSessionConfig> = {}) {
  const runtime = new TestOpenCodeHarness();
  runtime.enqueueClient(native);
  const session = await new OpenCodeAgentClient(
    createTestLogger(),
    { serverUrl: runtime.server.url },
    {
      serverManager: runtime,
      createClient: runtime.createClient,
      observationTiming: new ManualObservationTiming(),
    },
  ).createSession({ provider: "opencode", cwd: "/workspace/repo", ...config });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, native, events };
}

function sentMessageId(native: TestOpenCodeClient, index: number): string {
  const id = (native.calls.sessionPromptAsync[index] as { messageID: string }).messageID;
  if (typeof id !== "string") throw new Error("Expected a native dispatch message ID");
  return id;
}

function persistedTurn(messageId: string, completed = true) {
  return [
    {
      info: {
        id: messageId,
        sessionID: "session-1",
        role: "user",
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        time: { created: 1 },
      },
      parts: [],
    },
    {
      info: {
        id: `assistant-${messageId}`,
        sessionID: "session-1",
        role: "assistant",
        parentID: messageId,
        time: { created: 2, ...(completed ? { completed: 3 } : {}) },
      },
      parts: [],
    },
  ];
}

describe("OpenCode abortable turn admission", () => {
  test("rejects a cancelled queued admission before publishing or sending a turn", async () => {
    const ctx = await setup();
    const fence = admission();
    fence.controller.abort(new Error("Stop revoked the queue"));
    try {
      await expect(ctx.session.startTurn("queued prompt", fence.options)).rejects.toThrow(
        "Stop revoked the queue",
      );
      expect(ctx.native.calls.sessionPromptAsync).toEqual([]);
      expect(ctx.events).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("cancels readiness waits without sending when the stream connects later", async () => {
    const native = new TestOpenCodeClient();
    native.emitConnected = false;
    const ctx = await setup(native);
    const fence = admission();
    try {
      const pending = ctx.session.startTurn("waiting for connection", fence.options);
      await flushObservation();
      fence.controller.abort(new Error("Stop during readiness"));
      await expect(pending).rejects.toThrow("Stop during readiness");
      native.emitEvent({ type: "server.connected", properties: {} });
      await flushObservation();
      expect(native.calls.sessionPromptAsync).toEqual([]);
      expect(ctx.events).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test.each(["/custom", "/compact"])(
    "revokes %s while command resolution is pending, without a plain-prompt fallback",
    async (prompt) => {
      const native = new TestOpenCodeClient();
      const started = observationDeferred<void>();
      const gate = observationDeferred<{ data: unknown[] }>();
      native.commandListImplementation = async () => {
        started.resolve();
        return gate.promise;
      };
      const ctx = await setup(native);
      const fence = admission();
      try {
        const pending = ctx.session.startTurn(prompt, fence.options);
        await started.promise;
        fence.controller.abort(new Error("Stop during command lookup"));
        await expect(pending).rejects.toThrow("Stop during command lookup");
        gate.resolve({ data: [{ name: "custom" }] });
        await flushObservation();
        expect(native.calls.sessionPromptAsync).toEqual([]);
        expect(native.calls.sessionCommand).toEqual([]);
        expect(native.calls.sessionSummarize).toEqual([]);
        expect(ctx.events).toEqual([]);
        expect((native.calls.commandListOptions[0] as { signal: AbortSignal }).signal.aborted).toBe(
          true,
        );
      } finally {
        gate.resolve({ data: [] });
        await ctx.session.close();
      }
    },
  );

  test("checks the manager identity after an awaited command lookup even without a signal abort", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: unknown[] }>();
    native.commandListImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native);
    const fence = admission();
    try {
      const pending = ctx.session.startTurn("/custom", fence.options);
      await started.promise;
      fence.revoke();
      gate.resolve({ data: [{ name: "custom" }] });
      await expect(pending).rejects.toThrow("stale manager admission");
      expect(native.calls.sessionCommand).toEqual([]);
      expect(native.calls.sessionPromptAsync).toEqual([]);
      expect(ctx.events).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("rejects an admission object reassigned to a different attempt during lookup", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: unknown[] }>();
    native.commandListImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native);
    const fence = admission();
    try {
      const pending = ctx.session.startTurn("/custom", fence.options);
      await started.promise;
      fence.options.admission!.id = "different-attempt";
      gate.resolve({ data: [{ name: "custom" }] });
      await expect(pending).rejects.toThrow("admission identity");
      expect(native.calls.sessionCommand).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("applies a queued mode only when sending, leaving the current mode intact on cancellation", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: unknown[] }>();
    native.commandListImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native, { modeId: "plan" });
    const cancelled = admission();
    cancelled.options.admission!.modeId = "queued-agent";
    try {
      const pending = ctx.session.startTurn("/custom", cancelled.options);
      await started.promise;
      expect(await ctx.session.getCurrentMode()).toBe("plan");
      cancelled.controller.abort(new Error("cancel queued mode"));
      await expect(pending).rejects.toThrow("cancel queued mode");
      gate.resolve({ data: [{ name: "custom" }] });
      await flushObservation();
      expect(await ctx.session.getCurrentMode()).toBe("plan");
      expect(ctx.native.calls.sessionCommand).toEqual([]);
      const next = admission();
      next.options.admission!.modeId = "queued-agent";
      await ctx.session.startTurn("explicit fresh request", next.options);
      expect(ctx.native.calls.sessionPromptAsync).toMatchObject([{ agent: "queued-agent" }]);
      expect(await ctx.session.getCurrentMode()).toBe("queued-agent");
      expect(ctx.session.describePersistence()?.metadata?.modeId).toBe("queued-agent");
    } finally {
      gate.resolve({ data: [] });
      await ctx.session.close();
    }
  });

  test("rechecks the fence immediately after start notification and before the native send", async () => {
    const ctx = await setup();
    const fence = admission();
    ctx.session.subscribe((event) => {
      if (event.type === "turn_started") fence.revoke();
    });
    try {
      await expect(ctx.session.startTurn("cancel at publication", fence.options)).rejects.toThrow(
        "stale manager admission",
      );
      expect(ctx.native.calls.sessionPromptAsync).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("cancels a pending MCP setup and prevents its late continuation from sending", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: {} }>();
    native.mcpAddImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native, {
      mcpServers: { tools: { type: "http", url: "https://tools.example.test/mcp" } },
    });
    const fence = admission();
    try {
      const pending = ctx.session.startTurn("waiting for MCP", fence.options);
      await started.promise;
      fence.controller.abort(new Error("Stop during MCP setup"));
      await expect(pending).rejects.toThrow("Stop during MCP setup");
      gate.resolve({ data: {} });
      await flushObservation();
      expect(native.calls.sessionPromptAsync).toEqual([]);
      expect((native.calls.mcpAddOptions[0] as { signal: AbortSignal }).signal.aborted).toBe(true);
      expect(ctx.events).toEqual([]);
    } finally {
      gate.resolve({ data: {} });
      await ctx.session.close();
    }
  });

  test("cancels the final native-status admission check before sending", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: {} }>();
    native.sessionStatusImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native);
    const fence = admission();
    try {
      const pending = ctx.session.startTurn("queued", fence.options);
      await started.promise;
      fence.controller.abort(new Error("Stop during status check"));
      await expect(pending).rejects.toThrow("Stop during status check");
      gate.resolve({ data: {} });
      await flushObservation();
      expect(native.calls.sessionPromptAsync).toEqual([]);
      expect(ctx.events).toEqual([]);
    } finally {
      gate.resolve({ data: {} });
      await ctx.session.close();
    }
  });

  test("direct Stop revokes an unfenced start still preparing its command", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: unknown[] }>();
    native.commandListImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native);
    try {
      const pending = ctx.session.startTurn("/custom");
      await started.promise;
      const stopped = ctx.session.interrupt();
      await expect(pending).rejects.toThrow("admission interrupted");
      await stopped;
      gate.resolve({ data: [{ name: "custom" }] });
      await flushObservation();
      expect(native.calls.sessionCommand).toEqual([]);
      expect(native.calls.sessionPromptAsync).toEqual([]);
      expect(native.calls.sessionAbort).toHaveLength(1);
      expect(ctx.events).toEqual([]);
    } finally {
      gate.resolve({ data: [] });
      await ctx.session.close();
    }
  });

  test("close cancels a waiting admission and permanently rejects later starts", async () => {
    const native = new TestOpenCodeClient();
    native.emitConnected = false;
    const ctx = await setup(native);
    const pending = ctx.session.startTurn("waiting", admission().options);
    await flushObservation();
    const rejection = expect(pending).rejects.toThrow("OpenCode session is closed");
    await ctx.session.close();
    await rejection;
    await expect(ctx.session.startTurn("after close")).rejects.toThrow(
      "OpenCode session is closed",
    );
    expect(native.calls.sessionPromptAsync).toEqual([]);
    expect(native.calls.sessionAbort).toEqual([]);
    expect(ctx.events).toEqual([]);
  });

  test("does not overlap two preparing admissions", async () => {
    const native = new TestOpenCodeClient();
    native.emitConnected = false;
    const ctx = await setup(native);
    const fence = admission();
    const first = ctx.session.startTurn("first", fence.options);
    await expect(ctx.session.startTurn("second", admission().options)).rejects.toThrow(
      "admission is already pending",
    );
    fence.controller.abort(new Error("cancel first"));
    await expect(first).rejects.toThrow("cancel first");
    expect(native.calls.sessionPromptAsync).toEqual([]);
    await ctx.session.close();
  });

  test("keeps admission pending until an in-flight SDK submission settles after cancellation", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: {} }>();
    native.sessionPromptAsyncImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native);
    const fence = admission();
    const pending = ctx.session.startTurn("already invoking SDK", fence.options);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    await started.promise;
    fence.controller.abort(new Error("Stop during submission"));
    await flushObservation();
    expect(settled).toBe(false);
    expect(
      (native.calls.sessionPromptAsyncOptions[0] as { signal: AbortSignal }).signal.aborted,
    ).toBe(true);
    gate.resolve({ data: {} });
    await expect(pending).rejects.toThrow("Stop during submission");
    expect(
      ctx.events.filter((event) => event.type === "turn_failed" || event.type === "turn_completed"),
    ).toEqual([]);
    await ctx.session.close();
  });

  test("a late SDK response after external close cannot return an accepted turn", async () => {
    const native = new TestOpenCodeClient();
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: {} }>();
    native.sessionPromptAsyncImplementation = async () => {
      started.resolve();
      return gate.promise;
    };
    const ctx = await setup(native);
    const pending = ctx.session.startTurn("submitted before close", admission().options);
    await started.promise;
    await ctx.session.close();
    const eventsAtClose = [...ctx.events];
    gate.resolve({ data: {} });
    await expect(pending).rejects.toThrow("OpenCode session is closed");
    expect(ctx.events).toEqual(eventsAtClose);
    expect(native.calls.sessionPromptAsync).toHaveLength(1);
    expect(native.calls.sessionAbort).toEqual([]);
  });

  test("an exact command echo admits the turn before its long HTTP response completes", async () => {
    const native = new TestOpenCodeClient();
    native.commandListResponse = { data: [{ name: "custom" }] };
    const started = observationDeferred<string>();
    const gate = observationDeferred<{ data: {} }>();
    native.sessionCommandImplementation = async (parameters) => {
      started.resolve((parameters as { messageID: string }).messageID);
      return gate.promise;
    };
    const ctx = await setup(native);
    const pending = ctx.session.startTurn("/custom", admission().options);
    const messageID = await started.promise;
    expect(messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    native.emitEvent({
      type: "message.updated",
      properties: { info: { id: messageID, sessionID: "session-1", role: "user" } },
    });
    await expect(pending).resolves.toEqual({ turnId: "opencode-turn-0" });
    expect(ctx.session.capabilities.supportsAbortableTurnAdmission).toBe(true);
    gate.resolve({ data: {} });
    await ctx.session.close();
  });

  test("old idle and assistant finish events cannot complete a newer admitted turn or release its successor", async () => {
    const ctx = await setup();
    ctx.native.sessionPromptAsyncEvents = [];
    try {
      const first = await ctx.session.startTurn("first", admission().options);
      const firstMessage = sentMessageId(ctx.native, 0);
      ctx.native.sessionMessagesResponse = { data: persistedTurn(firstMessage) };
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toMatchObject([
        { turnId: first.turnId },
      ]);

      const second = await ctx.session.startTurn("second", admission().options);
      const secondMessage = sentMessageId(ctx.native, 1);
      expect(secondMessage).not.toBe(firstMessage);
      ctx.native.emitEvent({
        type: "message.updated",
        properties: {
          info: {
            id: "old-assistant",
            sessionID: "session-1",
            role: "assistant",
            parentID: firstMessage,
            time: { completed: 3 },
            structured: "old output",
          },
        },
      });
      ctx.native.emitEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "old-step",
            sessionID: "session-1",
            messageID: "old-assistant",
            type: "step-finish",
            tokens: { input: 999, output: 999 },
          },
        },
      });
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      await expect(ctx.session.startTurn("unsafe successor", admission().options)).rejects.toThrow(
        "already active",
      );
      expect(
        ctx.events.filter((event) => event.type === "timeline" || event.type === "usage_updated"),
      ).toEqual([]);
      expect(ctx.native.calls.sessionPromptAsync).toHaveLength(2);

      ctx.native.sessionMessagesResponse = {
        data: [...persistedTurn(firstMessage), ...persistedTurn(secondMessage, false)],
      };
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toMatchObject([
        { turnId: first.turnId },
      ]);

      ctx.native.sessionMessagesResponse = {
        data: [...persistedTurn(firstMessage), ...persistedTurn(secondMessage)],
      };
      ctx.native.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toMatchObject([
        { turnId: first.turnId },
      ]);
      ctx.native.sessionStatusResponse = { data: {} };
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toMatchObject([
        { turnId: first.turnId },
        { turnId: second.turnId },
      ]);
    } finally {
      await ctx.session.close();
    }
  });

  test("a new busy event invalidates an older in-flight idle confirmation", async () => {
    const ctx = await setup();
    ctx.native.sessionPromptAsyncEvents = [];
    const started = observationDeferred<void>();
    const gate = observationDeferred<{ data: {} }>();
    try {
      await ctx.session.startTurn("current", admission().options);
      const messageId = sentMessageId(ctx.native, 0);
      ctx.native.sessionMessagesResponse = { data: persistedTurn(messageId) };
      ctx.native.sessionStatusImplementation = async () => {
        started.resolve();
        return gate.promise;
      };
      ctx.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await started.promise;
      ctx.native.emitEvent({
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await flushObservation();
      gate.resolve({ data: {} });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toEqual([]);
      await expect(ctx.session.startTurn("next", admission().options)).rejects.toThrow(
        "already active",
      );
    } finally {
      gate.resolve({ data: {} });
      await ctx.session.close();
    }
  });

  test("a late compaction response cannot reset or finish a newer compaction", async () => {
    const native = new TestOpenCodeClient();
    const firstResponse = observationDeferred<{ error: string }>();
    const secondResponse = observationDeferred<{ data: {} }>();
    const secondStarted = observationDeferred<void>();
    native.sessionSummarizeImplementation = async () => {
      if (native.calls.sessionSummarize.length === 1) return firstResponse.promise;
      secondStarted.resolve();
      return secondResponse.promise;
    };
    const ctx = await setup(native);
    try {
      const first = await ctx.session.startTurn("/compact");
      native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      const second = ctx.session.startTurn("/compact", admission().options);
      await secondStarted.promise;
      firstResponse.resolve({ error: "late old failure" });
      native.emitEvent({
        type: "message.updated",
        properties: { info: { id: "current-summary", sessionID: "session-1", role: "assistant" } },
      });
      native.emitEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "summary-text",
            sessionID: "session-1",
            messageID: "current-summary",
            type: "text",
            text: "internal compaction summary",
            time: { end: 1 },
          },
        },
      });
      native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(
        ctx.events.filter((event) => event.type === "timeline" || event.type === "turn_failed"),
      ).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toMatchObject([
        { turnId: first.turnId },
      ]);
      secondResponse.resolve({ data: {} });
      const result = await second;
      native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toMatchObject([
        { turnId: first.turnId },
        { turnId: result.turnId },
      ]);
    } finally {
      firstResponse.resolve({ error: "late old failure" });
      secondResponse.resolve({ data: {} });
      await ctx.session.close();
    }
  });
});
