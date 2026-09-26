import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { OpenCodeHistorySnapshot } from "./providers/opencode/native-history.js";
import { isSystemInjectedEnvelope } from "./agent-prompt.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

function nativePresentationItem(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "user_message" || !item.clientMessageId) return item;
  // A native echo can beat local acceptance. Its first published identity must already match
  // the submitted-row contract; retain the provider identity on the internal row instead.
  return { ...item, messageId: item.clientMessageId };
}

/** Presentation identity survives native acknowledgement; content matching is not authority. */
export function reconcileNativeHistoryRows(
  snapshot: OpenCodeHistorySnapshot,
  previous: readonly AgentTimelineRow[],
): AgentTimelineRow[] {
  const presentations = previous.filter(
    (row) => row.item.type === "user_message" && row.item.clientMessageId,
  );
  const consumed = new Set<AgentTimelineRow>();
  const rows: AgentTimelineRow[] = [];
  for (const event of snapshot) {
    const item = event.item;
    if (item.type === "user_message" && isSystemInjectedEnvelope(item.text)) continue;
    const local =
      item.type === "user_message"
        ? presentations.find(
            (row) =>
              row.item.type === "user_message" &&
              ((item.clientMessageId && row.item.clientMessageId === item.clientMessageId) ||
                (item.messageId && row.providerMessageId === item.messageId)),
          )
        : undefined;
    if (local) consumed.add(local);
    const providerMessageId =
      item.type === "user_message" && (local || item.clientMessageId) ? item.messageId : undefined;
    rows.push({
      seq: rows.length + 1,
      timestamp: local?.timestamp ?? event.timestamp ?? new Date().toISOString(),
      item: limitAgentTimelineItemContent(local?.item ?? nativePresentationItem(item)),
      ...(providerMessageId ? { providerMessageId } : {}),
    });
  }
  // Only unacknowledged presentations cross a destructive native epoch boundary. A reverted
  // native row must not be resurrected from an already acknowledged local submission.
  for (const row of presentations) {
    if (!consumed.has(row) && !row.providerMessageId)
      // Build a plain AgentTimelineRow instead of spreading `row`: a retained presentation can
      // arrive as an already-projected row (seqStart/seqEnd from a prior TimelineProjection
      // pass), and makeCanonicalEntries trusts those fields verbatim once present, silently
      // ignoring the new seq assigned here and colliding with another row at the stale position.
      rows.push({
        seq: rows.length + 1,
        timestamp: row.timestamp,
        item: row.item,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        ...(row.providerMessageId ? { providerMessageId: row.providerMessageId } : {}),
      });
  }
  return rows;
}
