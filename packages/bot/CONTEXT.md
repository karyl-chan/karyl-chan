# Bot / Runtime

The Discord bot host: runs the gateway connection, serves the admin UI, and operates the plugin system (registration, dispatch, feature gating, RPC).

## Language

**Feature Reach**:
Whether a plugin's declared guild feature is effectively enabled in a specific guild — the answer that gates feature-scoped event dispatch, and one of the two grounds of Guild Reach.
_Avoid_: feature gate check, guild feature check (as loose synonyms)

**Command Reach**:
Whether a plugin has a track-3 command (`plugin_commands[]`) that the reconciler has actually registered where a given guild can invoke it — the guild's own copy, or the global command with the Guild context. A track-3 command's follow-ups — its buttons, modals, and replies into the guild — follow the command, not the features (#129). Track 1 feature commands never confer it.
_Avoid_: command gate

**Guild Reach**:
Whether a plugin may serve a guild outside event delivery — component and modal dispatch, and every guild-targeted RPC: Feature Reach for any declared feature, or Command Reach. Plugin-level, because neither a `kc:` custom_id nor an RPC call carries the command it came from. The accepted cost: a plugin with both Track 1 features and a usable track-3 command is no longer fenced off by its feature toggles. Its old Track 1 buttons and its background RPC (e.g. proactive `messages.send`) reach a feature-off guild too.
_Avoid_: guild gate

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
The act of safely delivering one payload to one plugin: liveness check, the kind's reach policy (Feature Reach per scope for events, Guild Reach for components and modals, none for commands and behavior actions), signing, delivery, health recording — one shared path regardless of what triggered it.
_Avoid_: forward, post to plugin (as loose synonyms)

**Dispatch Kind**:
The variety of a Plugin Dispatch (command, autocomplete, component, modal, lifecycle, event, behavior_action). A kind determines the payload shape, the endpoint, and which reach policy applies.
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
_Avoid_: subcommand behavior、子行為、slash behavior 的範圍、指定使用者的指令

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
管理員可選的動作提供者：webhook 或 plugin。資料裡的 `builtin` 只是 System Behavior 的持久化值、`service` 是 Service Behavior 的，都不是管理員可選的動作來源。
_Avoid_: `source: custom / system`（舊稱）

**System Behavior（系統指令）**:
系統提供、固定存在的 behavior，只有登入（另一種固定列是 Service Behavior）；只能改它的觸發方式（與 bot 私訊的訊息比對，或一個全域指令），而且只有 bot owner 能改（它是 owner 進後台唯一的路）；不能新增、刪除或停用。換觸發方式時新的觸發先生效、舊的才停用，任何一步失敗都保留原本的觸發。它的動作在資料裡記為 `actionSource: builtin`，那只是持久化值，不是管理員可選的 Action Source。
_Avoid_: 內建動作（它不是可選的動作來源）、admin-login

**Service（服務）**:
透過 karyl 登入的自架服務：名稱、audience（唯一的小寫 slug，就是它收到的 Service Token 的 `aud`）與 redirect URL（https）。只有 bot owner 能在「服務」管理頁新增、修改、刪除（redirect URL 收得到登入者的 token），每個服務擁有一個 Service Behavior，同生同滅。
_Avoid_: OIDC client、SSO app（karyl 不實作 OIDC）

**Service Behavior（服務列）**:
服務擁有的固定列，與 System Behavior 並列：動作固定為以觸發者身分簽發 Service Token、私下回覆帶 token 的登入連結。能觸發的人就能登入，所以只能換觸發，而且只有 bot owner 能換：與 bot 私訊的訊息比對（預設剛好是 `!login-<audience>`，可設對象），或一個全域指令（ephemeral 回覆）；換法與登入相同，新的觸發先生效。不能停用、刪除、轉換或改動作，隨服務新增與刪除。訊息觸發排在 System Behavior 之前比對、一定收尾，因此不能蓋過登入的觸發，也不能蓋過別的服務的。資料裡記為 `actionSource: service`，不是管理員可選的 Action Source。
_Avoid_: 服務的 webhook（它不呼叫服務）

**Service Token（服務 token）**:
karyl 簽給一個 Service、證明「這個 Discord 使用者剛透過 karyl 登入」的 JWT（EdDSA）：header `typ: karyl-service+jwt` 與 `kid`；claims `sub`（Discord user id）、`name`、`avatar`、`aud`、`iss`（bot 的公開 base URL）、`jti`、`iat`、`exp`（120 秒）。服務端必須檢查 `typ`、`kid`、`aud`、`iss`、`exp`，並拒絕用過的 `jti`（karyl 不追蹤）。與後台登入 token 共用主金鑰，但靠 `typ` 與 `aud` 互不通用。
_Avoid_: login token（那是後台登入用的）

**JWKS**:
`/.well-known/jwks.json` 公開的驗證金鑰集：目前的簽章金鑰與 24 小時內輪換掉的，`kid` 是 RFC 7638 thumbprint。服務遇到不認識的 `kid` 時重新抓一次。

**Behavior Reply（回覆）**:
動作的回答：`{ content?, embeds?, components?, ephemeral?, flags? }`，與 plugin `interactions.respond` 同形。webhook 的回應與內建登入動作都產生它，由 Reply Renderer 送出；`ephemeral` 決定誰看得到（指令預設只有執行的人；伺服器訊息預設公開，`true` 改私訊作者；與 bot 的私訊不受影響）。
誰看得到的順序：回應的 `ephemeral` → behavior 儲存的 Reply Visibility → 觸發本身的預設。
`attachments: [{ name, path }]`（#156）是附加檔案：bot 從 webhook URL 的 origin 下載（同一套目標規則、pinned 連線、不跟 redirect，最多 5 個、每個 8 MiB、合計 25 MiB，全 bot 同時最多 2 批下載），拿不到就整個動作失敗（`attachment_failed`），不會只送出沒有檔案的回覆。只有附件的回覆也算有回覆。
`direct_messages`（#157）是私訊其他使用者：回覆顯示之後才送，每則各自有結果（記在 DM Log），不會讓回覆失敗。可以私訊誰由 behavior 的 DM Allowlist 決定，沒有名單時是觸發所在伺服器的成員（私訊觸發則是 bot 所在任一伺服器的成員）。
_Avoid_: relay、轉發內容（舊稱，只有 content / embeds）

**DM Allowlist（私訊白名單）**:
behavior 的回覆可以私訊的對象（#157）：使用者 id 與 behavior 群組。觸發者本人一律可以私訊；其他人：有名單就只能私訊名單上的人與群組成員；名單引用的群組算被使用中。存在 behavior_dm_allowlists。
_Avoid_: 白名單（單獨用時不清楚是哪一份）

**DM Log（私訊紀錄）**:
behavior 每一則私訊的結果（收件人、觸發者、`sent` / `not_allowed` / `rate_limited` / `attachment_failed` / `failed`、時間），保留 30 天，存在 behavior_dm_log。與 Delivery 不同，它存使用者 id；不存訊息內容。

**Reply Visibility（回覆給誰看）**:
指令葉節點與伺服器訊息觸發儲存的回覆預設：`private`（指令只有執行的人；伺服器訊息私訊作者）、`public`（貼在頻道），null 沿用觸發本身的預設。回應的 `ephemeral` 可覆蓋；與 bot 的私訊與 System Behavior 不適用。

**Delivery（投遞）**:
一次 webhook 動作的呼叫（或 Plugin Action 的派送）與它的結果：成功或失敗、HTTP 狀態、延遲、錯誤碼、簽章驗證。每個 behavior 留最近 20 筆、最多 7 天（delivery log，投遞紀錄）；不存 URL、密鑰、內容或使用者 id。測試 webhook 不算投遞；指令的 defer 被 Discord 拒絕時 webhook 沒被呼叫，仍記成一次失敗的投遞（`defer_failed`）。receiver 回 `{"defer": true}` 的投遞算成功並標為延後（deferred）；之後用 Callback Token 的呼叫失敗時，另記一筆失敗的投遞（`callback_invalid` / `callback_failed`）。回覆的附件下載失敗記成 `attachment_failed`。Plugin Action 派送成功即算成功並標為延後；plugin 無法接手（`plugin_unavailable`）或 manifest 已不再宣告該 action（`action_undeclared`）時不派送，記成失敗。
_Avoid_: 事件（那是 bot event log）、forward（只是投遞的一部分）

**Callback Token**:
bot 每次觸發簽發、只對該次觸發有效的不透明 token，15 分鐘到期，放在 webhook 請求的 `_meta.callback`（Plugin Action 的派送則是 `callback`）。receiver 拿它呼叫 `/api/plugin/interactions.respond`／`followup`／`edit_followup`／`delete_followup`，補發、修改或刪除這次的回覆；其他 `/api/plugin/*` 一律 403。它代替 Discord interaction token，後者不離開 bot。指令觸發與訊息觸發都有；訊息觸發沒有 interaction，bot 以自己送出、修改的訊息模擬回覆。
_Avoid_: interaction token（那是 Discord 的，從不交給 receiver）、plugin token

**Reply Renderer**:
把 Behavior Reply 送到 Discord 的唯一入口，目標是一個互動（指令觸發）或一則訊息（訊息觸發）。

**Plugin Action**:
Plugin 在 manifest 宣告（`behavior_actions: [{ key, name, description }]`）、與觸發面無關的動作，由管理員綁到觸發上（`actionSource: plugin`，綁定存在 behavior_plugin_actions，以 pluginKey 為鍵）。執行時以 `behavior_action` 這種 Dispatch Kind 派送給 plugin，帶該次觸發的 Callback Token，plugin 憑它回覆；綁定本身就是授權，不經過 Feature Reach 或 Guild Reach。第一版綁定沒有可設定的值。
_Avoid_: dm_behavior（已移除的前身，綁死在私訊上）、plugin 指令（那是 Track 3 `plugin_commands`，plugin 自己註冊的指令）
