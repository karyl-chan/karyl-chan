/**
 * command-system/interaction-failure-reply.ts
 *
 * Something threw while handling an interaction: tell the user it failed,
 * in whatever shape the interaction's ack state still allows, so it never
 * hangs on Discord's "thinking…" until the token expires (#179).
 *
 *   - not repliable (autocomplete) / already replied → nothing; the
 *     user already saw an answer, or there is no message to show.
 *   - not acked yet → ephemeral reply.
 *   - deferReply'd → editReply the placeholder (ephemerality was locked
 *     at defer time, so no flags).
 *   - deferUpdate'd (component click, or a modal opened from one) →
 *     ephemeral followUp. editReply would overwrite the message hosting
 *     the clicked component. discord.js marks both defers `deferred`;
 *     only deferReply sets `ephemeral` (to a boolean), deferUpdate leaves
 *     it `null` — the same discriminator reply-renderer's renderFailure
 *     reads.
 *
 * Errors are swallowed: this runs in a catch, the token may be gone, and
 * the caller has already logged the original failure.
 *
 * Depends only on discord.js + i18n, so the dispatcher, the in-process
 * registry and the runtime's interactionCreate catch can all import it
 * without a cycle.
 */

import { MessageFlags, type Interaction } from "discord.js";
import { tForInteraction } from "../../i18n/index.js";

export async function replyInteractionFailure(
  interaction: Interaction,
): Promise<void> {
  if (!interaction.isRepliable() || interaction.replied) return;
  const content = tForInteraction(
    interaction,
    interaction.isModalSubmit()
      ? "common.modal-failed"
      : "common.command-failed",
  );
  try {
    if (!interaction.deferred) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } else if (interaction.ephemeral === null) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.editReply({ content });
    }
  } catch {
    // best effort — see the module comment
  }
}
