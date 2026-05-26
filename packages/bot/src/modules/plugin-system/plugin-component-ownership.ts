/**
 * Plugin component / modal ownership guard.
 *
 * Every Discord component the plugin asks the bot to forward — buttons,
 * select menus, modals, text inputs — carries a `custom_id`. The bot's
 * inbound modal/component dispatchers route an interaction back to a
 * plugin purely on that string's `kc:<pluginKey>:` prefix. Without this
 * gate, plugin A could send a message containing a button with
 * `custom_id="kc:plugin-b:adminAction"` and have plugin B receive the
 * click as if it had created the button itself.
 *
 * The walker recurses the standard Discord component structure (action
 * rows, v2 containers, modal rows) and rejects any `custom_id` whose
 * prefix doesn't match the calling plugin's key. Link buttons (style
 * 5) have no custom_id and are skipped.
 *
 * Returns `null` on success, or a discriminated result on failure so
 * callers can render distinct error messages — the previous design
 * returned the literal sentinel string "components nested too deep"
 * as if it were the offending id, which leaked into 400 errors as
 * `component custom_id 'components nested too deep' must use …`.
 */

const KC_PREFIX_RE = /^kc:([a-z0-9][a-z0-9-]{0,63}):/;
const MAX_NESTING_DEPTH = 8;

export type OwnershipFailure =
  | { kind: "bad-id"; customId: string }
  | { kind: "too-deep" };

function checkCustomIdOwnership(
  customId: unknown,
  ownerKey: string,
): string | null {
  if (typeof customId !== "string" || customId.length === 0) return null;
  // Every plugin-supplied custom_id must be in the plugin's own
  // `kc:<ownerKey>:` namespace. Plain (non-`kc:`) strings would let a
  // plugin collide with built-in component ids; foreign-prefixed
  // strings would impersonate another plugin's dispatcher routing.
  const m = customId.match(KC_PREFIX_RE);
  if (!m || m[1] !== ownerKey) return customId;
  return null;
}

function walkComponents(
  components: unknown,
  ownerKey: string,
  depth: number,
): OwnershipFailure | null {
  if (depth > MAX_NESTING_DEPTH) return { kind: "too-deep" };
  if (!Array.isArray(components)) return null;
  for (const node of components) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const offender = checkCustomIdOwnership(n.custom_id, ownerKey);
    if (offender) return { kind: "bad-id", customId: offender };
    // Action rows (type 1) and container types (e.g. v2 containers
    // type 17) carry a nested `components` array. Recurse without
    // assuming a specific type — any object with a `components`
    // array gets walked.
    if (Array.isArray(n.components)) {
      const inner = walkComponents(n.components, ownerKey, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

export function findUnownedCustomId(
  ownerKey: string,
  components: unknown,
): OwnershipFailure | null {
  return walkComponents(components, ownerKey, 0);
}

/**
 * Modal-specific check. Only the OUTER `modal.custom_id` decides
 * routing on MODAL_SUBMIT, so that's the security-critical id. The
 * inner text-input custom_ids are just field labels Discord echoes
 * back to the plugin — they aren't used for dispatcher routing, and
 * SDK convention uses plain ids ("username", "host", …) rather than
 * the `kc:` namespace. We deliberately don't recurse here.
 */
export function findUnownedModalCustomId(
  ownerKey: string,
  modal: unknown,
): OwnershipFailure | null {
  if (!modal || typeof modal !== "object") return null;
  const m = modal as Record<string, unknown>;
  const offender = checkCustomIdOwnership(m.custom_id, ownerKey);
  return offender ? { kind: "bad-id", customId: offender } : null;
}

/**
 * Render an OwnershipFailure as a human-readable 400 error message.
 * Centralised so every RPC route uses the same wording.
 */
export function describeOwnershipFailure(
  ownerKey: string,
  failure: OwnershipFailure,
): string {
  if (failure.kind === "too-deep") {
    return `components nested too deep (max ${MAX_NESTING_DEPTH} levels)`;
  }
  return `component custom_id '${failure.customId}' must use the kc:${ownerKey}: namespace`;
}
