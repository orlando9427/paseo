import { isAbsolute } from "node:path";
import type {
  GlobalSession,
  OpencodeClient,
  SessionMessagesResponses,
} from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import { createPathEquivalenceMatcher } from "../../../../utils/path.js";
import type {
  ExternalOpenCodeSessionMetadata,
  ExternalOpenCodeSessionPage,
  ListExternalOpenCodeSessionsInput,
} from "../../external-opencode-types.js";
import { toDiagnosticErrorMessage } from "../diagnostic-utils.js";
import { waitForOpenCodeObservation } from "./event-consumer.js";

const SESSION_READ_LIMIT = 21;
const MESSAGE_READ_LIMIT = 100;
const MESSAGE_PAGE_LIMIT = 20;
type NativeMessage = SessionMessagesResponses[200][number];

const CursorSchema = z
  .object({
    version: z.literal(1),
    endpoint: z.string(),
    cwd: z.string(),
    createdAfter: z.number().int().nonnegative(),
    before: z.number().int().positive(),
  })
  .strict();

interface ExternalSessionMetadataOptions {
  client: Pick<OpencodeClient, "experimental" | "session">;
  endpoint: string;
  input: ListExternalOpenCodeSessionsInput;
  signal: AbortSignal;
}

export async function collectExternalOpenCodeSessions(
  options: ExternalSessionMetadataOptions,
): Promise<ExternalOpenCodeSessionPage> {
  const { client, endpoint, input, signal } = options;
  signal.throwIfAborted();
  if (!isAbsolute(input.cwd) || !isTimestamp(input.createdAfter)) {
    throw new Error(
      "External OpenCode discovery requires an absolute cwd and a valid creation cutoff",
    );
  }
  const before = decodeCursor(input, endpoint);
  const response = await waitForOpenCodeObservation(
    client.experimental.session.list(
      {
        directory: input.cwd,
        // This native query filters time.updated, not time.created. Recheck creation locally.
        start: input.createdAfter,
        ...(before !== undefined ? { cursor: before } : {}),
        limit: SESSION_READ_LIMIT,
        archived: true,
        roots: false,
      },
      { signal },
    ),
    signal,
  );
  signal.throwIfAborted();
  if (response.error || !Array.isArray(response.data)) {
    throw new Error(
      `Failed to list external OpenCode sessions: ${toDiagnosticErrorMessage(response.error ?? "missing data")}`,
    );
  }
  const rows = response.data;
  validateSessionPage(rows, before);
  const next = readNextCursor(response.response, "session listing");
  const page = selectCompleteTimestampGroups(rows, next);
  const matchesCwd = createPathEquivalenceMatcher(input.cwd);
  const sessions: ExternalOpenCodeSessionMetadata[] = [];
  // Serial reads bound both fanout and cancellation latency. No partial page is returned on error.
  for (const session of page.rows) {
    signal.throwIfAborted();
    if (!matchesCwd(session.directory) || session.time.created <= input.createdAfter) continue;
    const messages = await readMessages(client, session, signal);
    sessions.push(projectMetadata(session, messages));
  }
  signal.throwIfAborted();
  return {
    endpoint,
    sessions,
    ...(page.before === undefined
      ? {}
      : {
          nextCursor: Buffer.from(
            JSON.stringify({
              version: 1,
              endpoint,
              cwd: input.cwd,
              createdAfter: input.createdAfter,
              before: page.before,
            }),
          ).toString("base64url"),
        }),
  };
}

function decodeCursor(
  input: ListExternalOpenCodeSessionsInput,
  endpoint: string,
): number | undefined {
  if (input.cursor === undefined) return undefined;
  try {
    if (input.cursor.length > 4096) throw new Error("oversized cursor");
    const cursor = CursorSchema.parse(
      JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
    );
    if (
      cursor.endpoint !== endpoint ||
      cursor.cwd !== input.cwd ||
      cursor.createdAfter !== input.createdAfter ||
      !isTimestamp(cursor.before)
    )
      throw new Error("cursor scope mismatch");
    return cursor.before;
  } catch {
    throw new Error("Invalid or mismatched external OpenCode discovery cursor");
  }
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 8_640_000_000_000_000;
}

function validateSessionPage(rows: GlobalSession[], before: number | undefined): void {
  if (rows.length > SESSION_READ_LIMIT)
    throw new Error("OpenCode session listing exceeded its read bound");
  const ids = new Set<string>();
  let previous = before ?? Infinity;
  for (const row of rows) {
    if (
      !nonEmpty(row.id) ||
      ids.has(row.id) ||
      !isAbsolute(row.directory) ||
      !isTimestamp(row.time?.created) ||
      !isTimestamp(row.time?.updated) ||
      row.time.updated < row.time.created
    ) {
      throw new Error("Invalid external OpenCode session identity or timestamps");
    }
    if (row.time.archived !== undefined && !isTimestamp(row.time.archived))
      throw new Error("Invalid external OpenCode archive timestamp");
    if (row.time.updated > previous || (before !== undefined && row.time.updated >= before))
      throw new Error("OpenCode session listing cursor did not advance in updated-time order");
    previous = row.time.updated;
    ids.add(row.id);
  }
}

function selectCompleteTimestampGroups(
  rows: GlobalSession[],
  next: string | undefined,
): { rows: GlobalSession[]; before?: number } {
  if (next === undefined) return { rows };
  const boundary = rows.at(-1)?.time.updated;
  if (boundary === undefined || !/^\d+$/.test(next) || Number(next) !== boundary) {
    throw new Error("Invalid OpenCode session listing pagination metadata");
  }
  // The experimental API uses time.updated < cursor, without an ID tie-break cursor. Keep the
  // trailing timestamp group for the next page so equal timestamps cannot silently disappear.
  const complete = rows.filter((row) => row.time.updated > boundary);
  if (complete.length === 0) {
    throw new Error(
      "OpenCode session timestamp group exceeds the bounded discovery page; a stable native cursor is required",
    );
  }
  return { rows: complete, before: boundary + 1 };
}

function readNextCursor(response: Response, operation: string): string | undefined {
  if (!response?.headers)
    throw new Error(`OpenCode ${operation} omitted pagination response metadata`);
  const next = response.headers.get("x-next-cursor");
  if (next === null) return undefined;
  if (!next.trim()) throw new Error(`OpenCode ${operation} returned an empty pagination cursor`);
  return next;
}

async function readMessages(
  client: Pick<OpencodeClient, "session">,
  session: GlobalSession,
  signal: AbortSignal,
): Promise<NativeMessage[]> {
  const messages: NativeMessage[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let before: string | undefined;
  let oldest: NativeMessage | undefined;
  for (let page = 0; page < MESSAGE_PAGE_LIMIT; page++) {
    signal.throwIfAborted();
    const response = await waitForOpenCodeObservation(
      client.session.messages(
        {
          sessionID: session.id,
          directory: session.directory,
          limit: MESSAGE_READ_LIMIT,
          ...(before === undefined ? {} : { before }),
        },
        { signal },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (response.error || !Array.isArray(response.data)) {
      throw new Error(
        `Failed to read external OpenCode session messages: ${toDiagnosticErrorMessage(response.error ?? "missing data")}`,
      );
    }
    if (response.data.length > MESSAGE_READ_LIMIT)
      throw new Error("OpenCode messages exceeded their read bound");
    for (const message of response.data) {
      validateMessage(message, session.id, ids);
      if (oldest && compareMessages(message, oldest) >= 0)
        throw new Error("OpenCode message pagination did not advance to older messages");
      ids.add(message.info.id);
      messages.push(message);
    }
    oldest = response.data.toSorted(compareMessages)[0] ?? oldest;
    const next = readNextCursor(response.response, "messages");
    if (next === undefined) return messages.sort(compareMessages);
    if (response.data.length === 0 || cursors.has(next))
      throw new Error("OpenCode message pagination did not advance");
    cursors.add(next);
    before = next;
  }
  throw new Error(
    "External OpenCode message scan exceeded 20 pages (up to 2000 messages); provenance is incomplete",
  );
}

function validateMessage(message: NativeMessage, sessionId: string, ids: Set<string>): void {
  if (
    !message.info ||
    !nonEmpty(message.info.id) ||
    message.info.sessionID !== sessionId ||
    !isTimestamp(message.info.time?.created) ||
    ids.has(message.info.id) ||
    !Array.isArray(message.parts)
  ) {
    throw new Error("Invalid or repeated external OpenCode message identity");
  }
  if (message.info.role !== "user" && message.info.role !== "assistant")
    throw new Error("Unknown external OpenCode message role");
  for (const part of message.parts) {
    if (part.sessionID !== sessionId || part.messageID !== message.info.id)
      throw new Error("Mismatched external OpenCode message part identity");
  }
}

function compareMessages(left: NativeMessage, right: NativeMessage): number {
  return (
    left.info.time.created - right.info.time.created || (left.info.id < right.info.id ? -1 : 1)
  );
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function meaningfulUser(
  message: NativeMessage,
): message is NativeMessage & { info: Extract<NativeMessage["info"], { role: "user" }> } {
  if (message.info.role !== "user" || message.parts.some((part) => part.type === "compaction"))
    return false;
  return message.parts.some((part) => {
    if (
      ("synthetic" in part && part.synthetic === true) ||
      ("ignored" in part && part.ignored === true)
    )
      return false;
    if (part.type === "text") return nonEmpty(part.text) !== undefined;
    return part.type === "file" && nonEmpty(part.url) !== undefined;
  });
}

function projectMetadata(
  session: GlobalSession,
  messages: NativeMessage[],
): ExternalOpenCodeSessionMetadata {
  // Worker provenance survives rewind. Only first-user/selection fallback uses the visible range.
  const agentNames = [
    ...new Set(
      [session.agent, ...messages.map((message) => message.info.agent)].flatMap((agent) => {
        const name = nonEmpty(agent);
        return name ? [name] : [];
      }),
    ),
  ].sort();
  const visible = visibleMessages(session, messages);
  const first = visible.find(meaningfulUser);
  const latest = visible.findLast(meaningfulUser);
  const firstAgent = nonEmpty(first?.info.agent);
  return {
    sessionId: session.id,
    cwd: session.directory,
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    archivedAt: session.time.archived ?? null,
    parentId: nonEmpty(session.parentID) ?? null,
    title: nonEmpty(session.title) ?? null,
    ...selectedMetadata(session, latest?.info),
    agentNames,
    // A missing agent on the first real user turn must not be replaced by a later named turn.
    firstUserMessage: first && firstAgent ? { id: first.info.id, agent: firstAgent } : null,
  };
}

function visibleMessages(session: GlobalSession, messages: NativeMessage[]): NativeMessage[] {
  const revert = session.revert;
  if (!revert?.messageID || revert.partID) return messages;
  const boundary = messages.findIndex((message) => message.info.id === revert.messageID);
  return boundary < 0 ? messages : messages.slice(0, boundary);
}

function selectedMetadata(
  session: GlobalSession,
  latest: Extract<NativeMessage["info"], { role: "user" }> | undefined,
): Pick<ExternalOpenCodeSessionMetadata, "modeId" | "model"> {
  const modeId = nonEmpty(session.agent) ?? nonEmpty(latest?.agent);
  const providerId = nonEmpty(session.model ? session.model.providerID : latest?.model?.providerID);
  const modelId = nonEmpty(session.model ? session.model.id : latest?.model?.modelID);
  return {
    ...(modeId ? { modeId } : {}),
    ...(providerId && modelId ? { model: `${providerId}/${modelId}` } : {}),
  };
}
