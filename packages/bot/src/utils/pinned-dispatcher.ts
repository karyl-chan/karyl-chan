/**
 * pinned-dispatcher — 讓 outbound HTTP 連到「host policy 檢查過的那些 IP」。
 *
 * host policy 先解析一次 DNS 並判斷每個答案；若之後由 fetch 自己再解析
 * 一次，惡意 DNS 可以在兩次之間換答案（DNS rebinding）把請求導去內網。
 * 這裡的 undici Agent 用自訂 `lookup` 只回傳檢查過的位址，所以不會有
 * 第二次解析。URL 的 hostname 不變 —— Host header、TLS SNI 與憑證驗證
 * 仍以原本的主機名稱進行。
 */

import { Agent } from "undici";
import { pinnedLookup, type PinnedAddress } from "@karyl-chan/voice/net";

// The pinned lookup itself lives in @karyl-chan/voice/net (shared with the
// voice media proxy, #158); re-exported so bot imports stay put.
export { pinnedLookup, type PinnedAddress };

/**
 * A one-shot undici Agent whose every connection goes to one of `pinned`.
 * Pass it as fetch's `dispatcher`; the caller owns it and must
 * `destroy()` it once the response has been read.
 */
export function createPinnedAgent(pinned: readonly PinnedAddress[]): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(pinned) } });
}
