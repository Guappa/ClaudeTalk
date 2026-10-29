import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "./text.ts";

export interface WakeRequest {
  id: string;
  sessionId: string;
  prompt: string;
}

// What the bridge tells the script that asked; the reason, where there is one, is meant to be printed as it stands.
type WakeOutcome = "sent" | "unbound" | "refused" | "expired" | "failed" | "unreadable";
export interface WakeAnswer {
  outcome: WakeOutcome;
  reason?: string;
}

const OUTCOMES: readonly WakeOutcome[] = ["sent", "unbound", "refused", "expired", "failed", "unreadable"];
const REQUEST_SUFFIX = ".json";
const TAKEN_SUFFIX = ".taken";
const ANSWER_SUFFIX = ".answer";

// Beside the lock, where a stop request already goes, so a script finds the bridge it means from the same setting.
function wakeFolder(lockPath: string): string {
  return path.join(path.dirname(lockPath), "wake");
}

function wakePath(lockPath: string, id: string, suffix: string): string {
  return path.join(wakeFolder(lockPath), `${id}${suffix}`);
}

// Written beside and renamed over: the other side lists or polls the folder and must never read half a file.
async function writeWhole(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, target);
}

// The script stops waiting at expiresAt, so a request it was killed before withdrawing is never sent days later.
export async function requestWake(lockPath: string, sessionId: string, prompt: string, expiresAt: Date): Promise<string> {
  const id = randomUUID();
  await fs.mkdir(wakeFolder(lockPath), { recursive: true });
  await writeWhole(
    wakePath(lockPath, id, REQUEST_SUFFIX),
    JSON.stringify({ sessionId, prompt, expiresAt: expiresAt.toISOString() }),
  );
  return id;
}

function parsed(id: string, content: string): (WakeRequest & { expiresAt: number }) | null {
  try {
    const value = JSON.parse(content) as { sessionId?: unknown; prompt?: unknown; expiresAt?: unknown };
    if (typeof value.sessionId !== "string" || typeof value.prompt !== "string" || typeof value.expiresAt !== "string")
      return null;
    const expiresAt = Date.parse(value.expiresAt);
    if (!value.sessionId.trim() || !value.prompt.trim() || Number.isNaN(expiresAt)) return null;
    return { id, sessionId: value.sessionId.trim(), prompt: value.prompt, expiresAt };
  } catch {
    return null;
  }
}

async function answerFor(
  content: string,
  id: string,
  now: number,
  deliver: (request: WakeRequest) => Promise<WakeAnswer>,
): Promise<WakeAnswer> {
  const request = parsed(id, content);
  if (!request) return { outcome: "unreadable" };
  if (request.expiresAt <= now) return { outcome: "expired" };
  try {
    return await deliver({ id, sessionId: request.sessionId, prompt: request.prompt });
  } catch (error) {
    return { outcome: "failed", reason: errorMessage(error) };
  }
}

// Claimed by a rename before it is read, so a script withdrawing a request it gave up on either wins outright or finds it claimed and waits for the answer; the answer is written before the claim is removed, so whoever sees the claim gone finds the answer there.
async function takeOne(lockPath: string, id: string, deliver: (request: WakeRequest) => Promise<WakeAnswer>): Promise<void> {
  const taken = wakePath(lockPath, id, TAKEN_SUFFIX);
  try {
    await fs.rename(wakePath(lockPath, id, REQUEST_SUFFIX), taken);
  } catch {
    return;
  }
  const content = await fs.readFile(taken, "utf8").catch(() => "");
  const answer = await answerFor(content, id, Date.now(), deliver);
  await writeWhole(wakePath(lockPath, id, ANSWER_SUFFIX), answer.reason ? `${answer.outcome}\n${answer.reason}` : answer.outcome);
  await fs.rm(taken, { force: true });
}

export async function takeWakeRequests(lockPath: string, deliver: (request: WakeRequest) => Promise<WakeAnswer>): Promise<void> {
  const names = await fs.readdir(wakeFolder(lockPath)).catch(() => [] as string[]);
  const ids = names.filter((name) => name.endsWith(REQUEST_SUFFIX)).map((name) => name.slice(0, -REQUEST_SUFFIX.length));
  for (const id of ids.sort()) await takeOne(lockPath, id, deliver);
}

export async function takeWakeAnswer(lockPath: string, id: string): Promise<WakeAnswer | null> {
  const answerPath = wakePath(lockPath, id, ANSWER_SUFFIX);
  const content = await fs.readFile(answerPath, "utf8").catch(() => null);
  if (content === null) return null;
  await fs.rm(answerPath, { force: true });
  const [first = "", ...rest] = content.split("\n");
  const outcome = OUTCOMES.find((known) => known === first) ?? "unreadable";
  return rest.length > 0 ? { outcome, reason: rest.join("\n") } : { outcome };
}

// False only when the bridge has claimed the request, so its answer is coming; one that could not be removed for any other reason has expired by now and is never sent.
export async function withdrawWake(lockPath: string, id: string): Promise<boolean> {
  try {
    await fs.rm(wakePath(lockPath, id, REQUEST_SUFFIX));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
