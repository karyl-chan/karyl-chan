import type { BehaviorTargetView } from '../../../api/behavior';

/**
 * What "new behavior" may create in a Behavior Target (ADR 0003: adding
 * somewhere only offers what it can hold; ADR 0004: the somewhere is a
 * target), and why the rest is not offered — reasons are i18n keys, shown
 * next to the disabled choice (board 2).
 *
 *   - App 指令: commands only — the bot cannot read messages between
 *     users or in servers it is not in.
 *   - 所有人與 bot 的私訊, 全部伺服器, one server: commands and message
 *     triggers.
 *   - one channel: message triggers only — Discord cannot limit a command
 *     to one channel.
 *   - one user / one group: message triggers only — a command has no
 *     audience: whoever sees it can run it.
 *
 * A new message trigger starts on the target itself (the dialog's target
 * select may send it elsewhere); the visibility a new command starts
 * with is command-draft.ts `newCommandVisibility`.
 */
export interface KindOption {
    possible: boolean;
    reason: string | null;
}

export interface NewBehaviorOptions {
    command: KindOption;
    message: KindOption;
}

const yes: KindOption = { possible: true, reason: null };
const no = (reason: string): KindOption => ({ possible: false, reason });

export function newBehaviorOptions(target: BehaviorTargetView): NewBehaviorOptions {
    switch (target.kind) {
        case 'app':
            return { command: yes, message: no('behaviors.add.reason.messageInApp') };
        case 'bot_dm':
        case 'guild_all':
        case 'guild':
            return { command: yes, message: yes };
        case 'channel':
            return { command: no('behaviors.add.reason.commandInChannel'), message: yes };
        case 'user':
        case 'group':
            return { command: no('behaviors.add.reason.commandNeedsEveryone'), message: yes };
    }
}
