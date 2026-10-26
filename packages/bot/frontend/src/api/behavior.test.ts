import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { clearTokens } from "../auth";
import { createMessageTrigger, deleteBehavior, reorderMessageTriggers } from "./behavior";

function mockFetch(response: Response) {
  const spy = vi.fn(async () => response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  clearTokens();
});

describe("behavior write client", () => {
  it("posts a message trigger as JSON and returns the one-time secret", async () => {
    const spy = mockFetch(json({ behavior: { id: 3 }, secret: "abc" }, 201));
    const res = await createMessageTrigger({
      title: "t",
      surface: "bot_dm",
      patternKind: "startswith",
      patternValue: "!t",
      webhook: { url: "https://x.example/h", authMode: "hmac" },
    });
    expect(res.secret).toBe("abc");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/behaviors");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ surface: "bot_dm" });
  });

  it("treats a 204 delete as success", async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(deleteBehavior(3)).resolves.toEqual({});
  });

  it("surfaces a stale reorder as an ApiError with its code and field", async () => {
    mockFetch(
      json({ error: { code: "validation_failed", message: "reload", field: "ids" } }, 409),
    );
    const err = await reorderMessageTriggers("bot_dm", [1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "validation_failed", field: "ids" });
  });
});
