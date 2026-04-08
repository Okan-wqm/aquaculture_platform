# Research: Realtime Messaging — Presence, Dedup, Redis Graceful Degradation, Channel Membership, Partition Fanout

**Topic:** Presence tracking, Redis SET NX idempotency with TTL, graceful degradation on Redis failure, channel membership validation, partition fanout
**Date:** 2026-04-08
**Agent:** messaging-expert

## Sources

- [Data deduplication with Redis using SET NX, sets, and bitsets — redis.io tutorials](https://redis.io/tutorials/data-deduplication-with-redis/)
- [What is idempotency in Redis? — Redis Blog](https://redis.io/blog/what-is-idempotency-in-redis/)
- [Presence Tracking with Redis — hjr265.me](https://hjr265.me/blog/presence-tracking-with-redis/)
- [Redis Sorted Sets and Time-Based Expiration — oneuptime](https://oneuptime.com/blog/post/2026-01-21-redis-sorted-sets-time-expiration/view)
- [Redis Keyspace Notifications — Redis Docs](https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/)
- [Deduplication in Distributed Systems — Architecture Weekly (Oskar Dudycz)](https://www.architecture-weekly.com/p/deduplication-in-distributed-systems)

## Key Findings

### 1. Redis SET NX idempotency with TTL
- The atomic primitive: `SET key value NX EX <seconds>`. The `NX` flag ensures atomicity — no check-then-insert race even under concurrent requests across replicas.
- Return value: `OK` -> first time (proceed), `nil` -> duplicate (skip).
- TTL calibration: must cover the full retry window of the producer + the longest realistic processing delay of the consumer. For messaging-service idempotency keys (HTTP send requests), 5–10 minutes is typical. For long-running batch jobs, longer.
- Key naming: tenant-scoped, format-stable: `msg:{tenantId}:idem:{idempotencyKey}`. Tenant prefix is mandatory to prevent cross-tenant collisions.
- Memory hygiene: TTL handles cleanup; no explicit DELETE needed. Avoid unbounded SETs without expiry.

### 2. Idempotency key scope and lifecycle
- Scope: per-(tenant, user, channel, action). The `idempotencyKey` is supplied by the client (typically a UUID v4 generated once per send attempt) and reused across retries by that client.
- Lifecycle: created at INSERT-time, returns the same response to duplicate calls within the TTL window. After TTL expiry, the key is gone — a duplicate at that point will create a new message (the producer's responsibility to retry within the window).
- For chat messaging, the body of the response (message ID, server timestamp) must be cached alongside the idempotency lock so duplicate requests get the original response, not a "duplicate" error. Pattern: `SET msg:{tenant}:idem:{key} <responseJSON> NX EX 600`. On `nil` return, `GET` the key and return the cached response.

### 3. Graceful degradation on Redis failure
- Redis is a critical-path dependency for idempotency, presence, consent cache, and rate limiting — but the system MUST NOT cease operation when Redis dies.
- Idempotency: fall through with a structured-log warning + Prometheus counter. Message delivery proceeds at the cost of accepting potential duplicates. The downstream layer (Postgres unique constraint on `(channel_id, client_msg_id)`) is the safety net.
- Presence: degrade to "presence unknown" — UI shows offline or unknown status. Don't block the message send.
- Rate limiting: fail-OPEN for non-security-critical limits (chat send), fail-CLOSED for security-critical (login attempts). Document the policy per limiter.
- Consent cache: fall through to Postgres lookup. Performance degraded but safe.
- The decision tree: **availability of messaging > strictness of dedup**. Better a duplicate message than a 500 error to the user.
- Circuit breaker on Redis client prevents cascading slowdowns: open after N consecutive failures, half-open probe after recovery interval.

### 4. Presence tracking
- Pattern: sorted set per tenant `presence:{tenantId}` where members are `userId` and scores are last-heartbeat unix timestamp.
- Heartbeat: client pings every 15-30s; server `ZADD presence:{tenant} <now> <userId>`.
- Online query: `ZRANGEBYSCORE presence:{tenant} (<now-90s>) +inf` returns currently-online users.
- Cleanup: periodic `ZREMRANGEBYSCORE presence:{tenant} -inf (<now-300s>` removes stale entries (or use Redis 7.4+ per-member TTL on hash fields, where supported).
- Per-channel presence: a separate sorted set per channel `presence:{tenant}:{channelId}` for "who's currently in this channel."
- Channel membership validation: BEFORE serving presence data for a channel, verify the requesting user is a member of that channel — `ChannelMember` lookup or cached `mem:{tenant}:{channelId}:{userId}` Redis SET membership.

### 5. Channel membership validation
- Every operation that touches channel data (send message, read history, query presence, fetch attachments) MUST validate that `requesterUserId` is a member of `channelId` AND that the channel belongs to `tenantId`.
- Cache pattern: `SISMEMBER chan:{tenant}:{channelId}:members {userId}` — O(1) check, populated lazily on first access, invalidated on `ChannelMember` add/remove events.
- Cache TTL: 5 minutes with explicit invalidation. Stale membership is a security-critical correctness bug — be aggressive about invalidation.
- Fall-through on cache miss: query Postgres `ChannelMember` table, populate cache.
- Fall-through on Redis failure: query Postgres; do NOT fail open (this is a security boundary, not a perf optimization).

### 6. Partition fanout
- A "fanout" is the act of distributing a single message event to all members of a channel. With monthly partitioned `messages` table, the fanout happens AFTER the message is persisted: the outbox publishes a `MessageSent` event, NATS JetStream consumers route to per-user notification queues.
- Fanout strategies:
  - **Push fanout (write-time):** on INSERT, write a `message_receipt` row for every channel member. Heavy write amplification but read-time is O(1). Used for channels with predictable membership (≤ 1000 members).
  - **Pull fanout (read-time):** receipts are written lazily as users read. Light writes, heavier reads. Used for very large broadcast channels.
- The choice is per-channel-type. For `direct` and `group` channels (small N), push fanout is correct. For `broadcast` channels (large N), pull fanout is correct.
- Fanout to a real-time websocket layer happens via NATS subjects per user (`user.{tenantId}.{userId}.messages`). The messaging-service publishes once; NATS delivers to all subscribed websocket connections (which may be on different gateway pods).
- **Tenant_id MUST be in every NATS subject** to allow per-tenant subscription and to prevent cross-tenant routing bugs.

### 7. Race conditions and sequencing
- Client sends two messages back-to-back (M1, M2) over different HTTP connections that route to different pod replicas. Without sequencing, M2 may persist before M1 (different transaction commit order). Mitigation:
  - Server-side timestamp + tiebreaker `seq` column ensures consistent ORDER BY for clients.
  - Client-supplied `clientSeq` is included in the response so the client can detect and reorder.
- Client cancels and retries M1 with same idempotency key while the original request is still in-flight. Mitigation: SET NX returns nil on the retry, but the cached response isn't yet written. The retry blocks/polls for up to TTL, then errors. Better: write a `pending` placeholder atomically with the SET NX, replaced by the real response on completion.

## Security Concerns

- **Channel-membership cache stale-data leak (CRITICAL):** if the cache returns "member" for a user who was just removed, that user can still read messages. Aggressive invalidation is mandatory; stale TTL > 5 minutes is unacceptable.
- **Cross-tenant channel access (CRITICAL):** every cache key MUST be tenant-scoped. Forgetting `tenantId` in the key allows another tenant's channel ID to collide.
- **Presence data leak (HIGH):** revealing who is currently online to a user who is not a member of the relevant channel/tenant is a privacy violation. Always validate scope before returning presence.
- **Idempotency key collision across tenants (HIGH):** without tenant prefix, two tenants choosing the same idempotency key (e.g., a client library default) collide.
- **Redis password / network exposure (HIGH):** Redis must not be reachable from outside the platform's private network. Authentication required even within the network.
- **Pattern subscription DoS:** `PSUBSCRIBE` with broad patterns is expensive. Limit pattern subscriptions and prefer explicit subject lists.
- **Fail-open consent cache (CRITICAL if not designed):** when Redis is down and the consent check falls through, the fall-through path must NOT default to "consent granted." Default DENY for AI processing on cache miss with Postgres unavailable too.

## Performance Concerns

- **Redis as a single point of contention:** under hot-channel write spikes, all idempotency SET NX calls hit the same Redis. Use Redis Cluster or shard by tenant for very high throughput.
- **Sorted set growth (presence):** `presence:{tenant}` grows unbounded if cleanup is missed. Schedule `ZREMRANGEBYSCORE` every minute.
- **Push-fanout write amplification:** a single message in a 1000-member channel = 1000 receipt rows. Bulk INSERT in one statement, not 1000 round-trips.
- **NATS subject explosion:** one subject per user means one consumer per user — fine for thousands, bad for millions. Use subject hierarchies and wildcards where appropriate.
- **Membership check on every read:** cache aggressively but invalidate correctly. Mongoid pattern: every `ChannelMember` mutation publishes an invalidation event consumed by all gateway pods.
- **Idempotency key memory:** 5M idempotency keys at 100 bytes each = 500 MB. Set Redis `maxmemory` and use `allkeys-lru` eviction policy. TTL handles most of it.

## Architectural Implications for messaging-expert reviews

When reviewing realtime/presence/dedup code, verify:

1. **All Redis keys are tenant-scoped** (`{type}:{tenantId}:...`). Missing tenant prefix -> CRITICAL.
2. **`SET ... NX EX <ttl>`** for all idempotency, never `SETEX` followed by `EXPIRE`. Atomicity violation -> HIGH.
3. **Idempotency response cached alongside lock** so duplicate requests return the original response. Missing -> HIGH (duplicate creates 5xx instead of replay).
4. **Postgres unique constraint** as the safety net for dedup (e.g., `UNIQUE(channel_id, client_msg_id)`). Missing -> CRITICAL (Redis failure -> duplicates persist).
5. **Channel membership check on every channel-touching operation** (send, read, attachment fetch, presence). Missing -> CRITICAL.
6. **Membership cache invalidated on member add/remove** events (not just TTL-expired). Missing -> HIGH.
7. **Membership cache TTL <= 5 minutes.** Longer -> MEDIUM.
8. **Redis failure fail-open for non-security paths** (idempotency, presence) and **fail-closed for security paths** (membership, consent). Wrong direction -> CRITICAL or HIGH.
9. **Circuit breaker on Redis client** to prevent cascading slowdowns. Missing -> MEDIUM.
10. **Presence cleanup job** runs periodically. Missing -> MEDIUM (memory leak).
11. **Per-channel fanout strategy chosen by channel type** (push for small, pull for broadcast). All-push for broadcast -> HIGH.
12. **NATS subject includes tenantId** in every fanout publish. Missing -> CRITICAL.
13. **Server-assigned `seq`** ensures consistent ordering when client sends parallel messages. Client-supplied seq trusted -> HIGH.
14. **Redis `maxmemory` and `allkeys-lru` eviction** configured. Missing -> MEDIUM (OOM risk).

## Domain Rule Additions for messaging-expert

- All Redis keys MUST be tenant-scoped: `{type}:{tenantId}:...`. No exception.
- Idempotency MUST use atomic `SET key value NX EX <ttl>` and cache the response payload alongside the lock so retries replay the original response.
- Idempotency Redis layer MUST be backed by a Postgres unique constraint (e.g., `UNIQUE(tenant_id, channel_id, client_msg_id)`) so a Redis outage cannot produce duplicate persisted messages.
- Channel-membership validation MUST occur on every operation that reads or writes channel data (send, history, presence, attachments). Cache TTL <= 5 minutes with explicit invalidation on `ChannelMember` mutations.
- Membership validation MUST fail-CLOSED on Redis+Postgres unavailability — never default to "member" on cache miss with DB unreachable.
- Idempotency, presence, and rate-limit subsystems MUST fail-OPEN on Redis outage (with structured-log + Prometheus warning); membership and consent subsystems MUST fail-CLOSED.
- Presence tracking MUST use sorted sets keyed by tenant + optional channel; cleanup job removes entries older than 5 minutes.
- Per-channel fanout strategy MUST be chosen by channel type: push for small channels (`direct`, `group`), pull for `broadcast`. No global default.
- Every NATS subject in messaging fanout MUST include `tenantId` in the subject hierarchy.
- Server-assigned monotonic `seq` (BIGSERIAL or per-channel sequence) MUST be the authoritative ordering field; client-supplied sequence numbers are debugging metadata only.
- Redis MUST be configured with bounded `maxmemory` and `allkeys-lru` eviction policy; presence sorted sets MUST have a periodic cleanup job.
- Circuit breaker MUST wrap the Redis client to prevent slowdown propagation.
