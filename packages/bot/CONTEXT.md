# Bot / Runtime

The Discord bot host: runs the gateway connection, serves the admin UI, and operates the plugin system (registration, dispatch, feature gating, RPC).

## Language

**Feature Reach**:
Whether a plugin's declared guild feature is effectively enabled in a specific guild — the answer that gates event dispatch, RPC calls, and interaction delivery.
_Avoid_: feature gate check, guild feature check (as loose synonyms)

**Precedence Tiers**:
The fixed 3-tier resolution order for Feature Reach: per-guild row → operator default → manifest default. There is exactly one implementation of this rule — `resolvePrecedenceTiers`, inside the Feature Reach module. Callers supply the tiers from whatever source suits them (cached read, fresh admin query, bulk prefetch for command registration) but never re-apply the order themselves.
_Avoid_: fallback chain, cascade

**Guild Override**:
An explicit per-guild row for a feature, placing it above both defaults in the Precedence Tiers. A feature with no Guild Override follows its resolved default.
_Avoid_: guild row (in user-facing prose), custom setting

**Operator Default**:
The "All Servers" default an operator sets for a feature, sitting between Guild Override and Manifest Default in the Precedence Tiers.
_Avoid_: global default

**Manifest Default**:
The `enabled_by_default` value a plugin's manifest declares for a feature — the bottom of the Precedence Tiers.

**Plugin Dispatch**:
The act of safely delivering one payload to one plugin: liveness check, Feature Reach, signing, delivery, health recording — one shared path regardless of what triggered it.
_Avoid_: forward, post to plugin (as loose synonyms)

**Dispatch Kind**:
The variety of a Plugin Dispatch (command, autocomplete, component, modal, lifecycle, event). A kind determines the payload shape, the endpoint, and which reach policy applies.
_Avoid_: dispatch type, channel

**Dispatch Transport**:
The channel a Plugin Dispatch travels over (direct HTTP, pooled HTTP, event bus). The transport determines which pre-delivery steps apply — e.g. SSRF preflight and signing exist only for outbound HTTP.
_Avoid_: delivery mode, backend

**Subscription Verdict**:
The bot's answer to "does this manifest subscribe to event names this build knows" — computed at register from the wire's classification, reported in the register response and on the admin health card. Host policy: what a given build knows is unanswerable from the plugin author's machine. Currently warn-only; one named constant turns it into a refusal.
_Avoid_: event validation (the wire owns whether the manifest is well-formed; this is about what this build recognizes)

**Plugin Change**:
A notification that a plugin's effective state changed (registration, enable/disable, deregistration, or a feature write for one guild). Emitted by the module that owns the mutation; caches subscribe and invalidate themselves.
_Avoid_: cache invalidation call (that's a subscriber's private reaction, not the event)

**Plugin Admin**:
The single entry point for everything an operator does *to* a plugin — enable it, approve its scopes, edit its config, delete it — reads included, so an admin route depends on one module and nothing else. Membership is decided by who initiates the action and by nothing else: operator-initiated belongs here, plugin-initiated stays with registration and heartbeat.
_Avoid_: plugin service, plugin manager (neither names an actor, so neither tells the next person what belongs inside)

**Admin Refusal**:
An expected, operator-facing outcome that Plugin Admin returns rather than throws, drawn from a closed set so the compiler forces every route to map every case. A plugin's protocol violation is not one — that is thrown, from the plugin-initiated side. Neither are auth failures or malformed requests: both resolve before an operation is reached.
_Avoid_: error, validation failure (both blur the line between an outcome to show someone and a bug to fix)

**Config Intake**:
Turning an admin config payload into validated, storage-ready values — normalize, validate, resolve the secret sentinel and encryption — before either storage model claims it. The one part the two config-write paths genuinely share; what each does afterwards is not.
_Avoid_: config validation (validation is one of its three jobs; naming it that invites a second copy of the other two)

### Behaviors

**Behavior**:
管理員設定的一個觸發綁定一個動作。
_Avoid_: rule、自訂指令（App 指令只是其中一種觸發）

**Trigger（觸發）**:
啟動 behavior 的方式；只有 App Command Trigger 與 Message Trigger 兩種。

**App Command Trigger（App 指令觸發）**:
Behavior 本身註冊成一個 Discord application command；誰看得到、在哪能用，由 Discord 與伺服器管理員決定，不由 karyl 決定。
_Avoid_: slash behavior 的範圍、指定使用者的指令

**Message Trigger（訊息觸發）**:
比對 bot 收得到的訊息 —— 與 bot 的私訊、bot 所在伺服器的頻道。對象與位置的篩選、持續對話，只屬於這種觸發。
_Avoid_: DM pattern、message_pattern（舊稱，且不只限於私訊）

**Action（動作）**:
Behavior 被觸發後要做的事，由一個 Action Source 提供。

**Action Source（動作來源）**:
動作的提供者：內建、webhook 或 plugin。
_Avoid_: `source: custom / system`（舊稱）

**Plugin Action**:
Plugin 宣告、與觸發面無關的動作，由管理員綁到觸發上。
_Avoid_: dm_behavior（已移除的前身，綁死在私訊上）

**Scope Tab（範圍分頁）**:
Admin UI 裡整理 behaviors 的分組；不決定 behavior 的任何行為。
_Avoid_: 範圍、reach（它不再是觸發範圍的來源）
