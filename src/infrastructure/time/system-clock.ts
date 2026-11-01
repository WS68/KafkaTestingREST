import type { Clock, ScheduledTask } from '../../application/ports/clock.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Создаёт адаптер системных часов Node.js. */
export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    schedule(delayMs, task): ScheduledTask {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let remainingMs = Math.max(0, delayMs);
      let scheduledAt = Date.now();

      const run = (): void => {
        timer = undefined;
        if (!active) {
          return;
        }

        const currentTime = Date.now();
        remainingMs -= Math.max(0, currentTime - scheduledAt);
        if (remainingMs > 0) {
          scheduledAt = currentTime;
          timer = setTimeout(run, Math.min(remainingMs, MAX_TIMEOUT_MS));
          return;
        }

        active = false;
        task();
      };

      timer = setTimeout(run, Math.min(remainingMs, MAX_TIMEOUT_MS));

      return {
        get active(): boolean {
          return active;
        },
        cancel(): void {
          if (!active) {
            return;
          }

          active = false;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        },
      };
    },
  };
}
