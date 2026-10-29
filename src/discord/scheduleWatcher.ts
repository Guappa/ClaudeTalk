import type { Client, SendableChannels } from "discord.js";
import type { Bridge } from "../bridge.ts";
import type { Conversation } from "../conversations.ts";
import type { ScheduledTask } from "../claude/scheduledTasks.ts";
import { lockPathBeside } from "../instanceLock.ts";
import { errorMessage, truncate } from "../text.ts";
import { type WakeAnswer, type WakeRequest, takeWakeRequests } from "../wakeRequests.ts";
import { forDiscord } from "./outgoing.ts";
import { NO_MENTIONS, channelSink } from "./sink.ts";
import { runConversationTurn } from "./turn.ts";

// Claude Code checks its schedule every second and allows one task a minute at the finest, so half a minute late is within what it promises.
const CHECK_MS = 30_000;
// The prompt is whole in the transcript; the channel needs enough of it to tell one task from another.
const SHOWN_PROMPT_CHARS = 200;

// A conversation bound before owners were recorded has none, and its scheduled turn would otherwise mention nobody and wait out every approval.
function whoToTell(bridge: Bridge, conversation: Conversation): string[] {
  return conversation.ownerId ? [conversation.ownerId] : bridge.config.ownerIds;
}

// A prompt from a schedule or a wake request goes to its conversation as a turn of its own, as a terminal kept open would run it: queued behind a turn already running, and answered in the channel.
async function sendPrompt(
  bridge: Bridge,
  channel: SendableChannels,
  conversation: Conversation,
  announcement: string,
  prompt: string,
): Promise<void> {
  const announced = await channel.send({ content: forDiscord(announcement), allowedMentions: NO_MENTIONS });
  bridge.latestPosts.set(channel.id, announced.id);
  await runConversationTurn(bridge, conversation, {
    prompt,
    sink: channelSink(channel, {
      replyToMessageId: announced.id,
      notifyUserIds: whoToTell(bridge, conversation),
      latestPosts: bridge.latestPosts,
    }),
    unattended: true,
  });
}

function announceDue(bridge: Bridge, task: ScheduledTask): string {
  return bridge.language.say("schedules.due", { id: task.id, prompt: truncate(task.prompt, SHOWN_PROMPT_CHARS) });
}

export async function fireDueTasks(bridge: Bridge, client: Client): Promise<void> {
  for (const { sessionId, task } of bridge.schedules.due()) {
    // Marked before anything is sent, so a slow channel or a long queue can never send the same fire twice.
    await bridge.schedules.fired(sessionId, task.id);
    const conversation = bridge.store.bySession(sessionId);
    if (!conversation) {
      await bridge.schedules.forget(sessionId);
      continue;
    }
    const channel = await client.channels.fetch(conversation.channels.text).catch(() => null);
    if (!channel?.isSendable()) continue;
    void sendPrompt(bridge, channel, conversation, announceDue(bridge, task), task.prompt).catch((error: unknown) => {
      console.error(`Scheduled task ${task.id} of ${sessionId} could not be sent: ${errorMessage(error)}`);
    });
  }
}

// A wake request names a session rather than a channel, since that is what a script on the host can know.
async function deliverWake(bridge: Bridge, client: Client, request: WakeRequest): Promise<WakeAnswer> {
  const conversation = bridge.store.bySession(request.sessionId);
  const channel = conversation ? await client.channels.fetch(conversation.channels.text).catch(() => null) : null;
  if (!conversation || !channel?.isSendable()) return { outcome: "unbound" };
  // Asked before anything is posted, so a conversation held elsewhere on the host is told to the script rather than left as a lone announcement.
  const check = bridge.flow.available(request.sessionId, await bridge.sessions.find(request.sessionId));
  if (check.kind !== "ok") return { outcome: "refused", reason: check.message };
  const announcement = bridge.language.say("schedules.wake", { prompt: truncate(request.prompt, SHOWN_PROMPT_CHARS) });
  void sendPrompt(bridge, channel, conversation, announcement, request.prompt).catch((error: unknown) => {
    console.error(`Wake request ${request.id} for ${request.sessionId} could not be sent: ${errorMessage(error)}`);
  });
  return { outcome: "sent" };
}

export async function fireWakeRequests(bridge: Bridge, client: Client): Promise<void> {
  await takeWakeRequests(lockPathBeside(bridge.config.bindingsPath), (request) => deliverWake(bridge, client, request));
}

export function watchSchedules(bridge: Bridge, client: Client): NodeJS.Timeout {
  // A check held up by a slow channel must not overlap the next, which would find the same task still due.
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void Promise.all([fireDueTasks(bridge, client), fireWakeRequests(bridge, client)])
      .catch((error: unknown) => {
        console.error(`Scheduled tasks could not be checked: ${errorMessage(error)}`);
      })
      .finally(() => {
        checking = false;
      });
  }, CHECK_MS);
  timer.unref();
  return timer;
}
