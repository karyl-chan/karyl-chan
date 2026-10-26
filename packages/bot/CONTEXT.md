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

**Registration Target（註冊目標）**:
一個 Command 在 Discord 註冊到哪裡：全域、指定伺服器，或每個伺服器。Behavior 的指令只選全域或指定伺服器；「每個伺服器」給 plugin 在 manifest 寫死的指令與內建指令。指令名稱在重疊的註冊目標內不能重複；全域指令與任何同名指令衝突。
_Avoid_: scope（舊欄位，只分全域 / 伺服器）

**Command Leaf（葉節點）**:
指令底下一個可呼叫的路徑（指令本身或某個子指令），綁一個動作。根葉節點與子指令不並存。
_Avoid_: subcommand behavior、子行為
_Avoid_: slash behavior 的範圍、指定使用者的指令

**Message Trigger（訊息觸發）**:
比對 bot 收得到的訊息 —— 與 bot 的私訊，或伺服器的頻道。對象篩選只在與 bot 的私訊提供。
_Avoid_: DM pattern、message_pattern（舊稱，且不只限於私訊）

**Message Trigger Location（訊息觸發位置）**:
一個 Message Trigger 設在哪裡：surface + guildId + channelId，也就是與 bot 的私訊、全部伺服器、指定伺服器或指定頻道。訊息觸發的排序以位置為單位：管理員排的是同一個位置裡的觸發，比對時所有位置仍走同一條順序。位置的 key 寫成 `bot_dm`、`guild:all`、`guild:<id>`、`channel:<guildId>:<channelId>`（與訊息觸發的 Behavior Section key 相同，但位置是寫入用的識別，分區只是呈現）。
_Avoid_: 用 section / 分區指稱排序或寫入的單位

**Audience Group（對象群組）**:
與 bot 私訊的 Message Trigger 可以只對一個群組的成員觸發。群組只是一個名字加一份名單，沒有自己的列：只有被訊息觸發引用的名字能設名單，同名的觸發共用同一份名單；最後一個引用它的觸發改掉對象或被刪除時，名單一起清掉。
_Avoid_: 用群組指稱 Discord 身分組或群組私訊

**Behavior Section（分區）**:
Admin UI 依觸發的可用情境推導出的分組：App 指令、與 bot 的私訊、伺服器。只是呈現，不儲存、不影響行為。
_Avoid_: scope tab、範圍分頁（已移除）

**App 指令**:
可用情境跨越多處，或開放使用者安裝的指令觸發所屬的分區。
_Avoid_: 用來泛稱所有 slash 指令

**Action（動作）**:
Behavior 被觸發後要做的事，由一個 Action Source 提供。

**Action Source（動作來源）**:
管理員可選的動作提供者：webhook 或 plugin。資料裡的 `builtin` 只是 System Behavior 的持久化值，不是管理員可選的動作來源。
_Avoid_: `source: custom / system`（舊稱）

**System Behavior（系統指令）**:
系統提供、固定存在的 behavior，目前只有登入；管理員只能改它的觸發方式（與 bot 私訊的訊息比對，或一個全域指令），不能新增、刪除或停用。換觸發方式時新的觸發先生效、舊的才停用，任何一步失敗都保留原本的觸發。它的動作在資料裡記為 `actionSource: builtin`，那只是持久化值，不是管理員可選的 Action Source。
_Avoid_: 內建動作（它不是可選的動作來源）、admin-login

**Behavior Reply（回覆）**:
動作的回答：`{ content?, embeds?, components?, ephemeral?, flags? }`，與 plugin `interactions.respond` 同形。webhook 的回應與內建登入動作都產生它，由 Reply Renderer 送出；`ephemeral` 決定誰看得到（指令預設只有執行的人；伺服器訊息預設公開，`true` 改私訊作者；與 bot 的私訊不受影響）。
誰看得到的順序：回應的 `ephemeral` → behavior 儲存的 Reply Visibility → 觸發本身的預設。
_Avoid_: relay、轉發內容（舊稱，只有 content / embeds）

**Reply Visibility（回覆給誰看）**:
指令葉節點與伺服器訊息觸發儲存的回覆預設：`private`（指令只有執行的人；伺服器訊息私訊作者）、`public`（貼在頻道），null 沿用觸發本身的預設。回應的 `ephemeral` 可覆蓋；與 bot 的私訊與 System Behavior 不適用。

**Reply Renderer**:
把 Behavior Reply 送到 Discord 的唯一入口，目標是一個互動（指令觸發）或一則訊息（訊息觸發）。

**Plugin Action**:
Plugin 宣告、與觸發面無關的動作，由管理員綁到觸發上。
_Avoid_: dm_behavior（已移除的前身，綁死在私訊上）
