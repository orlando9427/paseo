import type { AgentPermissionRequest, AgentStreamEvent } from "./agent-sdk-types.js";

/** Daemon-facing projection for message-owned results. This does not specify a native RPC. */
export interface AgentPromptCompletion {
  status: "completed" | "failed" | "cancelled" | "interrupted";
  lastMessage: string | null;
  error?: string;
}

export type AgentPromptCheckpoint =
  | AgentPromptCompletion
  | { status: "permission"; permission: AgentPermissionRequest };

export interface AgentPromptHandle {
  messageId: string;
  completion: Promise<AgentPromptCompletion>;
  result: Promise<AgentPromptCheckpoint>;
  subscribe(listener: (checkpoint: AgentPromptCheckpoint) => void): () => void;
}

/** Observe one already-admitted local stream. This owns no payload storage or retry queue. */
export function observeAdmittedPrompt(
  messageId: string,
  events: AsyncGenerator<AgentStreamEvent>,
  initialPermission?: AgentPermissionRequest,
): AgentPromptHandle {
  let complete!: (result: AgentPromptCompletion) => void;
  let checkpoint!: (result: AgentPromptCheckpoint) => void;
  const completion = new Promise<AgentPromptCompletion>((resolve) => {
    complete = resolve;
  });
  const result = new Promise<AgentPromptCheckpoint>((resolve) => {
    checkpoint = resolve;
  });
  const listeners = new Set<(value: AgentPromptCheckpoint) => void>();
  let latest: AgentPromptCheckpoint | null = null;
  const publish = (value: AgentPromptCheckpoint) => {
    latest = value;
    checkpoint(value);
    if (value.status !== "permission") complete(value);
    for (const listener of listeners) listener(value);
  };
  void (async () => {
    let lastMessage: string | null = null;
    let assistantPrefix = false;
    try {
      if (initialPermission) publish({ status: "permission", permission: initialPermission });
      for await (const event of events) {
        if (event.type === "timeline") {
          if (event.item.type === "assistant_message")
            lastMessage = (assistantPrefix ? (lastMessage ?? "") : "") + event.item.text;
          assistantPrefix = event.item.type === "assistant_message";
        } else if (event.type === "permission_requested") {
          publish({ status: "permission", permission: event.request });
        } else if (event.type === "turn_completed") {
          publish({ status: "completed", lastMessage });
          return;
        } else if (event.type === "turn_failed") {
          publish({ status: "failed", lastMessage, error: event.error });
          return;
        } else if (event.type === "turn_canceled") {
          publish({ status: "cancelled", lastMessage });
          return;
        }
      }
      publish({
        status: "failed",
        lastMessage,
        error: "Provider stream ended without a terminal outcome",
      });
    } catch (error) {
      publish({
        status: "failed",
        lastMessage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return {
    messageId,
    completion,
    result,
    subscribe(listener) {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
