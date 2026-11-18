import type { BehaviorTargetView } from '../../../api/behavior';
import type { Translate } from './translate';

/**
 * How a Behavior Target reads on the page. Names come from what the page
 * could resolve; whatever it could not shows as its id.
 */
export interface TargetNames {
    guilds: ReadonlyMap<string, string>;
    channels: ReadonlyMap<string, string>;
    /** A user's display name, or null when it is not known. */
    user: (userId: string) => string | null;
}

export const NO_NAMES: TargetNames = { guilds: new Map(), channels: new Map(), user: () => null };

export function targetLabel(t: Translate, target: BehaviorTargetView, names: TargetNames): string {
    switch (target.kind) {
        case 'app':
            return t('behaviors.target.app');
        case 'bot_dm':
            return t('behaviors.target.botDm');
        case 'guild_all':
            return t('behaviors.target.guildAll');
        case 'guild':
            return guildName(target.guildId, names);
        case 'channel': {
            const channel = target.channelId ?? '';
            return t('behaviors.target.channelIn', {
                guild: guildName(target.guildId, names),
                channel: names.channels.get(channel) ?? channel,
            });
        }
        case 'user':
            return names.user(target.userId ?? '') ?? target.userId ?? '';
        case 'group':
            return target.groupName ?? '';
    }
}

function guildName(guildId: string | null, names: TargetNames): string {
    return names.guilds.get(guildId ?? '') ?? guildId ?? '';
}

export function targetIcon(target: BehaviorTargetView): string {
    switch (target.kind) {
        case 'app':
            return 'material-symbols:apps-rounded';
        case 'bot_dm':
            return 'material-symbols:smart-toy-outline-rounded';
        case 'guild_all':
            return 'material-symbols:dns-outline';
        case 'guild':
            return 'material-symbols:shield-outline-rounded';
        case 'channel':
            return 'material-symbols:tag-rounded';
        case 'user':
            return 'material-symbols:person-outline-rounded';
        case 'group':
            return 'material-symbols:groups-outline-rounded';
    }
}

/** What kind of target it is, in a few words — the header badge and the sidebar's second line. */
export function targetKind(t: Translate, target: BehaviorTargetView): string {
    return t(`behaviors.target.kind.${target.kind}`);
}
