import type { BehaviorCommandOption, BehaviorPatch, CommandLeafView } from '../../../api/behavior';
import type { DraftModel } from './draft-rebase';
import { NEW_WEBHOOK, savedWebhookBody, webhookBody, webhookDraftOf, type WebhookDraft } from './webhook-draft';

/**
 * The edit draft of a Command Leaf (board 5 「子指令」): its subcommand
 * name and Discord description (subcommands only — the root leaf is the
 * command itself), its title and admin note, its options, and its
 * webhook action. A leaf never changes its place in the tree here: the
 * root leaf stays the root (convert-to-subcommands is the one way out).
 */
export type OptionType = BehaviorCommandOption['type'];

export interface OptionDraft {
    type: OptionType;
    name: string;
    description: string;
    required: boolean;
}

export interface LeafDraft extends WebhookDraft {
    /** '' = the root leaf. */
    subcommand: string;
    /** Discord's description of a subcommand; '' = the title stands in. */
    leafDescription: string;
    title: string;
    /** Admin note, never sent to Discord. */
    description: string;
    options: OptionDraft[];
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
        ...webhookDraftOf(leaf.webhook),
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
        ...NEW_WEBHOOK,
    };
}

export function emptyOption(): OptionDraft {
    return { type: 'string', name: '', description: '', required: false };
}

export interface LeafBody {
    subcommand: string;
    title: string;
    description: string;
    leafDescription: string | null;
    options: BehaviorCommandOption[];
    webhook: { url: string; authMode: 'token' | 'hmac' | null };
}

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
        webhook: webhookBody(d),
    };
}

function savedBody(leaf: CommandLeafView): LeafBody {
    return {
        subcommand: leaf.subcommand,
        title: leaf.title,
        description: leaf.description,
        leafDescription: leaf.leafDescription,
        options: leaf.options,
        webhook: savedWebhookBody(leaf.webhook),
    };
}

/**
 * The PATCH (PATCH /api/behaviors/:id) for saving `draft` over the saved
 * leaf: the changed fields, the whole webhook when it changed, and the
 * version the edit is based on. The root leaf sends neither a path nor a
 * subcommand description. Null when the draft changes nothing.
 */
export function leafPatch(saved: CommandLeafView, draft: LeafDraft): BehaviorPatch | null {
    const before = savedBody(saved);
    const after = leafBody(draft);
    const keys: Array<keyof LeafBody> =
        saved.subcommand === ''
            ? ['title', 'description', 'options', 'webhook']
            : ['subcommand', 'leafDescription', 'title', 'description', 'options', 'webhook'];
    const patch: Record<string, unknown> = {};
    for (const key of keys) {
        if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) patch[key] = after[key];
    }
    if (Object.keys(patch).length === 0) return null;
    return { ...(patch as BehaviorPatch), ifUpdatedAt: saved.updatedAt };
}

export const leafDraftModel: DraftModel<CommandLeafView, LeafDraft> = {
    draftOf: draftFromLeaf,
    patchOf: leafPatch,
};
