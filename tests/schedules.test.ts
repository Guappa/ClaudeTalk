import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { ClaudeEvent } from "../src/claude/events.ts";
import { nextFire, parseCron } from "../src/claude/cron.ts";
import { ScheduleReader } from "../src/claude/scheduledTasks.ts";
import { ScheduleStore } from "../src/schedules.ts";
import { lockPathBeside } from "../src/instanceLock.ts";
import { requestWake, takeWakeAnswer, takeWakeRequests, withdrawWake } from "../src/wakeRequests.ts";
import { fakeChannel } from "./helpers/discord.ts";
import { OWNER, testBridge } from "./helpers/bridge.ts";
import type { MessageSink } from "../src/discord/messageSink.ts";

const ran = vi.hoisted(() => [] as Array<{ prompt: string; unattended?: boolean; sink: MessageSink }>);
vi.mock("../src/discord/turn.ts", () => ({
  runConversationTurn: async (
    _bridge: unknown,
    _conversation: unknown,
    turn: { prompt: string; unattended?: boolean; sink: MessageSink },
  ) => {
    ran.push({ prompt: turn.prompt, unattended: turn.unattended, sink: turn.sink });
    return true;
  },
}));

const { fireDueTasks, fireWakeRequests } = await import("../src/discord/scheduleWatcher.ts");

const at = (year: number, month: number, day: number, hour: number, minute: number): Date =>
  new Date(year, month - 1, day, hour, minute);
const next = (cron: string, after: Date): Date | null => nextFire(parseCron(cron)!, after);

describe("cron", () => {
  it("reads the expressions Claude Code takes, and refuses what it would not", () => {
    for (const valid of ["*/5 * * * *", "0 9 * * 1-5", "7,37 * * * *", "30 14 15 3 *", "0 0 * * 7", "1-30/10 * * * *"]) {
      expect(parseCron(valid), valid).not.toBeNull();
    }
    for (const invalid of ["61 * * * *", "* * *", "0 9 * * MON", "*/0 * * * *", "5-1 * * * *", "0 24 * * *", "* * * * * *", ""]) {
      expect(parseCron(invalid), invalid).toBeNull();
    }
  });

  it("finds the next minute the schedule names, strictly after the time given", () => {
    expect(next("*/15 * * * *", at(2026, 10, 10, 10, 7))).toEqual(at(2026, 10, 10, 10, 15));
    expect(next("*/15 * * * *", at(2026, 10, 10, 10, 15))).toEqual(at(2026, 10, 10, 10, 30));
    expect(next("48 12 11 10 *", at(2026, 10, 11, 12, 47))).toEqual(at(2026, 10, 11, 12, 48));
    expect(next("30 14 15 3 *", at(2026, 10, 11, 0, 0))).toEqual(at(2027, 3, 15, 14, 30));
  });

  it("skips a weekend for weekdays, and takes 7 for Sunday", () => {
    // 2026-10-10 is a Saturday.
    expect(next("0 9 * * 1-5", at(2026, 10, 10, 8, 0))).toEqual(at(2026, 10, 12, 9, 0));
    expect(next("0 0 * * 7", at(2026, 10, 10, 8, 0))).toEqual(at(2026, 10, 11, 0, 0));
  });

  // Vixie cron: with both day fields restricted, either one matching is enough.
  it("fires on either the day of the month or the day of the week when both are given", () => {
    // From Monday the 12th, the next Friday (16th) comes before the 20th.
    expect(next("0 0 20 * 5", at(2026, 10, 12, 1, 0))).toEqual(at(2026, 10, 16, 0, 0));
  });

  it("finds February 29th in the next leap year", () => {
    expect(next("0 12 29 2 *", at(2026, 10, 11, 0, 0))).toEqual(at(2028, 2, 29, 12, 0));
  });
});

const assistantCall = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null): ClaudeEvent =>
  ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: parent,
  }) as ClaudeEvent;

const toolAnswer = (id: string, structured: unknown): ClaudeEvent =>
  ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
    parent_tool_use_id: null,
    tool_use_result: structured,
  }) as unknown as ClaudeEvent;

describe("ScheduleReader", () => {
  const now = new Date("2026-10-11T10:00:00.000Z");

  // The shapes are the ones Claude Code answers CronCreate, CronDelete and CronList with.
  it("reads a task made, a task cancelled and a list, from the call and its structured answer", () => {
    const reader = new ScheduleReader(() => now);
    expect(
      reader.read(assistantCall("t1", "CronCreate", { cron: "*/30 * * * *", prompt: "check the deploy", recurring: true })),
    ).toEqual([]);
    expect(
      reader.read(toolAnswer("t1", { id: "1772d4f6", humanSchedule: "*/30 * * * *", recurring: true, durable: false })),
    ).toEqual([
      {
        kind: "created",
        task: { id: "1772d4f6", cron: "*/30 * * * *", prompt: "check the deploy", recurring: true, createdAt: now.toISOString() },
      },
    ]);

    reader.read(assistantCall("t2", "CronDelete", { id: "1772d4f6" }));
    expect(reader.read(toolAnswer("t2", { id: "1772d4f6" }))).toEqual([{ kind: "deleted", id: "1772d4f6" }]);

    reader.read(assistantCall("t3", "CronList", {}));
    expect(
      reader.read(toolAnswer("t3", { jobs: [{ id: "aa", cron: "0 9 * * *", prompt: "standup", recurring: true }] })),
    ).toEqual([{ kind: "listed", tasks: [{ id: "aa", cron: "0 9 * * *", prompt: "standup", recurring: true }] }]);
  });

  it("ignores a subagent's scheduling, other tools, and an answer with nothing structured in it", () => {
    const reader = new ScheduleReader(() => now);
    reader.read(assistantCall("s1", "CronCreate", { cron: "* * * * *", prompt: "x" }, "agent-call"));
    expect(reader.read(toolAnswer("s1", { id: "zz", recurring: true }))).toEqual([]);

    reader.read(assistantCall("b1", "Bash", { command: "ls" }));
    expect(reader.read(toolAnswer("b1", { stdout: "" }))).toEqual([]);

    reader.read(assistantCall("c1", "CronCreate", { cron: "* * * * *", prompt: "x" }));
    expect(reader.read(toolAnswer("c1", undefined))).toEqual([]);
  });
});

async function storeIn(): Promise<{ store: ScheduleStore; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "schedules-"));
  const file = path.join(dir, "schedules.json");
  const store = new ScheduleStore(file);
  await store.load();
  return { store, file };
}

const created = (id: string, cron: string, recurring: boolean, createdAt: Date) =>
  ({ kind: "created", task: { id, cron, prompt: `prompt ${id}`, recurring, createdAt: createdAt.toISOString() } }) as const;

describe("ScheduleStore", () => {
  it("holds a task until its time, sends a one-shot once, and moves a recurring task on", async () => {
    const { store } = await storeIn();
    const made = at(2026, 10, 11, 12, 0);
    await store.apply("s1", [created("once", "5 12 11 10 *", false, made), created("every", "*/10 * * * *", true, made)], made);

    expect(store.due(at(2026, 10, 11, 12, 4))).toEqual([]);
    expect(store.due(at(2026, 10, 11, 12, 5)).map((due) => due.task.id)).toEqual(["once"]);
    expect(
      store
        .due(at(2026, 10, 11, 12, 10))
        .map((due) => due.task.id)
        .sort(),
    ).toEqual(["every", "once"]);

    await store.fired("s1", "once", at(2026, 10, 11, 12, 10));
    await store.fired("s1", "every", at(2026, 10, 11, 12, 10));
    expect(store.of("s1").map((task) => task.id)).toEqual(["every"]);
    expect(store.due(at(2026, 10, 11, 12, 19))).toEqual([]);
    expect(store.due(at(2026, 10, 11, 12, 20)).map((due) => due.task.id)).toEqual(["every"]);
  });

  // Claude Code expires a recurring task a week after it was made, after one last fire.
  it("drops a recurring task once its week is up", async () => {
    const { store } = await storeIn();
    const made = at(2026, 10, 1, 9, 0);
    await store.apply("s1", [created("daily", "0 9 * * *", true, made)], made);
    await store.fired("s1", "daily", at(2026, 10, 8, 9, 0));
    expect(store.of("s1")).toEqual([]);
  });

  it("forgets what a cancel names and keeps a listed task's start, and a list replaces what it leaves out", async () => {
    const { store } = await storeIn();
    const made = at(2026, 10, 11, 9, 0);
    await store.apply("s1", [created("a", "0 * * * *", true, made), created("b", "0 * * * *", true, made)], made);
    await store.apply("s1", [{ kind: "deleted", id: "a" }], made);
    expect(store.of("s1").map((task) => task.id)).toEqual(["b"]);

    const later = at(2026, 10, 11, 11, 0);
    await store.apply(
      "s1",
      [
        {
          kind: "listed",
          tasks: [
            { id: "b", cron: "30 * * * *", prompt: "prompt b", recurring: true },
            { id: "c", cron: "0 * * * *", prompt: "new", recurring: false },
          ],
        },
      ],
      later,
    );
    const held = store.of("s1");
    expect(held.map((task) => task.id)).toEqual(["b", "c"]);
    expect(held[0]!.createdAt).toBe(made.toISOString());
    expect(held[0]!.cron).toBe("30 * * * *");
    expect(held[1]!.createdAt).toBe(later.toISOString());

    await store.forget("s1");
    expect(store.of("s1")).toEqual([]);
  });

  // A terminal that was closed catches nothing up, and neither does a bridge that was down.
  it("skips what fell due while the bridge was down, keeping a recurring task for its next time", async () => {
    const { store, file } = await storeIn();
    const made = at(2026, 10, 11, 8, 0);
    await store.apply("s1", [created("once", "0 9 11 10 *", false, made), created("hourly", "0 * * * *", true, made)], made);

    const reopened = new ScheduleStore(file);
    await reopened.load(at(2026, 10, 11, 10, 30));
    expect(reopened.of("s1").map((task) => task.id)).toEqual(["hourly"]);
    expect(reopened.due(at(2026, 10, 11, 10, 59))).toEqual([]);
    expect(reopened.due(at(2026, 10, 11, 11, 0)).map((due) => due.task.id)).toEqual(["hourly"]);
  });

  it("starts empty from a file that is missing or not JSON", async () => {
    const { file } = await storeIn();
    await fs.writeFile(file, "{ not json", "utf8");
    const damaged = new ScheduleStore(file);
    await damaged.load();
    expect(damaged.due(new Date(8.64e15))).toEqual([]);
  });
});

function clientWith(channels: Record<string, unknown>): Client {
  return { channels: { fetch: async (id: string) => channels[id] ?? null } } as unknown as Client;
}

describe("fireDueTasks", () => {
  it("announces a due task in its conversation's channel and sends its prompt as an unattended turn, once", async () => {
    ran.length = 0;
    const bridge = await testBridge();
    await bridge.store.bindNew({
      sessionId: "s-due",
      cwd: bridge.config.projectsRoot,
      channelId: "chan-due",
      ownerId: "100000000000000001",
    });
    const made = new Date(Date.now() - 10 * 60_000);
    await bridge.schedules.apply("s-due", [created("t-due", "* * * * *", false, made)], made);
    const fake = fakeChannel("chan-due");

    await fireDueTasks(bridge, clientWith({ "chan-due": fake.channel }));
    await fireDueTasks(bridge, clientWith({ "chan-due": fake.channel }));
    await vi.waitFor(() => expect(ran).toHaveLength(1));

    expect(fake.posted[0]).toContain("t-due");
    expect(fake.posted[0]).toContain("prompt t-due");
    expect(ran[0]).toMatchObject({ prompt: "prompt t-due", unattended: true });
    expect(bridge.schedules.of("s-due")).toEqual([]);
  });

  // A conversation bound before owners were recorded has none; its scheduled turn reaches the bridge's owners instead of mentioning nobody.
  it("mentions the bridge's owners when the conversation records no owner of its own", async () => {
    ran.length = 0;
    const bridge = await testBridge();
    await bridge.store.bindNew({ sessionId: "s-old", cwd: bridge.config.projectsRoot, channelId: "chan-old", ownerId: "" });
    const made = new Date(Date.now() - 10 * 60_000);
    await bridge.schedules.apply("s-old", [created("t-old", "* * * * *", false, made)], made);
    const fake = fakeChannel("chan-old");

    await fireDueTasks(bridge, clientWith({ "chan-old": fake.channel }));
    await vi.waitFor(() => expect(ran).toHaveLength(1));
    await ran[0]!.sink.send("the answer", { notify: true });

    expect(fake.posted.at(-1)).toBe(`<@${OWNER}> the answer`);
    expect(fake.posted.join("\n")).not.toContain("<@>");
  });

  it("forgets the tasks of a conversation that is no longer bound", async () => {
    ran.length = 0;
    const bridge = await testBridge();
    const made = new Date(Date.now() - 10 * 60_000);
    await bridge.schedules.apply("s-gone", [created("t-gone", "* * * * *", true, made)], made);

    await fireDueTasks(bridge, clientWith({}));
    expect(bridge.schedules.of("s-gone")).toEqual([]);
    expect(ran).toEqual([]);
  });
});

describe("wake requests", () => {
  const soon = (): Date => new Date(Date.now() + 60_000);
  const tempLock = async (): Promise<string> => path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wake-")), "bridge.lock");

  it("is delivered once and answered, and the answer is taken once", async () => {
    const lockPath = await tempLock();
    const id = await requestWake(lockPath, "s-1", "look at the build", soon());
    const delivered: string[] = [];
    const deliver = async (request: { prompt: string }) => {
      delivered.push(request.prompt);
      return { outcome: "sent" as const };
    };

    await takeWakeRequests(lockPath, deliver);
    await takeWakeRequests(lockPath, deliver);

    expect(delivered).toEqual(["look at the build"]);
    expect(await takeWakeAnswer(lockPath, id)).toEqual({ outcome: "sent" });
    expect(await takeWakeAnswer(lockPath, id)).toBeNull();
  });

  it("answers a request it cannot read without delivering it", async () => {
    const lockPath = await tempLock();
    const id = await requestWake(lockPath, " ", "no session named", soon());
    const deliver = vi.fn();

    await takeWakeRequests(lockPath, deliver);

    expect(deliver).not.toHaveBeenCalled();
    expect(await takeWakeAnswer(lockPath, id)).toEqual({ outcome: "unreadable" });
  });

  // A script that gave up must either take its request back or know the bridge has it, never both or neither.
  it("can be withdrawn until the bridge claims it, and not after", async () => {
    const lockPath = await tempLock();
    const withdrawn = await requestWake(lockPath, "s-1", "never mind", soon());
    expect(await withdrawWake(lockPath, withdrawn)).toBe(true);
    const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
    await takeWakeRequests(lockPath, deliver);
    expect(deliver).not.toHaveBeenCalled();

    const claimed = await requestWake(lockPath, "s-1", "too late", soon());
    let duringDelivery: boolean | null = null;
    await takeWakeRequests(lockPath, async () => {
      duringDelivery = await withdrawWake(lockPath, claimed);
      return { outcome: "sent" };
    });
    expect(duringDelivery).toBe(false);
    expect(await takeWakeAnswer(lockPath, claimed)).toEqual({ outcome: "sent" });
  });

  it("sends the prompt to the conversation holding the session as an unattended turn, announced in its channel", async () => {
    ran.length = 0;
    const bridge = await testBridge();
    await bridge.store.bindNew({
      sessionId: "s-wake",
      cwd: bridge.config.projectsRoot,
      channelId: "chan-wake",
      ownerId: "100000000000000001",
    });
    const lockPath = lockPathBeside(bridge.config.bindingsPath);
    const id = await requestWake(lockPath, "s-wake", "the checker found new work", soon());
    const fake = fakeChannel("chan-wake");

    await fireWakeRequests(bridge, clientWith({ "chan-wake": fake.channel }));
    await fireWakeRequests(bridge, clientWith({ "chan-wake": fake.channel }));
    await vi.waitFor(() => expect(ran).toHaveLength(1));

    expect(fake.posted[0]).toContain("the checker found new work");
    expect(ran[0]).toMatchObject({ prompt: "the checker found new work", unattended: true });
    expect(await takeWakeAnswer(lockPath, id)).toEqual({ outcome: "sent" });
  });

  it("answers that no conversation holds a session nobody bound, and sends nothing", async () => {
    ran.length = 0;
    const bridge = await testBridge();
    const lockPath = lockPathBeside(bridge.config.bindingsPath);
    const id = await requestWake(lockPath, "s-nobody", "anyone there?", soon());

    await fireWakeRequests(bridge, clientWith({}));

    expect(await takeWakeAnswer(lockPath, id)).toEqual({ outcome: "unbound" });
    expect(ran).toEqual([]);
  });

  // A script killed before it could withdraw leaves its request behind; it must not be sent whenever the bridge next looks.
  it("answers a request past its expiry without delivering it", async () => {
    const lockPath = await tempLock();
    const id = await requestWake(lockPath, "s-1", "stale", new Date(Date.now() - 1000));
    const deliver = vi.fn();

    await takeWakeRequests(lockPath, deliver);

    expect(deliver).not.toHaveBeenCalled();
    expect(await takeWakeAnswer(lockPath, id)).toEqual({ outcome: "expired" });
  });

  it("answers a delivery that throws, with the reason, so the script is never left waiting on a claim", async () => {
    const lockPath = await tempLock();
    const id = await requestWake(lockPath, "s-1", "boom", soon());

    await takeWakeRequests(lockPath, async () => {
      throw new Error("channel fetch timed out");
    });

    expect(await takeWakeAnswer(lockPath, id)).toEqual({ outcome: "failed", reason: "channel fetch timed out" });
  });

  it("refuses with the reason when the conversation cannot take a turn, and posts nothing", async () => {
    ran.length = 0;
    const bridge = await testBridge();
    await bridge.store.bindNew({ sessionId: "s-held", cwd: bridge.config.projectsRoot, channelId: "chan-held", ownerId: OWNER });
    vi.spyOn(bridge.flow, "available").mockReturnValue({ kind: "refused", message: "Open in a terminal on the host." });
    const lockPath = lockPathBeside(bridge.config.bindingsPath);
    const id = await requestWake(lockPath, "s-held", "go", soon());
    const fake = fakeChannel("chan-held");

    await fireWakeRequests(bridge, clientWith({ "chan-held": fake.channel }));

    expect(await takeWakeAnswer(lockPath, id)).toEqual({ outcome: "refused", reason: "Open in a terminal on the host." });
    expect(fake.posted).toEqual([]);
    expect(ran).toEqual([]);
  });
});

describe("npm run wake", () => {
  const script = path.join(import.meta.dirname, "..", "scripts", "wake.mjs");

  function runWake(bindingsPath: string, args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, ...args],
        { env: { ...process.env, BINDINGS_PATH: bindingsPath } },
        (_error, stdout, stderr) => resolve({ code: child.exitCode, output: `${stdout}${stderr}` }),
      );
      child.stdin?.end();
    });
  }

  const tempBindings = async (): Promise<string> =>
    path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wake-script-")), "conversations.json");

  it("refuses without a session id or a prompt", async () => {
    const result = await runWake(await tempBindings(), ["s-1"]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("Usage: npm run wake");
  });

  it("says no bridge is running when there is no live lock, and leaves no request behind", async () => {
    const bindingsPath = await tempBindings();
    const result = await runWake(bindingsPath, ["s-1", "hello"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("no bridge is running");
    await expect(fs.readdir(path.join(path.dirname(bindingsPath), "wake"))).rejects.toThrow();
  });

  it("exits with the code for an unbound session when the bridge answers so", async () => {
    const bindingsPath = await tempBindings();
    const lockPath = lockPathBeside(bindingsPath);
    const now = new Date().toISOString();
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: now, heartbeatAt: now }));
    const answering = setInterval(() => {
      void takeWakeRequests(lockPath, async () => ({ outcome: "unbound" }));
    }, 100);

    const result = await runWake(bindingsPath, ["s-1", "hello"]).finally(() => clearInterval(answering));

    expect(result.code).toBe(3);
    expect(result.output).toContain("no channel the bridge can reach is bound to session s-1");
  });
});
