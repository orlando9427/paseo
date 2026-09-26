interface SessionIdentity {
  provider: string;
  persistence?: { metadata?: Record<string, unknown> } | null;
}

export function isExternalOpenCodeSession(session: SessionIdentity | null): boolean {
  // The adapter's endpoint marker also survives custom provider aliases extending OpenCode.
  return typeof session?.persistence?.metadata?.openCodeServerUrl === "string";
}
