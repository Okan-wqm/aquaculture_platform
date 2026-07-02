/**
 * Dependency injection tokens for the @platform/outbox library.
 *
 * Each consuming service registers its own concrete outbox entity
 * (e.g. `FarmOutbox extends OutboxEntityBase`) and binds it to the
 * `OUTBOX_ENTITY_CLASS` token via `OutboxModule.forFeature(...)`.
 * Services that share a process (rare) cannot share these tokens.
 */

/** Injection token for the concrete outbox entity class. */
export const OUTBOX_ENTITY_CLASS = Symbol('OUTBOX_ENTITY_CLASS');

/** Injection token for the OutboxModule options object. */
export const OUTBOX_OPTIONS = Symbol('OUTBOX_OPTIONS');

/** Maximum number of outbox events processed per poll cycle. */
export const OUTBOX_BATCH_SIZE = 100;

/** Events with retryCount >= this threshold are dead-lettered. */
export const OUTBOX_MAX_RETRIES = 5;

/** Truncate `lastError` text to this many characters before persisting. */
export const OUTBOX_LAST_ERROR_MAX_LENGTH = 2000;

/**
 * Lease duration — a row leased by a worker is skipped by every other
 * worker for this long. After the window expires, a new worker may
 * re-claim the row (treating the original holder as crashed).
 *
 * # Sizing rationale
 *
 * 5 minutes is deliberately generous vs. typical publish latency
 * (sub-100ms). A tight window (e.g. 30s) would cause false re-leases
 * during transient NATS slowdowns — every re-lease becomes a duplicate
 * publish that NATS `duplicate_window` must absorb. A longer window
 * trades worst-case stuck-event latency for a quieter dedup cache
 * and is the correct default for at-least-once semantics.
 *
 * Worst-case stuck-event latency on pod crash = this value. Operators
 * observing a row with `leasedAt > NOW() - 4 minutes` should consult
 * `leasedBy` to identify the crashed worker before manual intervention.
 */
export const OUTBOX_LEASE_DURATION_MS = 5 * 60 * 1000;

/**
 * ORPHAN-HIGH-321 — pending-age alarm threshold.
 *
 * The transactional-outbox guarantee is "the event WILL eventually
 * publish". The failure mode that voids it is SILENT: a worker that sees
 * zero rows (the 2026-07-02 incident: forced tenant RLS hid every row
 * from the sweeper) logs nothing and errors nothing — only the age of
 * the oldest unpublished row exposes the stall. When that age exceeds
 * this threshold the worker logs at ERROR level every poll cycle and the
 * `outbox_oldest_pending_age_seconds` gauge (alert on it) keeps climbing.
 *
 * 10 minutes = 2× the lease window: long enough to never fire on a
 * healthy backlog burst, short enough that a dead pipeline pages within
 * one operator coffee break.
 */
export const OUTBOX_PENDING_AGE_ALARM_MS = 10 * 60 * 1000;

/**
 * Debounce window applied to incoming `pg_notify` wake signals before
 * the listener invokes `pollAndPublish()`. A high-write burst (e.g.
 * 100 rows inserted in <100ms) produces 100 NOTIFY events; the listener
 * collapses them into a single worker cycle so the outbox does not
 * trash CPU or DB round-trips on a per-insert basis.
 *
 * 100ms is short enough that the user-observable latency penalty is
 * invisible (median NATS publish is already 5-30ms) and long enough
 * to absorb realistic handler bursts.
 */
export const OUTBOX_NOTIFY_DEBOUNCE_MS = 100;

/**
 * Initial backoff used by the LISTEN client when its dedicated pg
 * connection drops (network blip, PG restart, etc.). The listener
 * doubles the delay on each failed reconnect attempt up to
 * `OUTBOX_NOTIFY_RECONNECT_MAX_MS`. The cron safety net in the worker
 * continues to drain the outbox at a slower cadence during any
 * reconnect window, so event delivery is never stalled — only the
 * near-real-time latency is temporarily degraded.
 */
export const OUTBOX_NOTIFY_RECONNECT_INITIAL_MS = 1000;

/**
 * Upper bound on the LISTEN client reconnect backoff. Once this value
 * is reached, subsequent retries repeat at the same cadence instead
 * of growing unbounded. 30 seconds is the standard "patient but not
 * forgotten" setting used across the platform's reconnect loops.
 */
export const OUTBOX_NOTIFY_RECONNECT_MAX_MS = 30_000;

/**
 * Maximum number of concurrent NATS publishes per worker per poll cycle.
 *
 * # Sizing rationale
 *
 * The NATS client multiplexes publishes over a single TCP connection,
 * so concurrency is bounded by the client's internal flush pipeline
 * rather than connection count. 20 is well below the point where the
 * pipeline becomes a bottleneck.
 *
 * 20 × ~5ms per publish ≈ 25ms for a 100-row batch, which leaves the
 * majority of the 1-second cron budget free for the next batch.
 * Higher values give diminishing returns because the next gate is
 * the single DB UPDATE at the end of the cycle.
 *
 * Lowering this value is safe (caps in-flight work); raising it is
 * safe up to the NATS server's per-connection throttle, beyond which
 * publishes queue inside the client and latency grows. Do not tune
 * this without an observability baseline — measured, not guessed.
 */
export const OUTBOX_PUBLISH_CONCURRENCY = 20;

/**
 * UUID v4 validation regex — defined locally rather than imported from
 * `@aquaculture/backend-common` so the outbox library stays at a lower
 * dependency level and can be consumed by any service without pulling
 * in the NestJS-specific infrastructure package.
 *
 * Enforced at `OutboxPublisher.enqueue` because `event.tenantId` becomes
 * a NATS subject segment (`events.{tenantId}.{eventType}`) downstream,
 * and subsequently a Socket.IO room key (`tenant:{tenantId}`). A
 * malformed tenantId could inject subject wildcards (`*`, `>`) into NATS
 * routing, poison structured logs via newline injection, or collide with
 * another tenant's room key. Failing closed at the publisher boundary
 * keeps all downstream layers honest.
 */
export const OUTBOX_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PascalCase validation regex for `eventType`. The event type becomes the
 * third NATS subject segment (`events.{tenantId}.{eventType}`). Restricting
 * it to `^[A-Z][A-Za-z0-9]+$` prevents subject wildcards, dot injection,
 * and unexpected characters leaking into metric labels / room names.
 */
export const OUTBOX_EVENT_TYPE_REGEX = /^[A-Z][A-Za-z0-9]+$/;
