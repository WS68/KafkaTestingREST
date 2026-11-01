import type { Clock, ScheduledTask } from '../../src/application/ports/clock.js';

interface ManualTask {
  readonly dueAt: number;
  readonly order: number;
  readonly task: () => void;
  cancelled: boolean;
  completed: boolean;
}

/** Часы для синхронного управления виртуальным временем в тестах. */
export class ManualClock implements Clock {
  private time: number;
  private nextOrder = 0;
  private readonly tasks: ManualTask[] = [];

  constructor(initialTime = 0) {
    this.time = initialTime;
  }

  now(): number {
    return this.time;
  }

  schedule(delayMs: number, task: () => void): ScheduledTask {
    const entry: ManualTask = {
      dueAt: this.time + Math.max(0, delayMs),
      order: this.nextOrder,
      task,
      cancelled: false,
      completed: false,
    };
    this.nextOrder += 1;
    this.tasks.push(entry);

    return {
      get active(): boolean {
        return !entry.cancelled && !entry.completed;
      },
      cancel(): void {
        entry.cancelled = true;
      },
    };
  }

  advance(ms: number): void {
    const targetTime = this.time + Math.max(0, ms);

    while (true) {
      const nextTask = this.tasks
        .filter((entry) => !entry.cancelled && !entry.completed && entry.dueAt <= targetTime)
        .sort((left, right) => left.dueAt - right.dueAt || left.order - right.order)[0];

      if (nextTask === undefined) {
        break;
      }

      this.time = nextTask.dueAt;
      nextTask.completed = true;
      nextTask.task();
    }

    this.time = targetTime;
  }

  pendingCount(): number {
    return this.tasks.filter((entry) => !entry.cancelled && !entry.completed).length;
  }

  /** Продвигает часы до последнего срока активной задачи. */
  runAll(): void {
    while (true) {
      const lastDueAt = this.tasks
        .filter((entry) => !entry.cancelled && !entry.completed)
        .reduce<number | undefined>(
          (latest, entry) => (latest === undefined ? entry.dueAt : Math.max(latest, entry.dueAt)),
          undefined,
        );

      if (lastDueAt === undefined) {
        return;
      }

      this.advance(Math.max(0, lastDueAt - this.time));
    }
  }
}
