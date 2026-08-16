# farm-service + AquaMobil test health audit — 2026-08-16

**Agent:** `test-runner` · **Mode:** CATCHER (read-only) · **Lane:** farm
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 11 (CRITICAL 0 · HIGH 4 · MEDIUM 3 · LOW 4)

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `TEST-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read apps/farm-service in full breadth: jest.config.ts, jest.integration.config.ts,
jest.e2e.config.ts, project.json, tsconfig.spec.json, all 44 bounded-context directories (enumerated
handler/service/resolver classes and cross-referenced every exported class name against the
concatenated text of all 308 farm-service `*.spec.ts` files), `src/**tests**/e2e/` (14 files incl.
tenant-schema-routing.architecture.spec.ts), `src/database/migrations/**tests**/` (10 specs \+ 77
migration files). Read web/apps/aquamobil package.json, vitest.config.ts, CLAUDE.md, and enumerated
all 66 spec files under `src/{**tests**,components,hooks,pages,pwa,services,utils}`. Read CI wiring:
.github/workflows/{ci-affected,ci-full,e2e-tests,db-migration-check}.yml,
scripts/ci/affected-target-policy.{sh,json}, scripts/ci/write-affected-target-report.mjs,
tools/quality/{service-coverage-baselines.json,coverage-report-inventory.json,coverage-evidence.js,lint-target-inventory.json}.
Read e2e/playwright{,.aquamobil,.water-chemistry}.config.ts and e2e/tests/mobile/. Read
tests/invariants/{farm-service-tenant-isolation,farm-read-boundary-ssot,coverage-evidence-contract}.spec.ts,
eslint.config.mjs, jest.preset.js, nx.json, root package.json, and prior review
docs/reviews/test-runner/2026-04-10-full-repo-audit.md. NO test was executed: `npx jest --listTests`
failed with "npx canceled due to missing packages" — node_modules is not installed in this sandbox.

## Executive summary

No test run was possible (node_modules absent); this is static analysis only, stated up front.

Two suites that the repo believes are gating do not execute at all. AquaMobil declares no `test`
target (package.json has dev/build/lint/typecheck only, no project.json), so all 66 vitest specs —
including offline-queue, sw-replay, useAuth-logout-wipe, IdentityBoundary — never run in any
workflow, and aquamobil is absent from coverage-report-inventory.json. Compounding it,
ci-affected.yml's "SW build-artifact invariant" step targets `test:invariant`, which no project in
the workspace declares; the step is permanently a no-op while its own comment asserts aquamobil is
"the sole project declaring that target". offline-sync-roundtrip.spec.ts:19-22 explicitly names
those two dead specs as the compensating control for the non-browser-drivable closed-app replay
lane.

Separately, `farm-service:test:integration` is invoked by zero workflows, so the CLAUDE.md-mandated
tenant-schema-routing.architecture.spec.ts and 8 postgres tenant-isolation specs never run.

Assertion quality inside farm-service is genuinely good (308 specs, only 1 assertion-free test,
strong outbox/tenant assertions). The gap is reach, not rigor: 80 handler classes, 46/51 resolvers,
and ~3,600 lines of feeding services have no spec; the coverage floor is ratcheted to 20.39%
functions.

## Findings (by severity)

### HIGH

### TEST-HIGH-001

**Title:** AquaMobil PWA has 66 spec files and no CI execution path — the offline-first suite never
runs

**Severity:** HIGH (filed as CRITICAL, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
TEST-CRITICAL-001` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/package.json:9-13 — scripts are build/lint/typecheck only; there is no `test`
  script and no project.json, so Nx infers no `test` target
- tools/quality/lint-target-inventory.json:45-48 — aquamobil IS a real Nx project
  (`@aquaculture/aquamobil`, root web/apps/aquamobil) with a lint target, confirming the absence is
  test-specific
- tools/quality/coverage-report-inventory.json:4-35 — 35 coverage producers listed;
  web/apps/aquamobil is absent, so coverage-evidence.js never expects a report from it
- `web/apps/aquamobil/src/pwa/**tests**/sw-replay.spec.ts:1-14` — 29 assertions pinning zero-client
  cookie refresh, tenant-scoped drain and blob-lane skip; dead in CI
- web/apps/aquamobil/vitest.config.ts:38-45 — a fully configured jsdom vitest project (include:
  `src/**/*.{spec,test}.{ts,tsx}`) with no runner that invokes it

**Rule violated:**

CLAUDE.md CRITICAL block (`nx affected --target=test` is the gate) \+ agent Domain Rule 6 (CI
Pipeline Health: test results reported and gated); prior finding HIGH-002 in
docs/reviews/test-runner/2026-04-10-full-repo-audit.md flagged the same class of empty/unwired
suites

**Proposed fix direction:**

Make execution structural, not conventional: give aquamobil a project.json declaring a `test` target
(vitest executor pointing at the existing vitest.config.ts) and add
web/apps/aquamobil/coverage/lcov.info to coverage-report-inventory.json so coverage-evidence.js
fails closed when the producer is missing. Then invert coverage-evidence-contract.spec.ts to run
BOTH directions — today it only checks inventory→declared-target; add
project-with-spec-files→must-appear-in-inventory so any future workspace project carrying
`*.spec.ts` without a test target fails the invariant suite. That is the Tier-1 fix; without it this
recurs on the next standalone app.

**Affected surface (ripple set):**

- `web/apps/aquamobil/project.json (new)`
- `tools/quality/coverage-report-inventory.json`
- `tests/invariants/coverage-evidence-contract.spec.ts`
- `scripts/ci/affected-target-policy.json`
- `tools/quality/service-coverage-baselines.json`

**Expected closer:**

test-runner WRITER mode for the invariant; infra-expert for the Nx target \+ CI wiring

**Verifier note:**

Confirmed factually. web/apps/aquamobil/package.json declares
dev/build/build:quick/preview/lint/typecheck/postinstall — no `test` script; there is no
web/apps/aquamobil/project.json; nx.json registers only the @nx/eslint plugin (no @nx/vite /
@nx/vitest inference), so aquamobil's targets come solely from package.json script inference —
corroborated by tools/quality/lint-target-inventory.json showing its lint target with executor
`nx:run-script`. 66 spec/test files exist under web/apps/aquamobil/src and vitest.config.ts includes
`src/**/*.{spec,test}.{ts,tsx}`, but no workflow, and neither `npm test` (nx affected -t test) nor
ci-full's `npm run test:all` (nx run-many -t test --all) can reach a target that does not exist.
web/apps/aquamobil is absent from tools/quality/coverage-report-inventory.json's 35 producers.
sw-replay.spec.ts has exactly 29 `expect(` calls as claimed. Severity corrected `CRITICAL->HIGH`:
this is a missing pre-merge gate, not a live production defect, and partial compensating controls
exist — .github/workflows/e2e-tests.yml runs the 7-spec AquaMobil Playwright suite
(playwright.aquamobil.config.ts) against the deployed container, graphql-codegen-validate.yml gates
the generated client, and `build` runs `typecheck` (tsc on both tsconfig.json and tsconfig.sw.json).
Those run post-deploy on main rather than on the PR, so the gap is real but bounded. Minor
imprecision: the claim says scripts are 'build/lint/typecheck only' — dev, build:quick, preview and
postinstall also exist.

### TEST-HIGH-002

**Title:** ci-affected.yml `test:invariant` gate resolves to zero projects — permanently green no-op
whose comment claims the opposite

**Severity:** HIGH (filed as CRITICAL, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
TEST-CRITICAL-002` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- .github/workflows/ci-affected.yml:445 — "it only fires when aquamobil (the sole project declaring
  that target) is affected"; aquamobil declares no such script or target
- .github/workflows/ci-affected.yml:451 — `affected-target-policy.sh --target test:invariant`; the
  only repo-wide match for that string is e2e/package.json's `test:invariants` (plural), and
  e2e/package.json sets `"nx": {"includedScripts": []}` so Nx infers no targets from it
- scripts/ci/affected-target-policy.sh:124-127 — an empty strict-project list prints "No strict …
  projects remain" and `exit 0`, so the step is always green
- `web/apps/aquamobil/src/pwa/**tests**/sw-build-artifact.invariant.spec.ts:14-22` — the
  FE-CRITICAL-050-SW guard that runs a real vite build and asserts dist/messaging-sw.js still
  carries the sync/notificationclick/LOGOUT handlers
- e2e/tests/mobile/offline-sync-roundtrip.spec.ts:19-22 — names sw-replay.spec.ts \+ the
  sw-build-artifact invariant as the compensating control for the closed-app replay lane Playwright
  cannot drive

**Rule violated:**

CLAUDE.md Architectural Approach Tier-3 ("make it detectable") — a detection gate that cannot fire
is worse than none, because the workflow comment reads as coverage; agent Domain Rule 6 (CI Pipeline
Health)

**Proposed fix direction:**

Fail closed on an empty target resolution: affected-target-policy.sh must distinguish "no affected
project declares this target" (currently exit 0) from "target does not exist anywhere in the graph"
(must be a hard error). Add a declared-targets manifest cross-checked by an invariant so a workflow
step can never name a target no project owns. Then declare the real `test:invariant` target on
aquamobil's project.json so the FE-CRITICAL-050-SW guard actually executes.

**Affected surface (ripple set):**

- `.github/workflows/ci-affected.yml`
- `scripts/ci/affected-target-policy.sh`
- `scripts/ci/write-affected-target-report.mjs`
- `web/apps/aquamobil/project.json (new)`
- `tests/invariants/ (new declared-target manifest invariant)`

**Expected closer:**

infra-expert WRITER mode; test-runner CATCHER re-verify

**Verifier note:**

Confirmed. .github/workflows/ci-affected.yml:451 runs
`affected-target-policy.sh --target test:invariant`, and the workflow comment at :445 asserts 'it
only fires when aquamobil (the sole project declaring that target) is affected'. A repo-wide grep
for the literal `test:invariant` matches only ci-affected.yml and e2e/package.json — and the e2e
match is `test:invariants` (plural), on a project whose package.json sets
`"nx": {"includedScripts": []}`, so Nx infers no target from it. aquamobil declares no
`test:invariant` script and has no project.json. scripts/ci/affected-target-policy.sh:124-127
verified verbatim:
— and the early-exit at :86-102 also exits 0. The step is therefore unconditionally green. The guard
it claims to run, `web/apps/aquamobil/src/pwa/**tests**/sw-build-artifact.invariant.spec.ts` (real
vite build asserting dist/messaging-sw.js retains sync/notificationclick/LOGOUT handlers), is
confirmed present, and e2e/tests/mobile/offline-sync-roundtrip.spec.ts:15-21 does name
sw-replay.spec.ts \+ the build-artifact invariant as the compensating control for the
browser-undrivable closed-app replay lane. Severity corrected `CRITICAL->HIGH`: a permanently-green
CI step with a comment asserting coverage is genuine false assurance, but it is the same root cause
as TEST-CRITICAL-001 (aquamobil has no test targets at all) and produces no direct production
failure.

```text
if [[ ! -s "$STRICT_PROJECT_LIST" ]]; then echo "No strict $TARGET projects remain..."; exit 0; fi
```

### TEST-HIGH-004

**Title:** 80 CQRS handler classes and 46 of 51 GraphQL resolvers in farm-service have no spec;
coverage floor is ratcheted to 20.39% functions

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `TEST-HIGH-004` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- tools/quality/service-coverage-baselines.json:20-25 — farm-service floor is branches 32.86 /
  functions 20.39 / lines 33.92, wired as the only coverageThreshold via
  apps/farm-service/jest.config.ts:26
- apps/farm-service/src/finance — 11 of 13 handler classes never referenced by any spec
  (GetFinanceSummaryHandler, GetFinanceLedgerHandler, GetFinanceBatchTotalsHandler,
  UpdateFinanceEntryHandler, DeleteFinanceEntryHandler, UpdateFinanceSettingsHandler …)
- apps/farm-service/src/storage/handlers/transfer-stock.handler.ts:1-209 — 209-line handler doing
  pessimistic-lock inventory arithmetic, dual-site authorization (siteAuth.assertSiteAssignment on
  both legs) and idempotency-key replay; TransferStockHandler appears in no spec
- apps/farm-service/src/water-quality — 9 of 23 handler classes untested incl.
  ListCriticalWaterQualityHandler and GetTankWaterQualityStatisticsHandler; maintenance 7/20,
  equipment 6/15, fish-health 6/10, chemical 5/7
- `apps/farm-service/src/**/*.resolver.ts` — 46 of 51 resolver classes (45 of which carry
  @UseGuards) appear in no spec, including batch, storage, task, regulatory, harvest and compliance
  resolvers

**Rule violated:**

CLAUDE.md Test Rules (London School TDD; new feature → test first); agent Domain Rule 4 (coverage
thresholds with explicit floors — statements 80 / branches 75 / functions 80 / lines 80 minimum)

**Proposed fix direction:**

Treat the baseline file as a ratchet with a published slope, not a floor: make
service-coverage-baselines.json monotonic-only (an invariant rejecting any downward edit) and set a
per-PR rule that changed files must exceed the service floor, so new handlers cannot land below it.
Prioritise the backlog by blast radius rather than by count — the site-authorization \+
pessimistic-lock write handlers (transfer-stock, approve-inventory-count,
submit/approve-inventory-count, update-purchase-order-status) and the finance money-aggregation
query handlers first, since those combine an authorization decision with arithmetic that no other
gate observes.

**Affected surface (ripple set):**

- `tools/quality/service-coverage-baselines.json`
- `apps/farm-service/jest.config.ts`
- `tests/invariants/coverage-evidence-contract.spec.ts`

  ```text
  apps/farm-service/src/{finance,storage,water-quality,maintenance,equipment,fish-health}/**
  ```

**Expected closer:**

farm-expert WRITER mode per bounded context; test-runner CATCHER re-verify against the ratchet

**Verifier note:**

Confirmed, and if anything understated. tools/quality/service-coverage-baselines.json:20-25 matches
exactly: farm-service branches 32.86 / functions 20.39 / lines 33.92 / statements 33.84, wired as
the sole coverageThreshold via apps/farm-service/jest.config.ts:26
(`coverageThreshold: { global: coverageBaselines['farm-service'] }`). Independent recount: 250
exported handler classes under apps/farm-service/src, of which exactly 80 appear in no `*.spec.ts` —
matching the claim's number. The named finance handlers (GetFinanceSummaryHandler,
GetFinanceLedgerHandler, GetFinanceBatchTotalsHandler, UpdateFinanceEntryHandler,
DeleteFinanceEntryHandler, UpdateFinanceSettingsHandler), the water-quality set
(ListCriticalWaterQualityHandler, GetTankWaterQualityStatisticsHandler) and TransferStockHandler all
verified untested. apps/farm-service/src/storage/handlers/transfer-stock.handler.ts is 209 lines and
does exactly what is claimed: idempotency-key replay lookup (:48-53), dual
in-transaction inventory read (:96-107). Resolver figure is off by one in the claimer's
favour-of-caution: 51 @Resolver classes, 45 (not 46) untested, and 39 (not 45) of those untested
ones carry @UseGuards. Severity HIGH sustained — the arithmetic imprecision does not change the
finding.

```text
siteAuth.assertSiteAssignment` on both legs (:83-84), and a `lock: { mode: 'pessimistic_write' }
```

### TEST-HIGH-005

**Title:** ~3,600 lines of feeding-domain service logic have no spec — the highest-frequency
operational path in the product

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `TEST-HIGH-005` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/feeding/services/feeding-program.service.ts — FeedingProgramService, 1175
  lines, class name absent from all 308 farm-service specs
- apps/farm-service/src/feeding/services/feeding-cron.service.ts — FeedingCronService, 1048 lines,
  untested scheduled execution path
- apps/farm-service/src/feeding/services/feed-selector.service.ts — FeedSelectorService, 497 lines;
  growth-simulator.service.ts — GrowthSimulatorService, 476 lines;
  feed-consumption-forecast.service.ts — FeedConsumptionForecastService, 396 lines
- apps/farm-service/src/scheduler/feeding-scheduler.service.ts — FeedingSchedulerService untested
  (the scheduler context's only spec is minio-orphan-cleanup.spec.ts)
- apps/farm-service/src/ai-insights/ — 6 source files (ai-insights.service.ts,
  mcp-client.service.ts, mcp-sdk.port.ts, resolver) with zero spec files in the directory

**Rule violated:**

CLAUDE.md Test Rules (London School TDD, mock collaborators via @platform/testing); agent Domain
Rule 4 (untested critical paths: billing/quantity calculations, scheduled handlers)

**Proposed fix direction:**

Cover the arithmetic and the schedule separately. Feed dosing, FCR and growth simulation are
pure-ish computations over injected inputs — those get table-driven specs against known
biomass/temperature vectors, which is where mutation testing (see TEST-MEDIUM-007) pays for itself.
The cron services need collaborator-level specs asserting the OutboxRepository.save payload and the
tenant-scoped read boundary, matching the pattern already used well in
`batch/**tests**/handlers/transfer-batch.handler.spec.ts:189-199`. Do not add a coverage-only smoke
test — a covered-but-unasserted feeding calculator is exactly the failure mode the mutation gate
exists to catch.

**Affected surface (ripple set):**

- `apps/farm-service/src/feeding/services/**`
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
- `apps/farm-service/src/ai-insights/**`
- `tools/quality/service-coverage-baselines.json`

**Expected closer:**

farm-expert WRITER mode

**Verifier note:**

Confirmed line-for-line. Verified line counts: feeding-program.service.ts 1175,
feeding-cron.service.ts 1048, feed-selector.service.ts 497, growth-simulator.service.ts 476,
feed-consumption-forecast.service.ts 396 — total 3592, matching '~3,600'. Grep across all 308
farm-service `*.spec.ts` files returns ZERO hits for each of FeedingProgramService,
FeedingCronService, FeedSelectorService, GrowthSimulatorService, FeedConsumptionForecastService and
FeedingSchedulerService. apps/farm-service/src/scheduler/ contains exactly one spec,
**tests**/minio-orphan-cleanup.spec.ts, as claimed — and feeding-scheduler.service.ts is 1820 lines,
larger than the claim implies. apps/farm-service/src/ai-insights/ (module, resolver, services/,
types/) contains zero spec files. No compensating integration or e2e coverage was found for these
paths: apps/farm-service/jest.integration.config.ts targets only **tests**/integration and postgres
specs, none of which reference the feeding services either. HIGH sustained.

### MEDIUM

### TEST-MEDIUM-003

**Title:** farm-service `test:integration` target is invoked by zero workflows — the
CLAUDE.md-mandated tenant-schema-routing spec and 8 postgres tenant-isolation specs never run

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `TEST-HIGH-003` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/project.json:49-55 — `test:integration` target exists
  (jest.integration.config.ts, runInBand); a repo-wide grep for `test:integration` matches only two
  project.json files and e2e/package.json — no workflow, no script
- apps/farm-service/jest.integration.config.ts:5-11 — that config is the ONLY matcher for
  `src/**tests**/e2e/**/*.architecture.spec.ts`, `*.postgres.spec.ts` and race-conditions.spec.ts
- apps/farm-service/jest.config.ts:15 — the unit suite explicitly ignores
  `<rootDir>/src/**tests**/e2e/`, so the fast lane cannot pick them up either
- CLAUDE.md:6 — "Enforced by
  `apps/farm-service/src/**tests**/e2e/tenant-schema-routing.architecture.spec.ts` \+
  e2e/tests/integration/schema-invariants.spec.ts"; apps/farm-service/CLAUDE.md Enforcement section
  repeats "CI: the specs above run every PR"
- — a pure
  static fs scan needing no database, so nothing except the dead target keeps it out of the fast
  unit lane

  ```text
  apps/farm-service/src/**tests**/e2e/tenant-schema-routing.architecture.spec.ts:40-56
  ```

**Rule violated:**

CLAUDE.md CRITICAL block line 6 (schema-routing enforcement) and ADR-011;
apps/farm-service/CLAUDE.md Enforcement; agent Domain Rule 7 (Multi-Tenant Test Coverage)

**Proposed fix direction:**

Split by dependency, not by directory. tenant-schema-routing.architecture.spec.ts and
graphql-loader-tenant-source.architecture.spec.ts need no DB — move them into the default `test`
target so they gate every PR through the existing ci-full run. Wire the genuinely DB-backed
`.postgres.spec.ts` set into a testcontainers-backed CI job with its own timeout-minutes. Then add
an invariant asserting that every Nx target named in an agent-facing SSoT (CLAUDE.md, nested
CLAUDE.md) is referenced by at least one workflow file, so a documented enforcement claim cannot
outlive its runner.

**Affected surface (ripple set):**

- `apps/farm-service/jest.config.ts`
- `apps/farm-service/jest.integration.config.ts`
- `.github/workflows/ci-affected.yml`
- `tests/invariants/claude-md-accuracy.spec.ts`
- `apps/auth-service/project.json (same dead target)`

**Expected closer:**

infra-expert WRITER mode for CI wiring; multi-tenant-saas-expert to confirm the DB-backed isolation
set

**Verifier note:**

The factual core holds but the stated impact is substantially overstated. Verified:
apps/farm-service/project.json:49-56 defines `test:integration` (jest.integration.config.ts,
runInBand:true); a repo-wide grep for `test:integration` matches only
apps/farm-service/project.json, apps/auth-service/project.json and e2e/package.json — zero
workflows, zero npm scripts. jest.integration.config.ts:5-11 is indeed the only matcher for
`src/**tests**/e2e/**/*.architecture.spec.ts`, `*.postgres.spec.ts` and race-conditions.spec.ts, and
jest.config.ts:15 ignores `<rootDir>/src/**tests**/e2e/`. However, the headline claim that the
CLAUDE.md-mandated schema-routing invariant 'never runs' is REFUTED by a control the claimer missed:
tests/invariants/entity-schema-declaration.spec.ts enforces the identical ADR-011 rule repo-wide and
in BOTH directions ('every @Entity() respects the per-tenant OMIT / cross-tenant DECLARE rule', with
farm-service in TENANT_SCOPED_SERVICE_DIRS), and it lives in the `invariants` Nx project
(tests/invariants/project.json declares a `test` target) which ci-affected.yml explicitly runs — the
comment at ci-affected.yml:417-420 names that project by hand.
e2e/tests/integration/schema-invariants.spec.ts assertions B.1/B.2 add a second layer and are
path-triggered on any `apps/*/src/**/*.entity.ts` change by db-migration-check.yml:94/105. The
farm-service architecture spec is a strictly weaker, redundant copy. What genuinely never runs is
the 9 `postgres/*.architecture/race-conditions` specs — and
tools/gates/type-check-spec-baseline.json documents that those very files were excluded from
tsconfig.spec.json for systemic domain-model drift (84 type errors), so they are known-stale, not
silently-regressing coverage. MEDIUM: dead test target and stale live-DB specs, with the
load-bearing invariant already gated.

### TEST-MEDIUM-008

**Title:** 19 projects including farm-service are quarantined out of the affected test lane with no
owner, deadline or finding ID

**Severity:** MEDIUM
**Layer:** 3
**State:** OPEN
**Raised as:** `TEST-MEDIUM-008` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- scripts/ci/affected-target-policy.json:64 —
  under targets.test.knownUnstableProjects

  ```text
  "farm-service": "CI run 26116890061: existing unit-test debt, unrelated to deploy/migration recovery."
  ```

- scripts/ci/write-affected-target-report.mjs:58-61 — a quarantined project is pushed to
  quarantinedProjects and never reaches strictProjects, so it is not executed at all
- scripts/ci/affected-target-policy.json — the same file lists both `hr-module` and
  `@aquaculture/hr-module` as separate test-quarantine entries, evidence the list is hand-maintained
  and already drifting
- scripts/ci/affected-target-policy.json:29 — farm-service is separately quarantined for lint, so
  neither PR-lane gate covers it
- .github/workflows/ci-full.yml:19,211-212 — mitigation: ci-full triggers on pull_request to main
  and runs `npm run test:all -- --coverage`, so farm-service unit tests are not fully dark; the
  quarantine removes the fast-feedback lane only

**Rule violated:**

CLAUDE.md Architectural Approach — "deferred" / "out of scope" FORBIDDEN without an explicit owner
\+ deadline \+ tracked finding ID; CLAUDE.md Review Finding Traceability

**Proposed fix direction:**

Give every quarantine entry the three fields CLAUDE.md already requires: owner, deadline, finding ID
— enforced by schema validation in write-affected-target-report.mjs so an entry without them fails
the run rather than silently skipping a project. Add expiry semantics (a past deadline turns the
entry into a hard failure), and de-duplicate the project-name keys against the Nx graph so
`hr-module` vs `@aquaculture/hr-module` cannot both linger. A quarantine list with no clock is
indistinguishable from deleted coverage.

**Affected surface (ripple set):**

- `scripts/ci/affected-target-policy.json`
- `scripts/ci/write-affected-target-report.mjs`
- `tests/invariants/ (new quarantine-expiry invariant)`
- `docs/reviews/_registry/findings.jsonl`

**Expected closer:**

infra-expert WRITER mode; context-manager to register the per-project debt findings

**Verifier note:**

Confirmed on every point. scripts/ci/affected-target-policy.json targets.test.knownUnstableProjects
spans lines 55-73 and contains exactly 19 entries, with farm-service at :64 carrying the bare string
'CI run 26116890061: existing unit-test debt...' — no owner, no deadline, no finding ID; both
`hr-module` (:73) and `@aquaculture/hr-module` (:55) are present, confirming hand-maintained drift;
farm-service is separately lint-quarantined at :29.
scripts/ci/write-affected-target-report.mjs:55-61 is exactly as described — a project matched in
knownUnstable is pushed to quarantinedProjects and never appended to strictProjects, and only a
::warning is emitted, so ci-affected.yml:412 never executes it. I checked for a gate that would
refute this: tests/invariants/lint-quarantine-ssot.spec.ts enforces reasons, a MAX_EXCLUSIONS
ceiling and Nx-existence only for the FULL-lane lint list (scripts/ci/lint-all-exclusions.json) and
only reads targets.lint.knownUnstableProjects; tests/invariants/admin-route-contract-ci.spec.ts:54
asserts emptiness only for targets['test:contract']. Nothing constrains the 19-entry test quarantine
— no expiry, no ID, no size cap. The ci-full mitigation is genuine (ci-full.yml:19
pull_request→main, :211-212 `npm run test:all -- --coverage`, and test:all is
`nx run-many --target=test --all`), but the claim already discloses it, and the process violation
plus a drifting, clock-less list stands. MEDIUM as filed.

### TEST-MEDIUM-009

**Title:** The farm tenant-isolation invariant scans only `*.handler.ts` findOne/find — services,
resolvers and dataloaders are outside its reach

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `TEST-MEDIUM-009` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- tests/invariants/farm-service-tenant-isolation.spec.ts:60 — walkHandlerFiles only collects files
  ending `.handler.ts`
- tests/invariants/farm-service-tenant-isolation.spec.ts:108-115 — isRepoCall matches only
  findOne/findOneBy/findBy/find; createQueryBuilder chains are invisible to it
- apps/farm-service/src — 117 repository find calls live in `*.service.ts` and 139
  createQueryBuilder call sites (99 in handlers, 40 in services), none of which the scanner
  evaluates
- apps/farm-service/src — 51 resolvers, 7 responders and 6 dataloaders are not scanned by this
  invariant, and 46 of the 51 resolvers additionally have no spec (see TEST-HIGH-004)
- libs/backend-common/src/database/tenant-scoped-repository.ts:420-425 —
  TenantScopedRepository.createQueryBuilder does auto-inject the tenant predicate, so the unscanned
  sites reviewed here are correct today; the gap is detection of a future regression, not a present
  leak

**Rule violated:**

Agent Domain Rule 7 (tenant isolation test coverage: every tenant-scoped read path needs positive,
cross-tenant-negative and missing-context coverage); CLAUDE.md Layer Rules 6 (getScopedRepository)

**Proposed fix direction:**

Extend the invariant's file set to `*.service.ts`, `*.resolver.ts`, `*.responder.ts` and
`*.dataloader.ts`, and add a positive-form rule: raw `manager.getRepository` /
`dataSource.getRepository` outside tenantManagerRepo is a violation, which is far more robust than
pattern-matching where-clauses. Pair it with a Scope.REQUEST assertion for the 6 dataloaders — a
singleton DataLoader over tenant-scoped rows is the one failure mode neither the static scan nor the
current specs can observe.

**Affected surface (ripple set):**

- `tests/invariants/farm-service-tenant-isolation.spec.ts`
- `apps/farm-service/src/**/*.service.ts`
- `apps/farm-service/src/**/dataloaders/*.ts`
- `libs/backend-common/src/database/tenant-scoped-repository.ts`

**Expected closer:**

multi-tenant-saas-expert WRITER mode; test-runner CATCHER re-verify

**Verifier note:**

Verified line by line. tests/invariants/farm-service-tenant-isolation.spec.ts walkHandlerFiles
(53-67) admits only files ending `.handler.ts` (filter at :61, one line off the cited :60) and skips
**tests**; isRepoCall at :108-115 matches only findOne/findOneBy/findBy/find on
`*Repository/*Repo/queryRunner.manager/dataSource.manager` — grep for 'createQueryBuilder' in that
file returns zero hits, so builder chains are invisible. Counts reproduce: 117 repository `find*`
calls in non-test `*.service.ts`, 99 createQueryBuilder sites in `*.handler.ts` and 40 in
`*.service.ts` (139), 51 resolvers, 7 responders, 6 dataloaders, none scanned.
libs/backend-common/src/database/tenant-scoped-repository.ts:420-425 does inject
`alias.tenantId = :tenantId` and disables predicate resetters, exactly as cited. Two mitigations
partly blunt the proposed fix — tests/invariants/no-direct-getrepository-call.spec.ts already
implements the repo-wide 'raw getRepository is a violation' rule the claim proposes as new, and
farm's per-tenant tables route via search_path — but the detection gap is real and not merely
hypothetical: apps/farm-service/src/growth/services/fcr-calculation.service.ts injects a plain
`Repository<Batch>` (:144) and does `findOne({ where: { id: batchId } })` (:620) with no tenantId,
precisely the shape the handler invariant exists to catch, sitting in a file the scanner never
opens. Not escalated above MEDIUM because Batch (@Entity('batches_v2'), no `schema:`) is per-tenant
and search_path isolates it at runtime, so this is a missing detector, not a live leak.

### LOW

### TEST-MEDIUM-006

**Title:** tsconfig.spec.json excludes the migration specs on a factually false premise, so they run
under jest but escape the strict tsc gate

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 1
**State:** OPEN
**Raised as:** `TEST-MEDIUM-006` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/tsconfig.spec.json:23-27 — exclude block with the comment "These specs import
  deleted migration classes by design and are kept only as archaeological context"
- `apps/farm-service/src/database/migrations/**tests**/` — all 10 specs exist and every migration
  class they import is present on disk (verified 11/11 present:
  1800400000000-CreateFarmStockReadModel … 1808000000000-AddSatelliteCoverageProvenance)
- apps/farm-service/jest.config.ts:12-22 — the unit config deliberately does NOT ignore that
  directory, with a note that excluding it is "exactly why the unguarded ALTER TYPE that took
  production down on 2026-06-17 shipped untested (ORPHAN-MEDIUM-132)"
- package.json — `gates:type-check-spec` runs a second full tsc pass over spec sources; the exclude
  block removes these 10 files from it

**Rule violated:**

CLAUDE.md Code Quality Standards (no compat shims / stale escapes) and agent Domain Rule 1
(tsconfig.spec.json must extend base correctly); the two configs make contradictory claims about the
same directory

**Proposed fix direction:**

Delete the exclude entry — its stated justification is no longer true, so it is now an unreviewed
hole in the type gate. Add an invariant asserting that every path excluded from a tsconfig.spec.json
either does not exist or carries a live finding ID, so a stale exclusion cannot silently outlive its
reason. Also re-check `src/**tests**/e2e/code-sequences-schema-alignment.postgres.spec.ts`, the
other entry in the same block.

**Affected surface (ripple set):**

- `apps/farm-service/tsconfig.spec.json`
- `tools/gates/type-check-spec.ts`
- `tests/invariants/ (new tsconfig-exclusion-liveness invariant)`

**Expected closer:**

test-runner WRITER mode; build-validator to confirm the tsc pass stays green

**Verifier note:**

Facts hold. apps/farm-service/tsconfig.spec.json:23-29 still carries an exclude block whose comment
claims the specs "import deleted migration classes"; I listed
`apps/farm-service/src/database/migrations/**tests**/` (10 specs) and grepped their imports — every
migration class they import (1800400000000-CreateFarmStockReadModel,
1800500000000-AssertFarmStockBatchSnapshotMetadata, 1801300000000, 1801700000000, 1801800000000,
1806900000000, 1807000000000, 1807100000000, 1807200000000, 1807900000000, 1808000000000) exists on
disk, so the stated premise is false. jest.config.ts:12-24 deliberately does NOT ignore that
directory (explicit ORPHAN-MEDIUM-132 note), and package.json:157 gates:type-check-spec runs tsc -p
tsconfig.spec.json, so the exclude does remove them from the strict gate (baseline apps/farm-service
= 0 errors). Two mitigations the claimer missed cut the impact down: (1) I actually ran tsc over
just those 10 specs with the exclude lifted (temp project, same compilerOptions) — 0 errors, so the
hole hides nothing today and lifting it would not move the baseline; (2) ts-jest reads only
compilerOptions, not `exclude`, so those specs are still type-checked under the same strict settings
(tsconfig.base.json strict \+ noUncheckedIndexedAccess) whenever the farm-service jest target runs,
which ci-full's `npm run test:all` does on every PR to main. Real but narrow: a stale,
factually-wrong exclusion in one project's spec tsconfig with zero current type errors behind it,
plus one genuinely dark file (`src/**tests**/e2e/code-sequences-schema-alignment.postgres.spec.ts`,
also jest-ignored by the \.postgres\.spec\.ts$ pattern). LOW, not MEDIUM.

### TEST-MEDIUM-007

**Title:** No mutation testing and no jest/expect-expect rule anywhere — the coverage floor cannot
be shown to be honest

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `TEST-MEDIUM-007` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- Repo-wide search for `stryker` in package.json and `.github/workflows/*.yml` returns nothing; no
  `stryker.conf*` file exists
- package.json devDependencies contain no eslint-plugin-jest, eslint-plugin-vitest,
  eslint-plugin-testing-library or eslint-plugin-playwright
- eslint.config.mjs:598-606 — the TEST_FILE_GLOBS override turns OFF no-explicit-any and
  unbound-method for specs and adds no jest ruleset, so an assertion-free test lints clean
  closing a test titled "should verify all handlers use pessimistic lock pattern"; nothing detects
  it

  ```text
  apps/farm-service/src/**tests**/e2e/race-conditions.spec.ts:473` — `expect(true).toBe(true)
  ```

- tools/quality/service-coverage-baselines.json:20-25 — the farm-service floor is enforced as a
  number with no honesty metric behind it

**Rule violated:**

Agent Domain Rule 3 (jest/expect-expect MUST be enabled) and Domain Rule 4 (mutation testing
mandatory on CQRS handlers, guards, billing math, tenant predicates; track mutation_score /
line_coverage)

**Proposed fix direction:**

Add eslint-plugin-jest with expect-expect at error inside the existing TEST_FILE_GLOBS block —
cheap, immediate, and it retires the assertion-free class permanently. Then introduce Stryker as a
scheduled nightly job (never a per-PR gate) with coverageAnalysis: 'perTest', scoped initially to
the site-authorization handlers, the finance aggregation handlers and the feeding calculators, and
publish the mutation_score/line_coverage ratio alongside the coverage baseline so the 20.39% floor
in TEST-HIGH-004 gains a quality dimension rather than just a quantity one.

**Affected surface (ripple set):**

- `package.json (devDependencies)`
- `eslint.config.mjs:598-606`
- `tools/lint-gates/lint-gates.spec.ts (baseline parity)`
- `.github/workflows/ (new nightly mutation job)`
- `tools/quality/service-coverage-baselines.json`

**Expected closer:**

test-runner WRITER mode for the lint rule; infra-expert for the nightly job

**Verifier note:**

Every factual leg checks out. Repo-wide grep for stryker across package.json and .github/workflows/
returns nothing (only a docs/research path string inside tools/quality/format-scope.json);
package.json has no eslint-plugin-jest / -vitest / -testing-library / -playwright; eslint.config.mjs
override 14 (the TEST_FILE_GLOBS block at ~596-608) turns off no-explicit-any, unbound-method and
no-console and adds no jest ruleset; grep for 'expect-expect' across the tree finds no rule, gate or
invariant anywhere; and `apps/farm-service/src/**tests**/e2e/race-conditions.spec.ts:473` really is
`expect(true).toBe(true)` closing the test titled 'should verify all handlers use pessimistic lock
pattern'. tools/quality/service-coverage-baselines.json:20-25 does pin farm-service at functions
20\.39 with no quality metric. Downgraded because this is the absence of two optional test-quality
tools rather than a defect in shipped behaviour: the demonstrated harm is a single placeholder
assertion in a spec that only runs in the integration/e2e lane, and mutation testing is proposed by
the claim itself as a nightly non-gating job. Real and worth fixing (the eslint-plugin-jest half is
trivial), but narrowly evidenced — LOW.

### TEST-MEDIUM-010

**Title:** No Playwright config sets `trace`, and the E2E lane runs only after deploy — a failure
produces no debuggable artifact and gates nothing pre-merge

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `TEST-MEDIUM-010` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- e2e/playwright.aquamobil.config.ts:21-42 — full config with retries: CI?1:0 and workers:1, but no
  trace, screenshot or video key anywhere in `use`
- e2e/playwright.config.ts:23 and e2e/playwright.water-chemistry.config.ts:9 — retries set, trace
  absent in both; grep for `trace` across all three configs returns nothing
- .github/workflows/e2e-tests.yml:11-15 — triggers are `workflow_run` on "Deploy to DigitalOcean"
  completion plus workflow_dispatch, so the mobile suite is a post-production smoke, not a merge
  gate
- .github/workflows/e2e-tests.yml:160,168-171 — playwright-report and test-results are uploaded, so
  the HTML report survives, but with trace off it carries no DOM snapshot or network log
- e2e/tests/mobile/ — 6 specs; selector hygiene is good (29 getByRole/getByLabel/getByText, zero
  getByTestId, zero waitForTimeout, zero force:true)

**Rule violated:**

Agent Domain Rule 5 (Playwright trace: 'on-first-retry' in production CI; missing trace = HIGH) and
Domain Rule 6 (trace artifacts uploaded on failure for PR debugging)

**Proposed fix direction:**

Set `trace: 'on-first-retry'` in the shared `use` block of all three configs — with retries already
at 1-2 on CI this costs storage only on an actual flake. More consequentially, promote the aquamobil
lane from post-deploy to pre-merge: a browser suite that first runs after production deploy cannot
prevent the regression it detects. Gate it on PR with the existing served-instance harness, keeping
the post-deploy run as an additional production smoke.

**Affected surface (ripple set):**

- `e2e/playwright.aquamobil.config.ts`
- `e2e/playwright.config.ts`
- `e2e/playwright.water-chemistry.config.ts`
- `.github/workflows/e2e-tests.yml`
- `.github/workflows/ci-affected.yml`

**Expected closer:**

infra-expert WRITER mode; frontend-expert to confirm the pre-merge harness

**Verifier note:**

Half true, half refuted — real but smaller than filed.

WHAT HOLDS: I read all three configs in full. e2e/playwright.aquamobil.config.ts:30-35 has a `use`
block with only `...devices['Pixel 7']`, `baseURL` and `serviceWorkers` — no trace/screenshot/video.
e2e/playwright.config.ts:29-34 (`use` = baseURL \+ extraHTTPHeaders) and
e2e/playwright.water-chemistry.config.ts:14-16 (`use` = baseURL only) likewise. grep for `trace`
across `e2e/*.ts` returns nothing, and neither e2e/package.json scripts (test:mobile,
test:water-chemistry, test:security) nor the workflow invocations pass --trace, so Playwright's
`trace: 'off'` default is in force everywhere. This matters most for the water-chemistry lane, which
DOES run pre-merge (.github/workflows/ci-affected.yml:525-570) and uploads e2e/playwright-report/**
\+ e2e/test-results/** on failure (:578-587) — those artifacts would carry traces if the key were
set. A one-line config gap with a real debugging cost.

WHAT IS REFUTED: the second, more consequential half — 'the E2E lane runs only after deploy... gates
nothing pre-merge' plus the fix direction 'promote the aquamobil lane to pre-merge with the existing
served-instance harness'. The claimer missed
docs/reviews/mobile-app-auditor/2026-07-12-aquamobil-e2e-audit.md:170-192 (MOB-MEDIUM-016 /
MOB-HIGH-013), where exactly this was evaluated and deliberately rejected with recorded rationale:
the water-chemistry job serves STATIC frontend builds only
(e2e/scripts/serve-water-chemistry-shell.mjs — the page is a client-side calculation engine), while
the mobile lane needs the full platform (Postgres, NATS, Redis, MinIO, gateway \+
auth/farm/alert/messaging/ai) that no CI job provides for browser tests; post-deploy on the droplet
was chosen because the full stack is already up there. The proposed fix is factually wrong about the
harness it names. 'Gates nothing pre-merge' is also overbroad: ci-affected.yml:525 runs a pre-merge
Playwright browser smoke.

Also confirmed as stated: e2e-tests.yml:12-15 triggers are workflow_run on 'Deploy to DigitalOcean'
\+ workflow_dispatch, :146 runs `npm run test:mobile`, and reports are uploaded at :164-175. Grep
confirms only e2e-tests.yml and ci-affected.yml reference Playwright at all.

Net: keep the trace gap as LOW (debuggability-only, config one-liner, reports already uploaded so
failures are not invisible); the MEDIUM rating rested on the gating argument, which does not
survive.

### TEST-LOW-011

**Title:** One assertion-free test and no restoreMocks in the Jest preset

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `TEST-LOW-011` by `test-runner` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- `apps/farm-service/src/**tests**/e2e/race-conditions.spec.ts:461-474` — test titled "should verify
  all handlers use pessimistic lock pattern" whose body is a comment block closed by
  `expect(true).toBe(true)`; the file is in the dead test:integration lane (TEST-HIGH-003) so it
  neither passes nor fails today
- jest.preset.js:1-24 — no restoreMocks / clearMocks / resetMocks and no maxWorkers;
  apps/farm-service/jest.config.ts sets none either
- apps/farm-service/src — across 308 spec files this scan found exactly ONE assertion-free test, 400
  toHaveBeenCalledWith uses, zero it.skip/xit, zero toMatchSnapshot and only 3 setImmediate waits:
  assertion discipline is otherwise strong and should be recorded as such

**Rule violated:**

Agent Domain Rule 2 (restoreMocks: true; worker pool sizing for CI runner) and Domain Rule 3 (no
assertion-free tests)

**Proposed fix direction:**

Delete the placeholder test rather than converting it — the six invariants its comment enumerates
are already covered by the handler tests above it in the same file, so an honest deletion beats a
synthetic assertion. Add restoreMocks: true and an explicit maxWorkers to jest.preset.js so spy
state cannot accumulate across the 308-file farm-service suite and CI worker sizing stops defaulting
to 50% of the runner.

**Affected surface (ripple set):**

- `apps/farm-service/src/**tests**/e2e/race-conditions.spec.ts`
- `jest.preset.js`
- `apps/*/jest.config.ts`

**Expected closer:**

test-runner WRITER mode

**Verifier note:**

Verified; LOW is the right severity.

Assertion-free test: `apps/farm-service/src/**tests**/e2e/race-conditions.spec.ts:461-474` is
exactly as described — `it('should verify all handlers use pessimistic lock pattern', () => {` whose
body is a 6-item comment block closed by `expect(true).toBe(true);` at :473.
`grep -rn "expect(true).toBe(true)" apps/farm-service/src` returns this one hit only, so the
'exactly ONE' count holds.

Dead lane confirmed independently: apps/farm-service/jest.config.ts:15 ignores
`<rootDir>/src/**tests**/e2e/`, so the unit suite skips it. The only config matching it is
apps/farm-service/jest.integration.config.ts:10
('`<rootDir>/src/**tests**/e2e/race-conditions.spec.ts`'), driven by the test:integration target at
apps/farm-service/project.json:47-55 — and package.json:28 test:all is
`nx run-many --target=test --all` (target `test` only), which is what
.github/workflows/ci-full.yml:210 runs. No workflow invokes test:integration. So the placeholder
neither passes nor fails today, which is exactly why this is LOW and not higher.

restoreMocks: jest.preset.js is 25 lines and sets
testMatch/transform/resolver/moduleFileExtensions/coverageReporters/collectCoverageFrom only — no
restoreMocks, clearMocks, resetMocks or maxWorkers. I also read the upstream it spreads,
node_modules/@nx/jest/preset/jest-preset.js, which sets none of them either, so nothing supplies
them behind the scenes. apps/farm-service/jest.config.ts sets none and has no setup file. The repo
already treats this as the correct default elsewhere: apps/auth-service/jest.config.ts:16-22 sets
restoreMocks:true \+ clearMocks:true with resetMocks:false and a comment explaining the split — a
direct precedent farm-service does not follow. maxWorkers is likewise set in
apps/farm-service/jest.e2e.config.ts:11 and jest.integration.config.ts:17 but not in the unit
config.

One inaccuracy in the claim's rationale, not enough to refute: 'spy state cannot accumulate across
the 308-file farm-service suite' overstates it — Jest gives each test file its own module registry,
so spy leakage is within-file, not cross-file. The hygiene gap and the auth-service precedent are
still real.

## Inventory — what exists / what is missing

| Status          | Area                                                                      | Note                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MISSING**     | Mutation testing \+ test lint rules                                       | No Stryker configuration, dependency or workflow anywhere in the repo, and no eslint-plugin-jest/vitest/testing-library/playwright. The spec-file ESLint override disables no-explicit-any and adds no jest ruleset, so assertion-free tests and 168 `as any` uses in farm-service specs lint clean.                                 |
| **MISSING**     | farm-service / GraphQL resolvers                                          | 46 of 51 resolver classes have no spec, and 45 of the 51 carry @UseGuards — the authorization decorator wiring is therefore almost entirely unasserted. Only 3 __resolveReference sites exist (all in farm.resolver.ts) and their cross-tenant behaviour is exercised indirectly via get-farm.handler.spec.ts.                       |
| **MISSING**     | farm-service / ai-insights                                                | Six source files (ai-insights.service.ts, mcp-client.service.ts, mcp-sdk.port.ts, resolver, module, types) with zero spec files. The MCP client is an outbound third-party boundary with no test at all.                                                                                                                             |
| **MISSING**     | farm-service / dead or orphan code                                        | cache/farm-cache.service.ts is a 0-byte file imported by nothing. filters/global-exception.filter.ts (5.6 KB) has no spec. mobile-command/ holds only an entity, but it IS read through MobileCommandReceiptService in daily-feeding-execution.service.ts, so it is not orphaned.                                                    |
| **MISSING**     | farm-service / finance                                                    | Weakest context: 11 of 13 handler classes untested, including every finance query handler (summary, ledger, batch-totals, categories, settings) and all mutation handlers except create/archive. Money aggregation runs with no assertion behind it.                                                                                 |
| **MISSING**     | farm-service / tenant-isolation architecture specs                        | tenant-schema-routing.architecture.spec.ts, graphql-loader-tenant-source.architecture.spec.ts and 8 `*.postgres.spec.ts` tenant-isolation suites exist and are well written, but the only target that matches them (test:integration) is invoked by no workflow or script. They are authored, not executed.                          |
| **PARTIAL**     | CI test orchestration                                                     | ci-full runs `nx run-many --target=test --all --coverage` on every PR to main with sound timeout budgets and a coverage-evidence gate, so backend suites are genuinely gated. The fast ci-affected lane, however, quarantines 19 projects including farm-service and drives one target (test:invariant) that no project declares.    |
| **PARTIAL**     | aquamobil / E2E browser lane                                              | 6 Playwright specs (login, offline-sync-roundtrip, record-forms, alerts-ack, messaging-smoke, ai-action-confirm) with clean role-based selectors and no waitForTimeout or force clicks. They run only after a production deploy and the config sets no trace, so a failure is neither preventive nor debuggable.                     |
| **PARTIAL**     | aquamobil / PWA offline \+ sync tests                                     | The offline surface is well specified — offline-queue.spec.ts, sw-replay.spec.ts (29 assertions on zero-client drain, cookie refresh, tenant scoping, blob skip), operation-registry, queued-mutation-ssot, sw-build-artifact invariant, plus 4 useOfflineQueue specs. Every one of them is unreachable from CI.                     |
| **PARTIAL**     | aquamobil / unit \+ component tests                                       | 66 vitest specs exist with good discipline (64 getByRole vs 4 getByTestId, 3 container.querySelector, zero skipped tests) and a carefully reasoned vitest.config.ts. None of them execute in any CI workflow because the project declares no test target.                                                                            |
| **PARTIAL**     | farm-service / chemical, consumable, supplier, species                    | Uniform pattern across all four: read handlers (get/list) have specs, every create/update/delete handler has none — 5/7, 3/5, 3/7 and 3/6 untested respectively. Chemical additionally has untested document add/remove handlers.                                                                                                    |
| **PARTIAL**     | farm-service / database migrations                                        | 10 London-school migration specs run in the unit suite by explicit design (jest.config.ts carries a note tying the decision to a 2026-06-17 production incident), yet tsconfig.spec.json excludes the same directory from the strict tsc gate on a premise that is no longer true — all 11 imported migration classes exist on disk. |
| **PARTIAL**     | farm-service / equipment \+ fish-health                                   | equipment 6 of 15 handlers untested (all sub-equipment CRUD plus the delete-preview); fish-health 6 of 10 handlers and 1 of 7 services untested — every `list-*` handler (health events, lice counts, welfare assessments, escape incidents, treatments, overdue follow-ups) has no spec.                                            |
| **PARTIAL**     | farm-service / feeding \+ feeding-protocol                                | All 6 feeding handlers are covered, but 5 of 8 feeding services are not — FeedingProgramService (1175 lines), FeedingCronService (1048), FeedSelectorService (497), GrowthSimulatorService (476), FeedConsumptionForecastService (396). feeding-protocol has 19 specs but 9 untested services.                                       |
| **PARTIAL**     | farm-service / maintenance                                                | Three read-handler specs prove tenant scoping and fail-closed NotFound for get/getByCode/listOverdue/listMy, but 7 of 20 handlers remain untested including ListWorkOrdersHandler, ListSparePartsHandler and GetWorkOrderStatisticsHandler.                                                                                          |
| **PARTIAL**     | farm-service / scheduler                                                  | CronJobsService is covered but FeedingSchedulerService is not; the only spec in the directory is minio-orphan-cleanup.spec.ts. Automated feed scheduling therefore has no unit gate.                                                                                                                                                 |
| **PARTIAL**     | farm-service / storage                                                    | 19 specs cover the read side well (purchase orders, inventory listing, lot tracing, stock movement), but 10 of 27 handlers are untested and they are the mutating ones: transfer-stock, approve/create/submit/update-inventory-count, create-purchase-order, update-purchase-order-status, create/update/delete-storage-location.    |
| **PARTIAL**     | farm-service / tank, site, farm, department, system, worker, growth, task | Handler coverage is good (tank 0/9, site 1/9, farm 0/3, department 0/6, system 0/6, growth 1/6 untested) but task has 4 of 9 untested (list-tasks, list-my-tasks, list-todays-tasks, get-task-stats) and worker 2 of 4 (update, delete).                                                                                             |
| **PARTIAL**     | farm-service / water-quality                                              | 15 specs including a validation service and parameter-config seeder, but 9 of 23 handlers untested — notably ListCriticalWaterQualityHandler and the tank/system statistics query handlers, which feed the alerting surface.                                                                                                         |
| **IMPLEMENTED** | farm-service / assertion quality                                          | Across 308 spec files: 400 toHaveBeenCalledWith uses, exactly 1 assertion-free test, 0 skipped/xit tests, 0 snapshots, 0 sleep-based waits (3 setImmediate flushes only). Mock boundaries sit at repositories and the outbox, and 229 NotFoundException assertions back the fail-closed tenant pattern.                              |
| **IMPLEMENTED** | farm-service / batch                                                      | Strongest context in the service: 39 specs, only 2 of 24 handler classes and 1 of 11 services untested. transfer-batch.handler.spec.ts asserts the outbox payload via expect.objectContaining, which is the correct emission-assertion pattern.                                                                                      |
| **IMPLEMENTED** | farm-service / harvest \+ regulatory \+ compliance                        | Best-covered compliance surface: regulatory has 34 specs (2 of 7 handlers untested, 0 of 15 services), harvest 10 specs (2 of 13 handlers untested), compliance 4 specs including a substantial tenant-erasure.service.spec.ts.                                                                                                      |
| **IMPLEMENTED** | farm-service / outbox emission discipline                                 | 53 handlers publish through the outbox and 53 spec files assert against it; only 3 handlers call eventBus.publish directly and only 8 specs reference EventBus. The mandated assert-via-outbox pattern is genuinely followed here.                                                                                                   |
| **IMPLEMENTED** | farm-service / static invariant family                                    | All 8 farm invariants named in apps/farm-service/CLAUDE.md exist under tests/invariants/ and DO run (the `invariants` Nx project declares a test target). farm-service-tenant-isolation.spec.ts is a solid Tier-3 guard, though scoped to `*.handler.ts` only — see TEST-MEDIUM-009.                                                 |
| **IMPLEMENTED** | farm-service / weather, marine-data, sentinel-hub                         | 18 \+ 4 \+ 6 specs; only 1 of 9 weather services untested and that is an error class, not a service. EnvironmentSyncStore, the CDSE Sentinel and CMEMS providers all have specs.                                                                                                                                                     |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/test-runner.md`
- Rule SSoT: `CLAUDE.md`
