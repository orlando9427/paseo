import type {
  AgentPermissionRequest,
  AgentSession,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";

export type OpenCodeHistorySnapshot = readonly Extract<AgentStreamEvent, { type: "timeline" }>[];
export type OpenCodeHistorySink = (
  snapshot: OpenCodeHistorySnapshot,
  signal: AbortSignal,
) => Promise<void>;

/**
 * One manager-owned sink replaces the native transcript atomically. Register before subscribing
 * to ordinary events and skip legacy history priming for this session. Snapshots include ongoing
 * turns and can remove reverted rows. Preserve unacknowledged presentation rows separately.
 *
 * Root timeline events use this sink exclusively while registered; lifecycle and permission
 * events still use subscribe(). A rejected replacement is retried. Detaching cancels future
 * delivery, but the manager must also guard its in-flight replacement by session identity and
 * check the supplied signal before committing. A consumer may detach while its queue is blocked.
 */
export interface OpenCodeNativeHistorySession extends AgentSession {
  subscribeNativeHistory(replace: OpenCodeHistorySink): () => void;
  // A pending-list absence does not reveal the user's answer. Reconcile membership without
  // inventing an allow/deny permission_resolved event when that answer was missed during a gap.
  subscribeNativeRequests(
    replace: (requests: readonly AgentPermissionRequest[]) => void,
  ): () => void;
}

export function supportsOpenCodeNativeHistory(
  session: AgentSession,
): session is OpenCodeNativeHistorySession {
  return (
    session.capabilities.supportsNativeHistoryObservation === true &&
    "subscribeNativeHistory" in session &&
    typeof session.subscribeNativeHistory === "function" &&
    "subscribeNativeRequests" in session &&
    typeof session.subscribeNativeRequests === "function"
  );
}
