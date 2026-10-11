import { nextFire, parseCron } from "./claude/cron.ts";
import type { ScheduleChange, ScheduledTask } from "./claude/scheduledTasks.ts";
import { orderedWriter, readJsonOr } from "./jsonFile.ts";

// Claude Code lets a recurring task run for a week, firing one last time when the week is up.
const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
// A fire this late is still sent; one later than this fell due while nothing was running, and Claude Code catches none of those up either.
const LATE_ALLOWANCE_MS = 2 * 60 * 1000;

interface StoredTask extends ScheduledTask {
  nextAt: string | null;
}

export interface DueTask {
  sessionId: string;
  task: ScheduledTask;
}

function nextAtFor(cron: string, after: Date): string | null {
  const schedule = parseCron(cron);
  return schedule ? (nextFire(schedule, after)?.toISOString() ?? null) : null;
}

// The tasks each conversation's own scheduler holds, so the bridge can send their prompts when they fall due, as an open terminal session would.
export class ScheduleStore {
  private tasks: Record<string, StoredTask[]> = {};
  private readonly filePath: string;
  private readonly write: (value: unknown) => Promise<void>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.write = orderedWriter(filePath);
  }

  // Lost, the tasks are lost the way a closed terminal loses them; asking for them again brings them back, so nothing here stops a start.
  async load(now: Date = new Date()): Promise<void> {
    const parsed = await readJsonOr<unknown>(this.filePath, () => ({}));
    this.tasks =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, StoredTask[]>) : {};
    for (const sessionId of Object.keys(this.tasks)) this.tasks[sessionId] = this.withoutMissed(this.tasks[sessionId] ?? [], now);
    await this.save();
  }

  of(sessionId: string): ScheduledTask[] {
    return (this.tasks[sessionId] ?? []).map(({ nextAt: _nextAt, ...task }) => task);
  }

  async apply(sessionId: string, changes: ScheduleChange[], now: Date = new Date()): Promise<void> {
    if (changes.length === 0) return;
    let held = this.tasks[sessionId] ?? [];
    for (const change of changes) {
      if (change.kind === "created") {
        held = [
          ...held.filter((task) => task.id !== change.task.id),
          { ...change.task, nextAt: nextAtFor(change.task.cron, now) },
        ];
      } else if (change.kind === "deleted") {
        held = held.filter((task) => task.id !== change.id);
      } else {
        held = change.tasks.map((listed) => {
          const known = held.find((task) => task.id === listed.id);
          return known
            ? { ...known, ...listed }
            : { ...listed, createdAt: now.toISOString(), nextAt: nextAtFor(listed.cron, now) };
        });
      }
    }
    this.set(sessionId, held);
    await this.save();
  }

  due(now: Date = new Date()): DueTask[] {
    const due: DueTask[] = [];
    for (const [sessionId, held] of Object.entries(this.tasks)) {
      for (const { nextAt, ...task } of held) {
        if (nextAt !== null && Date.parse(nextAt) <= now.getTime()) due.push({ sessionId, task });
      }
    }
    return due;
  }

  // A one-shot is spent once sent; a recurring task moves on to its next time, unless its week is up.
  async fired(sessionId: string, taskId: string, now: Date = new Date()): Promise<void> {
    const held = this.tasks[sessionId] ?? [];
    const next = held.flatMap((task) => {
      if (task.id !== taskId) return [task];
      if (!task.recurring || now.getTime() - Date.parse(task.createdAt) >= RECURRING_LIFETIME_MS) return [];
      return [{ ...task, nextAt: nextAtFor(task.cron, now) }];
    });
    this.set(sessionId, next);
    await this.save();
  }

  // The conversation is gone or started over, and its scheduler with it.
  async forget(sessionId: string): Promise<void> {
    if (!(sessionId in this.tasks)) return;
    delete this.tasks[sessionId];
    await this.save();
  }

  private withoutMissed(held: StoredTask[], now: Date): StoredTask[] {
    const cutoff = now.getTime() - LATE_ALLOWANCE_MS;
    return held.flatMap((task) => {
      if (task.nextAt === null || Date.parse(task.nextAt) >= cutoff) return [task];
      if (!task.recurring || now.getTime() - Date.parse(task.createdAt) >= RECURRING_LIFETIME_MS) return [];
      return [{ ...task, nextAt: nextAtFor(task.cron, now) }];
    });
  }

  private set(sessionId: string, held: StoredTask[]): void {
    if (held.length === 0) delete this.tasks[sessionId];
    else this.tasks[sessionId] = held;
  }

  private async save(): Promise<void> {
    await this.write(this.tasks);
  }
}
