import { parentToolUseId, type ClaudeEvent } from "./events.ts";

// A task Claude Code's own scheduler holds for a session, as its CronCreate made it.
export interface ScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: string;
}

export type ScheduleChange =
  | { kind: "created"; task: ScheduledTask }
  | { kind: "deleted"; id: string }
  // CronList answers with everything the session holds, so what it leaves out is gone.
  | { kind: "listed"; tasks: Omit<ScheduledTask, "createdAt">[] };

interface PendingCall {
  name: string;
  input: Record<string, unknown>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function listedTask(value: unknown): Omit<ScheduledTask, "createdAt"> | null {
  const job = record(value);
  if (!job || !text(job.id) || !text(job.cron)) return null;
  return { id: text(job.id), cron: text(job.cron), prompt: text(job.prompt), recurring: job.recurring === true };
}

// Reads the scheduling tools' calls and their structured answers out of a turn's stream; one reader per turn, since a call and its answer arrive in separate events.
export class ScheduleReader {
  private readonly pending = new Map<string, PendingCall>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  read(event: ClaudeEvent): ScheduleChange[] {
    // A subagent's scheduling belongs to its own short-lived session, not to the conversation.
    if (parentToolUseId(event)) return [];
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.id && /^Cron(Create|Delete|List)$/.test(block.name)) {
          this.pending.set(block.id, { name: block.name, input: record(block.input) ?? {} });
        }
      }
      return [];
    }
    if (event.type !== "user") return [];
    const answer = record((event as { tool_use_result?: unknown }).tool_use_result);
    const changes: ScheduleChange[] = [];
    for (const block of event.message.content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const call = this.pending.get(block.tool_use_id);
      this.pending.delete(block.tool_use_id);
      if (!call || !answer) continue;
      const change = this.changeFrom(call, answer);
      if (change) changes.push(change);
    }
    return changes;
  }

  private changeFrom(call: PendingCall, answer: Record<string, unknown>): ScheduleChange | null {
    if (call.name === "CronCreate") {
      const id = text(answer.id);
      const cron = text(call.input.cron);
      if (!id || !cron) return null;
      const recurring = typeof answer.recurring === "boolean" ? answer.recurring : call.input.recurring !== false;
      return {
        kind: "created",
        task: { id, cron, prompt: text(call.input.prompt), recurring, createdAt: this.now().toISOString() },
      };
    }
    if (call.name === "CronDelete") {
      const id = text(answer.id) || text(call.input.id);
      return id ? { kind: "deleted", id } : null;
    }
    if (!Array.isArray(answer.jobs)) return null;
    return { kind: "listed", tasks: answer.jobs.map(listedTask).filter((task) => task !== null) };
  }
}
