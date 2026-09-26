import { z } from "zod";
import type { AgentSession } from "../../agent-sdk-types.js";
import { externalOpenCodeSessionKey } from "../../external-opencode-types.js";
import { toDiagnosticErrorMessage } from "../diagnostic-utils.js";

export const OpenCodeSubmissionReceiptSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    admissionId: z.string().min(1),
    endpoint: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    messageId: z.string().min(1).nullable(),
    operation: z.enum(["prompt", "command", "compact"]),
    delivery: z.enum(["in_flight", "acknowledged", "observed", "uncertain"]),
    callerInterrupted: z.boolean(),
    terminal: z.enum(["turn_completed", "turn_failed", "turn_canceled"]).optional(),
    error: z.string().optional(),
  })
  .strict();

export type OpenCodeSubmissionReceipt = z.infer<typeof OpenCodeSubmissionReceiptSchema>;
export const OPENCODE_SUBMISSION_RECEIPT_LIMIT = 128;

/** Local cancellation/transport failure is not proof that the native POST was rejected. */
export class OpenCodeSubmissionOutcomeError extends Error {
  readonly code = "OPENCODE_SUBMISSION_OUTCOME";
  readonly submission: OpenCodeSubmissionReceipt;

  constructor(error: unknown, submission: OpenCodeSubmissionReceipt) {
    const cause = error instanceof OpenCodeSubmissionOutcomeError ? error.cause : error;
    super(
      `${toDiagnosticErrorMessage(cause)}; reconcile OpenCode submission ${submission.id} before retrying (native work may continue)`,
      { cause },
    );
    this.name = "OpenCodeSubmissionOutcomeError";
    this.submission = structuredClone(submission);
  }
}

export function restoreOpenCodeSubmissions(
  value: unknown,
  endpoint: string,
  sessionId: string,
): OpenCodeSubmissionReceipt[] {
  if (value === undefined) return [];
  const receipts = z
    .array(OpenCodeSubmissionReceiptSchema)
    .max(OPENCODE_SUBMISSION_RECEIPT_LIMIT)
    .parse(value);
  const key = externalOpenCodeSessionKey(endpoint, sessionId);
  const ids = new Set<string>();
  for (const receipt of receipts) {
    if (
      externalOpenCodeSessionKey(receipt.endpoint, receipt.sessionId) !== key ||
      ids.has(receipt.id)
    ) {
      throw new Error(
        "OpenCode submission receipt has a mismatched endpoint/session or duplicate identity",
      );
    }
    if (
      receipt.terminal &&
      receipt.delivery !== "observed" &&
      !(receipt.operation === "compact" && receipt.delivery === "acknowledged")
    ) {
      throw new Error("OpenCode submission receipt lacks evidence for its terminal outcome");
    }
    ids.add(receipt.id);
    if (receipt.delivery === "in_flight") {
      receipt.delivery = "uncertain";
      receipt.error = "Adapter resumed before the native submission outcome was confirmed";
    }
  }
  return receipts;
}

/** Observation-only port. Native admission, not this receipt cache, owns execution durability. */
export interface OpenCodeSubmissionTrackingSession extends AgentSession {
  getNativeSubmissions(): OpenCodeSubmissionReceipt[];
  reconcileNativeSubmissions(): Promise<OpenCodeSubmissionReceipt[]>;
}

export function supportsOpenCodeSubmissionTracking(
  session: AgentSession,
): session is OpenCodeSubmissionTrackingSession {
  return "getNativeSubmissions" in session && "reconcileNativeSubmissions" in session;
}
