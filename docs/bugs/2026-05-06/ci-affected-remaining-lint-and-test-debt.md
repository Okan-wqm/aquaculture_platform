# 2026-05-06 - CI Affected Remaining Lint And Test Debt

## Affected Area
- `.github/workflows/ci-affected.yml`
- GitHub Actions `CI - Affected / lint`
- GitHub Actions `CI - Affected / test`
- Multiple backend services and frontend/workspace packages listed below

## Observed Issue
After the migration-harness Docker prewarm fix, the isolated `Run migration harness tests (affected, isolated)` step passed in run `25421974238`. The remaining CI failures are no longer the Testcontainers cold-start timeout.

The general affected test graph still failed 20 projects:

- `admin-api-service`
- `alert-engine`
- `auth-service`
- `config-service`
- `billing-service`
- `farm-service`
- `hr-service`
- `messaging-service`
- `notification-service`
- `sensor-service`
- `farm-module`
- `gateway-api`
- `eslint-plugin-aquaculture`
- `admin-panel`
- `dashboard`
- `@aquaculture/hr-module`
- `tenant-admin`
- `shell`
- `@aquaculture/sensor-module`
- `invariants`

Jest summary extraction from the same run showed the largest explicit failing suites:

- `alert-engine`: 11 failed suites, 140 failed tests
- `hr-service`: 8 failed suites, 115 failed tests
- `auth-service`: 11 failed suites, 100 failed tests
- `billing-service`: 10 failed suites, 91 failed tests

Affected lint also remains repo-wide, not localized:

- 23 lint targets failed
- 21,791 lint errors
- 2,740 lint warnings
- largest error clusters: `farm-module`, `@aquaculture/sensor-module`, `admin-panel`, `@aquaculture/hr-module`, `@aquaculture/e2e-tests`, `shell`, `auth-service`, `tenant-admin`

## Root Cause
The fail-closed affected gates are now exposing pre-existing quality debt that was previously hidden by non-blocking or incomplete CI boundaries. The current failure is not one bug and should not be handled with rule suppression, `continue-on-error`, `--quiet`, target exclusion, or test baseline inflation.

For tests, the current signal is too broad for a single safe code edit. Each failing service needs source-level triage by failure family:

- runtime module/bootstrap contract
- mocked dependency contract drift
- tenant/schema routing expectations
- DTO/validation contract mismatch
- stale spec assumptions versus intentional domain behavior

For lint, the error volume indicates typed-lint contract drift across application, module, and test harness boundaries. A one-shot auto-fix would be unsafe because many errors are likely architectural contracts, not formatting.

## Architectural Remediation Plan
1. Preserve fail-closed CI. Do not reintroduce non-blocking lint/test gates.
2. Keep `migration-harness` isolated and prewarmed; do not roll it back into the broad test graph.
3. Split test remediation by service cluster, starting with the explicit Jest-heavy failures: `alert-engine`, `hr-service`, `auth-service`, `billing-service`.
4. For each cluster, classify failures as real production defects versus stale tests before editing. Fix production code when behavior is wrong; fix test fixtures only when the test harness no longer models the domain/runtime contract.
5. For lint, introduce a governed lint-ratchet only if full cleanup cannot fit one PR. The ratchet must be per-project, monotonic, visible in CI, and must not hide new errors. Prefer direct source cleanup where feasible.
6. Add service-level verification notes and dated bug docs for every fixed failure class.

## Related CI Warnings
Run `25421974238` also emitted GitHub Actions Node.js 20 runtime deprecation warnings for pinned actions such as `actions/checkout`, `actions/setup-node`, and `actions/cache`. That is a separate CI platform lifecycle risk; the enterprise path is pinned-SHA action modernization to Node 24-compatible releases, not opt-out environment flags.

The run also showed GitHub cache restore/save warnings. The install step recovered through deterministic `npm ci`; cache availability should remain an optimization and must not become a correctness dependency.

## Verification
- GitHub Actions `CI - Affected / lint`
- GitHub Actions `CI - Affected / test`
- Per-cluster targeted service tests before pushing broad CI reruns

## Status
Open on 2026-05-06. Migration-harness timeout is fixed; remaining affected lint/test debt is explicitly tracked here.
