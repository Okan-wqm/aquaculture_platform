# Production-readiness gaps — external review, verified 2026-09-05

**Cycle:** `2026-09-05-production-readiness-external-review`
**Source:** seven claims raised by an external model review against `origin/main`
(2026-09-05), each verified independently against the code by a read-only
exploration before registration. All seven hold. Six were not in the registry;
one (backup activation / restore proof) is already tracked and is an
operator-evidence gap, not a code gap.

| #   | Claim                                          | Verdict                                   | Registry                     |
| --- | ---------------------------------------------- | ----------------------------------------- | ---------------------------- |
| 1a  | Invite link cannot be validated                | CONFIRMED (mechanism corrected)           | `SEC-HIGH-056`               |
| 1b  | auth-service has no `FRONTEND_URL`             | CONFIRMED (droplet, prod **and** staging) | `DEPLOY-HIGH-016`            |
| 2   | Super-admin password recovery silently dropped | CONFIRMED (+ second blocker)              | `SEC-HIGH-057`               |
| 3   | Notification handler acks failures             | CONFIRMED (+ null-returning resolvers)    | `PLAT-HIGH-902`              |
| 4   | MQTT reading vs alarm evaluation diverge       | CONFIRMED (scope half is the worse)       | `SENSOR-CRITICAL-106`        |
| 5   | Full deploy breaks the monitoring stack        | CONFIRMED (placeholder is structural)     | `DEPLOY-CRITICAL-017`        |
| 6   | Backup activation / restore proof missing      | CONFIRMED — already tracked               | `INFRA-HIGH-033/034/035/073` |
| 7   | MinIO bytes outside the recovery cut           | CONFIRMED                                 | `INFRA-HIGH-151`             |

## Findings

### SEC-HIGH-056 — invitation links cannot be validated

`internal-auth.controller.ts:73-85` builds the e-mailed link from
`actionToken.id` (a row PK). The shell routes `/accept-invitation/:token` to
`AcceptInvitationForm`, which calls `validateInvitation(token)` first and gates
the password form on the answer (`AcceptInvitationForm.tsx:39-89,154-156`).
`validateInvitation` (`authentication.service.ts:850-874`) hashes the segment and
looks it up as a raw invitation token, with a plaintext fallback — it has no
ActionToken resolution at all, while `acceptInvitation` (`:729-745`) and
`resetPassword` (`:1653-1660`) both resolve `actionToken.id → tokenHash`. Both
lookups miss, the form renders the generic invalid-invitation screen, and no
spec covers `validateInvitation`.

**Fix direction (tier 1):** one `ActionTokenResolver.resolve(urlSegment,
purpose)` primitive that every consumer of an emailed link segment goes
through, so a consumer that skips the indirection cannot be written.

### DEPLOY-HIGH-016 — auth-service is never given `FRONTEND_URL`

`internal-auth.controller.ts:189` reads `FRONTEND_URL` with an inline default
of `http://localhost:8080`. The variable is set only on `admin-api-service`
(`docker-compose.droplet.yml:1064`, `docker-compose.staging.yml:190`) and is
absent from `docker-compose.prod.yml` entirely. Every invitation and reset link
in every environment points at localhost. Same class as `DEPLOY-CRITICAL-007`.

**Fix direction (tier 1):** a required, schema-validated auth-service config key
that fails fast at boot in production; set in all three compose files.

### SEC-HIGH-057 — super-admin password recovery silently does nothing

`authentication.service.ts:1605` publishes `PasswordResetRequested` with
`user.tenantId ?? 'system'`; `auth-event.handler.ts:88-95` drops any event whose
`tenantId` is not a UUID and returns normally (acked — see PLAT-HIGH-902).
Behind it, `internal-auth.controller.ts:112-124` rejects an identity without a
tenant and `:73-75` filters the action token by `tenantId`, while the
super-admin token was saved with `tenantId: null` (`:1581-1584`). The resolver
reports success by anti-enumeration design; no e-mail is sent.

**Fix direction (tier 1):** tenancy scope as an explicit discriminated part of
the event contract (`{kind:'tenant', tenantId} | {kind:'platform'}`), so the
platform case must be handled at compile time; the internal-API identity gets a
matching platform-scope audience. Adjacent: `FARM-HIGH-083` (publish side).

### PLAT-HIGH-902 — the notification handler acks every failure

`auth-event.handler.ts:114-119` catches and logs; its resolvers return `null` on
any non-2xx or network error (`:151-156`, `:182-186`, `:219-224`) and the
handlers `return` on null (`:338-343`). `EmailService.sendEmail` does throw
(`email.service.ts:189-194`), but the throw never reaches the bus. The bus
documents the invariant explicitly and naks with backoff only on a thrown error
(`nats-event-bus.ts:1231-1262`); a logged-and-returned failure is acked at
`:1261`. No DLQ entry, no metric, no user-visible error.

**Fix direction (tier 1):** `IEventHandler.handle` returns `Ack | Retry(reason)
| DeadLetter(reason)` so a handler that logs must still choose an outcome;
resolvers distinguish permanent (404) from transient (5xx/network) failure.

### SENSOR-CRITICAL-106 — the MQTT path records one reading and alarms on another

`mqtt-listener.service.ts:467` persists calibrated, scoped
`SensorMetricInput` rows (`:2097-2131`); `:473` then publishes the untouched
wire payload as a `version: 1` `SensorReading` event with no `farmId`/`pondId`/
`tankId` (`:1746-1755`). `alert-evaluation.service.ts:146-163` applies
`rule.farmId IS NULL` / `rule.pondId IS NULL` when the fields are missing — the
fail-closed branch working as designed, fed a producer that omits them — so
every farm- or pond-scoped rule is silently excluded, and the result is cached
under the empty-scope key. The value compared is the raw one. The v1→v2
upcaster maps nine hardcoded camelCase keys (`sensor-reading.upcaster.ts:13-23`);
any other channel key upcasts to an empty reading, and `autoResolveIfNormal`
(`:564-600`) closes live INFO/LOW incidents as "returned to normal". The
HTTP ingestion path (`data-ingestion.service.ts:340-344`) has the same shape;
the Rust-sidecar bridge (`nats-ingestion-consumer.service.ts:327-363`) and the
GraphQL path already carry calibrated values and scope. Phase 5's VFD work does
not touch `publishSensorReadingEvent`.

**Fix direction (tier 1):** no producer may mint a `SensorReadingEvent` from
anything but persisted metric rows — `saveReading` returns the rows it wrote and
one shared `buildTypedReadingEvent(metrics, sensor)` (the mapper the sidecar
bridge already owns) serves all four producers with v3 flat fields; the v1
nested emission is deleted; the alert engine rejects an unscoped reading rather
than evaluating a narrowed rule set.

### DEPLOY-CRITICAL-017 — a full deploy kills monitoring and replaces it with a silent copy

`droplet-up.sh:1217-1240` force-removes every container whose name matches
`aqua-` with no project filter (the correct label idiom is already used at
`:224`); `docker-compose.monitoring.yml` names all four of its containers
`aqua-*` and its header defends only against `--remove-orphans`.
`docker-compose.droplet.yml:1989-2056` carries its own unprofiled copies of the
same four names, so `up -d` recreates them under `aqua-saas` with older pins, a
different volume, none of the hardening, and the committed placeholder
`alertmanager.yml` (`smtp.invalid`, `receiver: 'null'`). `render-configs.sh`
edits that file in place (`:31,53-60`) and is called only by
`monitoring-up.sh`; the deploy consumes a SHA-pinned worktree re-pinned with
`git checkout -f` (`deploy-paths.sh:123`) at a different path, so the rendered
config is discarded by construction. Nothing pages, nothing errors, and the
runbooks' `docker compose -p aqua-monitoring ps` reports a false outage.

**Fix direction (tier 1):** one owner per container — delete the four monitoring
services from `docker-compose.droplet.yml`; every container-selection step in
`droplet-up.sh` filters by `label=com.docker.compose.project=aqua-saas`; render
`alertmanager.yml` to a persistent gitignored path symlinked into the checkout
like `.env`/`certs/` (`deploy-paths.sh:137-139`) and mount that.

### INFRA-HIGH-151 — uploaded object bytes are outside the recovery cut

`docker-compose.droplet.yml:239-248,626` — a bare local `minio_data` volume.
No backup or replication path references it anywhere in `tools/`,
`infrastructure/`, `.github/`, `scripts/` or the runbooks; the only `mc`
command in the repo is a purge (`faz-6-cutover-window.md:95-102`).
`backup-databases.sh:253-300` uploads `pg_dump` output only;
`database-restore-drill.md:360-388`'s production stop-line names no
object-storage condition. The backup-architecture plan records the gap
(`PLAN.md:75`, BR-3, exit target 2026-08-28 — passed) without a finding id.

**Fix direction:** BR-3 is the end state (versioned Spaces replica + Object Lock
vault + version-bound references). Smallest sound step now: an
`object-storage-replica` capability in `dr-activation.json` with a
bucket-versioning/replication probe lane, so every backup/PITR run warns
`PRODUCTION HAS NO object-storage-replica`, and the restore-drill stop-line
names object-version parity as a required condition.

### Claim 6 — backup activation and restore proof (already tracked)

`dr-activation.json` declares `production-wal-archive` and
`production-logical-backup` as `not-activated`; `resolve-dr-activation.sh:60-73`
exits 0 with a warning, and `backup-production.yml:118` /
`database-wal-archive-freshness.yml:145` skip their real work on that verdict —
so today no backup runs and no WAL freshness is asserted, honestly declared.
The PITR, evidence and closure machinery exists and has never run because all
23 backup/PITR secrets are unprovisioned (`.github/provisioned-secrets.json`).
Tracked as `INFRA-HIGH-033` (OPEN), `INFRA-HIGH-034` (IN-PROGRESS),
`INFRA-HIGH-035` (BLOCKED), `INFRA-HIGH-073` (IN-PROGRESS) and the
`INFRA-CRITICAL-040/044` family. Two nits worth recording: the manifest's
`finding: ORPHAN-HIGH-563` is prose-only, not a registry id; and the deploy
stop-line (`deploy-digitalocean.yml:125-143`) trusts an independent repo
variable rather than reading the manifest, so the two gates can diverge.

## Programme placement

Recorded in `/root/.claude/plans/planla-once-tek-tek-concurrent-dragon.md`
("Dış inceleme — 2026-09-05"): invitation + recovery (`SEC-HIGH-056/057`,
`DEPLOY-HIGH-016`, `PLAT-HIGH-902`) join the tenant-provisioning acceptance
criteria as **Faz 2c**; `SENSOR-CRITICAL-106` joins Faz 5; `INFRA-HIGH-151` joins
Faz 6; `DEPLOY-CRITICAL-017` and claim 6's evidence chain become the
**production go-live gate**, not Faz 8 ledger work.

## Faz 2c deferred work (registered with owner + deadline)

### SEC-LOW-060 — retire the raw-token resolution branch of ActionTokenResolver

`ActionTokenResolver.resolve()` (apps/auth-service/src/modules/authentication/services/action-token-resolver.service.ts)
keeps a `raw-token` branch that hashes a 64-hex URL segment and looks it up as a legacy
`Invitation.token` / `User.passwordResetToken`. After SEC-HIGH-056 nothing mints such a link:
every delivery carries `actionToken.id`. The branch exists only so links e-mailed BEFORE the
PR-A deploy (invitations ≤ 7 days, resets ≤ 1 hour) still redeem. Deleting it earlier would
invalidate every invitation in flight; keeping it re-opens the "raw secret in the URL" surface
the ActionToken indirection closed.

**Fix:** delete the `raw-token` member of `ActionLinkResolution`, `RAW_TOKEN_PATTERN` and
`hashRawToken`, and the consumers' `raw-token` arms, once ≥ 7 days have passed after the PR-A
production deploy; `tests/invariants/action-link-resolver-ssot.spec.ts` then asserts the
pattern is gone. Owner @okan-wqm, deadline 2026-10-31.

### PLAT-MEDIUM-905 — NATS handlers still hand-roll a tenantId UUID guard

SEC-HIGH-057 introduced `eventTenantScope()` / `requireTenantScope()` in `@platform/event-contracts`
as the one way a consumer parses an event's tenancy, and rewrote `auth-event.handler.ts` on it.
Twelve other handlers still declare their own `UUID_REGEX` / `isValidUUID(event.tenantId)` and
`return` on a miss (acking the message — the PLAT-HIGH-902 shape): notification-service
`alert-triggered`, `billing-event`, `task-event`, `task-assigned`, `messaging-event`,
`feeding-daily-summary`, `harvest-regulatory`, `regulatory-report`, `device-token-revocation`;
ai-service `conversation-privacy-event.handler.ts`; auth-service
`tenant-subscription-projection.handler.ts`; farm-service `tenant-onboarding.event-handler.ts`;
backend-common `tenant-schema-cache-invalidation.subscriber.ts`. Each is a latent copy of the
super-admin drop.

**Fix:** replace every hand-rolled guard with `requireTenantScope(event)` (tenant-only events)
or `eventTenantScope(event)` (platform-capable), returning a `HandlerOutcome.terminate` on a
malformed scope once PLAT-HIGH-902 lands. `tests/invariants/event-tenant-scope-ssot.spec.ts`
carries the allowlist keyed to this finding and fails on staleness. Owner @okan-wqm,
deadline 2026-11-15.

**Measured set (2026-09-05, the invariant's allowlist — the SSoT for this burn-down).** The
shared detector (`tests/invariants/helpers/nats-event-handler.ts`: implements `IEventHandler`
and subscribes on the bus) found **25** handlers carrying a hand-rolled `tenantId` guard, not
the twelve enumerated above — the alert-engine and farm-service handlers use backend-common's
`isValidUUID(event.tenantId)` for the same `return`-on-miss shape:

- notification-service (9): `alert-triggered`, `billing-event`, `task-event`, `task-assigned`,
  `messaging-event`, `feeding-daily-summary`, `harvest-regulatory`, `regulatory-report`,
  `device-token-revocation`
- alert-engine (7): `fcr-alert`, `feed-coverage`, `feeding-execution`, `low-stock`,
  `mortality-alert`, `sensor-reading`, `water-quality-critical`
- farm-service (6): `events/listeners/{farm-stock-projection,harvest-completed,mortality-recorded,sensor-temperature-projection}.listener.ts`,
  `task/services/auto-rule-trigger.service.ts`, `water-quality/event-handlers/tenant-onboarding.event-handler.ts`
- ai-service (1): `conversation/conversation-privacy-event.handler.ts`
- auth-service (1): `modules/tenant/event-handlers/tenant-subscription-projection.handler.ts`
- ~~backend-common (1): `database/tenant-schema-cache/tenant-schema-cache-invalidation.subscriber.ts`~~ —
  migrated to `requireTenantScope` with PLAT-HIGH-902 B3 (2026-09-05); **24** remain.

The allowlist only shrinks: a file that stops matching the guard pattern must be removed from
it (staleness fails the spec), and the spec fails if this finding is RESOLVED while the list is
non-empty.
