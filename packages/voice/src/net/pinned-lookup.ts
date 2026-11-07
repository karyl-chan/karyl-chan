/**
 * pinned-lookup — 讓連線只連到「host policy 檢查過的那些 IP」。
 *
 * host policy 先解析一次 DNS 並判斷每個答案；若之後由連線端自己再解析
 * 一次，惡意 DNS 可以在兩次之間換答案（DNS rebinding）把請求導去內網。
 * 這裡的 `lookup` 只回傳檢查過的位址，所以不會有第二次解析。連線的
 * hostname 不變 —— Host header、TLS SNI 與憑證驗證仍以原本的主機名稱
 * 進行。Shared by the bot (undici Agent, RCON socket) and the voice
 * media proxy.
 */

import type { LookupFunction } from "node:net";

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * A `net.connect`-compatible lookup that ignores the hostname and answers
 * with the pinned addresses. Node asks with `all: true` when
 * autoSelectFamily (happy eyeballs) is on — the default — and gets every
 * checked address, so a dual-stack target still falls back from an
 * unroutable AAAA to its A record; otherwise it gets the first one.
 */
export function pinnedLookup(pinned: readonly PinnedAddress[]): LookupFunction {
  const [first] = pinned;
  if (!first) throw new Error("pinnedLookup needs at least one address");
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (options?.all) {
      callback(
        null,
        pinned.map(({ address, family }) => ({ address, family })),
      );
    } else {
      callback(null, first.address, first.family);
    }
  }) as LookupFunction;
}
