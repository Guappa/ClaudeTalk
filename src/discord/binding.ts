import type { ButtonInteraction, ChatInputCommandInteraction, Guild } from "discord.js";
import type { Bridge } from "../bridge.ts";
import type { Conversation } from "../conversations.ts";
import { respond } from "./respond.ts";

// A channel that is gone can show nothing and stop nothing, and a turn left running would go on with the run of the machine and nobody watching, so the channel takes its turn with it.
export async function channelDeleted(bridge: Bridge, channelId: string): Promise<void> {
  const conversation = bridge.store.byChannel(channelId);
  // A voice channel's deletion leaves the conversation bound through its text channel, so only the text channel's counts.
  const bound = conversation?.channels.text === channelId ? conversation : undefined;
  // A branch's channel is bound only once its first turn ends, and that turn runs in the source's lane, whose queue is not the branch's to drop.
  const branchedFrom = bridge.branchChannels.get(channelId);
  if (branchedFrom) {
    bridge.branchChannels.delete(channelId);
    bridge.flow.stopTurn(branchedFrom);
  }
  if (bound) {
    bridge.flow.stop(bound.sessionId);
    await bridge.schedules.forget(bound.sessionId);
  }
  await bridge.store.unbind(channelId);
  if (bound) console.log(`Unbound ${bound.sessionId}: its channel was deleted.`);
}

export async function requireConversation(
  bridge: Bridge,
  interaction: ChatInputCommandInteraction,
  unbound: string = bridge.language.say("binding.unbound"),
): Promise<Conversation | null> {
  const conversation = bridge.store.byChannel(interaction.channelId);
  if (conversation) return conversation;
  await respond(interaction, unbound);
  return null;
}

export async function requireGuild(
  bridge: Bridge,
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<Guild | null> {
  if (interaction.guild) return interaction.guild;
  await respond(interaction, bridge.language.say("binding.notInServer"));
  return null;
}
