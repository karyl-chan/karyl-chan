/**
 * The canonical bot↔plugin wire-contract fixtures — SINGLE SOURCE OF
 * TRUTH for every contract test on either side of the wire.
 *
 * Consumers (all import this module; none reads a file across a package
 * boundary any more):
 *   - `@karyl-chan/plugin-wire` — `tests/contract-fixtures.test.ts`
 *     binds the event list to `CANONICAL_EVENTS`.
 *   - `@karyl-chan/plugin-sdk`  — `tests/contract/sdk-contract.test.ts`
 *     asserts the SDK's consumer half (hmac, streams, events, payload
 *     types) against these literals.
 *   - `@karyl-chan/bot`         — `tests/contract-sdk-provider.test.ts`
 *     and `tests/behavior-webhook-contract.test.ts` REPLAY these
 *     literals through the bot's real Fastify routes and real dispatch
 *     services, and assert on observed HTTP behaviour.
 *
 * Why a typed TS module rather than a JSON asset (issue #29 decision 8):
 *   - plugin-wire emits `dist/*.js` with plain `tsc` and the SDK vendors
 *     that source into its published `dist` with tsup. A `.json` asset
 *     would need copy plumbing in the first pipeline and inlining in the
 *     second (plus a `.d.ts` for the bundled types); a `.ts` module is
 *     just another compiled unit in both.
 *   - Each of the four consumers used to hand-maintain its own
 *     `ContractFixtures` interface — near-copies that could silently
 *     disagree with the data they described. One exported type kills all
 *     four.
 *
 * If you change the wire contract (HMAC scheme, stream-key convention,
 * RPC paths, event names, register/dispatch envelope, dispatch payload
 * fields), update THIS file AND both sides' code; any side that
 * disagrees with these literals goes red.
 *
 * Regenerate the HMAC `expectedHex` values with:
 *   node -e "console.log(require('crypto').createHmac('sha256', SECRET).update(METHOD+':'+PATH+':'+TS+':'+NONCE+':'+BODY).digest('hex'))"
 */

/** One golden HMAC vector: inputs plus the hex both sides must produce. */
export interface HmacGoldenVector {
  name: string;
  secret: string;
  method: string;
  path: string;
  ts: string;
  body: string;
  nonce: string;
  expectedHex: string;
}

/** A plugin's private mailbox keys under the Redis-Streams transport. */
export interface StreamKeySample {
  pluginKey: string;
  streamKey: string;
  dlqKey: string;
}

/**
 * Field-level contract for one Dispatch Kind's HTTP body. `requiredFields`
 * are the top-level keys the bot MUST send as own properties — presence,
 * not truthiness, so a legitimately-null `sub_command_group` still counts
 * while a dropped one does not. `userFields` / `memberFields` do the same
 * one level down; `memberFields` is null for kinds that carry no member
 * object.
 */
export interface DispatchPayloadContract {
  /** Endpoint template the bot POSTs to (manifest-overridable). */
  endpointTemplate: string;
  requiredFields: readonly string[];
  userFields: readonly string[];
  memberFields: readonly string[] | null;
}

export interface ContractFixtures {
  readonly hmac: {
    readonly signatureHeader: string;
    readonly timestampHeader: string;
    readonly nonceHeader: string;
    readonly replayWindowSeconds: number;
    readonly payloadFormat: string;
    readonly golden: readonly HmacGoldenVector[];
  };
  readonly streams: {
    readonly streamPrefix: string;
    readonly dlqSuffix: string;
    readonly fields: readonly string[];
    readonly samples: readonly StreamKeySample[];
  };
  readonly events: {
    readonly canonical: readonly string[];
  };
  readonly dispatchEnvelope: {
    readonly httpBodyKeys: readonly string[];
    readonly payloads: {
      readonly command: DispatchPayloadContract;
      readonly autocomplete: DispatchPayloadContract;
      readonly component: DispatchPayloadContract;
      readonly modal: DispatchPayloadContract;
    };
  };
  readonly rpc: {
    readonly pathsCalledBySdk: readonly string[];
  };
  readonly register: {
    readonly endpoint: string;
    readonly setupSecretHeader: string;
    readonly requiredResponseFields: readonly string[];
    readonly optionalResponseFields: readonly string[];
    readonly heartbeatEndpoint: string;
  };
  readonly behaviorWebhook: {
    readonly endSentinel: string;
    readonly endSentinelCaseInsensitive: boolean;
    readonly request: {
      readonly topLevelKeys: readonly string[];
      readonly patternMetaKeys: readonly string[];
      readonly slashMetaKeys: readonly string[];
      readonly userKeys: readonly string[];
      readonly sessionKeys: {
        readonly inactive: readonly string[];
        readonly active: readonly string[];
      };
      readonly attachmentKeys: readonly string[];
    };
    readonly response: {
      readonly fields: readonly string[];
      readonly embedWhitelist: readonly string[];
      readonly maxEmbeds: number;
      readonly maxFields: number;
    };
  };
}

export const CONTRACT_FIXTURES: ContractFixtures = {
  hmac: {
    signatureHeader: "x-karyl-signature",
    timestampHeader: "x-karyl-timestamp",
    nonceHeader: "x-karyl-nonce",
    replayWindowSeconds: 300,
    payloadFormat: "<METHOD>:<path>:<ts>:<nonce>:<body>",
    golden: [
      {
        name: "command-dispatch",
        secret: "contract-secret-1",
        method: "POST",
        path: "/commands/uuid",
        ts: "1700000000",
        body: '{"command_name":"uuid"}',
        expectedHex:
          "f43255c0ed65ebee20d9019e301daa1d87d470fa8dfdbe285782390ecb80967b",
        nonce: "cafe0000000000000000000000000000",
      },
      {
        name: "events-dispatch",
        secret: "contract-secret-1",
        method: "POST",
        path: "/events",
        ts: "1700001234",
        body: '{"type":"guild.message_create","data":{"id":"1"}}',
        expectedHex:
          "6b0f37b8a3b33115492829acfaf2a254ed336def3a4ce8eb77f94e49c5ae5094",
        nonce: "cafe0000000000000000000000000001",
      },
      {
        name: "lifecycle-dispatch",
        secret: "another-secret",
        method: "POST",
        path: "/_kc/lifecycle",
        ts: "1699999999",
        body: '{"type":"plugin.guild.enabled"}',
        expectedHex:
          "09b3799ca1d41f14c97ae40701fa0becb90f5264f6f4a4068d3273cd645ca553",
        nonce: "cafe0000000000000000000000000002",
      },
      {
        name: "empty-body-get",
        secret: "another-secret",
        method: "GET",
        path: "/health",
        ts: "1699999999",
        body: "",
        expectedHex:
          "429e2465eb3eec41087ad807fdb0068a7e5a02c96b2e9014e4bdd480e8f6dc3f",
        nonce: "cafe0000000000000000000000000003",
      },
    ],
  },

  streams: {
    streamPrefix: "karyl:plugin:",
    dlqSuffix: ":dlq",
    fields: ["type", "data", "trace", "traceparent"],
    samples: [
      {
        pluginKey: "karyl-radio",
        streamKey: "karyl:plugin:karyl-radio:events",
        dlqKey: "karyl:plugin:karyl-radio:events:dlq",
      },
      {
        pluginKey: "my-plugin",
        streamKey: "karyl:plugin:my-plugin:events",
        dlqKey: "karyl:plugin:my-plugin:events:dlq",
      },
      {
        pluginKey: "a",
        streamKey: "karyl:plugin:a:events",
        dlqKey: "karyl:plugin:a:events:dlq",
      },
    ],
  },

  /**
   * Canonical Discord-side event type names the bot dispatches as the
   * `type` field. Must equal `CANONICAL_EVENTS` — `tests/contract-fixtures.test.ts`
   * asserts the two as values, so this list can't drift from the ledger.
   */
  events: {
    canonical: [
      "guild.message_create",
      "guild.message_update",
      "guild.message_delete",
      "guild.message_create_self",
      "guild.message_create_self_ephemeral",
      "dm.message_create",
      "guild.message_reaction_add",
      "guild.message_reaction_remove",
      "guild.voice_state_update",
    ],
  },

  /**
   * What the bot actually POSTs to a plugin.
   *
   * `httpBodyKeys` is the event/lifecycle envelope (also the field
   * layout of the Redis-Streams transport): both carry `{ type, data }`.
   *
   * `payloads` is the interaction half — the four Dispatch Kinds whose
   * bodies the SDK types as `InteractionPayload` / `AutocompletePayload`
   * / `ComponentPayload` / `ModalPayload`. These lists exist because
   * `sub_command_group` and `member.permissions` once dropped off the
   * wire without a single test noticing: the bot's contract test replays
   * a real interaction through the real dispatch service and asserts
   * every name below is an own key of the POSTed JSON.
   */
  dispatchEnvelope: {
    httpBodyKeys: ["type", "data"],
    payloads: {
      command: {
        endpointTemplate: "/commands/{command_name}",
        requiredFields: [
          "interaction_id",
          "interaction_token",
          "application_id",
          "command_name",
          "sub_command_name",
          "sub_command_group",
          "options",
          "guild_id",
          "channel_id",
          "user",
          "member",
          "locale",
          "guild_locale",
        ],
        userFields: ["id", "username", "global_name"],
        // The command path also puts a `voice_channel_id` on `member`,
        // but no SDK type declares it and no context surfaces it, so it
        // is an undeclared extra rather than part of the contract. Only
        // the component payload's copy is contractual (below).
        memberFields: ["permissions", "capabilities"],
      },
      autocomplete: {
        endpointTemplate: "/commands/{command_name}/autocomplete",
        requiredFields: [
          "interaction_id",
          "command_name",
          "sub_command_name",
          "sub_command_group",
          "options",
          "focused",
          "guild_id",
          "user",
          "locale",
          "guild_locale",
        ],
        // Autocomplete must answer inside Discord's 3s budget, so the
        // bot deliberately sends only the invoker id — no capability
        // resolution, no member lookup.
        userFields: ["id"],
        memberFields: null,
      },
      component: {
        endpointTemplate: "/components",
        requiredFields: [
          "interaction_id",
          "interaction_token",
          "application_id",
          "custom_id",
          "component_type",
          "selected_values",
          "guild_id",
          "channel_id",
          "message_id",
          "user",
          "member",
          "locale",
          "guild_locale",
        ],
        userFields: ["id", "username", "global_name"],
        memberFields: ["permissions", "voice_channel_id", "capabilities"],
      },
      modal: {
        endpointTemplate: "/modals/{modal_id}",
        requiredFields: [
          "interaction_id",
          "interaction_token",
          "application_id",
          "custom_id",
          "guild_id",
          "channel_id",
          "user",
          "member",
          "components",
          "locale",
          "guild_locale",
        ],
        userFields: ["id", "username", "global_name"],
        memberFields: ["permissions", "capabilities"],
      },
    },
  },

  /**
   * Every RPC path the SDK's typed facade (`rpc/*.ts`) calls. The bot
   * MUST serve each one (`registerPluginRpcRoutes` + `voice-rpc`);
   * drift = a plugin call that 404s. The `botRpc` escape hatch can
   * reach paths not listed here.
   */
  rpc: {
    pathsCalledBySdk: [
      "/api/plugin/messages.send",
      "/api/plugin/messages.edit",
      "/api/plugin/messages.delete",
      "/api/plugin/messages.add_reaction",
      "/api/plugin/members.get",
      "/api/plugin/interactions.respond",
      "/api/plugin/interactions.followup",
      "/api/plugin/interactions.send_modal",
      "/api/plugin/storage.kv_get",
      "/api/plugin/storage.kv_set",
      "/api/plugin/storage.kv_delete",
      "/api/plugin/storage.kv_increment",
      "/api/plugin/storage.kv_list",
      "/api/plugin/storage.kv_list_values",
      "/api/plugin/me/enabled_guilds",
      "/api/plugin/me/kv_usage",
      "/api/plugin/auth.session",
      "/api/plugin/voice.join",
      "/api/plugin/voice.leave",
      "/api/plugin/voice.play",
      "/api/plugin/voice.pause",
      "/api/plugin/voice.stop",
      "/api/plugin/voice.status",
    ],
  },

  /**
   * `POST /api/plugins/register` — the response fields the SDK client
   * consumes (`client.ts`). `token` is required; the rest are optional
   * to the SDK but the bot currently sends them. The bot's contract test
   * asserts the observed response body carries every required field and
   * introduces no key outside required ∪ optional, so a new response
   * field has to be declared here before it can ship.
   */
  register: {
    endpoint: "/api/plugins/register",
    setupSecretHeader: "X-Plugin-Setup-Secret",
    requiredResponseFields: ["token"],
    optionalResponseFields: [
      "plugin",
      "dispatchHmacKey",
      "sessionVerifyPublicKey",
      "publicBaseUrl",
      "heartbeat",
      "commandSync",
    ],
    heartbeatEndpoint: "/api/plugins/heartbeat",
  },

  /**
   * BH-2.3 — the behavior custom-webhook contract. The bot-side test
   * (`behavior-webhook-contract.test.ts`) locks payload/response shape
   * against these; external webhook authors can read this block as the
   * canonical schema.
   */
  behaviorWebhook: {
    endSentinel: "[BEHAVIOR:END]",
    endSentinelCaseInsensitive: true,
    request: {
      topLevelKeys: ["content", "username", "avatar_url", "_meta"],
      patternMetaKeys: [
        "user",
        "message_id",
        "channel_id",
        "guild_id",
        "behavior_id",
        "session",
        "attachments",
      ],
      slashMetaKeys: [
        "interaction_id",
        "application_id",
        "command_name",
        "guild_id",
        "channel_id",
        "user",
        "locale",
        "options",
        "behavior_id",
      ],
      userKeys: ["id", "username", "global_name", "discriminator", "avatar"],
      sessionKeys: {
        inactive: ["active"],
        active: ["active", "started_at"],
      },
      attachmentKeys: ["url", "filename", "content_type", "size"],
    },
    response: {
      fields: ["content", "embeds"],
      embedWhitelist: [
        "title",
        "description",
        "url",
        "color",
        "timestamp",
        "footer",
        "image",
        "thumbnail",
        "author",
        "fields",
      ],
      maxEmbeds: 10,
      maxFields: 25,
    },
  },
};
