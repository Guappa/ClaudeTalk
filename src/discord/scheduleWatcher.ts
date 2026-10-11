import type { Client, SendableChannels } from "discord.js";
import type { Bridge } from "../bridge.ts";
import type { Conversation } from "../conversations.ts";
import type { ScheduledTask } from "../claude/scheduledTasks.ts";
import { errorMessage, truncate } from "../text.ts";
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

// A due task's prompt goes to its conversation as a turn of its own, as a terminal kept open would run it: queued behind a turn already running, and answered in the channel.
async function sendDue(
  bridge: Bridge,
  channel: SendableChannels,
  conversation: Conversation,
  task: ScheduledTask,
): Promise<void> {
  const say = bridge.language.say;
  const announced = await channel.send({
    content: forDiscord(say("schedules.due", { id: task.id, prompt: truncate(task.prompt, SHOWN_PROMPT_CHARS) })),
    allowedMentions: NO_MENTIONS,
  });
  bridge.latestPosts.set(channel.id, announced.id);
  await runConversationTurn(bridge, conversation, {
    prompt: task.prompt,
    sink: channelSink(channel, {
      replyToMessageId: announced.id,
      notifyUserIds: whoToTell(bridge, conversation),
      latestPosts: bridge.latestPosts,
    }),
    unattended: true,
  });
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
    void sendDue(bridge, channel, conversation, task).catch((error: unknown) => {
      console.error(`Scheduled task ${task.id} of ${sessionId} could not be sent: ${errorMessage(error)}`);
    });
  }
}

export function watchSchedules(bridge: Bridge, client: Client): NodeJS.Timeout {
  // A check held up by a slow channel must not overlap the next, which would find the same task still due.
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void fireDueTasks(bridge, client)
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
