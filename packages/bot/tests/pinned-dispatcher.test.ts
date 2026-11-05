import { describe, expect, it } from "vitest";
import { pinnedLookup } from "../src/utils/pinned-dispatcher.js";

type Cb = (err: Error | null, ...rest: unknown[]) => void;

function callLookup(options: { all?: boolean }): Promise<unknown[]> {
  const lookup = pinnedLookup([
    { address: "192.168.2.40", family: 4 },
    { address: "fd12::40", family: 6 },
  ]) as unknown as (
    host: string,
    opts: { all?: boolean },
    cb: Cb,
  ) => void;
  return new Promise((resolve) =>
    lookup("whatever-dns-now-says.example", options, (err, ...rest) =>
      resolve([err, ...rest]),
    ),
  );
}

describe("pinnedLookup", () => {
  it("answers with the first pinned address whatever the hostname (single form)", async () => {
    expect(await callLookup({})).toEqual([null, "192.168.2.40", 4]);
  });

  it("answers with every pinned address in the `all: true` (happy-eyeballs) form", async () => {
    expect(await callLookup({ all: true })).toEqual([
      null,
      [
        { address: "192.168.2.40", family: 4 },
        { address: "fd12::40", family: 6 },
      ],
    ]);
  });
});
