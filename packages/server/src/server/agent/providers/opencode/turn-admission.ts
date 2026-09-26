import { randomBytes } from "node:crypto";
import type { AgentTurnAdmission } from "../../agent-sdk-types.js";
import { waitForOpenCodeObservation } from "./event-consumer.js";

export class OpenCodeAdmission {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly modeId: string | undefined;
  private readonly admissionId: string | undefined;
  turnId: string | null = null;
  submissionId: string | null = null;
  submitted = false;

  constructor(
    readonly fence: AgentTurnAdmission | undefined,
    private readonly assertAdapter: () => void,
  ) {
    this.admissionId = fence?.id;
    this.modeId = fence?.modeId;
    this.signal = fence
      ? AbortSignal.any([this.controller.signal, fence.signal])
      : this.controller.signal;
  }

  assertCurrent(): void {
    this.signal.throwIfAborted();
    this.assertAdapter();
    this.assertIdentity();
    this.fence?.assertCurrent();
    // An admission callback or subscriber can synchronously revoke the adapter.
    this.signal.throwIfAborted();
    this.assertAdapter();
    this.assertIdentity();
  }

  private assertIdentity(): void {
    if (this.fence?.id !== this.admissionId)
      throw new Error("Stale OpenCode turn admission identity");
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    const value = await waitForOpenCodeObservation(operation, this.signal);
    this.assertCurrent();
    return value;
  }
}

// Native message ID layout from pinned Paseo upstream d1b705a0. The timestamp/counter prefix
// preserves OpenCode ordering; the random suffix separates adapters sharing an external server.
let lastTimestamp = -1;
let counter = 0;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function createOpenCodeDispatchMessageId(): string {
  const now = Date.now();
  if (now !== lastTimestamp) counter = 0;
  lastTimestamp = now;
  counter += 1;
  const ascending = (BigInt(now) * 0x1000n + BigInt(counter))
    .toString(16)
    .padStart(12, "0")
    .slice(-12);
  const random = Array.from(randomBytes(14), (value) => ALPHABET[value % 62]).join("");
  return `msg_${ascending}${random}`;
}
