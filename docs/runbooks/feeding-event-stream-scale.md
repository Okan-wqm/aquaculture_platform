# Runbook — Feeding event stream capacity & dead-letter operations

**Scope:** the 12 feeding subjects added by the protocol-feeding v2 programme, the
shared `AQUACULTURE_EVENTS` JetStream stream that carries them, and the
`event_dlq` shelves that catch what the stream gives up on.

**Closes:** `docs/reviews/claude/2026-07-27-feeding-v2-post-merge-audit.md#FARM-LOW-287`
(the subjects shipped without anyone sizing their retention or consumer load)
and documents the operational half of
`#FARM-MEDIUM-260` (the dead-letter shelf).

---

## 1. What is on the stream

Every event subject on the platform lands in ONE stream —
`getStreamConfig()` in `platform/libs/event-bus/src/nats/nats-event-bus.ts`
declares `subjects: ['events.>', 'commands.>', 'queries.>']`. There is no
per-domain stream today, so the feeding subjects share the global budget:

| Setting | Value | Where |
|---|---|---|
| `max_age` | 7 days | `getStreamConfig()` |
| `max_bytes` | 1.5 GB | `getStreamConfig()` (must stay < `max_file_store` 2 GB) |
| `max_msgs` | 1,000,000 | `getStreamConfig()` |
| `max_msg_size` | 1 MB | `getStreamConfig()` |
| `discard` | `old` | `getStreamConfig()` |
| `duplicate_window` | 2 min | `getStreamConfig()` |
| `num_replicas` | `NATS_STREAM_REPLICAS`, clamped to what the server can host | `resolveEffectiveReplicas()` |

`discard: old` is the fact that matters for capacity: when the stream fills, the
OLDEST messages are dropped, silently, regardless of whether a consumer has
acked them. Durability against that is owned by the transactional outbox +
event-store, not by JetStream — but a consumer that is down long enough for its
backlog to age out will simply never see those events.

### The 12 feeding subjects

Published by `farm_service` (`infrastructure/nats/services.yaml`):

| Subject | Producer cadence | Per-tenant volume/day |
|---|---|---|
| `MealWindowUpcoming` | 15-min cron, batched | ≤ 96 (500 meal entries per event; a 1000-unit tenant's shared 08:00 meal fits in ~2) |
| `MealFed` | per pour | ≈ units × meals/day (1000 units × 4 = 4,000) |
| `MealSkipped` | per skip | exceptional |
| `MealUnderfed` | per finalize + 20:00 day sweep | exceptional |
| `MealMissed` | 05:30 sweep | exceptional |
| `FeedTypeTransitioned` | per band crossing | ≈ units / band-days |
| `UnfedUnitDetected` | 06:00 generation | ≤ unplanned units |
| `FeedingDailySummary` | 20:00, one per tenant per local day | 1 |
| `FeedStockoutForecast` | 07:00 coverage sweep | ≤ feeds |
| `FeedTransitionUpcoming` | 07:00 coverage sweep | ≤ units |
| `FeedingProtocolAssigned` / `…AssignmentPaused` | operator action | low |
| `FCRAlert` | 18:00 sweep | ≤ batches over threshold |

Published by `sensor_service`:

| Subject | Producer cadence | Per-tenant volume/day |
|---|---|---|
| `FeedingWindowReadiness` | per NON-ready unit, per 15-min tick | ≤ guarded units × 96 (worst case) |

**Dominant term: `MealFed`.** Everything else is either batched, exceptional, or
bounded by the number of feeds/units. Sizing the feeding load therefore means
sizing pours.

### Capacity arithmetic

A `MealFed` event serialises to roughly 600 bytes (base event + 9 payload
fields). At 4 meals/day across 1,000 units:

```text
4,000 msgs/day × 600 B         ≈ 2.4 MB/day/tenant
7-day retention                ≈ 17 MB/tenant
```

Against the 1.5 GB / 1M-message budget:

```text
1.5 GB  ÷ 17 MB/tenant   ≈ 88 tenants at this size (byte ceiling)
1M msgs ÷ 28k msgs/tenant ≈ 35 tenants at this size (message ceiling)
```

**The message ceiling binds first.** ~35 large tenants (1,000 units, 4 meals) or
proportionally more small ones — and that budget is SHARED with every other
domain on the platform, so treat these numbers as an upper bound, not a target.

### Watch this number

`max_msgs` utilisation is the leading indicator. Alert at 70 %:

```bash
nats stream info AQUACULTURE_EVENTS --json | jq '.state.messages, .config.max_msgs'
```

**When utilisation passes 70 %,** do NOT raise `max_msgs` first — that trades a
visible limit for an invisible one against `max_bytes`. In order of preference:

1. **Split the stream.** Give `events.*.Meal*` its own stream with a shorter
   `max_age` (24 h is ample: every one-shot meal signal is consumed within
   seconds, and replay past a day is an incident-forensics need served by the
   event-store). This is the intended first move and requires no contract change
   — only a new stream whose subject filter is narrower than `events.>`, plus
   removing that filter from the global stream.
2. **Shorten global `max_age`** from 7 days if event-store coverage makes the
   longer window redundant.
3. **Raise `max_bytes`** only after raising `max_file_store` in `nats.conf`,
   keeping the 25 % headroom the current values encode (1.5 GB of 2 GB).

## 2. Consumers

Consumer names are `aquaculture-<SERVICE_NAME>-events--<EventType>` (see
`generateConsumerName`). They are durable and stable across restarts, and scaled
replicas of the same service SHARE one durable — messages load-balance, they do
not duplicate.

| Setting | Value |
|---|---|
| `ack_policy` | explicit |
| `ack_wait` | 30 s (`SubscriptionOptions.ackWait`) |
| `max_deliver` | 3 (`SubscriptionOptions.maxRetries`) |
| backoff | NAK with `min(1000 × 2^deliveryCount, 30_000)` ms |

`ack_wait: 30s` is the one to watch on the feeding consumers: alert-engine's
handlers write an `AlertHistory` row AND an incident inside the ack window. If
`num_pending` climbs on `…-events--MealFed` while the service is healthy, the
handler is slower than 30 s and the message is being redelivered under the
service's own feet.

```bash
nats consumer info AQUACULTURE_EVENTS aquaculture-alert-engine-events--MealMissed --json \
  | jq '.num_pending, .num_redelivered, .num_ack_pending'
```

`num_redelivered` climbing with `num_pending` flat = handler failing, not
handler slow. Go to §3.

## 3. Dead-letter shelf

Once `max_deliver` is exhausted for a ONE-SHOT event
(`FARM_SIGNAL_DELIVERY_SEMANTICS` in `libs/event-contracts`), the bus writes
the message to the consuming service's `event_dlq` table and only then calls
`msg.term()`.

If the shelf write fails, the message is NAK'd instead. Be clear about what
that does and does not buy: past `max_deliver` JetStream will not redeliver
either way, so the NAK is not a save. It is the refusal to take the
irreversible action (`term()` can never be undone) on the strength of a write
nobody confirmed — and it leaves the consumer's `num_redelivered` /
`num_ack_pending` climbing, which is the signal §4 alerts on. **A service
consuming a one-shot event without `DeadLetterModule` registered loses those
messages outright** — the bus logs it at error level naming the missing module.

Shelves: `farm.event_dlq`, `alert.event_dlq`, `notification.event_dlq`.

**Triage:**

```sql
SELECT "eventType", count(*), max("failedAt")
  FROM alert.event_dlq
 WHERE "failedAt" > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 2 DESC;
```

```sql
-- One row in full, including the original payload and the terminal error.
SELECT "id", "source", "tenantId", "eventType", "error", "retryCount",
       "metadata"->>'subject' AS subject, "payload"
  FROM alert.event_dlq
 WHERE "id" = :id;
```

**Replay:** the `payload` column is the exact decoded event. Republish it with
`nats pub` on the subject recorded in `metadata->>'subject'`; consumers are
idempotent (incident dedup is `(ruleId, tenantId)`; the in-app digest is guarded
by its delivery-id unique index), so a replayed message converges rather than
duplicating. Delete the row after a confirmed replay — the shelf is a work
queue, not an archive; the event-store holds the permanent record.

**A non-empty shelf is always a defect**, not a routine state. The event got
three chances against a live database. Read `error` before replaying: replaying
into an unfixed handler just refills the shelf.

## 4. Alerting

| Signal | Threshold | Meaning |
|---|---|---|
| `stream.state.messages / max_msgs` | > 0.70 | Capacity — go to §1 |
| `consumer.num_pending` on any feeding consumer | > 1000 sustained 10 min | Consumer stalled or too slow |
| `consumer.num_redelivered` delta | > 0 sustained | Handler failing; DLQ rows imminent |
| `count(event_dlq WHERE failedAt > now() - 1h)` | > 0 | Permanent loss averted — triage now |

## 5. Related

- `docs/runbooks/farm-outbox-dlq-replay.md` — the OUTBOUND half (publish-side failures)
- `docs/runbooks/nats-service-addition.md` — adding a subject + cert CN (ADR-015)
- `libs/event-contracts/src/event-delivery-semantics.ts` — which events must never be swallowed
