import { text } from "node:stream/consumers";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bindingsPathFrom } from "../src/config.ts";
import { isLockHeld, lockPathBeside } from "../src/instanceLock.ts";
import { readJsonOr } from "../src/jsonFile.ts";
import { requestWake, takeWakeAnswer, withdrawWake } from "../src/wakeRequests.ts";

// Exit codes a calling script can branch on.
const SENT = 0;
const NOT_SENT = 1;
const USAGE = 2;
const UNBOUND = 3;
const UNKNOWN = 4;
// The bridge looks for requests every 30 seconds, so one look and a margin.
const ANSWER_MS = 45_000;
// A request the bridge has claimed is answered as soon as its channel is fetched.
const CLAIMED_MS = 15_000;
const POLL_MS = 500;

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

// Found the way the bridge finds it, from the same setting, or a BINDINGS_PATH elsewhere would have this looking in an empty folder.
const lockPath = resolve(lockPathBeside(bindingsPathFrom(process.env)));

const [rawSessionId = "", ...words] = process.argv.slice(2);
const sessionId = rawSessionId.trim();
// A prompt too long or too awkward to quote on a command line can be piped in instead.
const prompt = words.length > 0 ? words.join(" ") : process.stdin.isTTY ? "" : await text(process.stdin);
if (!sessionId || !prompt.trim()) {
  fail(
    USAGE,
    "Usage: npm run wake -- <session id> <prompt>, or pipe the prompt in: npm run wake -- <session id> < prompt.txt\n" +
      "The session id is the one in the `claude --resume <id>` line /whoami shows in the conversation's channel; the prompt is sent to it as a turn.",
  );
}

const lock = await readJsonOr(lockPath, () => ({}));
if (!isLockHeld(lock, Date.now())) {
  fail(NOT_SENT, `Not sent: no bridge is running here (no live lock at ${lockPath}). Start it, then ask again.`);
}
if (lock.draining) {
  fail(NOT_SENT, `Not sent: bridge pid ${lock.pid} is stopping and takes no new turns. Ask again once it is running.`);
}

const id = await requestWake(lockPath, sessionId, prompt, new Date(Date.now() + ANSWER_MS));

async function answerWithin(ms) {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    const answer = await takeWakeAnswer(lockPath, id);
    if (answer) return answer;
    await delay(POLL_MS);
  }
  return null;
}

let answer = await answerWithin(ANSWER_MS);
if (!answer) {
  if (await withdrawWake(lockPath, id)) {
    fail(
      NOT_SENT,
      `Not sent: bridge pid ${lock.pid} did not take the request within ${ANSWER_MS / 1000} seconds, and it is withdrawn. ` +
        "It may be running a version that predates wake requests (restart it onto this one), or be stuck: check data/bridge.log.",
    );
  }
  answer = await answerWithin(CLAIMED_MS);
}

switch (answer?.outcome) {
  case "sent":
    console.log(`Sent to ${sessionId}. The turn runs in its channel, behind any turn already running there.`);
    process.exit(SENT);
    break;
  case "unbound":
    fail(
      UNBOUND,
      `Not sent: no channel the bridge can reach is bound to session ${sessionId}. Check the id against /whoami in the channel, or bind the session with /resume first.`,
    );
    break;
  case "refused":
    fail(NOT_SENT, `Not sent: the conversation cannot take a turn now.\n${answer.reason ?? ""}`);
    break;
  case "failed":
    fail(
      NOT_SENT,
      `Not sent: the bridge could not start the turn: ${answer.reason ?? "no reason given"}. Check data/bridge.log, then ask again.`,
    );
    break;
  case "expired":
  case "unreadable":
    fail(NOT_SENT, "Not sent: the bridge could not use the request. Ask again; if it keeps happening, check data/bridge.log.");
    break;
  default:
    fail(
      UNKNOWN,
      `Bridge pid ${lock.pid} took the request but did not say within ${CLAIMED_MS / 1000} more seconds whether it sent it. ` +
        "It may still run: look in the conversation's channel before asking again, and check data/bridge.log.",
    );
}
