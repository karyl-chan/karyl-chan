/**
 * RateLimitStoreFactory — adapter for `@fastify/rate-limit` so the
 * write / login / plugin-RPC limiters can share state across shard
 * processes.
 *
 * Today every Fastify-rate-limit rule uses the library's built-in
 * in-memory store. That's fine for one shard, broken for two — a
 * limiter that allows N writes/min counts each shard's N
 * independently, so a 2-shard deployment doubles the effective
 * limit. The Redis implementation uses the library's own
 * `redis: { client }` option; this adapter just centralises the
 * decision point so the four `@fastify/rate-limit` registrations
 * don't each have to know the connection string.
 *
 * The factory returns the *option* shape that
 * `fastify.register(rateLimit, { …, redis: <client>, … })` accepts.
 * When the factory returns `null`, the limiter falls back to the
 * library default (in-memory).
 */

export interface RateLimitStoreFactory {
  /**
   * Returns a fastify-rate-limit `redis` option (a node-redis client),
   * or `null` to use the library's in-memory default.
   *
   * Typed as `unknown` so this file doesn't pull in node-redis as a
   * dependency until the Redis adapter actually ships.
   */
  redisClient(): unknown | null;
}

export class InProcessRateLimitStoreFactory implements RateLimitStoreFactory {
  redisClient(): null {
    return null;
  }
}
