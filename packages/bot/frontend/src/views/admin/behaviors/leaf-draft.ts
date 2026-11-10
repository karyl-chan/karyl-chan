import type { BehaviorCommandOption, BehaviorPatch, CommandLeafView, ReplyVisibility } from '../../../api/behavior';
import type { DraftModel } from './draft-rebase';
import {
    NEW_ACTION,
    actionBody,
    actionChanged,
    actionDraftOf,
    actionPartOf,
    savedActionBody,
    type ActionBody,
    type ActionDraft,
} from './webhook-draft';

/**
 * The edit draft of a Command Leaf (board 5 「子指令」): its subcommand
 * name and Discord description (subcommands only — the root leaf is the
 * command itself), its title and admin note, its options, and its
 * action (a webhook or a plugin action). A leaf never changes its place in the tree here: the
 * root leaf stays the root (convert-to-subcommands is the one way out).
 */
export type OptionType = BehaviorCommandOption['type'];

export interface OptionDraft {
    type: OptionType;
    name: string;
    description: string;
    required: boolean;
}

export interface LeafDraft extends ActionDraft {
    /** '' = the root leaf. */
    subcommand: string;
    /** Discord's description of a subcommand; '' = the title stands in. */
    leafDescription: string;
    title: string;
    /** Admin note, never sent to Discord. */
    description: string;
    options: OptionDraft[];
    /** Who the reply is for when the response does not say; null = only the invoker. */
    replyVisibility: ReplyVisibility | null;
}

export const OPTION_TYPES: readonly OptionType[] = [
    'string',
    'integer',
    'number',
    'boolean',
    'user',
    'channel',
    'role',
    'mentionable',
    'attachment',
];

export function draftFromLeaf(leaf: CommandLeafView): LeafDraft {
    return {
        subcommand: leaf.subcommand,
        leafDescription: leaf.leafDescription ?? '',
        title: leaf.title,
        description: leaf.description,
        options: leaf.options.map((o) => ({ ...o })),
        replyVisibility: leaf.replyVisibility,
        ...actionDraftOf(leaf),
    };
}

/** A new subcommand: nothing filled in, an HMAC webhook. */
export function emptyLeafDraft(): LeafDraft {
    return {
        subcommand: '',
        leafDescription: '',
        title: '',
        description: '',
        options: [],
        replyVisibility: null,
        ...NEW_ACTION,
    };
}

export function emptyOption(): OptionDraft {
    return { type: 'string', name: '', description: '', required: false };
}

export type LeafBody = {
    subcommand: string;
    title: string;
    description: string;
    leafDescription: string | null;
    options: BehaviorCommandOption[];
    replyVisibility: ReplyVisibility | null;
} & ActionBody;

/** The request body of a leaf (POST …/leaves, or a command's `leaves[i]`). */
export function leafBody(d: LeafDraft): LeafBody {
    return {
        subcommand: d.subcommand.trim(),
        title: d.title.trim(),
        description: d.description.trim(),
        leafDescription: d.leafDescription.trim() || null,
        options: d.options.map((o) => ({
            type: o.type,
            name: o.name.trim(),
            description: o.description.trim(),
            required: o.required,
        })),
        replyVisibility: d.replyVisibility,
        ...actionBody(d),
    };
}

function savedBody(leaf: CommandLeafView): LeafBody {
    return {
        subcommand: leaf.subcommand,
        title: leaf.title,
        description: leaf.description,
        leafDescription: leaf.leafDescription,
        options: leaf.options,
        replyVisibility: leaf.replyVisibility,
        ...savedActionBody(leaf),
    };
}

/**
 * The PATCH (PATCH /api/behaviors/:id) for saving `draft` over the saved
 * leaf: the changed fields, the whole action when it changed (a change of
 * source converts the leaf, #203), and the
 * version the edit is based on. The root leaf sends neither a path nor a
 * subcommand description. Null when the draft changes nothing.
 */
export function leafPatch(saved: CommandLeafView, draft: LeafDraft): BehaviorPatch | null {
    const before = savedBody(saved);
    const after = leafBody(draft);
    const keys: Array<keyof LeafBody> =
        saved.subcommand === ''
            ? ['title', 'description', 'options', 'replyVisibility']
            : ['subcommand', 'leafDescription', 'title', 'description', 'options', 'replyVisibility'];
    const patch: Record<string, unknown> = {};
    for (const key of keys) {
        if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) patch[key] = after[key];
    }
    if (actionChanged(actionPartOf(after), actionPartOf(before))) Object.assign(patch, actionPartOf(after));
    if (Object.keys(patch).length === 0) return null;
    return { ...(patch as BehaviorPatch), ifUpdatedAt: saved.updatedAt };
}

export const leafDraftModel: DraftModel<CommandLeafView, LeafDraft> = {
    draftOf: draftFromLeaf,
    patchOf: leafPatch,
};
