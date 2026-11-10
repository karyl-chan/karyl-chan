/**
 * A behavior write's action (#203): a webhook (webhook-action-input.ts)
 * or a plugin action — one of the two, never both. Every write route that
 * takes an action (a message trigger, a command's leaves, a new leaf, a
 * PATCH) goes through here, so they agree on what may be stored:
 *
 *   - create: exactly one of `webhook` / `pluginAction`;
 *   - PATCH: at most one; the other kind's row goes, and actionSource
 *     follows — converting a behavior between sources is a PATCH that
 *     names the other kind. A webhook given anew after a plugin action
 *     has no secret yet, so turning on authentication issues one.
 *
 * A plugin action must be declared by the plugin's current manifest
 * (`behavior_actions`), checked on save; the runtime checks again on
 * every run (the plugin may have dropped it since). The plugin may be
 * disabled or offline on save — that is a runtime failure, not a bad
 * binding. The installed plugins' actions come from an injected
 * PluginActionCatalog: the behavior module does not import plugin-system.
 */

import type { Transaction } from "sequelize";
import { BehaviorApiError } from "./behavior-api-error.js";
import {
  BehaviorWebhookAction,
  rowOfBehaviorWebhookAction,
} from "./models/behavior-webhook-action.model.js";
import {
  BehaviorPluginAction,
  destroyPluginActions,
} from "./models/behavior-plugin-action.model.js";
import {
  prepareWebhookWrite,
  type WebhookAuditView,
  type WebhookInput,
  type WebhookWrite,
} from "./webhook-action-input.js";

// ── installed plugins' actions ──────────────────────────────────────────────

/** One installed plugin and the behavior actions its manifest declares. */
export interface PluginBehaviorActions {
  pluginKey: string;
  pluginName: string;
  enabled: boolean;
  status: "active" | "inactive";
  actions: Array<{ key: string; name: string; description: string }>;
}

/** The installed plugins that declare behavior actions (prod: plugin-behavior-actions.ts). */
export interface PluginActionCatalog {
  list(): Promise<PluginBehaviorActions[]>;
}

// ── input ───────────────────────────────────────────────────────────────────

export interface PluginActionInput {
  pluginKey: string;
  actionKey: string;
}

/** A plugin action binding: the plugin (manifest `plugin.id`) and one of its `behavior_actions[].key`. */
export const pluginActionInputSchema = {
  type: "object",
  properties: {
    pluginKey: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" },
    // plugin-wire BEHAVIOR_ACTION_KEY_PATTERN (V-09)
    actionKey: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" },
  },
  required: ["pluginKey", "actionKey"],
  additionalProperties: false,
} as const;

/** The action half of a write body. */
export interface ActionInput {
  webhook?: WebhookInput;
  pluginAction?: PluginActionInput;
}

/** What a write stores for its action, ready to go into a transaction. */
export type ActionWrite =
  | { source: "webhook"; webhook: WebhookWrite }
  | { source: "plugin"; pluginAction: PluginActionInput };

/** Audit view of an action write (never a URL or a secret). */
export function actionAuditOf(
  write: ActionWrite,
): { webhook: WebhookAuditView } | { pluginAction: PluginActionInput } {
  return write.source === "webhook"
    ? { webhook: write.webhook.audit }
    : { pluginAction: { ...write.pluginAction } };
}

/** The plaintext secret the write generated, shown once; null otherwise. */
export function issuedSecretOf(write: ActionWrite | null): string | null {
  return write?.source === "webhook" ? write.webhook.issuedSecret : null;
}

async function checkPluginAction(
  input: PluginActionInput,
  catalog: PluginActionCatalog | undefined,
  field: string,
): Promise<void> {
  // injected (module-routes.ts): behavior does not import plugin-system
  if (!catalog) throw new Error("PluginActionCatalog not provided to behavior routes");
  const plugin = (await catalog.list()).find((p) => p.pluginKey === input.pluginKey);
  if (!plugin) {
    throw new BehaviorApiError(
      "validation_failed",
      `no installed plugin '${input.pluginKey}' declares behavior actions`,
      `${field}.pluginKey`,
    );
  }
  if (!plugin.actions.some((a) => a.key === input.actionKey)) {
    throw new BehaviorApiError(
      "validation_failed",
      `plugin '${input.pluginKey}' does not declare behavior action '${input.actionKey}'`,
      `${field}.actionKey`,
    );
  }
}

export interface ActionWriteContext {
  /** The behavior being edited; null while creating. */
  behaviorId: number | null;
  plugins: PluginActionCatalog | undefined;
  /** Field path prefix for a list item (`leaves.0`); '' for the body itself. */
  path?: string;
}

/**
 * The action a write body gives, checked: a webhook URL against the
 * forwarder's target policy, a plugin action against the plugin's
 * manifest. Null when the body gives none (a PATCH that leaves the action
 * alone); a create (`required`) without one, or any body with both, is
 * refused.
 */
export async function prepareActionWrite(
  body: ActionInput,
  ctx: ActionWriteContext,
  required: boolean,
): Promise<ActionWrite | null> {
  const at = (field: string) => (ctx.path ? `${ctx.path}.${field}` : field);
  if (body.webhook !== undefined && body.pluginAction !== undefined) {
    throw new BehaviorApiError(
      "validation_failed",
      `${at("pluginAction")}: a behavior has one action — give webhook or pluginAction, not both`,
      at("pluginAction"),
    );
  }
  if (body.pluginAction !== undefined) {
    await checkPluginAction(body.pluginAction, ctx.plugins, at("pluginAction"));
    return {
      source: "plugin",
      pluginAction: { pluginKey: body.pluginAction.pluginKey, actionKey: body.pluginAction.actionKey },
    };
  }
  if (body.webhook !== undefined) {
    const existing = ctx.behaviorId !== null ? await BehaviorWebhookAction.findByPk(ctx.behaviorId) : null;
    return {
      source: "webhook",
      webhook: await prepareWebhookWrite(
        body.webhook,
        existing ? rowOfBehaviorWebhookAction(existing) : null,
        at("webhook"),
      ),
    };
  }
  if (required) {
    throw new BehaviorApiError(
      "validation_failed",
      `${at("webhook")} is required (or ${at("pluginAction")})`,
      at("webhook"),
    );
  }
  return null;
}

/**
 * Store a prepared action for `behaviorId`: its row in, the other kind's
 * row out. The caller sets the definition's actionSource to `write.source`
 * in the same transaction.
 */
export async function storeActionWrite(
  behaviorId: number,
  write: ActionWrite,
  transaction: Transaction,
): Promise<void> {
  if (write.source === "webhook") {
    await BehaviorWebhookAction.upsert({ behaviorId, ...write.webhook.values }, { transaction });
    await destroyPluginActions(behaviorId, transaction);
  } else {
    await BehaviorPluginAction.upsert({ behaviorId, ...write.pluginAction }, { transaction });
    await BehaviorWebhookAction.destroy({ where: { behaviorId }, transaction });
  }
}
