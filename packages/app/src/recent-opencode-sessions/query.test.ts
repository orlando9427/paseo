import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { RecentOpenCodeSessionsClient, RecentOpenCodeSessionsHost } from "./query";
import {
  fetchRecentOpenCodeSessions,
  openRecentOpenCodeSession,
  resolveRecentOpenCodeSessionsHosts,
} from "./query";

function client(input: {
  entries?: Awaited<
    ReturnType<RecentOpenCodeSessionsClient["fetchRecentProviderSessions"]>
  >["entries"];
  fetchError?: Error;
  importedAgent?: AgentSnapshotPayload;
  requests?: unknown[];
}): RecentOpenCodeSessionsClient {
  return {
    fetchRecentProviderSessions: async (request) => {
      input.requests?.push(request);
      if (input.fetchError) throw input.fetchError;
      return {
        requestId: "recent-opencode",
        entries: input.entries ?? [],
        filteredAlreadyImportedCount: 0,
      };
    },
    importAgent: async (request) => {
      input.requests?.push(request);
      if (!input.importedAgent) throw new Error("No imported agent configured");
      return input.importedAgent;
    },
  };
}

function host(
  serverId: string,
  sessionClient: RecentOpenCodeSessionsClient,
): RecentOpenCodeSessionsHost {
  return { serverId, serverName: `${serverId} name`, client: sessionClient };
}

function entry(providerHandleId: string, lastActivityAt: string) {
  return {
    providerId: "opencode",
    providerLabel: "OpenCode",
    providerHandleId,
    cwd: `/work/${providerHandleId}`,
    title: `Session ${providerHandleId}`,
    firstPromptPreview: null,
    lastPromptPreview: "Continue the task",
    lastActivityAt,
  };
}

function importedAgent(id: string, workspaceId: string): AgentSnapshotPayload {
  return {
    id,
    workspaceId,
    provider: "opencode",
    cwd: "/work/native-session",
    model: null,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    lastUserMessageAt: "2026-08-30T10:00:00.000Z",
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

describe("fetchRecentOpenCodeSessions", () => {
  it("loads OpenCode sessions from every host and sorts them by activity", async () => {
    const firstRequests: unknown[] = [];
    const secondRequests: unknown[] = [];
    const batch = await fetchRecentOpenCodeSessions([
      host(
        "first",
        client({
          requests: firstRequests,
          entries: [entry("older", "2026-08-29T10:00:00.000Z")],
        }),
      ),
      host(
        "second",
        client({
          requests: secondRequests,
          entries: [entry("newer", "2026-08-30T10:00:00.000Z")],
        }),
      ),
    ]);

    expect(firstRequests).toEqual([{ providers: ["opencode"] }]);
    expect(secondRequests).toEqual([{ providers: ["opencode"] }]);
    expect(
      batch.sessions.map((session) => `${session.serverId}:${session.entry.providerHandleId}`),
    ).toEqual(["second:newer", "first:older"]);
    expect(batch.errors).toEqual([]);
  });

  it("keeps successful rows and names a host whose list failed", async () => {
    const batch = await fetchRecentOpenCodeSessions([
      host("online", client({ entries: [entry("available", "2026-08-30T10:00:00.000Z")] })),
      host("failed", client({ fetchError: new Error("list failed") })),
    ]);

    expect(batch.sessions.map((session) => session.entry.providerHandleId)).toEqual(["available"]);
    expect(batch.errors).toEqual([
      { serverId: "failed", serverName: "failed name", reason: "listFailed" },
    ]);
  });
});

describe("resolveRecentOpenCodeSessionsHosts", () => {
  it("does not query a connected host that lacks import-session support", async () => {
    const requests: unknown[] = [];
    const unsupportedClient = client({ requests });
    const resolution = resolveRecentOpenCodeSessionsHosts([
      {
        serverId: "old-host",
        serverName: "Old host",
        client: unsupportedClient,
        isConnected: true,
        supportsImportSessions: false,
      },
    ]);

    await fetchRecentOpenCodeSessions(resolution.targetHosts);

    expect(requests).toEqual([]);
    expect(resolution.hostErrors).toEqual([
      { serverId: "old-host", serverName: "Old host", reason: "unsupported" },
    ]);
  });

  it("distinguishes an unreachable host from an unsupported host", () => {
    const sessionClient = client({});
    const resolution = resolveRecentOpenCodeSessionsHosts([
      {
        serverId: "offline-host",
        serverName: "Offline host",
        client: sessionClient,
        isConnected: false,
        supportsImportSessions: true,
      },
      {
        serverId: "old-host",
        serverName: "Old host",
        client: sessionClient,
        isConnected: true,
        supportsImportSessions: false,
      },
    ]);

    expect(resolution.targetHosts).toEqual([]);
    expect(resolution.hostErrors).toEqual([
      { serverId: "offline-host", serverName: "Offline host", reason: "unreachable" },
      { serverId: "old-host", serverName: "Old host", reason: "unsupported" },
    ]);
  });
});

describe("openRecentOpenCodeSession", () => {
  it("imports on the owning host and navigates to the resulting workspace agent", async () => {
    const requests: unknown[] = [];
    const navigations: unknown[] = [];
    const sessionClient = client({
      importedAgent: importedAgent("agent-1", "workspace-1"),
      requests,
    });
    const session = {
      serverId: "host-1",
      serverName: "Main host",
      entry: entry("native-session", "2026-08-30T10:00:00.000Z"),
    };

    await openRecentOpenCodeSession({
      session,
      getClient: (serverId) => (serverId === "host-1" ? sessionClient : null),
      navigate: (target) => navigations.push(target),
    });

    expect(requests).toEqual([
      {
        providerId: "opencode",
        providerHandleId: "native-session",
        cwd: "/work/native-session",
      },
    ]);
    expect(navigations).toEqual([
      { serverId: "host-1", agentId: "agent-1", workspaceId: "workspace-1", pin: true },
    ]);
  });

  it("fails before importing when the owning host disconnected", async () => {
    await expect(
      openRecentOpenCodeSession({
        session: {
          serverId: "offline",
          serverName: "Offline host",
          entry: entry("native-session", "2026-08-30T10:00:00.000Z"),
        },
        getClient: () => null,
        navigate: () => {
          throw new Error("navigation should not run");
        },
      }),
    ).rejects.toThrow("Host Offline host is disconnected");
  });
});
