/** Read-only provider port. Rows must come from native IDs, never inferred titles. */
export interface ExternalOpenCodeSessionMetadata {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  parentId: string | null;
  title: string | null;
  modeId?: string;
  model?: string;
  agentNames: string[];
  /** First meaningful, nonsynthetic user message; null for empty/system-only sessions. */
  firstUserMessage: { id: string; agent: string } | null;
}

export interface ListExternalOpenCodeSessionsInput {
  cwd: string;
  createdAfter: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ExternalOpenCodeSessionPage {
  endpoint: string;
  sessions: ExternalOpenCodeSessionMetadata[];
  nextCursor?: string;
}

export function externalOpenCodeSessionKey(endpoint: string, sessionId: string): string {
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Expected an external OpenCode HTTP(S) endpoint without credentials, query or fragment",
    );
  }
  return `${url.href.replace(/\/+$/, "")}\0${sessionId}`;
}
