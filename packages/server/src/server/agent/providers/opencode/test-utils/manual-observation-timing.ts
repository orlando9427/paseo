import type { OpenCodeObservationTiming } from "../event-consumer.js";

export function flushObservation(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class ManualObservationTiming implements OpenCodeObservationTiming {
  private now = 0;
  private readonly timers = new Set<{ at: number; callback: () => void }>();

  arm(delayMs: number, callback: () => void): () => void {
    const timer = { at: this.now + delayMs, callback };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const cancel = this.arm(delayMs, () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
      const onAbort = () => {
        cancel();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async advance(delayMs: number): Promise<void> {
    const target = this.now + delayMs;
    await flushObservation();
    let next = this.nextTimer(target);
    while (next) {
      this.now = next.at;
      this.timers.delete(next);
      next.callback();
      await flushObservation();
      next = this.nextTimer(target);
    }
    this.now = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  private nextTimer(target: number) {
    return [...this.timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
  }
}

export function observationDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
