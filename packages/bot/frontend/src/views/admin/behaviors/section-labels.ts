import type { BehaviorSection } from '../../../api/behavior';
import { parseSection } from './behavior-sections';

type Translate = (key: string, named?: Record<string, unknown>) => string;

/** Display name of a section (guild names resolve when known). */
export function sectionLabel(
    t: Translate,
    section: BehaviorSection,
    guildNames: ReadonlyMap<string, string>,
): string {
    const s = parseSection(section);
    switch (s.kind) {
        case 'app':
            return t('behaviors.sidebar.app');
        case 'bot_dm':
            return t('behaviors.sidebar.botDm');
        case 'guild_all':
            return t('behaviors.sidebar.guildAll');
        case 'guild':
            return guildNames.get(s.guildId) ?? s.guildId;
        case 'channel':
            return `#${s.channelId}`;
    }
}

export function sectionIcon(section: BehaviorSection): string {
    switch (parseSection(section).kind) {
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
    }
}

/** Short kind badge for the workspace header. */
export function sectionKind(t: Translate, section: BehaviorSection): string {
    return t(`behaviors.workspace.kind.${parseSection(section).kind}`);
}
