import { semaphoreQueueDepth, semaphoreInFlight } from "./metrics.ts";

export type QueryPriority = "high" | "low";

type QueuedResolve = () => void;

/**
 * Priority-aware semaphore.
 * - Two FIFO queues: "high" (user messages) and "low" (heartbeats/scheduled).
 * - When a slot opens, oldest "high" is dequeued first, then oldest "low".
 * - Release hands the slot directly to the next waiter (no decrement/increment
 *   round-trip), so the in-flight gauge stays accurate and there's no lost wakeup.
 */
export function createSemaphore(max: number) {
  let active = 0;
  const highQueue: QueuedResolve[] = [];
  const lowQueue: QueuedResolve[] = [];

  function updateDepthGauges(): void {
    semaphoreQueueDepth.set(highQueue.length, { priority: "high" });
    semaphoreQueueDepth.set(lowQueue.length, { priority: "low" });
    semaphoreInFlight.set(active);
  }

  function acquire(priority: QueryPriority): Promise<void> {
    if (active < max) {
      active++;
      updateDepthGauges();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      if (priority === "high") {
        highQueue.push(resolve);
      } else {
        lowQueue.push(resolve);
      }
      updateDepthGauges();
    });
  }

  function release(): void {
    // Drain high before low.
    const next = highQueue.shift() ?? lowQueue.shift();
    if (next) {
      // Slot handed off — in-flight count stays the same.
      next();
    } else {
      active--;
    }
    updateDepthGauges();
  }

  // Initialise gauges at zero.
  updateDepthGauges();

  return { acquire, release };
}
