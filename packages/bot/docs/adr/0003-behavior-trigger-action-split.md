---
status: proposed
---

# Behavior 拆成觸發與動作；App 指令是一種觸發，不是範圍的實作手段

Behaviors 最初照早期 Discord bot 的思路設計：每個 behavior 掛在一個 scope tab 上，由 tab 決定「在哪裡、對誰」，slash 指令只是附加的觸發方式，被當成某個範圍的實作手段。但 slash 指令（Discord application command）的可見範圍由 Discord 決定，不是 bot：只能註冊為全域或指定伺服器，用 `contexts` / `integration_types` 限定使用情境；伺服器內的身分組與頻道限制由伺服器管理員在「伺服器設定 → 整合」設定，bot token 無法設定，私訊裡也沒有對應機制。結果是指定使用者、群組、頻道的 slash behavior 對所有人可見，只在執行時拒絕；訊息比對設在 `PrivateChannel` 永遠不會觸發（盤點見 #92）。我們改採 Discord 自己的分工 —— **提供者宣告能力，管理員決定在哪裡給誰用** —— 把 behavior 拆成觸發與動作兩半。

## 決定

- **Behavior 是一個觸發綁定一個動作。**
- **觸發只有兩種：**
  - **App 指令觸發**：behavior 本身註冊為一個 Discord application command。設定直接沿用 Discord 的觀念：名稱、說明、參數、註冊範圍（全域或指定伺服器）、安裝方式、使用情境、預設成員權限。誰看得到、在哪能用，交給 Discord 與伺服器管理員；karyl 不在執行時模擬可見性。
  - **訊息觸發**：只能設在 bot 收得到訊息的地方 —— 與 bot 的私訊、bot 所在伺服器的頻道。對象（使用者、群組）、位置（伺服器、頻道）與持續對話，只屬於這種觸發，由 karyl 在執行時判斷。
- **Scope tab 只是 admin UI 的分組**，不再決定 behavior 的任何欄位或行為。
- **動作有三種來源**：內建（現在的 `/login`、`/manual`、`/break`）、webhook、plugin action。三者共用同一個回覆模型。
- **Plugin action 與觸發面無關**：plugin 只宣告動作 —— 輸入、支援哪些觸發種類、每個綁定可以有的設定 —— 管理員決定把它綁到哪個觸發。
- **分兩階段做**：第一階段是觸發拆分、動作來源抽象（先做內建與 webhook）、共用回覆模型；第二階段才是 plugin action（manifest 宣告、SDK、派送、admin UI）。

## 被否決的選項

- **維持現況，指令範圍由 scope tab 推導。** Discord 無法表達大多數 tab 的範圍，只能靠執行時拒絕來模擬；管理員在後台看到的，和使用者在 Discord 實際看到的不一致。
- **在 karyl 端模擬每個使用者的可見性**（例如替特定使用者動態註冊伺服器指令）。私訊沒有伺服器指令可用，而且每個伺服器每天只能建立 200 次指令。
- **用伺服器管理員的 OAuth token 讓 karyl 代管指令權限。** 需要每個伺服器的管理員另外授權，私訊依然無效；Discord 的「伺服器設定 → 整合」已經提供同樣的能力。
- **`dm_behavior`：plugin 宣告綁在私訊上的 behavior。** 早期做過、後來移除。它把 plugin 的能力綁死在單一觸發面上，behaviors 一要擴展到私訊以外，就找不到乾淨的接法。這正是 plugin action 必須與觸發面無關的原因。

## 後果

- 既有資料要遷移。指定使用者、群組、頻道的 slash behavior 無法等價轉換，遷移時標示成「需要管理員重新決定」，不自動刪除。
- Track 3 `plugin_commands`（plugin 在 manifest 寫死註冊範圍等三個維度）和「App 指令觸發 + plugin action」的能力重疊；兩者之後的關係另外決定。
- 第二階段需要新版的 plugin 協定與 SDK，三個獨立 plugin repo 要跟著升級。
