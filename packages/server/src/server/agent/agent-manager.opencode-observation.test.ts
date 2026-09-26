import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import type { AgentClient, AgentPersistenceHandle } from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import { OpenCodeAgentClient } from "./providers/opencode-agent.js";
import { wrapClientProvider } from "./provider-registry.js";
import { Session } from "../session.js";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  FetchAgentTimelineResponseMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import {
  asDownloadTokenStore,
  asPushNotifications,
  asScheduleService,
  asCheckoutDiffManager,
  asWorkspaceGitService,
  asDaemonConfigStore,
  createProviderSnapshotManagerStub,
} from "../test-utils/session-stubs.js";
import { supportsOpenCodeNativeHistory } from "./providers/opencode/native-history.js";
import {
  supportsOpenCodeSubmissionTracking,
  OpenCodeSubmissionOutcomeError,
} from "./providers/opencode/native-submissions.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineStore,
  AgentTimelineRow,
  AgentTimelineFetchOptions,
} from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./providers/opencode/test-utils/test-opencode-harness.js";
import {
  ManualObservationTiming,
  flushObservation,
  observationDeferred,
} from "./providers/opencode/test-utils/manual-observation-timing.js";

const cleanup: Array<() => Promise<void>> = [];
const agentId = "12345678-1234-4234-8234-123456789abc";
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  model = "model-1",
  agent = "build",
) {
  return {
    info: {
      id,
      sessionID: "session-1",
      role,
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

async function fixture(
  durableTimelineStore?: AgentTimelineStore,
  external = true,
  managedCreate = false,
) {
  const home = await mkdtemp(join(tmpdir(), "paseo-native-observation-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(home, "agents"), logger);
  const native = new TestOpenCodeClient();
  const runtime = new TestOpenCodeHarness();
  const timing = new ManualObservationTiming();
  const provider = new OpenCodeAgentClient(
    logger,
    external ? { serverUrl: runtime.server.url } : undefined,
    {
      serverManager: runtime,
      createClient: runtime.createClient,
      observationTiming: timing,
    },
  );
  // Availability is the only process/network probe replaced here. All session operations use
  // the real provider with its SDK port, including the registry's session decorator.
  const createProvider = managedCreate
    ? new OpenCodeAgentClient(logger, undefined, {
        serverManager: runtime,
        createClient: runtime.createClient,
        observationTiming: timing,
      })
    : provider;
  const client: AgentClient = {
    provider: provider.provider,
    capabilities: provider.capabilities,
    isAvailable: async () => true,
    fetchCatalog: provider.fetchCatalog.bind(provider),
    createSession: createProvider.createSession.bind(createProvider),
    resumeSession: provider.resumeSession.bind(provider),
    listExternalOpenCodeSessions: provider.listExternalOpenCodeSessions.bind(provider),
  };
  const manager = new AgentManager({
    clients: { opencode: wrapClientProvider("opencode", client, [], [], false) },
    registry: storage,
    durableTimelineStore,
    logger,
  });
  cleanup.push(async () => {
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    await manager.flush();
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { replayState: false });
  const handle = {
    provider: "opencode",
    sessionId: "session-1",
    metadata: { cwd: home, openCodeServerUrl: runtime.server.url, model: "test/model-1" },
  };
  const resume = async (sdk = native, persisted: AgentPersistenceHandle = handle) => {
    sdk.sessionGetResponse = { data: { id: "session-1", directory: home, title: null } };
    runtime.enqueueClient(sdk);
    return manager.resumeAgentFromPersistence(
      persisted,
      { cwd: home, model: "test/model-1" },
      agentId,
    );
  };
  const observe = async (ms = 100) => {
    await timing.advance(ms);
    await manager.flush();
  };
  const projects = new FileBackedProjectRegistry(join(home, "projects.json"), logger);
  const workspaces = new FileBackedWorkspaceRegistry(join(home, "workspaces.json"), logger);
  const openObserver = (selective = false) => {
    const messages: SessionOutboundMessage[] = [];
    const session = new Session({
      clientId: "observation-client",
      permissions: OWNER_PERMISSIONS,
      paseoHome: home,
      clientCapabilities: selective ? { [CLIENT_CAPS.selectiveAgentTimeline]: true } : null,
      logger,
      agentManager: manager,
      agentStorage: storage,
      projectRegistry: projects,
      workspaceRegistry: workspaces,
      onMessage: (msg) => messages.push(msg),
      downloadTokenStore: asDownloadTokenStore(),
      pushNotifications: asPushNotifications(),
      scheduleService: asScheduleService(),
      checkoutDiffManager: asCheckoutDiffManager({}),
      workspaceGitService: asWorkspaceGitService({ peekSnapshot: () => null }),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      stt: null,
      tts: null,
      terminalManager: null,
    });
    cleanup.push(() => session.cleanup());
    const pages = () => messages.filter((msg) => msg.type === "fetch_agent_timeline_response");
    return { session, messages, pages };
  };
  return {
    home,
    logger,
    storage,
    native,
    runtime,
    provider,
    manager,
    timing,
    events,
    resume,
    observe,
    projects,
    workspaces,
    openObserver,
  };
}

test("replaces a primed retained transcript with inactive terminal history after stored resume", async () => {
  const f = await fixture();
  await f.resume();
  await f.manager.appendTimelineItem(agentId, {
    type: "assistant_message",
    text: "stale stored tail",
  });
  await f.manager.closeAgent(agentId);
  const stored = await new AgentStorage(join(f.home, "agents"), f.logger).get(agentId);
  expect(stored?.persistence?.sessionId).toBe("session-1");
  if (!stored?.persistence) throw new Error("Missing stored resume handle");
  const resumed = new TestOpenCodeClient();
  resumed.sessionMessagesResponse = {
    data: [
      message("u-1", "user", "terminal question"),
      message("a-1", "assistant", "terminal answer"),
    ],
  };
  await f.resume(resumed, stored.persistence);
  expect(f.manager.getAgent(agentId)?.historyPrimed).toBe(true);
  const oldEpoch = f.manager.fetchTimeline(agentId).epoch;
  await f.observe(0);
  expect(f.manager.getTimeline(agentId)).toEqual([
    { type: "user_message", messageId: "u-1", text: "terminal question" },
    { type: "assistant_message", messageId: "a-1", text: "terminal answer" },
  ]);
  const tail = f.manager.fetchTimeline(agentId, {
    direction: "after",
    cursor: { epoch: oldEpoch, seq: 1 },
  });
  expect(tail).toMatchObject({ reset: true, staleCursor: true, window: { maxSeq: 2 } });
  expect(resumed.calls.sessionPromptAsync).toEqual([]);
  expect(resumed.calls.sessionAbort).toEqual([]);
});

test("publishes an atomic bounded client page and an empty epoch through the real Session", async () => {
  const f = await fixture();
  const observer = f.openObserver();
  const hidden = f.openObserver(true);
  f.native.sessionMessagesResponse = {
    data: [message("u1", "user", "native"), message("a1", "assistant", "answer")],
  };
  await f.resume();
  await f.observe(0);
  expect(observer.pages()).toHaveLength(1);
  const first = FetchAgentTimelineResponseMessageSchema.parse(observer.pages()[0]);
  expect(first.payload).toMatchObject({
    reset: true,
    direction: "tail",
    window: { maxSeq: 2 },
    hasNewer: false,
  });
  expect(first.payload.entries.map((entry) => entry.item)).toEqual(f.manager.getTimeline(agentId));
  expect(hidden.pages()).toEqual([]);
  await hidden.session.handleMessage({
    type: "agent.timeline.set_subscription.request",
    requestId: "viewed",
    agentIds: [agentId],
  });
  f.native.sessionMessagesResponse = { data: [] };
  f.native.emitEvent({ type: "session.updated", properties: { info: { id: "session-1" } } });
  await f.observe();
  const empty = FetchAgentTimelineResponseMessageSchema.parse(observer.pages().at(-1));
  expect(empty.payload).toMatchObject({
    reset: true,
    entries: [],
    startCursor: null,
    endCursor: null,
    window: { maxSeq: 0, nextSeq: 1 },
  });
  expect(empty.payload.epoch).not.toBe(first.payload.epoch);
  expect(hidden.pages()).toHaveLength(1);
  expect(hidden.pages()[0]?.payload).toEqual(empty.payload);
  expect(
    observer.messages.filter(
      (msg) => msg.type === "agent_stream" && msg.payload.event.type === "timeline",
    ),
  ).toEqual([]);
});

test("snapshot/subscription overlap catches up without appending duplicate live content", async () => {
  const f = await fixture();
  const observer = f.openObserver();
  const old = message("u1", "user", "before");
  const current = message("a1", "assistant", "arrived during snapshot");
  await f.resume();
  const gate = observationDeferred<{ data: ReturnType<typeof message>[] }>();
  f.native.sessionMessagesImplementation = () => gate.promise;
  await f.timing.advance(0);
  f.native.emitEvent({ type: "message.updated", properties: { info: current.info } });
  f.native.emitEvent({ type: "message.part.updated", properties: { part: current.parts[0] } });
  await flushObservation();
  f.native.sessionMessagesImplementation = null;
  f.native.sessionMessagesResponse = { data: [old, current] };
  gate.resolve({ data: [old] });
  await f.observe();
  expect(observer.pages().map((page) => page.payload.entries.map((entry) => entry.item))).toEqual([
    [{ type: "user_message", messageId: "u1", text: "before" }],
    [
      { type: "user_message", messageId: "u1", text: "before" },
      { type: "assistant_message", messageId: "a1", text: "arrived during snapshot" },
    ],
  ]);
});

test("client replacement is bounded and older native rows remain reachable through the existing request path", async () => {
  const f = await fixture();
  const observer = f.openObserver();
  f.native.sessionMessagesResponse = {
    data: Array.from({ length: 205 }, (_, i) => message(`u${i}`, "user", `native ${i}`)),
  };
  await f.resume();
  await f.observe(0);
  const tail = observer.pages()[0]?.payload;
  if (!tail?.startCursor) throw new Error("Missing replacement cursor");
  expect(tail.entries).toHaveLength(200);
  expect(tail).toMatchObject({
    reset: true,
    hasOlder: true,
    hasNewer: false,
    window: { maxSeq: 205 },
  });
  expect(tail.entries[0]?.item).toEqual({
    type: "user_message",
    messageId: "u5",
    text: "native 5",
  });
  await observer.session.handleMessage({
    type: "fetch_agent_timeline_request",
    requestId: "older",
    agentId,
    direction: "before",
    cursor: tail.startCursor,
    limit: 200,
  });
  const older = observer.pages().at(-1)?.payload;
  expect(older).toMatchObject({
    requestId: "older",
    epoch: tail.epoch,
    reset: false,
    hasOlder: false,
  });
  expect(older?.entries.map((entry) => entry.item)).toEqual([
    { type: "user_message", messageId: "u0", text: "native 0" },
    { type: "user_message", messageId: "u1", text: "native 1" },
    { type: "user_message", messageId: "u2", text: "native 2" },
    { type: "user_message", messageId: "u3", text: "native 3" },
    { type: "user_message", messageId: "u4", text: "native 4" },
  ]);
});

test.each(["close", "replace"])(
  "%s rejects stale native reads without blocking the successor adapter",
  async (action) => {
    const f = await fixture();
    await f.resume();
    const gate = observationDeferred<{ data: ReturnType<typeof message>[] }>();
    f.native.sessionMessagesImplementation = () => gate.promise;
    await f.timing.advance(0);
    const hydration = f.manager
      .hydrateTimelineFromProvider(agentId)
      .catch((error: unknown) => error);
    const replacement = new TestOpenCodeClient();
    replacement.sessionGetResponse = { data: { id: "session-1", directory: f.home } };
    replacement.sessionMessagesResponse = { data: [message("new", "user", "successor")] };
    if (action === "replace") {
      f.runtime.enqueueClient(replacement);
      await f.manager.reloadAgentSession(agentId);
    } else {
      await f.manager.closeAgent(agentId);
      await f.resume(replacement);
    }
    expect(await hydration).toBeInstanceOf(Error);
    await f.observe(0);
    gate.resolve({ data: [message("stale", "user", "must not publish")] });
    f.native.emitEvent({ type: "permission.asked", properties: permission });
    await f.observe();
    expect(f.manager.getTimeline(agentId)).toEqual([
      { type: "user_message", messageId: "new", text: "successor" },
    ]);
    expect(f.manager.getPendingPermissions(agentId)).toEqual([]);
    expect(f.native.calls.sessionAbort).toEqual([]);
  },
);

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
    { header: "Choice", question: "Which?", options: [{ label: "One", description: "First" }] },
  ],
};

test("terminal replies retain known permission actions and question answers", async () => {
  const f = await fixture();
  f.native.permissionListResponse = { data: [permission] };
  f.native.questionListResponse = { data: [question] };
  await f.resume();
  await f.observe(0);
  expect(f.manager.getPendingPermissions(agentId).map((request) => request.id)).toEqual([
    permission.id,
    question.id,
  ]);
  f.native.emitEvent({
    type: "permission.replied",
    properties: { sessionID: "session-1", requestID: permission.id, reply: "always" },
  });
  f.native.emitEvent({
    type: "question.replied",
    properties: { sessionID: "session-1", requestID: question.id, answers: [["One"]] },
  });
  await flushObservation();
  await f.manager.flush();
  expect(f.manager.getPendingPermissions(agentId)).toEqual([]);
  expect(
    f.events.flatMap((event) =>
      event.type === "agent_stream" && event.event.type === "permission_resolved"
        ? [event.event]
        : [],
    ),
  ).toEqual([
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
      resolution: { behavior: "allow", updatedInput: { answers: { Choice: "One" } } },
    },
  ]);
  expect(f.native.calls.permissionReply).toEqual([]);
  expect(f.native.calls.questionReply).toEqual([]);
});

test("a pending-list read racing a terminal reply cannot resurrect membership in the manager", async () => {
  const f = await fixture();
  await f.resume();
  const gate = observationDeferred<{ data: (typeof permission)[] }>();
  f.native.permissionListImplementation = () => gate.promise;
  f.native.emitEvent({ type: "permission.asked", properties: permission });
  await f.timing.advance(0);
  f.native.emitEvent({
    type: "permission.replied",
    properties: { sessionID: "session-1", requestID: permission.id, reply: "reject" },
  });
  await flushObservation();
  f.native.permissionListImplementation = null;
  gate.resolve({ data: [permission] });
  await f.observe();
  expect(f.manager.getPendingPermissions(agentId)).toEqual([]);
});

test("reconnect recovers inactive history and pending membership without fabricating missed answers", async () => {
  const f = await fixture();
  const disconnected = observationDeferred<void>();
  let first = true;
  f.native.globalEventImplementation = async () => {
    if (!first) return { stream: f.native.eventStream };
    first = false;
    return {
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await disconnected.promise;
            return { done: true, value: undefined };
          },
        }),
      },
    };
  };
  f.native.permissionListResponse = { data: [permission] };
  await f.resume();
  await f.observe(0);
  f.native.permissionListResponse = { data: [] };
  f.native.sessionMessagesResponse = {
    data: [message("terminal", "assistant", "finished elsewhere")],
  };
  disconnected.resolve();
  await f.observe();
  expect(f.native.calls.globalEvent).toHaveLength(2);
  expect(f.manager.getTimeline(agentId)).toEqual([
    { type: "assistant_message", messageId: "terminal", text: "finished elsewhere" },
  ]);
  expect(f.manager.getPendingPermissions(agentId)).toEqual([]);
  expect(
    f.events.filter(
      (event) => event.type === "agent_stream" && event.event.type === "permission_resolved",
    ),
  ).toEqual([]);
});

test("native model and agent updates persist the current handle while a newer local setter wins a read race", async () => {
  const f = await fixture();
  f.native.sessionMessagesResponse = { data: [message("u1", "user", "first", "model-2", "plan")] };
  await f.resume();
  await f.observe(0);
  const readStored = () => new AgentStorage(join(f.home, "agents"), f.logger).get(agentId);
  expect(await readStored()).toMatchObject({
    config: { model: "test/model-2", modeId: "plan" },
    runtimeInfo: { model: "test/model-2", modeId: "plan" },
    persistence: {
      nativeHandle: "session-1",
      metadata: { model: "test/model-2", modeId: "plan", openCodeServerUrl: f.runtime.server.url },
    },
  });
  const next = message("u2", "user", "next", "model-3", "build");
  const gate = observationDeferred<{ data: ReturnType<typeof message>[] }>();
  f.native.sessionMessagesImplementation = () => gate.promise;
  f.native.emitEvent({ type: "message.updated", properties: { info: next.info } });
  await f.timing.advance(100);
  await f.manager.setAgentModel(agentId, "test/local-model");
  f.native.sessionMessagesImplementation = null;
  gate.resolve({ data: [next] });
  await f.observe();
  expect(await readStored()).toMatchObject({
    config: { model: "test/local-model" },
    persistence: { metadata: { model: "test/local-model" } },
  });
});

test("attachment-only replay retains exact URLs in the real client page", async () => {
  const f = await fixture();
  const observer = f.openObserver();
  f.native.sessionMessagesResponse = {
    data: [
      {
        info: message("files", "user", "").info,
        parts: [
          {
            id: "image",
            sessionID: "session-1",
            messageID: "files",
            type: "file",
            mime: "image/png",
            filename: "image.png",
            url: "data:image/png;base64,AQID",
          },
          {
            id: "file",
            sessionID: "session-1",
            messageID: "files",
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "file:///shared/note%20one.txt",
          },
        ],
      },
    ],
  };
  await f.resume();
  await f.observe(0);
  expect(
    observer
      .pages()
      .at(-1)
      ?.payload.entries.map((entry) => entry.item),
  ).toEqual([
    {
      type: "user_message",
      messageId: "files",
      text: "\n[image.png](data:image/png;base64,AQID)\nMIME: image/png\n\n[note.txt](file:///shared/note%20one.txt)\nMIME: text/plain\n",
    },
  ]);
});

test("preserves independent local presentations and joins a native receipt by identity, never by text", async () => {
  const f = await fixture();
  await f.resume();
  await f.observe(0);
  const session = f.manager.getAgent(agentId)?.session;
  if (!session || !supportsOpenCodeNativeHistory(session))
    throw new Error("Missing observation session");
  await f.manager.appendTimelineItem(agentId, {
    type: "user_message",
    clientMessageId: "sent",
    messageId: "sent",
    text: "local attachment presentation",
  });
  await f.manager.appendTimelineItem(agentId, {
    type: "user_message",
    clientMessageId: "unacknowledged",
    text: "still waiting",
  });
  let nativeMessageId = "";
  let sent = 0;
  f.native.sessionPromptAsyncImplementation = async (input) => {
    if (typeof input !== "object" || input === null) throw new Error("Missing prompt request");
    const id = Reflect.get(input, "messageID");
    if (typeof id !== "string") throw new Error("Missing native message identity");
    nativeMessageId = id;
    return {};
  };
  await session.startTurn("native payload", {
    clientMessageId: "sent",
    admission: {
      id: "fixture-send",
      modeId: "plan",
      signal: new AbortController().signal,
      assertCurrent() {},
      markRequestSent() {
        sent += 1;
      },
    },
  });
  expect(sent).toBe(1);
  await f.manager.flush();
  expect(await new AgentStorage(join(f.home, "agents"), f.logger).get(agentId)).toMatchObject({
    config: { modeId: "plan" },
    persistence: { metadata: { modeId: "plan" } },
  });
  const nativeUser = message(nativeMessageId, "user", "native payload", "model-1", "plan");
  f.native.sessionMessagesResponse = { data: [nativeUser] };
  f.native.emitEvent({ type: "message.updated", properties: { info: nativeUser.info } });
  await f.observe();
  expect(f.manager.getTimeline(agentId)).toEqual([
    {
      type: "user_message",
      clientMessageId: "sent",
      messageId: "sent",
      text: "local attachment presentation",
    },
    { type: "user_message", clientMessageId: "unacknowledged", text: "still waiting" },
  ]);
  expect((await f.manager.getTimelineRows(agentId))[0]?.providerMessageId).toBe(nativeMessageId);
  expect(await new AgentStorage(join(f.home, "agents"), f.logger).get(agentId)).toMatchObject({
    config: { modeId: "plan" },
    persistence: { metadata: { modeId: "plan" } },
  });
  f.native.sessionMessagesResponse = { data: [] };
  f.native.emitEvent({ type: "session.updated", properties: { info: { id: "session-1" } } });
  await f.observe();
  expect(f.manager.getTimeline(agentId)).toEqual([
    { type: "user_message", clientMessageId: "unacknowledged", text: "still waiting" },
  ]);
});

test("persists ambiguous native outcome observations and restores their fence without resubmitting", async () => {
  const f = await fixture();
  await f.resume();
  await f.observe(0);
  const session = f.manager.getAgent(agentId)?.session;
  if (!session || !supportsOpenCodeSubmissionTracking(session))
    throw new Error("Missing receipt observation port");
  f.native.sessionPromptAsyncImplementation = async () => ({
    error: new Error("acknowledgement lost"),
  });
  await expect(
    session.startTurn("do work", {
      admission: {
        id: "lost-ack",
        signal: new AbortController().signal,
        assertCurrent() {},
        markRequestSent() {},
      },
    }),
  ).rejects.toBeInstanceOf(OpenCodeSubmissionOutcomeError);
  await f.manager.flush();
  await f.manager.closeAgent(agentId);
  const stored = await new AgentStorage(join(f.home, "agents"), f.logger).get(agentId);
  if (!stored?.persistence) throw new Error("Missing persisted receipt handle");
  expect(stored.persistence.metadata?.openCodeNativeSubmissions).toMatchObject([
    { admissionId: "lost-ack", delivery: "uncertain", callerInterrupted: true },
  ]);
  const resumed = new TestOpenCodeClient();
  await f.resume(resumed, stored.persistence);
  await f.observe(0);
  const restored = f.manager.getAgent(agentId)?.session;
  if (!restored || !supportsOpenCodeSubmissionTracking(restored))
    throw new Error("Missing restored receipt port");
  expect(await restored.reconcileNativeSubmissions()).toMatchObject([
    { admissionId: "lost-ack", delivery: "uncertain", callerInterrupted: true },
  ]);
  expect(resumed.calls.sessionPromptAsync).toEqual([]);
  expect(resumed.calls.sessionAbort).toEqual([]);
});

test("a native snapshot arriving before local acceptance uses the canonical client presentation identity", async () => {
  const f = await fixture();
  const observer = f.openObserver();
  await f.resume();
  await f.observe(0);
  const session = f.manager.getAgent(agentId)?.session;
  if (!session) throw new Error("Missing observation session");
  let nativeId = "";
  f.native.sessionPromptAsyncImplementation = async (input) => {
    if (typeof input !== "object" || input === null) throw new Error("Missing native request");
    const id = Reflect.get(input, "messageID");
    if (typeof id !== "string") throw new Error("Missing native message ID");
    nativeId = id;
    return {};
  };
  await session.startTurn("early echo", {
    clientMessageId: "client-early",
    admission: {
      id: "early",
      signal: new AbortController().signal,
      assertCurrent() {},
      markRequestSent() {},
    },
  });
  const input = message(nativeId, "user", "early echo");
  f.native.sessionMessagesResponse = { data: [input] };
  f.native.emitEvent({ type: "message.updated", properties: { info: input.info } });
  await f.observe();
  expect(
    observer
      .pages()
      .at(-1)
      ?.payload.entries.map((entry) => entry.item),
  ).toEqual([
    {
      type: "user_message",
      messageId: "client-early",
      clientMessageId: "client-early",
      text: "early echo",
    },
  ]);
  expect((await f.manager.getTimelineRows(agentId))[0]?.providerMessageId).toBe(nativeId);
});

test("failed native history reads retain the committed client epoch until recovery succeeds", async () => {
  const f = await fixture();
  f.native.sessionMessagesResponse = { data: [message("u1", "user", "retained")] };
  await f.resume();
  await f.observe(0);
  const before = f.manager.fetchTimeline(agentId);
  f.native.sessionMessagesResponse = { error: new Error("native read failed") };
  f.native.emitEvent({ type: "session.updated", properties: { info: { id: "session-1" } } });
  await f.observe();
  expect(f.manager.fetchTimeline(agentId)).toEqual(before);
  f.native.sessionMessagesResponse = { data: [message("u2", "user", "recovered")] };
  await f.observe(200);
  expect(f.manager.getTimeline(agentId)).toEqual([
    { type: "user_message", messageId: "u2", text: "recovered" },
  ]);
});

/** Transactional datastore port with an injectable pre-commit barrier, not a manager replica. */
class TimelinePersistence implements AgentTimelineStore {
  readonly store = new InMemoryAgentTimelineStore();
  commitGate: Promise<void> | null = null;
  readonly entered = observationDeferred<void>();
  replacements = 0;
  bulkGate: Promise<void> | null = null;
  readonly bulkEntered = observationDeferred<void>();
  updateGate: Promise<void> | null = null;
  readonly updateEntered = observationDeferred<void>();
  settlementGate: Promise<void> | null = null;
  onCommitted: (() => void) | null = null;
  constructor() {
    this.store.initialize(agentId);
  }
  async appendCommitted(id: string, item: AgentTimelineItem, options?: { timestamp?: string }) {
    return this.store.append(id, item, options);
  }
  async fetchCommitted(id: string, options?: AgentTimelineFetchOptions) {
    return this.store.fetch(id, options);
  }
  async getLatestCommittedSeq(id: string) {
    return this.store.fetch(id).window.maxSeq;
  }
  async getCommittedRows(id: string) {
    return this.store.getRows(id);
  }
  async getLastItem(id: string) {
    return this.store.getLastItem(id);
  }
  async getLastAssistantMessage(id: string) {
    return this.store.getLastAssistantMessage(id);
  }
  async deleteAgent(id: string) {
    this.store.initialize(id);
  }
  async bulkInsert(id: string, rows: readonly AgentTimelineRow[]) {
    this.bulkEntered.resolve();
    await this.bulkGate;
    const combined = new Map(this.store.getRows(id).map((row) => [row.seq, row]));
    for (const row of rows) combined.set(row.seq, row);
    this.store.initialize(id, { rows: [...combined.values()] });
  }
  async updateCommittedRow(id: string, row: AgentTimelineRow) {
    this.updateEntered.resolve();
    await this.updateGate;
    await this.bulkInsert(id, [row]);
  }
  async replaceCommitted(id: string, rows: readonly AgentTimelineRow[], assertCurrent: () => void) {
    this.replacements += 1;
    this.entered.resolve();
    await this.commitGate;
    assertCurrent();
    this.store.initialize(id, { rows });
    this.onCommitted?.();
    await this.settlementGate;
  }
}

test("detach aborts a blocked sink commit and an old transaction cannot replace the successor timeline", async () => {
  const durable = new TimelinePersistence();
  const gate = observationDeferred<void>();
  durable.commitGate = gate.promise;
  const f = await fixture(durable);
  f.native.sessionMessagesResponse = { data: [message("old", "user", "stale transaction")] };
  await f.resume();
  await f.timing.advance(0);
  await durable.entered.promise;
  await f.manager.closeAgent(agentId);
  durable.commitGate = null;
  const successor = new TestOpenCodeClient();
  successor.sessionMessagesResponse = { data: [message("new", "user", "new transaction")] };
  await f.resume(successor);
  await f.timing.advance(0);
  expect(durable.replacements).toBe(1);
  gate.resolve();
  await f.observe();
  expect(await f.manager.getTimelineRows(agentId)).toMatchObject([
    { item: { messageId: "new", text: "new transaction" } },
  ]);
  expect(f.manager.getTimeline(agentId)).toEqual([
    { type: "user_message", messageId: "new", text: "new transaction" },
  ]);
});

test("a fresh manager replaces primed committed history instead of treating stored rows as current native history", async () => {
  const durable = new TimelinePersistence();
  await durable.appendCommitted(agentId, {
    type: "assistant_message",
    text: "previously committed",
  });
  const f = await fixture(durable);
  f.native.sessionMessagesResponse = {
    data: [message("new-native", "assistant", "terminal activity while detached")],
  };
  await f.resume();
  expect(f.manager.getAgent(agentId)?.historyPrimed).toBe(true);
  expect((await f.manager.getTimelineRows(agentId)).map((row) => row.item)).toEqual([
    { type: "assistant_message", text: "previously committed" },
  ]);
  await f.observe(0);
  const expected = [
    {
      type: "assistant_message",
      messageId: "new-native",
      text: "terminal activity while detached",
    },
  ];
  expect(f.manager.getTimeline(agentId)).toEqual(expected);
  expect((await f.manager.getTimelineRows(agentId)).map((row) => row.item)).toEqual(expected);
});

test("a simultaneous presentation write invalidates the pending transaction and is retained on retry", async () => {
  const durable = new TimelinePersistence();
  const gate = observationDeferred<void>();
  durable.commitGate = gate.promise;
  const f = await fixture(durable);
  f.native.sessionMessagesResponse = { data: [message("native", "user", "native history")] };
  await f.resume();
  await f.timing.advance(0);
  await durable.entered.promise;
  await f.manager.appendTimelineItem(agentId, {
    type: "user_message",
    clientMessageId: "pending",
    text: "unacknowledged",
  });
  durable.commitGate = null;
  gate.resolve();
  await f.observe(200);
  expect(f.manager.getTimeline(agentId)).toEqual([
    { type: "user_message", messageId: "native", text: "native history" },
    { type: "user_message", clientMessageId: "pending", text: "unacknowledged" },
  ]);
  expect((await f.manager.getTimelineRows(agentId)).map((row) => row.item)).toEqual(
    f.manager.getTimeline(agentId),
  );
});

test("managed OpenCode retains the run-result stream instead of opting into external observation", async () => {
  const f = await fixture(undefined, false);
  f.runtime.enqueueClient(f.native);
  const answer = message("answer", "assistant", "managed result");
  f.native.sessionPromptAsyncEvents = [
    { type: "message.updated", properties: { info: answer.info } },
    { type: "message.part.updated", properties: { part: answer.parts[0] } },
    { type: "session.idle", properties: { sessionID: "session-1" } },
  ];
  const agent = await f.manager.createAgent(
    { provider: "opencode", cwd: f.home, model: "test/model-1" },
    agentId,
    { workspaceId: "workspace" },
  );
  if (!agent.session) throw new Error("Missing managed session");
  expect(supportsOpenCodeNativeHistory(agent.session)).toBe(false);
  const result = await f.manager.runAgent(agentId, "managed prompt");
  expect(result.finalText).toBe("managed result");
  expect(f.native.calls.sessionPromptAsync).toHaveLength(1);
});

test("orders an older delayed presentation insert before native replacement so durable and client history agree", async () => {
  const durable = new TimelinePersistence();
  const gate = observationDeferred<void>();
  durable.bulkGate = gate.promise;
  const f = await fixture(durable);
  const observer = f.openObserver();
  await f.resume();
  await f.manager.appendTimelineItem(agentId, {
    type: "user_message",
    clientMessageId: "pending",
    text: "local presentation",
  });
  await durable.bulkEntered.promise;
  f.native.sessionMessagesResponse = { data: [message("history", "user", "native history")] };
  await f.timing.advance(0);
  gate.resolve();
  await f.observe();
  const expected = [
    { type: "user_message", messageId: "history", text: "native history" },
    { type: "user_message", clientMessageId: "pending", text: "local presentation" },
  ];
  expect(f.manager.getTimeline(agentId)).toEqual(expected);
  expect((await f.manager.getTimelineRows(agentId)).map((row) => row.item)).toEqual(expected);
  expect(
    observer
      .pages()
      .at(-1)
      ?.payload.entries.map((entry) => entry.item),
  ).toEqual(expected);
});

test("orders an older delayed acknowledgement update before native replacement at a new sequence", async () => {
  const durable = new TimelinePersistence();
  const f = await fixture(durable, true, true);
  const observer = f.openObserver();
  f.runtime.enqueueClient(f.native);
  f.native.sessionPromptAsyncEvents = [];
  await f.manager.createAgent(
    { provider: "opencode", cwd: f.home, model: "test/model-1" },
    agentId,
    { workspaceId: "workspace" },
  );
  const run = f.manager.streamAgent(agentId, "submitted", { clientMessageId: "client-submitted" });
  await run.next();
  await f.manager.flush();
  const gate = observationDeferred<void>();
  durable.updateGate = gate.promise;
  const echo = message("native-submitted", "user", "submitted");
  f.native.emitEvent({ type: "message.updated", properties: { info: echo.info } });
  f.native.emitEvent({ type: "message.part.updated", properties: { part: echo.parts[0] } });
  await durable.updateEntered.promise;
  await f.manager.closeAgent(agentId);
  await run.return(undefined);
  const successor = new TestOpenCodeClient();
  successor.sessionMessagesResponse = {
    data: [message("history", "user", "earlier native history"), echo],
  };
  await f.resume(successor);
  await f.timing.advance(0);
  gate.resolve();
  await f.observe();
  const expected = [
    { type: "user_message", messageId: "history", text: "earlier native history" },
    {
      type: "user_message",
      messageId: "client-submitted",
      clientMessageId: "client-submitted",
      text: "submitted",
    },
  ];
  expect(f.manager.getTimeline(agentId)).toEqual(expected);
  const rows = await f.manager.getTimelineRows(agentId);
  expect(rows.map((row) => row.item)).toEqual(expected);
  expect(rows[1]?.providerMessageId).toBe("native-submitted");
  expect(
    observer
      .pages()
      .at(-1)
      ?.payload.entries.map((entry) => entry.item),
  ).toEqual(expected);
});

test("keeps replacement publication ordered when a presentation arrives after the store commit but before its promise settles", async () => {
  const durable = new TimelinePersistence();
  const f = await fixture(durable);
  const observer = f.openObserver();
  f.native.sessionMessagesResponse = { data: [message("old", "user", "old history")] };
  await f.resume();
  await f.observe(0);
  const gate = observationDeferred<void>();
  const committed = observationDeferred<void>();
  durable.settlementGate = gate.promise;
  durable.onCommitted = () => committed.resolve();
  f.native.sessionMessagesResponse = { data: [message("new", "user", "new history")] };
  f.native.emitEvent({ type: "session.updated", properties: { info: { id: "session-1" } } });
  await f.timing.advance(100);
  await committed.promise;
  await f.manager.appendTimelineItem(agentId, {
    type: "user_message",
    clientMessageId: "pending",
    text: "late presentation",
  });
  durable.settlementGate = null;
  gate.resolve();
  await f.manager.flush();
  const expected = [
    { type: "user_message", messageId: "new", text: "new history" },
    { type: "user_message", clientMessageId: "pending", text: "late presentation" },
  ];
  expect(f.manager.getTimeline(agentId)).toEqual(expected);
  expect((await f.manager.getTimelineRows(agentId)).map((row) => row.item)).toEqual(expected);
  expect(
    observer
      .pages()
      .at(-1)
      ?.payload.entries.map((entry) => entry.item),
  ).toEqual(expected);
});

test("does not replay native activity that ended before manager attachment", async () => {
  const f = await fixture();
  const entered = observationDeferred<void>();
  const modes = observationDeferred<{ data: never[] }>();
  f.native.appAgentsImplementation = () => {
    entered.resolve();
    return modes.promise;
  };
  const registration = f.resume();
  await entered.promise;
  f.native.emitEvent({
    type: "session.status",
    properties: { sessionID: "session-1", status: { type: "busy" } },
  });
  await flushObservation();
  f.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
  await flushObservation();
  modes.resolve({ data: [] });
  expect(await registration).toMatchObject({ lifecycle: "idle", activeTurnId: null });
  await f.observe(0);
  expect(
    f.events.filter(
      (event) => event.type === "agent_stream" && event.event.type === "turn_started",
    ),
  ).toEqual([]);
  expect(await f.manager.cancelAgentRun(agentId)).toEqual({ status: "not_running" });
  expect(f.native.calls.sessionAbort).toEqual([]);
});

test.each(["after settlement", "before settlement"])(
  "retains cold and late presentations when detaching after commit and resuming %s",
  async (resumeOrder) => {
    const durable = new TimelinePersistence();
    const oldPresentation: AgentTimelineItem = {
      type: "user_message",
      clientMessageId: "old-pending",
      text: "old unacknowledged presentation",
    };
    const newPresentation: AgentTimelineItem = {
      type: "user_message",
      clientMessageId: "new-pending",
      text: "late unacknowledged presentation",
    };
    await durable.appendCommitted(agentId, oldPresentation);
    const committed = observationDeferred<void>();
    const settlement = observationDeferred<void>();
    durable.onCommitted = () => committed.resolve();
    durable.settlementGate = settlement.promise;
    const f = await fixture(durable);
    const observer = f.openObserver();
    f.native.sessionMessagesResponse = {
      data: [message("history", "user", "committed native history")],
    };
    await f.resume();
    expect(f.manager.getTimeline(agentId)).toEqual([]);
    expect(f.manager.fetchTimeline(agentId).window.nextSeq).toBe(2);
    await f.timing.advance(0);
    await committed.promise;
    expect(durable.store.getRows(agentId).map((row) => row.item)).toEqual([
      { type: "user_message", messageId: "history", text: "committed native history" },
      oldPresentation,
    ]);
    await f.manager.appendTimelineItem(agentId, newPresentation);
    expect(f.manager.fetchTimeline(agentId).rows[0]?.seq).toBe(2);
    await f.manager.closeAgent(agentId);

    const successor = new TestOpenCodeClient();
    successor.sessionMessagesResponse = {
      data: [message("resumed", "user", "current native history")],
    };
    if (resumeOrder === "before settlement") {
      await f.resume(successor);
      await f.timing.advance(0);
      expect(durable.replacements).toBe(1);
      expect(observer.pages()).toEqual([]);
    }
    durable.settlementGate = null;
    settlement.resolve();
    await f.manager.flush();
    if (resumeOrder === "after settlement") {
      expect(durable.store.getRows(agentId).map((row) => row.item)).toEqual([
        { type: "user_message", messageId: "history", text: "committed native history" },
        oldPresentation,
        newPresentation,
      ]);
      expect(observer.pages()).toEqual([]);
      await f.resume(successor);
    }
    await f.observe(0);
    const expected = [
      { type: "user_message", messageId: "resumed", text: "current native history" },
      oldPresentation,
      newPresentation,
    ];
    expect(f.manager.getTimeline(agentId)).toEqual(expected);
    expect((await f.manager.getTimelineRows(agentId)).map((row) => row.item)).toEqual(expected);
    expect(observer.pages().map((page) => page.payload.entries.map((entry) => entry.item))).toEqual(
      [expected],
    );
    expect(successor.calls.sessionPromptAsync).toEqual([]);
  },
);

test.each(["busy", "retry"])(
  "replays native %s activity observed during manager initialization and Stop reaches its native session",
  async (status) => {
    const f = await fixture();
    const modesEntered = observationDeferred<void>();
    const modes = observationDeferred<{ data: never[] }>();
    f.native.appAgentsImplementation = () => {
      modesEntered.resolve();
      return modes.promise;
    };
    const registration = f.resume();
    await modesEntered.promise;
    f.native.sessionStatusResponse = { data: { "session-1": { type: status } } };
    f.native.emitEvent({
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: { type: status, attempt: 1, message: "waiting", next: 100 },
      },
    });
    await flushObservation();
    modes.resolve({ data: [] });
    const registered = await registration;
    await f.observe(0);
    const started = f.events.flatMap((event) =>
      event.type === "agent_stream" && event.event.type === "turn_started" ? [event.event] : [],
    );
    expect(started).toHaveLength(1);
    expect(registered.lifecycle).toBe("running");
    expect(f.manager.getAgent(agentId)).toMatchObject({
      lifecycle: "running",
      activeTurnId: started[0]?.turnId,
    });
    const readyStates = f.events.flatMap((event) =>
      event.type === "agent_state" && event.agent.lifecycle !== "initializing"
        ? [event.agent.lifecycle]
        : [],
    );
    expect(readyStates).not.toContain("idle");
    // The follow-up status read must not mint another identity or duplicate the replay.
    expect(f.native.calls.sessionStatus).toHaveLength(1);
    f.native.sessionAbortImplementation = async () => {
      f.native.sessionStatusResponse = { data: { "session-1": { type: "idle" } } };
      f.native.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
      return {};
    };
    expect(await f.manager.cancelAgentRun(agentId)).toEqual({ status: "settled" });
    await f.manager.flush();
    expect(f.native.calls.sessionAbort).toEqual([{ sessionID: "session-1", directory: f.home }]);
    expect(f.manager.getAgent(agentId)).toMatchObject({ lifecycle: "idle", activeTurnId: null });
    expect(f.native.calls.sessionPromptAsync).toEqual([]);
  },
);
