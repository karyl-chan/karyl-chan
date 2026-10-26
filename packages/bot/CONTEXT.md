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
_Avoid_: rule、自訂指令（指令只是其中一種觸發）

**Trigger（觸發）**:
啟動 behavior 的方式；只有 Command Trigger 與 Message Trigger 兩種。

**Command Trigger（指令觸發）**:
Behavior 綁在某個 Command 的一個 Command Leaf 上；誰看得到、在哪能用，由 Discord 與伺服器管理員決定，看得到就能執行。

**Command（指令）**:
Discord 註冊的單位，持有名稱與所有可見性設定，底下有一或多個 Command Leaf。
_Avoid_: 用「指令」稱呼單一子指令

**Command Leaf（葉節點）**:
指令底下一個可呼叫的路徑（指令本身或某個子指令），綁一個動作。根葉節點與子指令不並存。
_Avoid_: subcommand behavior、子行為
_Avoid_: slash behavior 的範圍、指定使用者的指令

**Message Trigger（訊息觸發）**:
比對 bot 收得到的訊息 —— 與 bot 的私訊，或伺服器的頻道。對象篩選只在與 bot 的私訊提供。
_Avoid_: DM pattern、message_pattern（舊稱，且不只限於私訊）

**Behavior Section（分區）**:
Admin UI 依觸發的可用情境推導出的分組：App 指令、與 bot 的私訊、伺服器。只是呈現，不儲存、不影響行為。
_Avoid_: scope tab、範圍分頁（已移除）

**App 指令**:
可用情境跨越多處，或開放使用者安裝的指令觸發所屬的分區。
_Avoid_: 用來泛稱所有 slash 指令

**Action（動作）**:
Behavior 被觸發後要做的事，由一個 Action Source 提供。

**Action Source（動作來源）**:
管理員可選的動作提供者：webhook 或 plugin。
_Avoid_: `source: custom / system`（舊稱）

**System Behavior（系統指令）**:
系統提供、固定存在的 behavior，目前只有登入；管理員只能改它的觸發方式，不能新增、刪除或停用。
_Avoid_: 內建動作（它不是可選的動作來源）、admin-login

**Plugin Action**:
Plugin 宣告、與觸發面無關的動作，由管理員綁到觸發上。
_Avoid_: dm_behavior（已移除的前身，綁死在私訊上）
