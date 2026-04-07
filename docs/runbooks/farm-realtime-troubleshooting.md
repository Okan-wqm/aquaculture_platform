# Farm Domain Real-Time Troubleshooting

Operational runbook for the farm real-time delivery pipeline:

```
farm-service handler → farm_outbox → OutboxWorkerService → NATS JetStream
  → FarmNatsBridgeService → FarmGateway → Socket.IO → useFarmRealtimeStream
  → React Query invalidation → UI re-render
```

If a user reports **"I recorded a mortality/cull/transfer/harvest/feeding
and the list didn't update"**, walk through the steps below in order. Each
step narrows the problem to a smaller section of the pipeline.

---

## Step 1 — Did the DB write succeed?

Query the canonical source of truth. All six user-visible operations write
a row to the `Batch` aggregate or a child table.

```sql
-- Check the batch itself
SELECT id, "currentQuantity", "cullCount", "totalMortality", status, "updatedAt"
FROM farm.batches_v2
WHERE id = '<batchId>';

-- Mortality / cull / transfer / harvest operation history
SELECT id, "operationType", quantity, "operationDate", "createdAt"
FROM farm.tank_operations
WHERE "batchId" = '<batchId>'
ORDER BY "createdAt" DESC
LIMIT 10;
```

**If the row is present with the expected change:** proceed to Step 2.

**If the row is missing:** the handler's transaction rolled back. Check
farm-service logs for the handler name (e.g. `RecordCullHandler`) around
the time of the user action. Common causes:
- Pessimistic lock timeout (another transaction held the batch)
- Validation failure (quantity > currentQuantity) — user sees an error
  toast in this case
- DB constraint violation

---

## Step 2 — Did the outbox row land?

The handler enqueues a domain event into `farm_outbox` in the same
transaction as the domain write. If Step 1 succeeded but Step 2 is empty,
the handler is bypassing the outbox (a regression).

```sql
SELECT id, "eventType", "publishedAt", "retryCount", "lastError", "createdAt"
FROM farm.farm_outbox
WHERE "payload"->>'batchId' = '<batchId>'
ORDER BY "createdAt" DESC
LIMIT 10;
```

**Expected:** a row with `eventType` matching the operation
(`CullRecorded`, `MortalityRecorded`, `BatchTransferred`,
`BatchHarvested`, `BatchCreated`, `FeedingRecorded`, etc).

**If missing:** the handler did not call `outboxPublisher.enqueue(...)`.
This is a code regression — verify the commit that added
`OutboxPublisher` injection to that handler has not been reverted.
Check `git log --oneline apps/farm-service/src/batch/handlers/` and
look for the Phase A commit.

---

## Step 3 — Is the outbox worker publishing?

The worker polls every second and publishes via `NatsEventBus` to NATS
JetStream. If a row stays with `publishedAt IS NULL`, either the worker
is not running or NATS is unreachable.

### Is the worker running?

```bash
# farm-service pod logs
kubectl logs -l app=farm-service --tail=100 | grep -i outbox
```

Expected: periodic `Outbox poll cycle` debug lines and, for each event,
`Published outbox row <id> (<eventType>) to NATS in <ms>`.

### Prometheus metrics

Scrape the `/metrics` endpoint on farm-service (or your Grafana instance):

```
outbox_pending{service="farm_outbox"} — should be near 0 under normal load
outbox_dead_letter_count{service="farm_outbox"} — MUST be 0 at steady state
outbox_publish_latency_seconds{service="farm_outbox"}[p99] — should be < 5s
outbox_publish_failures_total{service="farm_outbox"} — should not increase
```

**If `outbox_pending` is climbing:** worker is behind. Check NATS
connectivity and CPU pressure on the farm-service pod.

**If `outbox_dead_letter_count > 0`:** some rows exceeded
`OUTBOX_MAX_RETRIES` (5). Inspect the row's `lastError` column to
see the publish error message. Common causes:
- NATS server restart / split-brain
- Event payload too large (exceeds NATS max_payload)
- Consumer group rebalance

**If `outbox_publish_latency_seconds` p99 > 5s sustained:** increase
the worker batch size (`OUTBOX_BATCH_SIZE` in `@platform/outbox` constants)
or scale farm-service horizontally.

---

## Step 4 — Is NATS forwarding the event?

Use the `nats` CLI to watch the subject pattern in real time:

```bash
# All farm events for one tenant
nats sub "events.<tenantId>.>" --raw

# All batch-created events across tenants
nats sub "events.*.BatchCreated" --raw
```

**Expected:** within 1-2 seconds of the user action, a JSON line appears
with the matching `eventType` and `batchId`.

**If nothing appears but Step 3 shows the row as `publishedAt IS NOT NULL`:**
the worker thinks it published but NATS did not receive. Check:
- NATS credentials / TLS config (`buildNatsConnectionOptions`)
- NATS JetStream stream config — is `events.>` in the `subjects` list?
- NATS server storage — is the stream full?

---

## Step 5 — Is gateway-api subscribed?

`FarmNatsBridgeService` subscribes to `events.*.<EventType>` wildcard
patterns. If the bridge is not connected, no Socket.IO broadcast happens.

### gateway-api logs

```bash
kubectl logs -l app=gateway-api --tail=200 | grep -i "farm.*bridge"
```

Expected startup lines:
```
Farm bridge connected to NATS at nats://...
Subscribed to events.*.BatchCreated (queue: gateway-farm)
Subscribed to events.*.MortalityRecorded (queue: gateway-farm)
... (10 subjects total)
```

**If the bridge failed to connect:** NATS auth or TLS issue. The bridge
logs the error but does NOT crash gateway-api (sensor + messaging
bridges keep working). Fix the NATS config and restart gateway-api.

### Per-event counter

```
farm_ws_events_broadcast_total{tenant="<tenantId>", event_type="cullRecorded"}
```

Should increment each time a cull event passes through the bridge.
If this counter is zero while Step 4 shows events on NATS, the bridge
is not receiving them — most likely a subject mismatch (`events.X` vs
`events.*.X`).

---

## Step 6 — Is the client connected to /farms?

```
farm_ws_connected_clients{tenant="<tenantId>"}
```

Should be >= 1 per user tab currently on a farm-module page.

**If zero:** the client never connected. Check:
- Browser DevTools → Network → WS filter — look for a connection to
  `/farms` namespace
- `useFarmRealtimeStream` is mounted at `FarmModule.tsx` — verify the
  module wrapper code is in place
- JWT is present in `localStorage` / auth store
- CORS error in browser console (check `WS_CORS_ORIGINS` on gateway-api)

**If >= 1 but UI still not updating:** the socket is connected but the
cache invalidation is not firing. Open browser DevTools → Network → WS,
expand the `/farms` socket, look at the Messages tab. You should see
the broadcast frame arrive within ~200ms of the backend write. If the
frame is visible but the UI still stale, the bug is in the React Query
invalidation map in `useFarmRealtimeStream.ts` — verify the `eventType`
matches one of the mapped keys.

---

## Dead-letter recovery

If events accumulate in the dead-letter state (retryCount >= 5):

```sql
-- Inspect dead-lettered rows
SELECT id, "eventType", "retryCount", "lastError",
       "createdAt", "publishedAt"
FROM farm.farm_outbox
WHERE "publishedAt" IS NULL
  AND "retryCount" >= 5
ORDER BY "createdAt" DESC;
```

Once the underlying cause is fixed (e.g. NATS restored), reset the retry
counter to unblock the worker:

```sql
-- Surgical: reset a single row
UPDATE farm.farm_outbox
SET "retryCount" = 0, "lastError" = NULL
WHERE id = <dead_letter_id>;

-- Aggressive: reset all dead letters
UPDATE farm.farm_outbox
SET "retryCount" = 0, "lastError" = NULL
WHERE "publishedAt" IS NULL AND "retryCount" >= 5;
```

The worker picks them up on the next poll (within 1s).

---

## Multi-tenant isolation verification

A tenant must NEVER see another tenant's farm events. Verify after any
bridge or gateway change:

1. Log in as tenant A in one browser, tenant B in another.
2. Record a cull as tenant A.
3. Tenant B's UI must NOT update.
4. Tenant B's DevTools WS tab must NOT show a frame for that event.

The enforcement chain is:
- Event includes `tenantId` at the root (`BaseEvent.tenantId`)
- NATS subject includes `tenantId` (`events.{tenantId}.{eventType}`)
- Bridge reads `event.tenantId` and passes to `broadcastXxx(tenantId, ...)`
- Gateway emits to `tenant:{tenantId}` Socket.IO room
- Client auto-joins ONLY its own tenant room on handshake

If any link in the chain drops tenantId, isolation breaks. The contract
guard `isValidEvent()` in `FarmNatsBridgeService` refuses events without
a top-level `tenantId` — a malformed event is logged and dropped
rather than broadcast cross-tenant.

---

## Quick reference — relevant files

| Component | File |
|---|---|
| Handler enqueue | `apps/farm-service/src/**/handlers/*.handler.ts` |
| Outbox library | `platform/libs/outbox/src/` |
| Outbox entity | `apps/farm-service/src/outbox/farm-outbox.entity.ts` |
| Outbox table migration | `apps/farm-service/src/database/migrations/1780300000000-CreateFarmOutboxTable.ts` |
| NATS event bus | `platform/libs/event-bus/src/nats/nats-event-bus.ts` |
| Gateway bridge | `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts` |
| Gateway | `apps/gateway-api/src/websocket/farm.gateway.ts` |
| Frontend hook | `web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts` |
| Hook mount | `web/modules/farm-module/src/Module.tsx` |
