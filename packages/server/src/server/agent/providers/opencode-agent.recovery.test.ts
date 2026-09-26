import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  OpenCodeEventConsumer,
  type OpenCodeEventConsumerTiming,
} from "./opencode/event-consumer.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";
import {
  supportsOpenCodeNativeHistory,
  type OpenCodeHistorySnapshot,
} from "./opencode/native-history.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";
import {
  ManualObservationTiming,
  flushObservation,
  observationDeferred,
} from "./opencode/test-utils/manual-observation-timing.js";

test("dispatches ascending OpenCode message identifiers through the public provider path", async () => {
  const upstream = await createRecoveryUpstream();
  const fixture = await createPublicRecoverySession(upstream, new RecoveryTiming());
  const observed: AgentStreamEvent[] = [];
  fixture.session.subscribe((event) => observed.push(event));
  await upstream.connected(1);
  upstream.send(0, connectedRecord());

  await fixture.session.startTurn("first");
  await upstream.dispatched(1);
  upstream.send(0, idleRecord());
  await eventually(() =>
    expect(observed.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );
  await fixture.session.startTurn("second");
  const ids = await upstream.dispatched(2);

  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(ids[1]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect((ids[0] as string) < (ids[1] as string)).toBe(true);

  await fixture.session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

test("recovers missed output after EOF without failing the active turn", async () => {
  const upstream = await createRecoveryUpstream();
  const timing = new RecoveryTiming();
  const fixture = await createPublicRecoverySession(upstream, timing);
  const { session } = fixture;
  const observed: AgentStreamEvent[] = [];
  session.subscribe((event) => observed.push(event));

  await upstream.connected(1);
  upstream.send(0, connectedRecord());
  await session.startTurn("hello");
  const [dispatchId] = await upstream.dispatched();
  expect(upstream.messageReads()).toBe(0);
  upstream.setRecoveredMessages(dispatchId as string);
  upstream.end(0);
  await timing.waiting();
  timing.advance();
  await upstream.connected(2);
  upstream.send(1, connectedRecord());

  await eventually(() => expect(observed.map((event) => event.type)).toContain("turn_completed"));
  expect(observed.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0);
  const assistantTexts = observed.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
  expect(assistantTexts).toHaveLength(52);
  expect(assistantTexts.at(-1)).toBe("recovered output");
  expect(assistantTexts).not.toContain("before boundary");
  expect(upstream.messageReads()).toBe(1);

  await session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

test("orders queued live deltas behind an incomplete recovery snapshot and suppresses late output", async () => {
  const upstream = await createRecoveryUpstream();
  const timing = new RecoveryTiming();
  const fixture = await createPublicRecoverySession(upstream, timing);
  const { session } = fixture;
  const observed: AgentStreamEvent[] = [];
  session.subscribe((event) => observed.push(event));

  await upstream.connected(1);
  upstream.send(0, connectedRecord());
  await session.startTurn("hello");
  const [dispatchId] = await upstream.dispatched();
  upstream.send(0, assistantMessageRecord("message-race"));
  upstream.send(0, textDeltaRecord("message-race", "part-race", "Hello"));
  await eventually(() => expect(assistantText(observed)).toEqual(["Hello"]));

  upstream.setStatus("busy");
  upstream.setMessages([
    { info: { id: dispatchId as string, sessionID: "session-1", role: "user" }, parts: [] },
    {
      info: { id: "message-race", sessionID: "session-1", role: "assistant" },
      parts: [
        {
          id: "part-race",
          sessionID: "session-1",
          messageID: "message-race",
          type: "text",
          text: "",
          time: { start: 1 },
        },
      ],
    },
  ]);
  upstream.end(0);
  await timing.waiting();
  timing.advance();
  await upstream.connected(2);
  upstream.send(1, connectedRecord());
  upstream.send(1, textDeltaRecord("message-race", "part-race", " world"));
  await eventually(() => expect(assistantText(observed)).toEqual(["Hello", " world"]));

  upstream.setMessages([
    {
      info: {
        id: "message-race",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          id: "part-race",
          sessionID: "session-1",
          messageID: "message-race",
          type: "text",
          text: "Hello world!",
          time: { start: 1, end: 2 },
        },
      ],
    },
  ]);
  upstream.send(1, finalTextRecord("message-race", "part-race", "Hello world!"));
  upstream.send(1, {
    directory: "/workspace",
    payload: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  });
  upstream.send(1, textDeltaRecord("message-race", "part-race", " too late"));

  await eventually(() =>
    expect(observed.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );
  expect(observed.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0);
  expect(observed.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
  expect(assistantText(observed)).toEqual(["Hello", " world", "!"]);
  expect(assistantText(observed).join("")).toBe("Hello world!");
  const ordered = observed.flatMap((event) => {
    if (event.type === "turn_started" || event.type === "turn_completed") return [event.type];
    if (event.type === "timeline" && event.item.type === "assistant_message") {
      return [event.item.text];
    }
    return [];
  });
  expect(ordered).toEqual(["turn_started", "Hello", " world", "!", "turn_completed"]);

  await session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

class RecoveryTiming implements OpenCodeEventConsumerTiming {
  private resolveWait: (() => void) | null = null;
  arm(): () => void {
    return () => undefined;
  }
  wait(_delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveWait = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  async waiting(): Promise<void> {
    await eventually(() => expect(this.resolveWait).not.toBeNull());
  }
  advance(): void {
    this.resolveWait?.();
    this.resolveWait = null;
  }
}

async function createPublicRecoverySession(
  upstream: Awaited<ReturnType<typeof createRecoveryUpstream>>,
  timing: OpenCodeEventConsumerTiming,
) {
  let serverProcess: RecoveryServerProcess | null = null;
  const manager = new OpenCodeServerManager({
    logger: createTestLogger(),
    portAllocator: async () => upstream.port,
    resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
    resolveHomeDir: () => process.cwd(),
    spawnServerProcess: () => {
      serverProcess = new RecoveryServerProcess();
      return serverProcess as unknown as ChildProcess;
    },
    terminateProcess: async () => {
      serverProcess?.exit();
      return "terminated";
    },
    createEventSource: (options) => new OpenCodeEventConsumer({ ...options, timing }),
  });
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: manager,
    createClient: ({ baseUrl, directory }) => createOpencodeClient({ baseUrl, directory }),
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/workspace" });
  return { manager, session };
}

class RecoveryServerProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 42_001;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    queueMicrotask(() => this.stdout.emit("data", Buffer.from("listening on test server\n")));
  }

  exit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

async function createRecoveryUpstream() {
  const streams: ServerResponse[] = [];
  const dispatchIds: string[] = [];
  let messages: unknown[] = [];
  let messageReadCount = 0;
  let status: "busy" | "idle" = "idle";
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.url?.startsWith("/global/event")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      streams.push(response);
      return;
    }
    if (request.method === "POST" && pathname === "/session") {
      return json(response, { id: "session-1", directory: "/workspace" });
    }
    if (request.url?.includes("/prompt_async")) {
      const body = JSON.parse(await readBody(request)) as { messageID: string };
      dispatchIds.push(body.messageID);
      return json(response, {});
    }
    if (request.url?.includes("/message")) {
      messageReadCount += 1;
      return json(response, messages);
    }
    if (request.url?.includes("/status"))
      return json(response, status === "busy" ? { "session-1": { type: "busy" } } : {});
    return json(response, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    connected: async (count: number) => eventually(() => expect(streams).toHaveLength(count)),
    send(index: number, value: unknown) {
      streams[index]?.write(`data: ${JSON.stringify(value)}\n\n`);
    },
    end(index: number) {
      streams[index]?.end();
    },
    dispatched: async (count = 1) => {
      await eventually(() => expect(dispatchIds).toHaveLength(count));
      return [...dispatchIds];
    },
    messageReads: () => messageReadCount,
    setMessages(nextMessages: unknown[]) {
      messages = nextMessages;
    },
    setStatus(nextStatus: "busy" | "idle") {
      status = nextStatus;
    },
    setRecoveredMessages(messageId: string) {
      messages = [
        {
          info: {
            id: "msg_before_boundary",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
          parts: [
            {
              id: "part-before",
              sessionID: "session-1",
              messageID: "msg_before_boundary",
              type: "text",
              text: "before boundary",
              time: { start: 1, end: 2 },
            },
          ],
        },
        {
          info: { id: messageId, sessionID: "session-1", role: "user" },
          parts: [],
        },
        ...Array.from({ length: 51 }, (_, index) => ({
          info: {
            id: `msg_step_${index}`,
            sessionID: "session-1",
            role: "assistant",
            time: { created: index + 3, completed: index + 4 },
          },
          parts: [
            {
              id: `part-step-${index}`,
              sessionID: "session-1",
              messageID: `msg_step_${index}`,
              type: "text",
              text: `step ${index}`,
              time: { start: index + 3, end: index + 4 },
            },
          ],
        })),
        {
          info: { id: "msg_compaction", sessionID: "session-1", role: "user" },
          parts: [
            {
              id: "part-compaction",
              sessionID: "session-1",
              messageID: "msg_compaction",
              type: "compaction",
              auto: true,
            },
          ],
        },
        {
          info: {
            id: "msg_assistant",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-1",
              messageID: "msg_assistant",
              type: "text",
              text: "recovered output",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ];
    },
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function assistantMessageRecord(messageId: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.updated",
      properties: { info: { id: messageId, sessionID: "session-1", role: "assistant" } },
    },
  };
}

function textDeltaRecord(messageId: string, partId: string, delta: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: messageId,
        partID: partId,
        field: "text",
        delta,
      },
    },
  };
}

function finalTextRecord(messageId: string, partId: string, text: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.part.updated",
      properties: {
        part: {
          id: partId,
          sessionID: "session-1",
          messageID: messageId,
          type: "text",
          text,
          time: { start: 1, end: 2 },
        },
      },
    },
  };
}

function assistantText(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
}

function connectedRecord() {
  return { directory: "/workspace", payload: { type: "server.connected", properties: {} } };
}

function idleRecord() {
  return {
    directory: "/workspace",
    payload: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

const permission = {
  id: "permission-1",
  sessionID: "session-1",
  permission: "bash",
  patterns: ["npm run build"],
  always: [],
  metadata: {},
};
const question = {
  id: "question-1",
  sessionID: "session-1",
  questions: [
    {
      header: "Choice",
      question: "Which option?",
      options: [{ label: "One", description: "First" }],
    },
  ],
};

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  agent = "build",
  model = "model-1",
) {
  return {
    info: {
      id,
      role,
      sessionID: "session-1",
      agent,
      model: { providerID: "test", modelID: model },
      providerID: "test",
      modelID: model,
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: `part-${id}`,
        messageID: id,
        sessionID: "session-1",
        type: "text",
        text,
        time: { start: 1, end: 2 },
      },
    ],
  };
}

async function setup(openCode = new TestOpenCodeClient()) {
  const runtime = new TestOpenCodeHarness();
  runtime.enqueueClient(openCode);
  const timing = new ManualObservationTiming();
  const client = new OpenCodeAgentClient(
    createTestLogger(),
    { serverUrl: runtime.server.url },
    {
      serverManager: runtime,
      createClient: runtime.createClient,
      observationTiming: timing,
    },
  );
  const session = await client.resumeSession({
    provider: "opencode",
    sessionId: "session-1",
    metadata: { cwd: "/workspace/repo", openCodeServerUrl: runtime.server.url },
  });
  if (!supportsOpenCodeNativeHistory(session))
    throw new Error("Expected native observation support");
  const events: AgentStreamEvent[] = [];
  const snapshots: OpenCodeHistorySnapshot[] = [];
  const pending: string[][] = [];
  const unsubscribeHistory = session.subscribeNativeHistory(async (snapshot) => {
    snapshots.push(snapshot);
  });
  session.subscribeNativeRequests((requests) =>
    pending.push(requests.map((request) => request.id)),
  );
  session.subscribe((event) => events.push(event));
  return { session, openCode, runtime, timing, events, snapshots, pending, unsubscribeHistory };
}

function timelineText(snapshot: OpenCodeHistorySnapshot | undefined) {
  return snapshot?.map((event) => ("text" in event.item ? event.item.text : event.item.type));
}

describe("OpenCode handoff observation", () => {
  test("hydrates pending requests on attach, removes terminal answers once, and detaches without aborting", async () => {
    const openCode = new TestOpenCodeClient();
    openCode.permissionListResponse = {
      data: [permission, { ...permission, id: "other", sessionID: "other-session" }],
    };
    openCode.questionListResponse = { data: [question] };
    openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(0);
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        "permission-1",
        "question-1",
      ]);
      expect(ctx.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
      openCode.emitEvent({
        type: "permission.replied",
        properties: { sessionID: "session-1", requestID: permission.id, reply: "always" },
      });
      openCode.emitEvent({
        type: "question.rejected",
        properties: { sessionID: "session-1", requestID: question.id },
      });
      openCode.emitEvent({
        type: "question.rejected",
        properties: { sessionID: "session-1", requestID: question.id },
      });
      await flushObservation();
      expect(ctx.session.getPendingPermissions()).toEqual([]);
      expect(ctx.pending.at(-1)).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_resolved")).toEqual([
        {
          type: "permission_resolved",
          provider: "opencode",
          requestId: permission.id,
          resolution: { behavior: "allow", selectedActionId: "allow_always" },
        },
        {
          type: "permission_resolved",
          provider: "opencode",
          requestId: question.id,
          resolution: { behavior: "deny" },
        },
      ]);
    } finally {
      await ctx.session.close();
    }
    expect(openCode.calls.sessionPromptAsync).toEqual([]);
    expect(openCode.calls.sessionAbort).toEqual([]);
    expect(openCode.calls.sessionDelete).toEqual([]);
    expect(ctx.runtime.acquisitions.at(-1)?.releaseCount).toBe(1);
    expect(ctx.timing.pendingCount).toBe(0);
  });

  test("a terminal reply arriving during the pending-list read cannot resurrect a request", async () => {
    const ctx = await setup();
    const gate = observationDeferred<{ data: (typeof permission)[] }>();
    ctx.openCode.permissionListImplementation = () => gate.promise;
    try {
      ctx.openCode.emitEvent({ type: "permission.asked", properties: permission });
      await ctx.timing.advance(0);
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        permission.id,
      ]);
      ctx.openCode.emitEvent({
        type: "permission.replied",
        properties: { sessionID: "session-1", requestID: permission.id, reply: "reject" },
      });
      await flushObservation();
      ctx.openCode.permissionListImplementation = null;
      gate.resolve({ data: [permission] });
      await ctx.timing.advance(100);
      expect(ctx.session.getPendingPermissions()).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_requested")).toHaveLength(1);
    } finally {
      await ctx.session.close();
    }
  });

  test("reconnect replaces missed external turns with no active Paseo dispatch and resolves missed request membership", async () => {
    const openCode = new TestOpenCodeClient();
    const disconnect = observationDeferred<void>();
    let attempt = 0;
    openCode.globalEventImplementation = async () => {
      attempt += 1;
      return {
        stream:
          attempt === 1
            ? {
                [Symbol.asyncIterator]: () => ({
                  next: async () => {
                    await disconnect.promise;
                    return { done: true, value: undefined };
                  },
                }),
              }
            : openCode.eventStream,
      };
    };
    openCode.sessionMessagesResponse = { data: [message("u1", "user", "before disconnect")] };
    openCode.permissionListResponse = { data: [permission] };
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(0);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual(["before disconnect"]);
      openCode.sessionMessagesResponse = {
        data: [
          message("u1", "user", "before disconnect"),
          message("u2", "user", "terminal follow-up"),
          message("a2", "assistant", "completed elsewhere"),
        ],
      };
      openCode.permissionListResponse = { data: [] };
      disconnect.resolve();
      await ctx.timing.advance(100);
      expect(openCode.calls.globalEvent).toHaveLength(2);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual([
        "before disconnect",
        "terminal follow-up",
        "completed elsewhere",
      ]);
      expect(ctx.pending.at(-1)).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_resolved")).toEqual([]);
      expect(
        ctx.events.filter((event) => event.type === "timeline" || event.type === "turn_failed"),
      ).toEqual([]);
      expect(openCode.calls.sessionPromptAsync).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("snapshot/subscription overlap reconciles an inactive terminal message without duplicate append events", async () => {
    const ctx = await setup();
    const old = message("u1", "user", "old");
    const current = message("u2", "user", "arrived during attach");
    const gate = observationDeferred<{ data: ReturnType<typeof message>[] }>();
    ctx.openCode.sessionMessagesImplementation = () => gate.promise;
    try {
      await ctx.timing.advance(0);
      ctx.openCode.emitEvent({ type: "message.updated", properties: { info: current.info } });
      ctx.openCode.emitEvent({
        type: "message.part.updated",
        properties: { part: current.parts[0] },
      });
      await flushObservation();
      ctx.openCode.sessionMessagesImplementation = null;
      ctx.openCode.sessionMessagesResponse = { data: [old, current] };
      gate.resolve({ data: [old] });
      await ctx.timing.advance(100);
      expect(ctx.snapshots.map(timelineText)).toEqual([["old"], ["old", "arrived during attach"]]);
      expect(ctx.events.filter((event) => event.type === "timeline")).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("history read failures retain the last snapshot and retry instead of publishing empty history", async () => {
    const ctx = await setup();
    ctx.openCode.sessionMessagesResponse = { data: [message("u1", "user", "retained")] };
    try {
      await ctx.timing.advance(0);
      ctx.openCode.sessionMessagesResponse = { error: { message: "unavailable" } };
      ctx.openCode.emitEvent({
        type: "message.updated",
        properties: { info: message("u2", "user", "new").info },
      });
      await ctx.timing.advance(100);
      expect(ctx.snapshots.map(timelineText)).toEqual([["retained"]]);
      const readHistory = async () => {
        for await (const _event of ctx.session.streamHistory()) {
          /* exhaust */
        }
      };
      await expect(readHistory()).rejects.toThrow("Failed to read OpenCode history");
      ctx.openCode.sessionMessagesResponse = {
        data: [message("u1", "user", "retained"), message("u2", "user", "new")],
      };
      await ctx.timing.advance(200);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual(["retained", "new"]);
    } finally {
      await ctx.session.close();
    }
  });

  test("latest user agent/model wins over old turns and internal compaction, and a newer mobile selection survives a read race", async () => {
    const ctx = await setup();
    const messages = [
      message("u1", "user", "first", "plan", "old"),
      message("u2", "user", "latest", "coordinator", "new"),
      message("a3", "assistant", "internal summary", "compaction", "internal"),
    ];
    ctx.openCode.sessionMessagesResponse = { data: messages };
    try {
      await ctx.timing.advance(0);
      expect(await ctx.session.getRuntimeInfo()).toMatchObject({
        model: "test/new",
        modeId: "coordinator",
      });
      const gate = observationDeferred<{ data: typeof messages }>();
      ctx.openCode.sessionMessagesImplementation = () => gate.promise;
      ctx.openCode.emitEvent({ type: "message.updated", properties: { info: messages[1].info } });
      await ctx.timing.advance(100);
      await ctx.session.setModel("test/mobile");
      await ctx.session.setMode("reviewer");
      gate.resolve({ data: messages });
      await flushObservation();
      expect(await ctx.session.getRuntimeInfo()).toMatchObject({
        model: "test/mobile",
        modeId: "reviewer",
      });
      expect(ctx.session.describePersistence()?.metadata).toMatchObject({
        model: "test/mobile",
        modeId: "reviewer",
        openCodeServerUrl: ctx.runtime.server.url,
      });
    } finally {
      await ctx.session.close();
    }
  });

  test("a terminal question answer retains the actual choice; failed mobile replies remain pending", async () => {
    const ctx = await setup();
    ctx.openCode.questionListResponse = { data: [question] };
    ctx.openCode.questionReplyResponse = { error: { message: "offline" } };
    try {
      await ctx.timing.advance(0);
      await expect(
        ctx.session.respondToPermission(question.id, {
          behavior: "allow",
          updatedInput: { answers: { Choice: "One" } },
        }),
      ).rejects.toThrow("offline");
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        question.id,
      ]);
      ctx.openCode.emitEvent({
        type: "question.replied",
        properties: { sessionID: "session-1", requestID: question.id, answers: [["One"]] },
      });
      await flushObservation();
      expect(ctx.session.getPendingPermissions()).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "permission_resolved")).toEqual([
        {
          type: "permission_resolved",
          provider: "opencode",
          requestId: question.id,
          resolution: { behavior: "allow", updatedInput: { answers: { Choice: "One" } } },
        },
      ]);
    } finally {
      await ctx.session.close();
    }
  });

  test("reconnect during a running external turn catches up partial content then observes completion once", async () => {
    const openCode = new TestOpenCodeClient();
    const disconnect = observationDeferred<void>();
    let attempt = 0;
    openCode.globalEventImplementation = async () => {
      attempt += 1;
      return {
        stream:
          attempt === 1
            ? {
                [Symbol.asyncIterator]: () => ({
                  next: async () => {
                    await disconnect.promise;
                    return { done: true, value: undefined };
                  },
                }),
              }
            : openCode.eventStream,
      };
    };
    openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    openCode.sessionMessagesResponse = { data: [message("a1", "assistant", "partial")] };
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(0);
      openCode.sessionMessagesResponse = {
        data: [message("a1", "assistant", "partial and missed suffix")],
      };
      disconnect.resolve();
      await ctx.timing.advance(100);
      expect(timelineText(ctx.snapshots.at(-1))).toEqual(["partial and missed suffix"]);
      expect(ctx.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
      expect(
        ctx.events.filter(
          (event) => event.type === "turn_completed" || event.type === "turn_failed",
        ),
      ).toEqual([]);
      openCode.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      await flushObservation();
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(ctx.events.filter((event) => event.type === "timeline")).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("a missed session error is recovered as failure rather than successful idle", async () => {
    const ctx = await setup();
    ctx.openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    try {
      await ctx.timing.advance(0);
      const failed = message("a1", "assistant", "partial");
      ctx.openCode.sessionMessagesResponse = {
        data: [
          {
            ...failed,
            info: {
              ...failed.info,
              error: { name: "UnknownError", data: { message: "provider lost credentials" } },
            },
          },
        ],
      };
      ctx.openCode.sessionStatusResponse = { data: {} };
      // The watchdog reconnect is a real consumer transition, not a fabricated lifecycle event.
      await ctx.timing.advance(30_100);
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "turn_failed")).toMatchObject([
        {
          type: "turn_failed",
          error: '{"name":"UnknownError","data":{"message":"provider lost credentials"}}',
        },
      ]);
    } finally {
      await ctx.session.close();
    }
  });

  test("detach cancels a blocked snapshot consumer without waiting for the manager queue", async () => {
    const ctx = await setup();
    ctx.unsubscribeHistory();
    const gate = observationDeferred<void>();
    let applied = 0;
    ctx.session.subscribeNativeHistory(async (_snapshot, signal) => {
      await gate.promise;
      if (!signal.aborted) applied += 1;
    });
    await ctx.timing.advance(0);
    await ctx.session.close();
    gate.resolve();
    await flushObservation();
    expect(applied).toBe(0);
    expect(ctx.timing.pendingCount).toBe(0);
    expect(ctx.openCode.calls.sessionAbort).toEqual([]);
  });

  test("attach hydrates pending requests from a discovered child's actual directory", async () => {
    const openCode = new TestOpenCodeClient();
    openCode.sessionChildrenResponses = [
      { data: [{ id: "child", parentID: "session-1", directory: "/workspace/child" }] },
    ];
    openCode.permissionListImplementation = async (parameters) => ({
      data:
        (parameters as { directory: string }).directory === "/workspace/child"
          ? [{ ...permission, sessionID: "child" }]
          : [],
    });
    const ctx = await setup(openCode);
    try {
      await ctx.timing.advance(100);
      expect(ctx.session.getPendingPermissions().map((request) => request.id)).toEqual([
        permission.id,
      ]);
      await ctx.session.respondToPermission(permission.id, { behavior: "allow" });
      expect(openCode.calls.permissionReply).toEqual([
        {
          requestID: permission.id,
          directory: "/workspace/child",
          reply: "once",
          message: undefined,
        },
      ]);
    } finally {
      await ctx.session.close();
    }
  });

  test("history observation makes progress even when each read overlaps more streaming output", async () => {
    const ctx = await setup();
    let reads = 0;
    ctx.openCode.sessionMessagesImplementation = async () => {
      reads += 1;
      const current = message("a1", "assistant", `output ${reads}`);
      ctx.openCode.emitEvent({ type: "message.updated", properties: { info: current.info } });
      await flushObservation();
      return { data: [current] };
    };
    try {
      await ctx.timing.advance(0);
      await flushObservation();
      expect(ctx.snapshots.map(timelineText)).toEqual([["output 1"]]);
      await ctx.timing.advance(100);
      await flushObservation();
      expect(ctx.snapshots.map(timelineText)).toEqual([["output 1"], ["output 2"]]);
      expect(ctx.events.filter((event) => event.type === "timeline")).toEqual([]);
    } finally {
      await ctx.session.close();
    }
  });

  test("recovery does not attribute a previous turn's error to a later native user message", async () => {
    const ctx = await setup();
    ctx.openCode.sessionStatusResponse = { data: { "session-1": { type: "busy" } } };
    try {
      await ctx.timing.advance(0);
      const previous = message("a1", "assistant", "previous failure");
      ctx.openCode.sessionMessagesResponse = {
        data: [
          {
            ...previous,
            info: {
              ...previous.info,
              error: { name: "UnknownError", data: { message: "old failure" } },
            },
          },
          message("u2", "user", "later request"),
        ],
      };
      ctx.openCode.sessionStatusResponse = { data: {} };
      await ctx.timing.advance(30_100);
      expect(ctx.events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    } finally {
      await ctx.session.close();
    }
  });
});
