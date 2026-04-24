# Scope B — Cross-Service Infrastructure (2026-04-24)

Deferred cross-service infrastructure items: Phase 7.4 (sensor federation),
Phase 7.1 (backend i18n), Phase 6.2.2 (ClamAV async virus scan).

**Canonical repo:** `/var/aqua-saas`
**Active illustrator worktree:** `/tmp/aqua-main-illustrator` (pinned to `main`)

---

Registry discipline: findings.jsonl currently carries INFRA- and PROC- families up to `INFRA-CRITICAL-035`. No `FARM-*-NNN` IDs exist yet. I therefore propose new IDs in the following reserved ranges so the next implementer can register them before phase 1 without collision:
- Cross-service infra items: `INFRA-CRITICAL-036` upward.
- Farm-service-local items (i18n migration of farm errors, upload scan hooks on farm storage module): `FARM-HIGH-001` upward (brand-new series).

---

## Scope 1 — Phase 7.4: Sensor Service Federation

### 1.1 Investigation tasks

Before touching code, verify the following so the plan below still matches reality:

1. **Existing federation posture** — confirm both services are already federation-v2 subgraphs:
   - `/var/aqua-saas/apps/farm-service/src/app.module.ts` lines 6 / 237 use `ApolloFederationDriver` — confirmed.
   - Sensor-service uses the same driver: `/var/aqua-saas/apps/sensor-service/src/app.module.ts` lines 2 / 205. Inspect that forRootAsync to confirm `autoSchemaFile` with `federation: 2` (should match farm-service pattern).
2. **Sensor entities already have `@Directive('@key…')`?** `grep -n "@key" /var/aqua-saas/apps/sensor-service/src` — none today per my search. So `Sensor` + `SensorReading` currently lack federation keys and cannot be extended cross-service.
3. **Gateway supergraph** — sensor subgraph is already registered at `/var/aqua-saas/apps/gateway-api/src/app.module.ts:315`. No new entry is needed; only composition guard tests need updates.
4. **WaterQualityMeasurement shape** — read `/var/aqua-saas/apps/farm-service/src/water-quality/entities/water-quality-measurement.entity.ts` end-to-end to confirm no `sensorReadingId` column yet and to decide which axis (`tankId + timestamp window` or `relatedWaterQualityMeasurementId` reverse ref) is the correlation key. Current usages of `relatedWaterQualityMeasurementId` live only on `fish-health/dto/*`, not on `WaterQualityMeasurement` itself. This is the single biggest source of misdesign risk — confirm before writing the event contract.
5. **Existing event contract** — `/var/aqua-saas/libs/event-contracts/src/sensor-events.ts` already defines `SensorReadingEvent` (v2 flat fields) and `SensorMetricIngestedEvent`. The brief calls for `libs/shared-contracts/src/events/sensor-reading.event.ts`, but `libs/event-contracts/` is where every other event lives, and `libs/shared-contracts/src/` today only holds enums (`grep` confirms). **Decision point:** keep the new contract in `libs/event-contracts/` co-located with the rest, not in `shared-contracts`. Extend the existing `SensorReadingEvent` with a `tankId` + `parameter` + `unit` axis rather than minting a parallel event.
6. **Subgraph introspection timing** — `/var/aqua-saas/apps/gateway-api/src/config/retryable-introspect.ts` already exists (gateway has retry-on-composition-failure). Check its retry budget so deployment-ordering (phase 3 below) sets realistic `depends_on` expectations.
7. **Tenant-scope in `@ResolveReference`** — the farm-service `FarmResolver.resolveReference` at line 55 rejects empty tenantId. Sensor-service must mirror this for multi-tenant safety. Read `/var/aqua-saas/apps/farm-service/src/farm/resolvers/farm.resolver.ts` lines 50-75 as the reference pattern.

### 1.2 Phases

#### Phase S1.1 — Event contract extension

- **Goal:** extend the existing `SensorReadingEvent` with correlation fields so farm-service can match readings to `WaterQualityMeasurement` without a new parallel event shape.
- **Files touched:**
  - edit `/var/aqua-saas/libs/event-contracts/src/sensor-events.ts` — add optional `tankId?: string`, `parameter?: 'temperature'|'ph'|'dissolvedOxygen'|...`, `unit?: string`, `relatedWaterQualityMeasurementId?: string` to `SensorReadingEvent`. Bump the JSDoc to `v3` with a `readings_v3` upcaster note.
  - new `/var/aqua-saas/libs/event-contracts/src/upcasters/sensor-reading-v2-to-v3.upcaster.ts` — identity upcaster (all new fields optional, old v2 events still valid).
  - edit `/var/aqua-saas/libs/event-contracts/src/schemas/*` — add Zod/JSON schema for the three new fields.
  - edit `/var/aqua-saas/libs/event-contracts/src/__tests__/sensor-events.spec.ts` — round-trip + upcaster tests.
- **Validation / audit / test:**
  - Zod schema test with `strict: false` for legacy + `strict: true` for v3.
  - Upcaster invariant test: `upcast(v2) ↔ v3` with new fields absent.
  - Banned-phrase grep in new text.
- **Risk + rollback:** zero-risk — all new fields are optional. Rollback = revert commit; no data migration.
- **LOC / PRs:** ~120 LOC, 1 PR.

#### Phase S1.2 — Sensor-service exposes `SensorReading` and `Sensor` as federated entities

- **Goal:** mark `SensorReading` + `Sensor` with `@key(fields: "id")`, implement `@ResolveReference` with tenant guard.
- **Files touched:**
  - edit `/var/aqua-saas/apps/sensor-service/src/database/entities/sensor-reading.entity.ts` — add `@Directive('@key(fields: "id")')` above `@ObjectType()`, add `shareable` marker if needed.
  - edit `/var/aqua-saas/apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts` — add `@ResolveReference` method for `Sensor`. Mirror `FarmResolver.resolveReference` tenant-guard shape.
  - new `/var/aqua-saas/apps/sensor-service/src/sensor/resolvers/sensor-reading.resolver.ts` — dedicated resolver hosting `@Resolver(() => SensorReading)` + `@ResolveReference` + a tenant-scoped `sensorReadingsByTank(tankId, range)` query. (Today `SensorReading` has no resolver class — the sensor resolver exposes list queries but there is no entity-level `@Resolver` for it.)
  - edit `/var/aqua-saas/apps/sensor-service/src/sensor/sensor.module.ts` — register the new resolver.
  - new `/var/aqua-saas/apps/sensor-service/src/sensor/__tests__/sensor-reading.resolver.spec.ts` — unit test `@ResolveReference` happy path + empty-tenantId rejection.
  - edit `/var/aqua-saas/apps/sensor-service/src/__tests__/e2e/federation-composition.e2e-spec.ts` (new if missing) — boot NestJS, introspect schema, assert `SensorReading` carries `@key(fields: "id")` directive.
- **Validation / audit / test:**
  - p0-fixes-style test mirroring `apps/farm-service/src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts:89` — assert empty tenantId in `resolveReference` returns null, not 500.
  - Snapshot of generated SDL to guard against accidental directive loss.
  - Audit note in PR description: who can access `SensorReading.__resolveReference` and why tenantId gate is safe.
- **Risk + rollback:** medium. Adding `@key` to an existing type is a federation-breaking composition change: if any other subgraph already exposes a conflicting `SensorReading`, the gateway will fail to compose. Mitigation: Phase S1.5 (deployment ordering) deploys sensor-service first with the new schema, and the gateway's `RetryableIntrospectAndCompose` buys a rollback window. Rollback = revert Directive addition; gateway recomposes.
- **LOC / PRs:** ~280 LOC, 1 PR.

#### Phase S1.3 — Farm-service `Tank.sensorReadings` extension

- **Goal:** farm-service's `Tank` gains a `sensorReadings(range): [SensorReading!]!` field resolved via federation.
- **Files touched:**
  - edit `/var/aqua-saas/apps/farm-service/src/tank/entities/tank.entity.ts` — retain existing `@key(fields: "id")` on line 192. No additions here; the field lives on the resolver side.
  - new `/var/aqua-saas/apps/farm-service/src/tank/resolvers/tank-sensor-reading.resolver.ts` — declare `@ResolveField(() => [SensorReading])` on `Tank` returning federation reference stubs `{ __typename: 'SensorReading', id: … }`. The representation is fetched by passing `{ tankId }` through a keyed query on sensor-service.
  - Alternative pattern if sensor-service's `SensorReading.id` is not the natural join key: extend `Tank` with `@extends @external` references to `Sensor[]`, then resolve inside farm-service using a sensor-service NATS responder. The resolver file above must pick the direction explicitly — see Open Questions.
  - new `/var/aqua-saas/apps/farm-service/src/tank/__tests__/tank-sensor-reading.resolver.spec.ts` — mocked supergraph composition.
  - edit `/var/aqua-saas/apps/farm-service/src/tank/tank.module.ts` — register the new resolver.
- **Validation / audit / test:**
  - Jest snapshot of generated SDL under `@nestjs/graphql` to verify the `extend type SensorReading @key(fields: "id")` + `extend type Tank { sensorReadings(...): [SensorReading!]! }` output.
  - Supertest against a two-process composition: spin up stub sensor-service, real farm-service, gateway — query `tank { sensorReadings { id readings { temperature } } }`.
- **Risk + rollback:** medium-high. The resolver's N+1 risk is real — the sensor-service `sensorReadingsByTank` responder must take a list of `tankId`s and a time window. Rollback = remove the `@ResolveField`; existing `tank { id name }` queries unaffected.
- **LOC / PRs:** ~220 LOC, 1 PR.

#### Phase S1.4 — Gateway composition guard + cross-service integration tests

- **Goal:** automated guard preventing anyone from removing `@key` from `SensorReading` or breaking `Tank.sensorReadings` in a subsequent PR.
- **Files touched:**
  - new `/var/aqua-saas/apps/gateway-api/src/__tests__/e2e/supergraph-composition.e2e-spec.ts` — boot all subgraph stubs with their SDL, compose via `@apollo/composition`, assert zero composition errors.
  - new `/var/aqua-saas/e2e/sensor-tank-federation.e2e-spec.ts` — end-to-end against the real three-process stack (farm + sensor + gateway) via `docker-compose.dev.yml`. Uses Testcontainers or the existing `e2e/` harness (see `/var/aqua-saas/e2e` to confirm convention).
  - edit `/var/aqua-saas/apps/gateway-api/src/config/retryable-introspect.ts` — no code change expected; verify the retry budget is ≥ 30s for prod so a sensor-service cold start doesn't trip composition.
- **Validation / audit / test:**
  - CI gate: the new e2e test runs on every PR that touches `apps/sensor-service/**` or `apps/farm-service/src/tank/**`.
  - Prometheus metric assertion: `gateway_supergraph_composition_failures_total` stays flat during the rolling deploy rehearsal.
- **Risk + rollback:** low (test-only code).
- **LOC / PRs:** ~180 LOC, 1 PR.

#### Phase S1.5 — Deployment ordering + k8s manifest update

- **Goal:** guarantee sensor-service ships with the new subgraph schema before farm-service ships the consuming `@ResolveField`.
- **Files touched:**
  - edit `/var/aqua-saas/infrastructure/kubernetes/base/sensor-service.yaml` — bump image tag + add readiness-probe on `/graphql?query={__schema{types{name}}}` confirming `SensorReading` has `_entities` coverage.
  - edit `/var/aqua-saas/infrastructure/kubernetes/base/farm-service.yaml` — same readiness discipline.
  - edit `/var/aqua-saas/infrastructure/kubernetes/base/gateway-api.yaml` (if present — confirmed) — the gateway's existing retryable introspection handles rolling, but add an initContainer that `curl`s both subgraphs' `/health/ready` before the gateway pod starts.
  - new `/var/aqua-saas/docs/runbooks/sensor-federation-rollout.md` — 3-step rollout (sensor-service first, wait composition-OK, farm-service second), rollback plan, on-call pager text.
- **Validation / audit / test:**
  - Staging rehearsal: deploy to `deploy/staging` with a chaos-roll (kill sensor-service pod during farm-service rollout), confirm gateway composes after ≤ 30s.
  - Runbook dry-run signed off by two reviewers per the standing rules.
- **Risk + rollback:** high if skipped, low if followed. Rollback = Argo CD sync to previous revision (both kustomization overlays).
- **LOC / PRs:** ~90 LOC + runbook, 1 PR.

### 1.3 Pre-registered findings to close

Propose these IDs and register them in `/var/aqua-saas/docs/reviews/_registry/findings.jsonl` before phase S1.1 lands:

- `INFRA-CRITICAL-036` — "Sensor + farm services publish independent GraphQL schemas with no cross-reference of the natural sensor↔tank join. Operators must correlate by hand via two UIs." Closed by S1.3.
- `INFRA-HIGH-005` — "`SensorReadingEvent` v2 lacks `tankId`/`parameter`/`unit` axes required for farm-service water-quality correlation." Closed by S1.1.
- `INFRA-MEDIUM-015` — "Sensor-service does not implement `@ResolveReference` — any future federated extension silently breaks under tenant-scope rules." Closed by S1.2.
- `INFRA-MEDIUM-016` — "Gateway rolling deploy has no composition-guard CI test; a PR that removes `@key` from a federated entity would ship and break prod at pod start." Closed by S1.4.

### 1.4 Sequencing

S1.1 → S1.2 → S1.3 → S1.4 → S1.5. Events first (smallest blast radius), then subgraph schema, then cross-service consumer, then guard, then rollout. Do not merge S1.3 before S1.2 is in prod for ≥ 24h — the gateway will attempt to resolve `SensorReading` references that sensor-service cannot yet answer.

### 1.5 Open questions

- **A)** Who owns `SensorReading` in the federated supergraph:
  - A1. sensor-service owns it with `@key(fields: "id")`, farm-service only consumes. *(Recommended.)*
  - A2. sensor-service marks `@shareable` and farm-service co-owns. Rejected: multi-ownership of hot-path time-series readings violates ADR-022 data/control-plane cut.
- **B)** Correlation direction on water-quality:
  - B1. Farm-service writes `WaterQualityMeasurement.sensorReadingId` on every sensor-initiated measurement (requires schema migration on farm DB).
  - B2. Farm-service resolves `WaterQualityMeasurement.sensorReading` via federation using `tankId + closestTimestamp` heuristic (no migration, but N+1 risk).
- **C)** Integration test harness:
  - C1. Docker-compose based (slow, real).
  - C2. In-process subgraph composition via `@apollo/composition` (fast, skips the network). *(Recommended for PR-gate; keep C1 for nightly.)*

---

## Scope 2 — Phase 7.1: i18n

### 2.1 Investigation tasks

1. **Confirm zero i18n deps today** — `grep -n "i18n\|locale\|intl" /var/aqua-saas/package.json` returns nothing except `site.entity.ts:112` which is an unrelated tenant site locale column. Confirmed: no `@nestjs/i18n` installed.
2. **Inventory error files** — `grep -rln "FarmAppError\|extends AppError\|extends HttpException" /var/aqua-saas/apps` to enumerate every error subclass. Farm-service has 5 subclasses in `farm-errors.ts` today. Do the same grep for sensor-service, hr-service, billing-service, auth-service to build the per-service ownership matrix.
3. **Hardcoded message audit** — every call site that *constructs* `FarmAppError` subclasses passes a pre-formatted `userMessage`. Find them: `grep -rn "new BatchWithdrawalBlockedError\|new TankCapacityExceededError\|new BackdateBlockedError\|new RestoreUniquenessConflictError\|new HarvestPlanRequiredError" /var/aqua-saas/apps`. Each call site currently interpolates user data directly into a Turkish sentence. These are the migration targets.
4. **GraphQL enum labels** — grep `registerEnumType` usage, especially `/var/aqua-saas/apps/farm-service/src/tank/entities/tank.entity.ts` lines 60-83 where `TankType`/`TankMaterial` have Turkish `description` strings. Decide in Phase 2.3 whether enum labels go through i18n or remain API-stable English enum codes with frontend-side labelling.
5. **JWT locale claim surface** — `/var/aqua-saas/apps/auth-service/src/modules/authentication/services/token.service.ts:37` `JwtPayload` has no `locale`. Verify every consumer type (`/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts`) so adding `locale?: string` is a non-breaking extension.
6. **Tenant default locale** — `/var/aqua-saas/apps/farm-service/src/site/entities/site.entity.ts:112` already has `locale` on `Site`, and `farm-seed.service.ts:299` defaults to `'tr-TR'`. Decide if Site.locale or a new `TenantSettings.defaultLocale` column is the right anchor.
7. **Existing filter wire-up** — `/var/aqua-saas/apps/farm-service/src/app.module.ts:547` binds `FarmAppErrorFilter` via `APP_FILTER`. The filter is where `userMessage` gets surfaced to GraphQL. That is the single right place to perform translation at emission time.

### 2.2 Phases

#### Phase I1 — Dependency install + SHA pin

- **Goal:** land `@nestjs/i18n` + peer deps with integrity-checked lockfile.
- **Files touched:**
  - edit `/var/aqua-saas/package.json` — add `@nestjs/i18n` (pin to the version compatible with the monorepo's NestJS v10/11; consult `@nestjs/core` version there). Add `accept-language-parser` for HTTP header fallback.
  - edit `/var/aqua-saas/package-lock.json` — regenerated via `npm install`, verify SHAs against the npm registry advisory DB.
  - new `/var/aqua-saas/docs/adr/ADR-0NN-i18n-backend.md` — record the choice of `@nestjs/i18n` over alternatives (`i18next-node`, custom Accept-Language middleware) and the cache strategy.
- **Validation / audit / test:**
  - Snyk / npm audit gate on the new dep version.
  - Reproducible-build check: `npm ci --ignore-scripts` must produce an identical lockfile hash on two CI runners.
- **Risk + rollback:** low. Rollback = revert package.json + lockfile.
- **LOC / PRs:** ~30 LOC (mostly deps), 1 PR.

#### Phase I2 — Shared translation infrastructure in `libs/backend-common`

- **Goal:** one `I18nModule` wrapper + loader + translation-file convention that every service imports, instead of each service reinventing the pattern.
- **Decision:** translation files live under `libs/backend-common/src/i18n/{tr,en,no}/*.json` split by service namespace (`farm.json`, `sensor.json`, `auth.json`, ...). Rejected per-service `apps/<svc>/src/i18n/` because cross-service error messages (tenant-banned, rate-limited) would duplicate.
- **Files touched:**
  - new `/var/aqua-saas/libs/backend-common/src/i18n/i18n.module.ts` — wraps `I18nModule.forRoot` with `AcceptLanguageResolver`, `HeaderResolver`, and a custom `JwtLocaleResolver` that reads `request.user.locale`.
  - new `/var/aqua-saas/libs/backend-common/src/i18n/jwt-locale.resolver.ts`.
  - new `/var/aqua-saas/libs/backend-common/src/i18n/tenant-locale.resolver.ts` — reads `TenantSettings.defaultLocale` via NATS request to config-service (or a lazy-cached in-process lookup).
  - new `/var/aqua-saas/libs/backend-common/src/i18n/translations/{tr,en,no}/common.json` — shared keys (validation errors, auth errors, rate-limit, tenant-banned).
  - new `/var/aqua-saas/libs/backend-common/src/i18n/__tests__/resolver-precedence.spec.ts` — asserts JWT > tenant-default > Accept-Language > EN fallback.
  - edit `/var/aqua-saas/libs/backend-common/src/index.ts` — re-export.
- **Validation / audit / test:**
  - Unit: missing-key returns EN fallback + logs warning at `warn`, not `error`.
  - Unit: precedence chain tested all 4 layers.
  - Banned-phrase lint on new text.
- **Risk + rollback:** medium. Adding `I18nModule` globally means any service that imports `backend-common` picks it up. The module must be opt-in (`forRoot({ enabled: process.env.I18N_ENABLED === 'true' })`) in Phase I2, becoming default-on in Phase I5.
- **LOC / PRs:** ~450 LOC, 1 PR.

#### Phase I3 — JWT `locale` claim

- **Goal:** auth-service issues tokens carrying `locale`; every service propagates it via request context.
- **Files touched:**
  - edit `/var/aqua-saas/apps/auth-service/src/modules/authentication/services/token.service.ts` — add `locale?: string` to `JwtPayload`, populate from `User.preferredLanguage` (new column, see below) at token mint.
  - new `/var/aqua-saas/database/migrations/modules/auth/NNNN-add-user-preferred-language.ts` — `users.preferred_language varchar(5) NOT NULL DEFAULT 'en'`.
  - edit `/var/aqua-saas/apps/auth-service/src/modules/users/user.entity.ts` (confirm path) — add `preferredLanguage`.
  - edit `/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts` — relax `JwtPayload` interface to include optional `locale`.
  - new `/var/aqua-saas/apps/auth-service/src/modules/users/__tests__/locale-mint.spec.ts`.
- **Validation / audit / test:**
  - Backward compat: old tokens without `locale` default to EN.
  - Migration is idempotent, includes `DOWN`.
- **Risk + rollback:** medium. Adding a JWT claim during a rolling deploy means some in-flight tokens will have it, some won't. Resolver chain in I2 must treat it as optional. Rollback = revert mint change, keep column (harmless).
- **LOC / PRs:** ~150 LOC, 1 PR.

#### Phase I4 — Farm-service error migration (wave 1)

- **Goal:** convert the 5 `FarmAppError` subclasses + their call sites to use i18n keys instead of hardcoded Turkish.
- **Decision:** incremental wave-by-wave. Farm-service first because it's the highest-volume error surface and where the `FarmAppErrorFilter` lives. Bang-migration rejected because the 300+ call-site blast radius makes review impossible.
- **Files touched:**
  - new `/var/aqua-saas/libs/backend-common/src/i18n/translations/{tr,en,no}/farm.json` — keys: `farm.errors.batchWithdrawalBlocked`, `farm.errors.tankCapacityExceeded.biomass`, `farm.errors.tankCapacityExceeded.density`, etc. Include ICU plurals for `{daysRemaining, plural, ...}`.
  - edit `/var/aqua-saas/apps/farm-service/src/common/errors/farm-app-error.ts` — add `userMessageKey: string` + `userMessageArgs?: Record<string, unknown>` params; keep `userMessage` as a *fallback* for call sites not yet migrated (dual-write for the migration window).
  - edit `/var/aqua-saas/apps/farm-service/src/common/errors/farm-app-error.filter.ts` — resolve the key through `I18nService.translate(key, { lang: resolveLocale(request), args })` at emission time. Locale-resolve chain: JWT > tenant-default > Accept-Language > `'en'`.
  - edit `/var/aqua-saas/apps/farm-service/src/common/errors/farm-errors.ts` — each subclass now takes `userMessageKey`.
  - edit ~5 call sites per error subclass (find via grep from investigation task 3) — replace hardcoded Turkish sentences with key + args.
  - edit `/var/aqua-saas/apps/farm-service/src/common/errors/__tests__/farm-errors.spec.ts` — assert key resolution + fallback.
- **Validation / audit / test:**
  - Every migrated call site has a matching key in all three locale files (enforce via jest test that loads all JSONs and asserts coverage).
  - Missing-key lint: `libs/backend-common/src/i18n/__tests__/key-coverage.spec.ts` — every key referenced in code must exist in `tr/en/no`.
- **Risk + rollback:** medium. User-visible error copy changes. Rollback plan: keep `userMessage` dual-write until the migration is live in prod for 7 days. Rollback = switch filter to prefer `userMessage` over translated key.
- **LOC / PRs:** ~800 LOC (mostly JSON + call-site edits), 1 PR per error subclass = 5 PRs.

#### Phase I5 — Service-by-service migration (waves 2-N)

- **Goal:** repeat I4 shape for sensor-service, hr-service, billing-service, auth-service, admin-api-service.
- **Files touched:** mirror I4 per service. Each service gets its own `{service}.json` translation file + its own error filter updated.
- **Validation / audit / test:** per-wave test discipline identical to I4.
- **Risk + rollback:** low per-wave (each service independent). Rollback = revert single-service PR.
- **LOC / PRs:** ~600 LOC per service × 5 services = ~3000 LOC, 5 PRs.

#### Phase I6 — Tenant default locale + precedence enforcement

- **Goal:** tenant admins set a default locale; individual users override via JWT claim.
- **Files touched:**
  - new `/var/aqua-saas/database/migrations/modules/config/NNNN-add-tenant-default-locale.ts` — `tenant_settings.default_locale varchar(5) NOT NULL DEFAULT 'en'`.
  - edit `/var/aqua-saas/apps/config-service/...` — GraphQL mutation `setTenantDefaultLocale`.
  - edit `/var/aqua-saas/libs/backend-common/src/i18n/tenant-locale.resolver.ts` — wire real lookup (stubbed in I2).
  - new `/var/aqua-saas/docs/runbooks/i18n-locale-precedence.md` — document JWT > tenant-default > Accept-Language > EN.
- **Validation / audit / test:** e2e test asserting precedence across a three-layer fixture.
- **Risk + rollback:** low.
- **LOC / PRs:** ~200 LOC, 1 PR.

#### Phase I7 — GraphQL enum i18n (optional, last)

- **Goal:** decide whether `registerEnumType(TankType, { description })` Turkish descriptions move to i18n or are frozen as English codes.
- **Decision point:** *not recommended*. Enum SDL is API contract; clients cache schemas. Instead, expose a separate `tankTypeLabel(code: TankType, locale: String): String` query. Document this in ADR.
- **Files touched:** none if the decision is "don't move enums". If yes: new `label.resolver.ts` per entity + fallback.
- **Risk + rollback:** high if attempted (schema churn). Defer.

### 2.3 Pre-registered findings

- `FARM-HIGH-001` — "Farm-service error userMessage strings are hardcoded Turkish; Norwegian + English operators see Turkish errors." Closed by I4.
- `FARM-HIGH-002` — "JWT locale propagation missing; cross-tenant tokens have no per-user language preference." Closed by I3.
- `INFRA-HIGH-006` — "`@nestjs/i18n` assumed in plan but not installed; no shared translation infrastructure across microservices." Closed by I1 + I2.
- `INFRA-MEDIUM-017` — "Tenant default locale has no storage column or resolver precedence definition." Closed by I6.
- `FARM-MEDIUM-001` — "Missing-translation behaviour undefined — production could surface raw keys to operators." Closed by I2's fallback-to-EN test.

### 2.4 Sequencing

I1 → I2 → I3 (I2 and I3 can run in parallel) → I4 → I5 (per-service, parallel within wave) → I6 → I7 (optional, defer).

**Cross-scope gate:** I4 must not merge before Scope 1's S1.1 if both are in-flight, because the new `SensorReading` event correlation may carry user-facing copy that needs its own translation keys. Concretely: if a federation resolver throws `SensorReadingCorrelationFailedError`, register the key in `farm.json` during I4.

### 2.5 Open questions

- **D)** Translation file structure:
  - D1. Central `libs/backend-common/src/i18n/translations/{tr,en,no}/{service}.json`. *(Recommended.)*
  - D2. Per-service `apps/<svc>/src/i18n/{tr,en,no}.json`.
- **E)** Fallback strategy when a key is missing:
  - E1. Fall back to EN + log warning. *(Recommended, matches existing `EXIF strip failed` pattern in `file-upload-security.service.ts:222`.)*
  - E2. Return the raw key (useful for translators).
  - E3. Throw (rejected — fails closed on a translation miss, which is a bad posture for a non-security concern).
- **F)** Migration mode:
  - F1. Incremental wave-by-wave. *(Recommended.)*
  - F2. Big-bang single PR across every service. Rejected.
- **G)** Locale precedence: JWT > tenant-default > Accept-Language > EN. Needs user sign-off on the order.

---

## Scope 3 — Phase 6.2.2: ClamAV Async Virus Scan

### 3.1 Investigation tasks

1. **Confirm scan hook point exists** — `/var/aqua-saas/libs/storage/src/file-upload-security.service.ts:163` already carries the phase-6.2.1 EXIF strip. The `scanAfterUpload` entry referenced in the file's JSDoc (line 28) does NOT yet exist as a method — verify via `grep -n "scanAfterUpload" /var/aqua-saas/libs/storage`. Confirmed absent.
2. **Upload callers inventory** — `grep -rln "FileUploadSecurityService"` returns only the lib itself + 1 doc. Zero services consume it yet. This is critical: Scope 3 can therefore land without migrating existing upload paths, BUT the chemical/batch/health upload resolvers in farm-service (`/var/aqua-saas/apps/farm-service/src/chemical/chemical.resolver.ts:112`) are going direct-to-MinIO today. They must be routed through `FileUploadSecurityService` before the scan matters. Flag this as Phase V0 (prerequisite).
3. **Docker-compose stack** — `grep -n "clamav\|clamd" /var/aqua-saas/docker-compose.*yml` returns nothing. No ClamAV today.
4. **K8s manifest pattern** — `/var/aqua-saas/infrastructure/kubernetes/base/farm-service.yaml` is the template for new service manifests. Check it for: sidecar pattern (does any service already use a sidecar container?), resource-limits conventions, livenessProbe patterns.
5. **Minio multi-bucket support** — `/var/aqua-saas/libs/storage/src/minio-client.service.ts:23` has a single `bucket` field; quarantine bucket needs a second client or a `target bucket` parameter on `uploadFile`/`moveObject`. Read lines 160-200 for the existing mutation surface.
6. **Outbox availability** — `/var/aqua-saas/platform/libs/outbox/src/index.ts` is present. The scan consumer will be an outbox worker, not a cron, aligning with the event-sourced pattern.
7. **Notification path** — find `NotificationService` / email / Slack channels. `grep -rln "NotificationService\|slack" /var/aqua-saas/apps/notification-service/src` — confirm the `sendAlert` entry point exists.
8. **Fail-closed precedent** — the codebase already uses fail-closed on security pillars (file-upload security rejects unknown `documentType` per the comment at line 60-62 of `file-upload-security.service.ts`). ClamAV healthcheck down must follow this precedent.

### 3.2 Phases

#### Phase V0 — Route existing upload call sites through `FileUploadSecurityService`

- **Goal:** zero service calls `MinioClientService.uploadFile` directly; every byte goes through the security wrapper.
- **Files touched:**
  - edit `/var/aqua-saas/apps/farm-service/src/chemical/chemical.resolver.ts` — replace direct MinIO with `FileUploadSecurityService.upload(secureRequest)`.
  - edit every other `uploadFile` caller (grep `"MinioClientService"` in apps/) and migrate.
  - edit `/var/aqua-saas/libs/storage/src/storage.module.ts` — mark `MinioClientService` as non-exported from the public API of the module (keep it provider-internal); export only `FileUploadSecurityService`.
- **Validation / audit / test:**
  - Lint rule: banned-import from outside `libs/storage` for `MinioClientService`.
  - Test: each migrated resolver has a unit test that the security wrapper ran.
- **Risk + rollback:** low. No behavioural change if the policies already cover the document types.
- **LOC / PRs:** ~300 LOC, 1 PR.

#### Phase V1 — Decide and document the sidecar topology

- **Goal:** pick one of: per-pod sidecar, shared ClamAV Deployment, on-demand Lambda. Write an ADR so the next PR reviewer doesn't relitigate.
- **Decision (recommended):** **shared ClamAV Deployment with internal K8s Service** (not a sidecar, not Lambda). Rationale:
  - Sidecar per pod multiplies signature-DB storage (200MB×N pods) and wastes RAM; ClamAV's memory footprint is ~1GB.
  - Lambda-style on-demand scanning adds cold-start latency and costs per invocation; our upload volume is steady.
  - A shared `clamav` Deployment (2 replicas for HA) behind a ClusterIP service named `clamav` on port 3310 (clamd TCP) is the industry-standard shape.
- **Files touched:**
  - new `/var/aqua-saas/docs/adr/ADR-0NN-clamav-topology.md`.
- **Validation / audit / test:** ADR signed off before Phase V2.
- **Risk + rollback:** documentation only.
- **LOC / PRs:** 1 ADR file, 1 PR.

#### Phase V2 — Deploy ClamAV infrastructure (dev + prod)

- **Goal:** running ClamAV daemon reachable from every service's pod network.
- **Files touched:**
  - new `/var/aqua-saas/infrastructure/kubernetes/base/clamav.yaml` — Deployment (2 replicas), Service (ClusterIP on 3310), PVC for signature DB, CronJob for daily `freshclam` update inside the deployment's initContainer + sidecar `freshclam --daemon` with `--checks=24`.
  - edit `/var/aqua-saas/infrastructure/kubernetes/base/kustomization.yaml` — include `clamav.yaml`.
  - edit `/var/aqua-saas/docker-compose.dev.yml` — add `clamav` service (use `clamav/clamav:stable` image), mount a volume for sig DB, expose 3310.
  - edit `/var/aqua-saas/docker-compose.infra.yml` — same, for dev ergonomics.
  - new `/var/aqua-saas/infrastructure/kubernetes/base/clamav-freshclam-job.yaml` — daily CronJob that also queries `clamd VERSION` and alerts if DB age > 24h.
  - new `/var/aqua-saas/infrastructure/monitoring/prometheus/clamav-rules.yaml` — Prometheus alert rules: `ClamAVSignatureStale` (age > 24h), `ClamAVDown` (no healthy replicas), `ClamAVScanLatencyHigh` (p99 > 5s).
- **Validation / audit / test:**
  - Staging rehearsal: upload a EICAR test file, verify it's flagged.
  - SLO: signature DB freshness < 24h; alert wired.
  - Dev compose rehearsal: `docker compose -f docker-compose.dev.yml up clamav` and telnet 3310.
- **Risk + rollback:** medium. ClamAV pod can OOM on large files; set `resources.limits.memory=2Gi`. Rollback = scale deployment to 0 + fall through to fail-closed (V4).
- **LOC / PRs:** ~250 LOC (YAML), 1 PR.

#### Phase V3 — Scan client + storage-service integration

- **Goal:** `FileUploadSecurityService` exposes `scanAfterUpload(uploadResult)` that dispatches to an async worker via outbox event; worker calls ClamAV and acts on the result.
- **Files touched:**
  - edit `/var/aqua-saas/package.json` — add `clamscan` (Node client for clamd). Pin with SHA.
  - new `/var/aqua-saas/libs/storage/src/clamav-client.service.ts` — wraps `clamscan`, reads `CLAMAV_HOST` + `CLAMAV_PORT` from env, exposes `async scanStream(stream): Promise<ScanResult>`.
  - edit `/var/aqua-saas/libs/storage/src/file-upload-security.service.ts`:
    - After `MinioClientService.uploadFile`, emit a `StorageObjectUploadedEvent` to the outbox (subject `storage.object.uploaded`). Fire-and-forget from the request's perspective (upload response returns 201 immediately — see performance budget in section 3.5).
    - Remove the stale JSDoc about `scanAfterUpload`; replace with the new contract.
  - new `/var/aqua-saas/libs/event-contracts/src/storage-events.ts` already exists (see `ls` output above). Extend with `StorageObjectUploadedEvent` + `FileInfectedEvent` + `FileScannedCleanEvent`.
  - new `/var/aqua-saas/libs/storage/src/workers/virus-scan.worker.ts` — `@EventHandler('storage.object.uploaded')` — downloads the object, calls `ClamAVClientService.scanStream`, on infected emits `FileInfectedEvent` + moves to quarantine bucket; on clean emits `FileScannedCleanEvent` + tags the object `x-amz-meta-scan-status: clean`.
  - edit `/var/aqua-saas/libs/storage/src/minio-client.service.ts` — add `moveObject(sourcePath, targetBucket, targetPath): Promise<void>`.
  - edit `/var/aqua-saas/libs/storage/src/storage.module.ts` — register new providers.
- **Validation / audit / test:**
  - Unit: `ClamAVClientService` with mocked `clamscan`, clean + infected paths.
  - Integration: real ClamAV in docker-compose, EICAR-infected file, assert quarantine bucket contents + outbox event.
  - Performance test: p95 scan latency per file.
  - Banned-phrase gate.
- **Risk + rollback:** medium. The async worker might lag — quarantine moves may race against a user's download. Mitigation: the upload response includes `scanStatus: 'pending'`; frontend shows a "scanning..." badge until `FileScannedCleanEvent` arrives (via WebSocket). Rollback = disable the worker, objects stay unscanned (log a WARN, monitor for regression).
- **LOC / PRs:** ~700 LOC, 1 PR.

#### Phase V4 — Fail-closed enforcement on ClamAV down

- **Goal:** if ClamAV is unhealthy, upload endpoints return 503 rather than accepting unscannable bytes.
- **Files touched:**
  - edit `/var/aqua-saas/libs/storage/src/clamav-client.service.ts` — `async isHealthy(): Promise<boolean>` that does `clamd PING`.
  - edit `/var/aqua-saas/libs/storage/src/file-upload-security.service.ts` — pre-flight check calls `clamavClient.isHealthy()`; if false, throw `ServiceUnavailableException('Virus scanner unhealthy — upload temporarily unavailable')`.
  - new `/var/aqua-saas/apps/farm-service/src/health/indicators/clamav.health.ts` — NestJS Terminus health indicator.
  - edit `/var/aqua-saas/apps/farm-service/src/health/health.module.ts` — register new indicator.
  - new `/var/aqua-saas/libs/storage/src/__tests__/file-upload-security.fail-closed.spec.ts`.
- **Validation / audit / test:**
  - Chaos test: kill ClamAV pod, assert upload returns 503, liveness probe on farm-service still passes (readiness only fails).
  - Audit: explicitly document "fail-closed on scanner health" in the ADR.
- **Risk + rollback:** fail-closed is a design choice per the standing rules. The alternative (fail-open with retry-later) is unacceptable per posture. Rollback = toggle `VIRUS_SCAN_REQUIRED=false` env var for emergency; makes system fail-open.
- **LOC / PRs:** ~180 LOC, 1 PR.

#### Phase V5 — Infected-file response + notification + uploader throttling

- **Goal:** infected files trigger the full security response: quarantine → email → Slack → audit log → uploader soft-block.
- **Files touched:**
  - edit `/var/aqua-saas/libs/storage/src/workers/virus-scan.worker.ts` — on infected:
    - Move object to `${bucket}-quarantine` via `MinioClientService.moveObject`.
    - Emit `FileInfectedEvent` to NATS (consumed by notification-service + audit-service).
    - Write an audit log row via `AuditService`.
  - edit `/var/aqua-saas/apps/notification-service/src/...` — new handler for `FileInfectedEvent`:
    - Email to the tenant's security contact (template per-locale — ties into Scope 2's i18n).
    - Slack webhook to the platform security channel.
  - new `/var/aqua-saas/apps/admin-api-service/src/security/uploader-blocklist.service.ts` — after 3 infected uploads in 24h from the same user, auto-add to the per-tenant uploader blocklist.
  - new `/var/aqua-saas/database/migrations/modules/security/NNNN-uploader-blocklist.ts` — `uploader_blocklist(tenant_id, user_id, reason, blocked_at, unblocks_at)`.
  - edit `/var/aqua-saas/libs/storage/src/file-upload-security.service.ts` — preflight checks the blocklist; blocked users get 403 with a localised message.
- **Validation / audit / test:**
  - e2e: 3 EICAR uploads from the same user → 4th upload returns 403.
  - Audit trail assertion: every infected-upload has a row in the audit table.
  - i18n key coverage: `common.errors.uploaderBlocked` in all three locales.
- **Risk + rollback:** medium. Auto-blocking is a strong action; ensure the admin can manually unblock. Rollback = set threshold to ∞.
- **LOC / PRs:** ~500 LOC, 1 PR.

#### Phase V6 — Signature freshness monitoring + runbook

- **Goal:** operators get paged if ClamAV signatures exceed 24h old.
- **Files touched:**
  - new `/var/aqua-saas/infrastructure/monitoring/prometheus/clamav-rules.yaml` — already partially from V2; finalise alert routing.
  - new `/var/aqua-saas/docs/runbooks/clamav-signature-stale.md` — step-by-step: SSH to freshclam pod, run manual update, verify `clamd RELOAD`.
  - edit `/var/aqua-saas/apps/farm-service/src/health/indicators/clamav.health.ts` — extend to include signature age in health output.
- **Validation / audit / test:**
  - Runbook dry-run on staging.
  - Alert routing test via Prometheus dry-run.
- **Risk + rollback:** low.
- **LOC / PRs:** ~150 LOC + runbook, 1 PR.

### 3.3 Pre-registered findings

- `FARM-CRITICAL-001` — "Upload pipeline has no virus scanning; any file placed in MinIO is trusted." Closed by V3.
- `INFRA-CRITICAL-037` — "No ClamAV deployment exists in any environment; Phase 6.2.2 infrastructure deferral makes production non-compliant with standing security posture." Closed by V2.
- `FARM-HIGH-003` — "Farm-service resolver uploads bypass `FileUploadSecurityService` and go direct to MinIO." Closed by V0.
- `INFRA-HIGH-007` — "No fail-closed posture on upload when virus scanner is down." Closed by V4.
- `FARM-MEDIUM-002` — "Infected uploads have no operator notification path; security team finds out via audit-log review." Closed by V5.
- `INFRA-MEDIUM-018` — "ClamAV signature DB freshness has no alert — stale-signature scans are silent." Closed by V6.

### 3.4 Sequencing

V0 (prereq — migrate call sites) → V1 (topology ADR) → V2 (infra) → V3 (client + worker) → V4 (fail-closed) → V5 (notification + throttle) → V6 (monitoring).

**Cross-scope dependency on Scope 2:** V5's operator-notification email body should be i18n-aware. V5 can ship with hardcoded EN first and be migrated via Scope 2 Phase I5 later — this is the natural ordering because V5's blast radius is smaller than blocking on full i18n landing.

### 3.5 Open questions

- **H)** Sidecar pattern:
  - H1. Shared `clamav` Deployment with ClusterIP Service. *(Recommended, see V1 ADR rationale.)*
  - H2. Per-service-pod sidecar container.
  - H3. On-demand Lambda / AWS GuardDuty integration (cloud-native, adds $/invocation cost).
- **I)** Scan ownership:
  - I1. Outbox event consumer worker inside `libs/storage`. *(Recommended — aligns with event-sourced posture.)*
  - I2. Cron scanning unscanned objects nightly.
  - I3. Synchronous scan in the upload request path (rejected — blocks UX for 1-5s per file).
- **J)** Infected-file handling:
  - J1. Move to quarantine bucket + keep for 30 days for forensics. *(Recommended.)*
  - J2. Delete immediately. Rejected — forensics lost.
- **K)** Signature DB freshness: auto-update every 6h via sidecar `freshclam --daemon` + alert if `age > 24h`. Needs sign-off.
- **L)** Fail-closed scope:
  - L1. Block uploads only. *(Recommended.)*
  - L2. Block uploads AND reads of unscanned existing files (stricter — breaks backward compat for pre-scan files).
- **M)** Performance budget:
  - M1. Scan is async, upload response returns immediately with `scanStatus: 'pending'`. *(Recommended.)*
  - M2. Scan is sync inside upload request, target p99 < 3s.

---

## Cross-scope sequencing summary

```
Scope 1 (Federation)              Scope 2 (i18n)                Scope 3 (ClamAV)
────────────────────             ─────────────────             ──────────────────
S1.1 Events                       I1 Install                    V0 Route callers
   │                                 │                             │
S1.2 Sensor @key                  I2 Infrastructure            V1 ADR topology
   │                                 │                             │
S1.3 Farm resolver    ← guard ←   I3 JWT locale                V2 K8s + compose
   │                                 │                             │
S1.4 Composition CI               I4 Farm errors (wave 1)     V3 Client + worker
   │                                 │                             │
S1.5 Rollout                      I5 Other services           V4 Fail-closed
                                     │                             │
                                  I6 Tenant default           V5 Notify + block
                                                                   │
                                                              V6 Freshness alerts
```

**Hard cross-scope gates:**
- I4 (farm error i18n) before V5 (infected-file notification localised).
- S1.1 (event contract) does NOT block anything in Scope 2/3 — landable in parallel.
- V5 before S1.3 only if the federation resolver throws user-visible errors that need i18n; otherwise independent.

## Total estimate

- **Scope 1:** 5 PRs, ~890 LOC.
- **Scope 2:** ~13 PRs (I4 split 5-ways, I5 split 5-ways), ~4600 LOC.
- **Scope 3:** 7 PRs, ~2080 LOC.

Aggregate: ~25 PRs, ~7600 LOC. Plan-a-week cadence per standing rules → ~6 months end-to-end with one implementer.

### Critical Files for Implementation

- /var/aqua-saas/libs/storage/src/file-upload-security.service.ts
- /var/aqua-saas/apps/farm-service/src/common/errors/farm-app-error.filter.ts
- /var/aqua-saas/libs/event-contracts/src/sensor-events.ts
- /var/aqua-saas/apps/sensor-service/src/database/entities/sensor-reading.entity.ts
- /var/aqua-saas/apps/gateway-api/src/app.module.ts
