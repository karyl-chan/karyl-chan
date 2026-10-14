# Event delivery and DLQ operations

The bot owns the event transport selection. During registration each plugin
replica advertises what it can actually start; the bot returns one selection.
The SDK starts only that transport and does not infer a different choice from
its environment after registration.

## Delivery guarantees

| Transport     | Configuration                                                                                                 | Guarantee                  | Failure behaviour                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| HTTP          | Bot `EVENT_BUS` unset or `http`                                                                               | At-most-once / best effort | The plugin acknowledges before running the handler. A process or handler failure after the 204 response is not retried. |
| Redis Streams | Bot and plugin `EVENT_BUS=redis-streams`; both have the same reachable `REDIS_URL`; plugin installs `ioredis` | At-least-once              | The SDK acknowledges only after the handler resolves. A crash or throw leaves the entry pending for reclaim and retry.  |

Neither transport promises exactly-once execution. Streams handlers must be
idempotent because a handler can complete immediately before an acknowledgement
is lost. Prefer a stable event identifier from the payload as an idempotency
key when the event carries one.

An event-subscribing plugin is rejected with
`409 event_transport_unavailable` when it cannot start the bot's selection.
No token is issued and the replica cannot become ready. HTTP accepts legacy
SDKs; Streams rejects them because a legacy register request cannot prove that
a consumer will start.

## Redis keys and retry policy

For plugin key `<pluginKey>`:

- Mailbox: `karyl:plugin:<pluginKey>:events`
- Consumer group: `kc-consumer:<pluginKey>`
- Dead-letter stream: `karyl:plugin:<pluginKey>:events:dlq`

The consumer reclaims entries idle for 60 seconds. A handler gets five
deliveries by default. After the fifth unsuccessful delivery, the original
fields are copied to the DLQ with `dlq_reason` and `dlq_source_id`, then the
source entry is acknowledged. Malformed entries go directly to the DLQ.

## Diagnose

Start in Admin → Plugins → the plugin detail. Confirm:

1. configured transport is `redis-streams`;
2. every live replica reports `redis-streams` and consumer `ready`;
3. no replica reports `misconfigured` or remains `initializing`.

Then inspect Redis. Replace `<pluginKey>` before running these commands:

```sh
redis-cli XINFO GROUPS karyl:plugin:<pluginKey>:events
redis-cli XPENDING karyl:plugin:<pluginKey>:events kc-consumer:<pluginKey>
redis-cli XLEN karyl:plugin:<pluginKey>:events:dlq
redis-cli XRANGE karyl:plugin:<pluginKey>:events:dlq - + COUNT 20
```

Growing lag with no ready consumer is configuration or connectivity failure.
Pending entries with increasing delivery counts normally indicate a handler
failure. DLQ entries retain `type`, `data`, trace fields, the reason, and their
original source ID.

## Replay one DLQ entry

Fix the handler first. Copy only the original event fields from `XRANGE` and
append them to the mailbox as a new entry; do not copy `dlq_reason` or
`dlq_source_id` unless you deliberately want diagnostic fields on the replay.

```sh
redis-cli XADD karyl:plugin:<pluginKey>:events '*' \
  type '<event-type>' \
  data '<json-payload>' \
  traceparent '<traceparent-if-present>'
```

Observe handler success and group lag before removing the DLQ copy:

```sh
redis-cli XDEL karyl:plugin:<pluginKey>:events:dlq '<dlq-entry-id>'
```

`XADD` creates a new stream ID, so replay is another at-least-once delivery.
Record the original DLQ ID in the incident or change log before deletion.

## Purge a DLQ

Purging is destructive. Export or record the entries, confirm the plugin key,
and obtain the operator approval required by your environment. To delete the
entire DLQ only after that review:

```sh
redis-cli DEL karyl:plugin:<pluginKey>:events:dlq
```

Never purge the mailbox stream to clear a DLQ. The mailbox contains live and
pending work owned by the consumer group.
