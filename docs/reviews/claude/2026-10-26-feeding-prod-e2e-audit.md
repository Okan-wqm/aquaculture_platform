# Feeding production E2E audit — four defects fixed, four tracked (2026-10-26)

<!-- markdownlint-disable MD013 -->

An end-to-end audit of the ten Production > Feeding tabs on the Codex Test Tenant (frontend, GraphQL, handlers, database; read, create,
edit, delete) found, among others, four defects that stopped the Feeding engine and the web session. This file registers them, with the
evidence that was read on production, and the four follow-ups that were found on the way and are NOT fixed here.

---

## FARM-CRITICAL-479 — the feeding engine's tenant discovery, run ledger and zone read run outside any tenant context under FORCE RLS

- **Severity:** CRITICAL; owner: Okan-wqm; deadline: 2026-10-27.
- **Evidence:**
  - `feeding-cron-v2.service.ts` `feedingTenants()` and `tenantsForRetention()` queried FORCE-RLS tenant tables on a bare QueryRunner after
    `SET search_path`; `feeding-job-run.service.ts` `claim()` inserted into `farm.feeding_job_runs` with `dataSource.query`;
    `site-time-zone.service.ts` `tenantZones()` read `farm.tenant_localization`, and the `TenantUpdated` projection upserted it, both outside a tenant context.
  - Production, read-only, as `SET LOCAL ROLE farm_service`: the discovery probe saw 0 rows where the owner sees 2 live assignments, 0 stocked tanks, 0 active
    batches. `farm.feeding_job_runs` has 0 rows for every tenant, ever. The test tenant has one day plan (2026-10-11).
  - The legacy `FeedingSchedulerService` logs "K-5 cutover: legacy plan generation gated off" every night: nothing else generates plans.
- **Rule:** a cross-tenant worker reads and writes a FORCE-RLS table only inside a tenant context (`runInTenantTransaction`), listing tenants from the platform ledger.
- **Failure scenario:** the 06:00 plan generation, the 05:00 sweep, the 07:00 stock coverage, the 15-minute meal window, the 18:00 FCR sweep and the 20:00
  summary never reach any tenant: the Meal Board is empty every morning, forecast snapshots are only ever refreshed by events, no run is recorded.
- **Why no test saw it:** unit specs mock the QueryRunner (a mock enforces no RLS) and the other farm postgres specs run as the owner role, which bypasses it.
- **Fix:** `findTenantsMatching` (`libs/backend-common`) lists tenants from `platform.list_active_tenant_schema_mappings()` (or the retained ledger for
  retention) and asks each tenant its question inside `runInTenantTransaction`; the run ledger and the zone read run per tenant; the projection upsert runs
  in the tenant context. `feeding-cron-v2.discovery.rls.postgres.spec.ts` runs the real services on Postgres with a non-owner role and FORCE RLS, and drives
  `hourlyTick()` to `feeding_job_runs` rows; it fails on the old behaviour.

## FARM-HIGH-480 — BatchFilterInput and UpdateBatchInput declare no validators: every filtered batches() call and every updateBatch is rejected

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-10-27.
- **Evidence:** `batch-resolver.dto.ts` (16 `@Field`-only input properties). Production: `batches(page, limit)` returns the 7 batches;
  `batches(filter: { status: "ACTIVE" })` returns BAD_REQUEST, as does every single property of the filter. The Feeding page sends `{ status, isActive }` on every tab.
- **Rule:** every GraphQL input property declares a validator (`tests/invariants/graphql-input-validators.spec.ts`, PLAT-HIGH-922).
- **Failure scenario:** the batch picker is empty, the header KPIs read "0.0 t / 0 fish", and the Records, Summary, Growth and FCR tabs show "no batch".
- **Fix:** both inputs are decorated; the file leaves the PLAT-HIGH-922 ratchet (the umbrella finding stays open for the remaining files);
  `batch-resolver.dto.validation.spec.ts` drives the real global pipe with the variables the web sends.

## ALERT-HIGH-025 — farm-signal incidents were never opened, alarm rows were re-written on every redelivery, and MealUnderfed fired per delivery instead of once per unit per day

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-10-27.
- **Evidence:**
  - `alert_incidents.rule_id` is `uuid NOT NULL` (baseline) while every farm signal uses a synthetic key (`system:meal-underfed:<unitId>`); the entity declares `ruleId: string`.
  - `FeedingExecutionAlertService` saved the alarm row, then called `ensureIncident` outside any shared transaction; the handler rethrows (NAK + backoff).
  - Production: `alert_history` 99,5 thousand rows on the test tenant from four 7-day poison messages (mortality x2, water-quality, low-stock x2) and one live;
    `alert_incidents` 0 rows; `aqua-alert` logs `invalid input syntax for type uuid: "system:meal-underfed:..."` every 30 s.
- **Rule:** the alarm and the incident it feeds commit atomically and idempotently; the DB column is the type the entity declares; an underfed alarm is raised once per unit per day.
- **Fix:** migration `1824200000000` (rule_id text, foreign key dropped, idempotent, `down` refuses while a synthetic key exists);
  `FarmSignalIncidentService.raise` (one transaction, the unique `(rule_id, source_event_id)` key as the idempotency + frequency key, escalation after the commit);
  MealUnderfed keyed by its day plan, MealMissed by its meal; the unused `rule` relation removed from the entity. Proven on real Postgres
  (`farm-signal-incident.raise.postgres.spec.ts`, `align-alert-incident-rule-id.migration.postgres.spec.ts`).
- **Not done here (tracked):** mortality, low-stock, water-quality, FCR and feed-coverage still use `ensureIncident` (the migration unblocks them; their alarm write is not yet atomic).

## PLAT-HIGH-933 — no service may publish to the dead-letter subject: every dead-letter is refused and the poison message loops

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-10-27.
- **Evidence:** `services.yaml` has no publish grant matching `dlq.*` (only `dlq_replayer` subscribes `dlq.>`); `nats-event-bus.ts` publishes `dlq.<tenant>.<type>` with the service's own identity.
  Production: `aqua-alert` and `aqua-notification` log `DLQ publish FAILED ... Permissions Violation for Publish to "dlq.<tenant>.<type>"` ("original NAK'd, not finished into loss").
- **Rule:** every service that runs JetStream consumers may dead-letter, with exactly `dlq.*.*` (ADR-014/015).
- **Fix:** the grant for the 15 NestJS services, `nats.conf` regenerated, and two invariants in `nats-invariants.spec.ts`. Verified against a real `nats-server` 2.10.24
  with the alert-engine permissions: refused before, accepted into `AQUACULTURE_DLQ` after. **Deploy note:** `aqua-nats` must reload the regenerated configuration.

## PLAT-HIGH-934 — a GraphQL operation over its rate limit reaches the client as INTERNAL_SERVER_ERROR

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-10-27.
- **Evidence:** `rate-limit.guard.ts` decorator path rejected with `rejectIfOver(..., false)` for GraphQL too; `subgraphFormatError` and the gateway formatter keep only the code.
  Production: refresh bucket `11/10`..`17/10` on the crawl, surfaced to the browser as INTERNAL_SERVER_ERROR.
- **Rule:** a throttled request is answered TOO_MANY_REQUESTS with the wait, never as a server fault.
- **Fix:** GraphQL gets a coded `GraphQLError` (`TOO_MANY_REQUESTS`, `retryAfter`); the subgraph preset keeps the message and `retryAfter` for that code; the gateway
  forwards `retryAfter` (`formatGatewayError`); REST keeps its HTTP 429.

## FE-HIGH-396 — the web client reads a failed refresh as a dead session and spends a refresh on UNAUTHENTICATED answers to a fresh token

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-10-27.
- **Evidence:** `api-client.ts` `performTokenRefresh()` returned a boolean and every failure ended in `clearSession()`; each page load fired a second `refreshToken` because
  `GetUnreadNotificationCount` answered UNAUTHENTICATED to a token issued seconds before. The 5th page load of the crawl was sent to `/login`.
- **Rule:** a refresh that could not be answered (throttled, server fault, offline) never ends the session; only a refused refresh does.
- **Fix:** `RefreshOutcome` (`ok` / `rejected` / `unavailable`); `unavailable` keeps the session (`REFRESH_UNAVAILABLE`) and starts a cooldown that honours the wait the server named;
  a page-load restore waits out a short throttle once; no refresh is spent on an answer to a token whose `iat` is under 30 s old.

## PLAT-HIGH-935 — notification-service does not register VerifiedUserAssertionMiddleware: every authenticated operation is UNAUTHENTICATED

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-10-27.
- **Evidence:** `notification-service/src/app.module.ts` `configure()` has no `VerifiedUserAssertionMiddleware` (every other business subgraph has it). Production:
  `UnauthorizedException: Authentication context is required. No verified user reached the tenant guard` at `TenantGuard.canActivate` for `unreadNotificationCount`,
  while `me()` with the same token succeeds.
- **Rule:** every GraphQL subgraph resolves the caller from the gateway-signed verified-user assertion.
- **Fix:** registered after `StripInternalHeadersMiddleware`; `tests/invariants/subgraph-verified-user-middleware.spec.ts` scans every `app.module.ts` that registers a
  GraphQLModule (gateway-api and auth-service are exempt, with the reason).

---

## FARM-HIGH-481 — the bare-runner tenant discovery under FORCE RLS remains in five more farm-service cron paths

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-11-02.
- **Evidence:** `task.service.ts:736` (detect-overdue), `auto-rule-trigger.service.ts:240`, `recurring-task.service.ts:175`, `report-scheduler.service.ts:477`, `feeding-scheduler.service.ts:778`.
- **Rule:** cross-tenant discovery goes through `findTenantsMatching`. **Fix:** migrate them and add a ratchet invariant on raw `listTenantSchemas` + `createQueryRunner` discovery in `apps/`.

## PLAT-HIGH-936 — notification-service's task event handlers insert into notification_logs outside a tenant context

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-11-02.
- **Evidence:** production `aqua-notification` logs `new row violates row-level security policy for table "notification_logs"` for TaskCreated / TaskOverdue every 30 s.
- **Rule:** tenant-table writes from an event handler run in the event's tenant context. With the DLQ grant deployed these poison messages are dead-lettered instead of looping.

## SEC-MEDIUM-212 — the refresh bucket is per client IP only

- **Severity:** MEDIUM; owner: Okan-wqm; deadline: 2026-11-02.
- **Evidence:** `auth.resolver.ts:140` `@RateLimit({ name: 'refresh', limit: 10, windowMs: 5 * 60_000 })`: everyone behind one office address shares 10 refreshes per 5 minutes.
- **Rule / fix:** a per-session budget (a hash of the refresh credential, never the credential) plus a larger per-IP abuse ceiling; a throttled page-load restore shows a reconnecting
  state instead of the login page. A security-design change (SEC-HIGH-202 chose the end-client IP on purpose): it needs its own review.

## FARM-HIGH-482 — the web sends lowercase enum values the schema rejects, and the growth resolver's inputs still carry no validators

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-11-02.
- **Evidence:** `ProtocolBuilderTab.tsx:91` (`fcrSource: 'band'` against `BAND`), `SamplingModal.tsx:100-101` (`'routine'`, `'manual_scale'`), `measuredBy` a name into a uuid column,
  `growth.resolver.ts` 30 undecorated input fields (PLAT-HIGH-922 ratchet). Protocol create/edit and every weighing fail from the UI.
- **Rule:** the client sends the GraphQL enum names; every input property declares a validator.
