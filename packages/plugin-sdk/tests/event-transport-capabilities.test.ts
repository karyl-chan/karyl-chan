import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { detectEventTransportCapabilities } from "../src/redis-streams-client.js";

const originalEventBus = process.env.EVENT_BUS;
const originalRedisUrl = process.env.REDIS_URL;

afterEach(() => {
  if (originalEventBus === undefined) delete process.env.EVENT_BUS;
  else process.env.EVENT_BUS = originalEventBus;
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe("detectEventTransportCapabilities", () => {
  it("always advertises HTTP and explains why Streams is disabled", async () => {
    delete process.env.EVENT_BUS;
    delete process.env.REDIS_URL;

    assert.deepEqual(await detectEventTransportCapabilities(), {
      available: ["http"],
      unavailable: {
        "redis-streams": "EVENT_BUS must be set to redis-streams",
      },
    });
  });

  it("reports a missing Redis URL rather than claiming Streams support", async () => {
    process.env.EVENT_BUS = "redis-streams";
    delete process.env.REDIS_URL;

    assert.deepEqual(await detectEventTransportCapabilities(), {
      available: ["http"],
      unavailable: { "redis-streams": "REDIS_URL is not set" },
    });
  });

  it("advertises Streams only when configuration and dependency are present", async () => {
    process.env.EVENT_BUS = "redis-streams";
    process.env.REDIS_URL = "redis://redis:6379";

    assert.deepEqual(await detectEventTransportCapabilities(), {
      available: ["http", "redis-streams"],
    });
  });
});
