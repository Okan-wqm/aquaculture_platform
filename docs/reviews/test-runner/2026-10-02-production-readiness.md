# CI gate reality and test health — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `test-runner` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | .github/workflows (ci-affected, ci-full, db-migration-check, e2e, deploy), test targets |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

Green CI on main is not evidence of production readiness. The production deploy path is switched
off, the full suite has been red for four weeks, and nothing has run end to end against a deployed
stack since April.

## Blockers

- **B1. The production pipeline is dead.** The GitHub API reports `deploy-digitalocean.yml` as
  `disabled_manually`; its last run was 2026-07-08. No workflow calls it, even though comments say
  it does (`deploy-digitalocean.yml:27-35,379-381`). The `deployed/production` tag points at
  7f1508da (2026-07-15), 421 commits behind main. The tag was moved outside the workflow: the last
  deploy run was faf48068.
- **B2. Dispatching a prod deploy needs no green CI.** `release-verification`
  (`deploy-digitalocean.yml:346-355`) runs only type-check, `invariants:fast` and the db-migrate
  tests. It runs no unit, integration, lint or E2E tests, and nothing checks that the ref is main.
  `staging-gate` skips itself unless `vars.STAGING_ENABLED` is set (`:206-218`). Concurrency is
  keyed on `github.ref` (`:118`), so deploys from two branches can change prod at the same time,
  despite the comment at `:115`.
- **B3. The full suite has failed on main four weeks running.** CI - Full runs 34018063733,
  34745082343, 35497439697 and 36304648357 all failed `lint-and-typecheck` and `test`. On 09-27,
  "Run all tests" timed out at 35 minutes (`ci-full.yml:208-213`). The last green run was
  2026-09-01. The affected-only runs mask this. ci-full is the only `--coverage` lane, so coverage
  thresholds have not been enforced for a month.

## Major

- **M4. The last passing deployed E2E run was 2026-04-04.**
  - `e2e-tests.yml:13` only triggers after the disabled deploy workflow; the last main runs failed
    at "Set up job".
  - By design it SSHes into the production droplet and points at the production DB (`:73`,
    `:127`), and seeds live rows there (`:95`). It runs from the shared working tree
    `/var/aqua-saas` (`:63`), not from the deployed SHA.
  - A failed health check is ignored (`:78`). There is no Playwright trace config and no artifact
    upload.
- **M5. `production-post-deploy-verify.yml` has run once ever** (2026-07-27), and nothing runs it
  after a deploy.
- **M6. Security tests against a live stack never run.** No workflow sets `TENANT_SWAP_ATTACK_E2E`
  (`e2e/tests/tenant-swap-attack.e2e.spec.ts:48,94`), `MQTT_ACL_E2E`
  (`apps/sensor-service/src/edge-device/__tests__/mqtt-acl.mosquitto.spec.ts:29,141`) or
  `SENSOR_INGEST_EQUIVALENCE_E2E`.
- **M7. There is no load testing.** The only k6 script, `tests/performance/api-smoke.js`, is a GET
  on /health at 10 VUs for 30 s. Its dispatch-only job has 0 runs.
- **M8. The nightly `db-migration-check` is unreliable.** It is scheduled daily
  (`db-migration-check.yml:113`) but last ran 2026-09-24, with month-long gaps before that. It is
  also not a required check; the required ones are sens-enterprise-summary, merge-gate,
  aria-merge-authority and build-status.

## Minor

- **The reachability invariant is not vacuous but has holes.**
  - It guards against an empty scan (`test-target-ci-reachability.spec.ts:306-312`).
  - It counts a plain text match in any workflow as "reachable", including comments and
    dispatch-only or disabled workflows (`:160-178`).
  - Its `*jest.config.*` glob misses `jest.e2e`/`jest.integration` configs, so farm-service's
    `e2e` target (2 specs) runs nowhere.
  - The allowlist reason for `tests/e2e/v11-*` (14 specs, `:294-297`) names an "upgrade workflow"
    that does not exist.
- **Coverage floors are low ratchets.** Examples: admin-api branches at 17%, hr functions at 15.6%
  (`tools/quality/service-coverage-baselines.json`). Only 6 of 34 Jest configs and 0 of 17 Vitest
  configs set thresholds. There is no Stryker mutation testing and no `jest/expect-expect` lint
  rule. Skips are rare: 3 `describe.skip`, including the abandoned
  `apps/admin-api-service/src/tenant/__tests__/tenant.e2e.spec.ts:41`.
- **The three jobs skipped on push are skipped by design, not by a broken condition.** merge-gate,
  schema-validation and infra-image-build-check are PR/merge_group-only
  (`ci-affected.yml:894,1385,1895`). The comment at `ci-affected.yml:1443` says security-audit
  runs only on PRs, but it runs on push. Its exceptions are dated (they expire 2026-10-16), so
  main can go red without any code change.

## Not verified

- The repo variables `PRODUCTION_DEPLOY_ENABLED` and `STAGING_ENABLED`, and the `production`
  environment's protection rules (the proxy blocked those API paths); which tests or lint rules
  fail in ci-full (job logs were blocked, annotations only say "exit code 1" or report the
  timeout); whether the production droplet is currently live.

## Registry entries

This review appended 9 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| DEPLOY-HIGH-028 | HIGH | The production deploy workflow deploy-digitalocean.yml is disabled\_manually (last run 2026-07-08), no workflow calls it, and the deployed/production tag sits 421 commits behind main at 7f1508da, so there is currently no running path that puts current code into production |
| DEPLOY-HIGH-029 | HIGH | A production deploy dispatch needs no green CI: release-verification runs only type-check, invariants:fast and the db-migrate tests (no unit, integration, lint or E2E), nothing checks that the ref is main, staging-gate skips itself unless STAGING\_ENABLED is set, and concurrency is keyed on github.ref so two branches can deploy at once |
| MT-HIGH-070 | HIGH | Live-stack security tests never run in CI: no workflow sets TENANT\_SWAP\_ATTACK\_E2E, MQTT\_ACL\_E2E or SENSOR\_INGEST\_EQUIVALENCE\_E2E, so the tenant-swap attack, MQTT ACL and sensor-ingest equivalence suites are skipped everywhere |
| PERF-HIGH-017 | HIGH | Capacity is unproven: the performance baseline is all TBD, the only k6 script GETs /health at 10 VUs for 30 s with a dispatch-only job that has never run, Mosquitto runs on 128M / 0.15 CPU with an HTTP ACL call per publish, and the deploy capacity gate still uses the pre-telemetry 1920 MiB floor |
| PROC-HIGH-039 | HIGH | CI - Full has failed on main four runs in a row (lint-and-typecheck and test), the last green run was 2026-09-01, the "Run all tests" step timed out at 35 minutes on 2026-09-27, and it is the only lane that enforces coverage thresholds, while the affected-only runs mask it |
| PROC-HIGH-040 | HIGH | No end-to-end run against a deployed stack has passed since 2026-04-04: e2e-tests.yml only triggers after the disabled deploy workflow, runs from the shared /var/aqua-saas working tree against the production database, ignores a failed health check, and production-post-deploy-verify.yml has run once ever |
| PROC-MEDIUM-041 | MEDIUM | The nightly db-migration-check is scheduled daily but last ran 2026-09-24 with month-long gaps before that, and it is not a required check (the required ones are sens-enterprise-summary, merge-gate, aria-merge-authority and build-status) |
| PROC-MEDIUM-042 | MEDIUM | tests/invariants/test-target-ci-reachability.spec.ts counts a plain text match in any workflow as reachable (including comments, dispatch-only and disabled workflows), its jest.config glob misses jest.e2e/jest.integration configs so the farm-service e2e target runs nowhere, and the tests/e2e/v11-\* allowlist names an upgrade workflow that does not exist |
| PROC-LOW-043 | LOW | Coverage floors are low ratchets (admin-api branches 17%, hr functions 15.6%), only 6 of 34 Jest configs and 0 of 17 Vitest configs set thresholds, there is no mutation testing or jest/expect-expect rule, and an abandoned describe.skip remains in admin-api tenant.e2e.spec.ts |
