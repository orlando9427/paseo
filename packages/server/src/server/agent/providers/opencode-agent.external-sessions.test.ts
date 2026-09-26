import { describe, expect, test } from "vitest";
import type { GlobalSession, SessionMessagesResponses } from "@opencode-ai/sdk/v2/client";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";
import { observationDeferred } from "./opencode/test-utils/manual-observation-timing.js";

type NativeMessage = SessionMessagesResponses[200][number];
const cwd = "/workspace/repo";
const endpoint = "https://native.example.test/opencode";

function nativeSession(id: string, overrides: Partial<GlobalSession> = {}): GlobalSession {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: cwd,
    title: "Title is not provenance",
    version: "test",
    time: { created: 200, updated: 300 },
    project: null,
    ...overrides,
  };
}

function userMessage(id: string, agent: string, text: string, created = 1): NativeMessage {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "user",
      agent,
      model: { providerID: "test", modelID: `model-${created}` },
      time: { created },
    },
    parts: [{ id: `part-${id}`, sessionID: "session-1", messageID: id, type: "text", text }],
  };
}

function response<T>(data: T, next?: string) {
  return { data, response: new Response(null, { headers: next ? { "X-Next-Cursor": next } : {} }) };
}

function setup() {
  const native = new TestOpenCodeClient();
  const runtime = new TestOpenCodeHarness();
  runtime.server = { url: endpoint, port: 443 };
  runtime.enqueueClient(native);
  const client = new OpenCodeAgentClient(
    createTestLogger(),
    { serverUrl: `${endpoint}/` },
    { serverManager: runtime, createClient: runtime.createClient },
  );
  return { native, runtime, client };
}

describe("OpenCode read-only external session metadata", () => {
  test("projects the exact adoption contract from the first meaningful user turn, including attachments", async () => {
    const { native, client, runtime } = setup();
    const synthetic = userMessage("synthetic", "system-agent", "automatic context");
    synthetic.parts = [
      { ...synthetic.parts[0], type: "text", text: "automatic context", synthetic: true },
    ];
    const attachment = userMessage("user-first", "reserved-coordinator", "", 2);
    attachment.parts = [
      {
        id: "file",
        sessionID: "session-1",
        messageID: "user-first",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,aW1hZ2U=",
      },
    ];
    const latest = userMessage("user-latest", "review-agent", "continue", 3);
    native.experimentalSessionListResponse = response([nativeSession("session-1")]);
    native.sessionMessagesResponse = response([synthetic, attachment, latest]);

    expect(await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).toEqual({
      endpoint,
      sessions: [
        {
          sessionId: "session-1",
          cwd,
          createdAt: 200,
          updatedAt: 300,
          archivedAt: null,
          parentId: null,
          title: "Title is not provenance",
          modeId: "review-agent",
          model: "test/model-3",
          agentNames: ["reserved-coordinator", "review-agent", "system-agent"],
          firstUserMessage: { id: "user-first", agent: "reserved-coordinator" },
        },
      ],
    });
    expect(native.calls.globalEvent).toEqual([]);
    expect(native.calls.sessionCreate).toEqual([]);
    expect(native.calls.sessionPromptAsync).toEqual([]);
    expect(native.calls.permissionReply).toEqual([]);
    expect(native.calls.sessionUpdate).toEqual([]);
    expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
  });

  test("paginates messages back to the first user turn and retains root-worker provenance after a later coordinator turn", async () => {
    const { native, client } = setup();
    native.experimentalSessionListResponse = response([
      nativeSession("session-1", {
        title: "reserved-coordinator",
        agent: "latest-selection",
        model: { providerID: "native", id: "selected" },
      }),
    ]);
    native.sessionMessagesImplementation = async (parameters) => {
      const before = (parameters as { before?: string }).before;
      return before
        ? response([userMessage("worker-first", "reserved-worker", "do the leaf work", 1)])
        : response(
            [userMessage("coordinator-later", "reserved-coordinator", "later", 2)],
            "native-opaque-older",
          );
    };
    const page = await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 });
    expect(page.sessions).toEqual([
      {
        sessionId: "session-1",
        cwd,
        createdAt: 200,
        updatedAt: 300,
        archivedAt: null,
        parentId: null,
        title: "reserved-coordinator",
        modeId: "latest-selection",
        model: "native/selected",
        agentNames: ["latest-selection", "reserved-coordinator", "reserved-worker"],
        firstUserMessage: { id: "worker-first", agent: "reserved-worker" },
      },
    ]);
    expect(native.calls.sessionMessages).toEqual([
      { sessionID: "session-1", directory: cwd, limit: 100 },
      { sessionID: "session-1", directory: cwd, limit: 100, before: "native-opaque-older" },
    ]);
  });

  test.each([
    {
      label: "unknown first agent",
      messages: [
        userMessage("unknown-first", "", "real first user message"),
        userMessage("later", "reserved-coordinator", "later named user message", 2),
      ],
    },
    { label: "empty session", messages: [] },
    {
      label: "whitespace-only user",
      messages: [userMessage("empty", "reserved-coordinator", "  \n ")],
    },
    {
      label: "synthetic and ignored context",
      messages: [
        {
          ...userMessage("system", "reserved-coordinator", "context"),
          parts: [
            {
              id: "synthetic",
              sessionID: "session-1",
              messageID: "system",
              type: "text" as const,
              text: "context",
              synthetic: true,
            },
            {
              id: "ignored",
              sessionID: "session-1",
              messageID: "system",
              type: "text" as const,
              text: "ignored",
              ignored: true,
            },
          ],
        },
      ],
    },
  ])(
    "leaves $label unclassified despite a coordinator-looking title/current agent",
    async ({ messages }) => {
      const { native, client } = setup();
      native.experimentalSessionListResponse = response([
        nativeSession("session-1", {
          title: "reserved-coordinator",
          agent: "reserved-coordinator",
        }),
      ]);
      native.sessionMessagesResponse = response(messages);
      const page = await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 });
      expect(page.sessions[0].firstUserMessage).toBeNull();
    },
  );

  test("preserves native archive/parent metadata while applying the exact cwd and creation cutoff before message reads", async () => {
    const { native, client } = setup();
    native.experimentalSessionListResponse = response([
      nativeSession("archived", { time: { created: 200, updated: 300, archived: 0 } }),
      nativeSession("child", { parentID: "native-parent" }),
      nativeSession("empty"),
      nativeSession("old", { time: { created: 100, updated: 300 } }),
      nativeSession("different-worktree", { directory: `${cwd}/other-worktree` }),
    ]);
    native.sessionMessagesResponse = response([]);
    const page = await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 });
    expect(
      page.sessions.map(({ sessionId, archivedAt, parentId }) => ({
        sessionId,
        archivedAt,
        parentId,
      })),
    ).toEqual([
      { sessionId: "archived", archivedAt: 0, parentId: null },
      { sessionId: "child", archivedAt: null, parentId: "native-parent" },
      { sessionId: "empty", archivedAt: null, parentId: null },
    ]);
    expect(native.calls.sessionMessages).toEqual(
      ["archived", "child", "empty"].map((sessionID) => ({
        sessionID,
        directory: cwd,
        limit: 100,
      })),
    );
    expect(native.calls.experimentalSessionList).toEqual([
      { directory: cwd, start: 100, archived: true, roots: false, limit: 21 },
    ]);
  });

  test("does not lose sessions tied at a native updated-time page boundary", async () => {
    const { native, client, runtime } = setup();
    const ties = Array.from({ length: 20 }, (_, index) =>
      nativeSession(`tie-${index}`, { time: { created: 200, updated: 400 } }),
    );
    native.experimentalSessionListImplementation = async (parameters) =>
      (parameters as { cursor?: number }).cursor === undefined
        ? response(
            [nativeSession("newest", { time: { created: 200, updated: 500 } }), ...ties],
            "400",
          )
        : response([...ties, nativeSession("oldest", { time: { created: 200, updated: 300 } })]);
    native.sessionMessagesResponse = response([]);
    const first = await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 });
    runtime.enqueueClient(native);
    const second = await client.listExternalOpenCodeSessions({
      cwd,
      createdAfter: 100,
      cursor: first.nextCursor,
    });
    expect(first.sessions.map((row) => row.sessionId)).toEqual(["newest"]);
    expect(second.sessions.map((row) => row.sessionId)).toEqual([
      ...ties.map((row) => row.id),
      "oldest",
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(native.calls.experimentalSessionList[1]).toEqual({
      directory: cwd,
      start: 100,
      archived: true,
      roots: false,
      limit: 21,
      cursor: 401,
    });
  });

  test("fails closed when a timestamp tie cannot fit in the bounded native page", async () => {
    const { native, client } = setup();
    native.experimentalSessionListResponse = response(
      Array.from({ length: 21 }, (_, index) => nativeSession(`tie-${index}`)),
      "300",
    );
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "timestamp group exceeds",
    );
    expect(native.calls.sessionMessages).toEqual([]);
  });

  test("binds continuation cursors to the endpoint, cwd, and fixed activation window", async () => {
    const { native, client, runtime } = setup();
    native.experimentalSessionListResponse = response(
      [nativeSession("top", { time: { created: 200, updated: 400 } }), nativeSession("last")],
      "300",
    );
    native.sessionMessagesResponse = response([]);
    const first = await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 });
    await expect(
      client.listExternalOpenCodeSessions({
        cwd: "/different-root",
        createdAfter: 100,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("mismatched");
    await expect(
      client.listExternalOpenCodeSessions({ cwd, createdAfter: 101, cursor: first.nextCursor }),
    ).rejects.toThrow("mismatched");
    runtime.server = { port: 443, url: "https://other-native.example.test" };
    const other = new OpenCodeAgentClient(
      createTestLogger(),
      { serverUrl: runtime.server.url },
      { serverManager: runtime, createClient: runtime.createClient },
    );
    await expect(
      other.listExternalOpenCodeSessions({ cwd, createdAfter: 100, cursor: first.nextCursor }),
    ).rejects.toThrow("mismatched");
    expect(native.calls.experimentalSessionList).toHaveLength(1);
  });

  test("throws message page errors instead of returning partial provenance", async () => {
    const { native, client, runtime } = setup();
    native.experimentalSessionListResponse = response([nativeSession("session-1")]);
    native.sessionMessagesImplementation = async (parameters) =>
      (parameters as { before?: string }).before
        ? { error: { message: "history unavailable" } }
        : response([userMessage("later", "reserved-coordinator", "later")], "older");
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "history unavailable",
    );
    expect(runtime.acquisitions[0].releaseCount).toBe(1);
  });

  test.each(["response", "rejection"])("throws native listing %s failures", async (kind) => {
    const { native, client, runtime } = setup();
    native.experimentalSessionListImplementation = async () => {
      if (kind === "rejection") throw new Error("listing unavailable");
      return { error: { message: "listing unavailable" } };
    };
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "listing unavailable",
    );
    expect(native.calls.sessionMessages).toEqual([]);
    expect(runtime.acquisitions[0].releaseCount).toBe(1);
  });

  test("bounds history scans and rejects repeated pagination", async () => {
    const { native, client, runtime } = setup();
    native.experimentalSessionListResponse = response([nativeSession("session-1")]);
    let count = 0;
    native.sessionMessagesImplementation = async () => {
      count += 1;
      return response(
        [userMessage(`message-${count}`, "reserved-coordinator", "text", 10000 - count)],
        `page-${count}`,
      );
    };
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "provenance is incomplete",
    );
    expect(count).toBe(20);
    runtime.enqueueClient(native);
    native.sessionMessagesImplementation = async () => {
      count += 1;
      return response(
        [userMessage(`message-${count}`, "reserved-coordinator", "text", 10000 - count)],
        "same-cursor",
      );
    };
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "pagination did not advance",
    );
    expect(count).toBe(22);
  });

  test("rejects pre-cancelled discovery before acquiring a server", async () => {
    const { client, runtime } = setup();
    const abort = new AbortController();
    abort.abort(new Error("stop discovery"));
    await expect(
      client.listExternalOpenCodeSessions({ cwd, createdAfter: 100, signal: abort.signal }),
    ).rejects.toThrow("stop discovery");
    expect(runtime.acquisitions).toEqual([]);
  });

  test.each(["listing", "messages"])(
    "cancels an in-flight %s read and releases the acquisition even if the adapter returns late",
    async (operation) => {
      const { native, client, runtime } = setup();
      native.experimentalSessionListResponse = response([nativeSession("session-1")]);
      const started = observationDeferred<AbortSignal>();
      const gate = observationDeferred<ReturnType<typeof response<never[]>>>();
      const wait = async (_parameters: unknown, options: unknown) => {
        started.resolve((options as { signal: AbortSignal }).signal);
        return gate.promise;
      };
      if (operation === "listing") native.experimentalSessionListImplementation = wait;
      else native.sessionMessagesImplementation = wait;
      const abort = new AbortController();
      const pending = client.listExternalOpenCodeSessions({
        cwd,
        createdAfter: 100,
        signal: abort.signal,
      });
      const requestSignal = await started.promise;
      abort.abort(new Error("stop discovery"));
      await expect(pending).rejects.toThrow("stop discovery");
      expect(requestSignal.aborted).toBe(true);
      expect(runtime.acquisitions[0].releaseCount).toBe(1);
      gate.resolve(response([]));
    },
  );

  test("does not acquire a managed server or silently cross an external endpoint", async () => {
    const { native, runtime } = setup();
    const managed = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    await expect(managed.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "explicitly configured serverUrl",
    );
    expect(runtime.acquisitions).toEqual([]);
    const external = new OpenCodeAgentClient(
      createTestLogger(),
      { serverUrl: "https://wrong-native.example.test" },
      { serverManager: runtime, createClient: runtime.createClient },
    );
    await expect(external.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "endpoint changed",
    );
    expect(native.calls.experimentalSessionList).toEqual([]);
    expect(runtime.acquisitions[0].releaseCount).toBe(1);
  });

  test("retains worker evidence from reverted turns without treating the reverted prompt as current activity", async () => {
    const { native, client } = setup();
    native.experimentalSessionListResponse = response([
      nativeSession("session-1", { revert: { messageID: "worker-turn" } }),
    ]);
    native.sessionMessagesResponse = response([
      userMessage("worker-turn", "reserved-worker", "worker task"),
    ]);
    const page = await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 });
    expect(page.sessions[0].agentNames).toEqual(["reserved-worker"]);
    expect(page.sessions[0].firstUserMessage).toBeNull();
  });

  test("reports an actual build fallback instead of inferring coordinator enrollment from later metadata", async () => {
    const { native, client } = setup();
    native.experimentalSessionListResponse = response([
      nativeSession("session-1", { agent: "reserved-coordinator", title: "reserved-coordinator" }),
    ]);
    native.sessionMessagesResponse = response([
      userMessage("actual-first", "build", "CLI fallback"),
    ]);
    const page = await client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 });
    expect(page.sessions[0].firstUserMessage).toEqual({ id: "actual-first", agent: "build" });
    expect(page.sessions[0].agentNames).toEqual(["build", "reserved-coordinator"]);
  });

  test("rejects oversized native responses instead of accepting an unbounded scan", async () => {
    const { native, client, runtime } = setup();
    native.experimentalSessionListResponse = response(
      Array.from({ length: 22 }, (_, index) => nativeSession(`session-${index}`)),
    );
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "listing exceeded its read bound",
    );
    runtime.enqueueClient(native);
    native.experimentalSessionListResponse = response([nativeSession("session-1")]);
    native.sessionMessagesResponse = response(
      Array.from({ length: 101 }, (_, index) =>
        userMessage(`message-${index}`, "reserved-coordinator", "text"),
      ),
    );
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "messages exceeded their read bound",
    );
  });

  test("does not mark a message page without pagination metadata complete", async () => {
    const { native, client } = setup();
    native.experimentalSessionListResponse = response([nativeSession("session-1")]);
    native.sessionMessagesResponse = {
      data: [userMessage("latest", "reserved-coordinator", "text")],
    };
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "omitted pagination response metadata",
    );
  });

  test("rejects a foreign session's messages instead of borrowing its provenance", async () => {
    const { native, client } = setup();
    native.experimentalSessionListResponse = response([nativeSession("different-session")]);
    native.sessionMessagesResponse = response([
      userMessage("wrong-session-message", "reserved-coordinator", "text"),
    ]);
    await expect(client.listExternalOpenCodeSessions({ cwd, createdAfter: 100 })).rejects.toThrow(
      "message identity",
    );
  });
});
