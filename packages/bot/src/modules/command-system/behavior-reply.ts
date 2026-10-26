/**
 * command-system/behavior-reply.ts
 *
 * The one reply model every behavior action answers with (#140): a webhook
 * response, and the built-in login action, both produce a BehaviorReply and
 * hand it to the ReplyRenderer.
 *
 * The shape follows the plugin `interactions.respond` body —
 * `{ content?, embeds?, components?, ephemeral?, flags? }` — and the earlier
 * webhook response `{ content, embeds }` is a subset of it, so there is no
 * version field. A webhook response is untrusted: parseBehaviorReply copies
 * only what phase 1 allows and reports what it dropped as notes (the admin
 * test result shows them; the live path logs them).
 *
 * Phase-1 rules:
 *   - embeds: field whitelist, Discord's per-field lengths, at most 10
 *   - components: only link buttons (type 2, style 5) with an https url,
 *     in action rows (type 1); at most 5 rows of 5
 *   - flags: only SuppressEmbeds and SuppressNotifications; visibility is
 *     the `ephemeral` field, never the Ephemeral bit
 *
 * Pure: no discord.js runtime, no I/O.
 */

import type { SanitizedEmbed } from "./types.js";

// ── the model ────────────────────────────────────────────────────────────────

/** A link button: the only component a phase-1 reply may carry. */
export interface LinkButton {
  type: 2;
  style: 5;
  label: string;
  url: string;
}

export interface LinkButtonRow {
  type: 1;
  components: LinkButton[];
}

export interface BehaviorReply {
  content?: string;
  embeds?: SanitizedEmbed[];
  components?: LinkButtonRow[];
  /**
   * Who sees the reply. Unset means the target's default: a command
   * answers only the invoker, a guild message trigger answers in the
   * channel. Ignored in a DM with the bot.
   */
  ephemeral?: boolean;
  /** SuppressEmbeds (4) | SuppressNotifications (4096) only. */
  flags?: number;
}

/** What parseBehaviorReply dropped or changed, for the admin and the log. */
export type ReplyNote =
  | { kind: "invalid_field"; field: string }
  | { kind: "components_dropped"; count: number }
  | { kind: "flags_dropped"; flags: number };

export type ReplyParse =
  | { ok: true; reply: BehaviorReply; notes: ReplyNote[] }
  | { ok: false; error: string };

/** MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications */
export const ALLOWED_REPLY_FLAGS = 4 | 4096;

const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const BUTTON_LABEL_MAX = 80;
const BUTTON_URL_MAX = 512;

// ── embeds (BH-2.2A) ─────────────────────────────────────────────────────────
// Only whitelisted fields are copied, types are enforced and strings are
// cut to Discord's limits. A malformed embed is dropped on its own.

const MAX_EMBEDS = 10;
const MAX_FIELDS = 25;

function clampStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

const isHttpUrl = (u: string): boolean => /^https?:\/\//i.test(u);

function sanitizeOneEmbed(raw: unknown): SanitizedEmbed | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const out: SanitizedEmbed = {};
  const title = clampStr(e["title"], 256);
  if (title) out.title = title;
  const description = clampStr(e["description"], 4096);
  if (description) out.description = description;
  const url = clampStr(e["url"], 2048);
  if (url && isHttpUrl(url)) out.url = url;
  if (typeof e["color"] === "number" && Number.isInteger(e["color"])) {
    out.color = Math.max(0, Math.min(0xffffff, e["color"]));
  }
  const ts = clampStr(e["timestamp"], 64);
  if (ts && !Number.isNaN(new Date(ts).getTime())) out.timestamp = ts;
  const footer = e["footer"] as Record<string, unknown> | undefined;
  const footerText = footer ? clampStr(footer["text"], 2048) : undefined;
  if (footerText) {
    out.footer = { text: footerText };
    const icon = footer ? clampStr(footer["icon_url"], 2048) : undefined;
    if (icon && isHttpUrl(icon)) out.footer.icon_url = icon;
  }
  for (const key of ["image", "thumbnail"] as const) {
    const obj = e[key] as Record<string, unknown> | undefined;
    const u = obj ? clampStr(obj["url"], 2048) : undefined;
    if (u && isHttpUrl(u)) out[key] = { url: u };
  }
  const author = e["author"] as Record<string, unknown> | undefined;
  const authorName = author ? clampStr(author["name"], 256) : undefined;
  if (authorName) {
    out.author = { name: authorName };
    const aUrl = author ? clampStr(author["url"], 2048) : undefined;
    if (aUrl && isHttpUrl(aUrl)) out.author.url = aUrl;
    const aIcon = author ? clampStr(author["icon_url"], 2048) : undefined;
    if (aIcon && isHttpUrl(aIcon)) out.author.icon_url = aIcon;
  }
  if (Array.isArray(e["fields"])) {
    const fields: NonNullable<SanitizedEmbed["fields"]> = [];
    for (const f of e["fields"] as unknown[]) {
      if (typeof f !== "object" || f === null) continue;
      const fr = f as Record<string, unknown>;
      const name = clampStr(fr["name"], 256);
      const value = clampStr(fr["value"], 1024);
      if (!name || !value) continue;
      fields.push({ name, value, inline: !!fr["inline"] });
      if (fields.length >= MAX_FIELDS) break;
    }
    if (fields.length > 0) out.fields = fields;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeEmbeds(raw: unknown): SanitizedEmbed[] {
  if (!Array.isArray(raw)) return [];
  const out: SanitizedEmbed[] = [];
  for (const item of raw) {
    const e = sanitizeOneEmbed(item);
    if (e) out.push(e);
    if (out.length >= MAX_EMBEDS) break;
  }
  return out;
}

// ── components ───────────────────────────────────────────────────────────────

function linkButtonOf(raw: unknown): LinkButton | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (b["type"] !== 2 || b["style"] !== 5) return null;
  const url = b["url"];
  const label = b["label"];
  if (typeof url !== "string" || url.length > BUTTON_URL_MAX) return null;
  if (typeof label !== "string" || label.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return { type: 2, style: 5, label: label.slice(0, BUTTON_LABEL_MAX), url };
}

/** Link-button rows, and how many components (rows or buttons) were dropped. */
function sanitizeComponents(raw: unknown[]): { rows: LinkButtonRow[]; dropped: number } {
  const rows: LinkButtonRow[] = [];
  let dropped = 0;
  for (const item of raw) {
    const row = item as Record<string, unknown> | null;
    if (
      typeof row !== "object" ||
      row === null ||
      row["type"] !== 1 ||
      !Array.isArray(row["components"])
    ) {
      dropped += 1;
      continue;
    }
    const buttons: LinkButton[] = [];
    for (const c of row["components"] as unknown[]) {
      const button = linkButtonOf(c);
      if (button && buttons.length < MAX_BUTTONS_PER_ROW && rows.length < MAX_ROWS) {
        buttons.push(button);
      } else {
        dropped += 1;
      }
    }
    if (buttons.length > 0) rows.push({ type: 1, components: buttons });
  }
  return { rows, dropped };
}

// ── parse ────────────────────────────────────────────────────────────────────

/**
 * A response body (already JSON-decoded) → the reply to render. `ok: false`
 * only when the body is not an object at all; anything inside an object
 * that phase 1 can't carry is dropped with a note instead.
 */
export function parseBehaviorReply(raw: unknown): ReplyParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "response body is not a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const reply: BehaviorReply = {};
  const notes: ReplyNote[] = [];
  const invalid = (field: string) => notes.push({ kind: "invalid_field", field });

  if (body.content !== undefined && body.content !== null) {
    if (typeof body.content !== "string") invalid("content");
    else if (body.content.trim() !== "") reply.content = body.content.trim();
  }

  if (body.embeds !== undefined && body.embeds !== null) {
    if (!Array.isArray(body.embeds)) invalid("embeds");
    else {
      const embeds = sanitizeEmbeds(body.embeds);
      if (embeds.length > 0) reply.embeds = embeds;
    }
  }

  if (body.components !== undefined && body.components !== null) {
    if (!Array.isArray(body.components)) invalid("components");
    else {
      const { rows, dropped } = sanitizeComponents(body.components);
      if (rows.length > 0) reply.components = rows;
      if (dropped > 0) notes.push({ kind: "components_dropped", count: dropped });
    }
  }

  if (body.ephemeral !== undefined && body.ephemeral !== null) {
    if (typeof body.ephemeral !== "boolean") invalid("ephemeral");
    else reply.ephemeral = body.ephemeral;
  }

  if (body.flags !== undefined && body.flags !== null) {
    if (typeof body.flags !== "number" || !Number.isInteger(body.flags) || body.flags < 0) {
      invalid("flags");
    } else {
      const kept = body.flags & ALLOWED_REPLY_FLAGS;
      if (kept !== 0) reply.flags = kept;
      const droppedFlags = body.flags & ~ALLOWED_REPLY_FLAGS;
      if (droppedFlags !== 0) notes.push({ kind: "flags_dropped", flags: droppedFlags });
    }
  }

  return { ok: true, reply, notes };
}

/** Whether the reply has anything Discord would show. */
export function hasVisibleReply(reply: BehaviorReply): boolean {
  return Boolean(
    reply.content ||
      (reply.embeds && reply.embeds.length > 0) ||
      (reply.components && reply.components.length > 0),
  );
}
