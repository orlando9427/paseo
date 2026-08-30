import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostFeatureMap } from "@/runtime/host-features";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";

export type RecentOpenCodeSessionsClient = Pick<
  DaemonClient,
  "fetchRecentProviderSessions" | "importAgent"
>;

export interface RecentOpenCodeSessionsHost {
  serverId: string;
  serverName: string;
  client: RecentOpenCodeSessionsClient;
}

export interface RecentOpenCodeSession {
  serverId: string;
  serverName: string;
  entry: FetchRecentProviderSessionEntry;
}

export interface RecentOpenCodeSessionsHostError {
  serverId: string;
  serverName: string;
  reason: "unreachable" | "unsupported" | "listFailed";
}

interface RecentOpenCodeSessionsBatch {
  sessions: RecentOpenCodeSession[];
  errors: RecentOpenCodeSessionsHostError[];
}

export async function fetchRecentOpenCodeSessions(
  hosts: readonly RecentOpenCodeSessionsHost[],
): Promise<RecentOpenCodeSessionsBatch> {
  const settled = await Promise.allSettled(
    hosts.map(async (host) => ({
      host,
      response: await host.client.fetchRecentProviderSessions({ providers: ["opencode"] }),
    })),
  );
  const sessions: RecentOpenCodeSession[] = [];
  const errors: RecentOpenCodeSessionsHostError[] = [];

  for (let index = 0; index < settled.length; index++) {
    const result = settled[index];
    const host = hosts[index];
    if (result.status === "rejected") {
      errors.push({
        serverId: host.serverId,
        serverName: host.serverName,
        reason: "listFailed",
      });
      continue;
    }
    for (const entry of result.value.response.entries) {
      sessions.push({ serverId: host.serverId, serverName: host.serverName, entry });
    }
  }

  sessions.sort(
    (a, b) =>
      new Date(b.entry.lastActivityAt).getTime() - new Date(a.entry.lastActivityAt).getTime(),
  );
  return { sessions, errors };
}

export async function openRecentOpenCodeSession(input: {
  session: RecentOpenCodeSession;
  getClient: (serverId: string) => RecentOpenCodeSessionsClient | null;
  navigate: (target: {
    serverId: string;
    agentId: string;
    workspaceId?: string;
    pin: true;
  }) => void;
}): Promise<void> {
  const client = input.getClient(input.session.serverId);
  if (!client) {
    throw new Error(`Host ${input.session.serverName} is disconnected`);
  }
  const agent = await client.importAgent({
    providerId: input.session.entry.providerId,
    providerHandleId: input.session.entry.providerHandleId,
    cwd: input.session.entry.cwd,
  });
  input.navigate({
    serverId: input.session.serverId,
    agentId: agent.id,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    pin: true,
  });
}

function mergeHostErrors(
  unreachable: readonly RecentOpenCodeSessionsHostError[],
  failed: readonly RecentOpenCodeSessionsHostError[],
): RecentOpenCodeSessionsHostError[] {
  const byServerId = new Map<string, RecentOpenCodeSessionsHostError>();
  for (const error of [...unreachable, ...failed]) {
    byServerId.set(error.serverId, error);
  }
  return [...byServerId.values()];
}

export interface RecentOpenCodeSessionsHostCandidate {
  serverId: string;
  serverName: string;
  client: RecentOpenCodeSessionsClient | null;
  isConnected: boolean;
  supportsImportSessions: boolean;
}

export function resolveRecentOpenCodeSessionsHosts(
  candidates: readonly RecentOpenCodeSessionsHostCandidate[],
): {
  targetHosts: RecentOpenCodeSessionsHost[];
  hostErrors: RecentOpenCodeSessionsHostError[];
} {
  const targetHosts: RecentOpenCodeSessionsHost[] = [];
  const hostErrors: RecentOpenCodeSessionsHostError[] = [];
  for (const candidate of candidates) {
    if (!candidate.client || !candidate.isConnected) {
      hostErrors.push({
        serverId: candidate.serverId,
        serverName: candidate.serverName,
        reason: "unreachable",
      });
      continue;
    }
    if (!candidate.supportsImportSessions) {
      hostErrors.push({
        serverId: candidate.serverId,
        serverName: candidate.serverName,
        reason: "unsupported",
      });
      continue;
    }
    targetHosts.push({
      serverId: candidate.serverId,
      serverName: candidate.serverName,
      client: candidate.client,
    });
  }
  return { targetHosts, hostErrors };
}

export function useRecentOpenCodeSessions(input: { serverId: string | null; enabled: boolean }) {
  const hosts = useHosts();
  const selectedHosts = useMemo(
    () => (input.serverId ? hosts.filter((host) => host.serverId === input.serverId) : hosts),
    [hosts, input.serverId],
  );
  const selectedServerIds = useMemo(
    () => selectedHosts.map((host) => host.serverId),
    [selectedHosts],
  );
  const importSessionsSupport = useHostFeatureMap(selectedServerIds, "providersSnapshot");
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const { targetHosts, hostErrors } = useMemo(() => {
    void runtimeVersion;
    const candidates = selectedHosts.map((host) => {
      const snapshot = runtime.getSnapshot(host.serverId);
      const client = runtime.getClient(host.serverId);
      return {
        serverId: host.serverId,
        serverName: host.label,
        client,
        isConnected: isHostRuntimeConnected(snapshot),
        supportsImportSessions: importSessionsSupport.get(host.serverId) === true,
      };
    });
    return resolveRecentOpenCodeSessionsHosts(candidates);
  }, [importSessionsSupport, runtime, runtimeVersion, selectedHosts]);
  const targetServerIds = useMemo(() => targetHosts.map((host) => host.serverId), [targetHosts]);
  const query = useFetchQuery({
    queryKey: ["recent-opencode-sessions", ...targetServerIds],
    enabled: input.enabled && targetHosts.length > 0,
    queryFn: () => fetchRecentOpenCodeSessions(targetHosts),
    dataShape: "value",
    staleTimeMs: 30_000,
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    if (!input.enabled || targetHosts.length === 0) return;
    await refetch();
  }, [input.enabled, refetch, targetHosts.length]);
  const errors = useMemo(
    () => mergeHostErrors(hostErrors, query.data?.errors ?? []),
    [hostErrors, query.data?.errors],
  );

  return {
    sessions: query.data?.sessions ?? [],
    errors,
    isLoading: input.enabled && targetHosts.length > 0 && query.isPending,
    refresh,
  };
}
