// Enforces a minimum spacing between calls (and an optional global pause,
// e.g. while Telegram has us in a flood-wait). Calls queue in order; each
// waiter gets the next free slot.
export class RateGate {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.nextSlot = 0;
    this.pausedUntil = 0;
  }

  pauseFor(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  isPaused() {
    return Date.now() < this.pausedUntil;
  }

  async wait() {
    // Loop because a pause can begin while a caller is already waiting for
    // its slot (another request just hit a flood-wait) — it must not then
    // fire straight into the same flood-wait.
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now);
        continue;
      }
      const slot = Math.max(now, this.nextSlot);
      this.nextSlot = slot + this.minIntervalMs;
      if (slot > now) await sleep(slot - now);
      if (Date.now() >= this.pausedUntil) return;
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
