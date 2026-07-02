# Untracked Worktree Remediation — 2026-07-02

## Context

`/var/aqua-saas` is a shared, long-running checkout used by many concurrent sessions (per `feedback_no_git_add_all_shared_checkout.md`). A `git status` sweep found **30 untracked files/dirs**, all dated 2026-06-21/22 (~10 days old), present in **zero** git branches across all ~25 worktrees on this box (`git log --all -- <path>` returns nothing for every one of them). They are orphaned scratch from a past session that was never committed and never cleaned up.

The user asked to bring each one to commit-ready state — but explicitly required verifying **none of them duplicate work that already exists**, since this repo has a documented history of "Potemkin-SSoT" duplication incidents (`project_ssot_audit_2026_06_23.md`). A full file-by-file investigation (direct `diff`/`grep`/`git log` plus two `Explore` sub-agents) was completed; this plan reflects the verified findings, not assumptions. Three ambiguous items were resolved directly with the user via `AskUserQuestion`.

**Outcome of this plan:** every one of the 30 files is either (a) discarded with cited evidence of duplication/danger, (b) wired into real call sites with a cited concrete gap it closes, or (c) committed as-is because it's already correct and unwired only by accident. Nothing lands as inert scaffolding.

---

## Group A — DISCARD (confirmed duplicate / dead / insecure — do NOT commit)

| Path | Evidence |
|---|---|
| `platform/libs/db-migrate-contracts/` (whole dir) | `diff` against the real, tracked, currently-running `apps/db-migrate/src/{schema-registry.ts,platform-bootstrap.service.ts}` shows this is an older, stripped-down fork — it still contains the phantom `audit_log`/`audit_logs` exclusion entries that `ORPHAN-178` already removed from the real file. Nothing in the repo imports `db-migrate-contracts` (no tsconfig path alias, no importer). Wiring this in would create a second schema-registry SSoT — the exact anti-pattern the repo has previously had to clean up. |
| `web/modules/sensor-module/src/services/scriptCompiler.ts` | Uses `new AsyncFunction(...)` to eval SCADA script code on the main thread. Commit `d99b82822` (#592, 2026-06-23) explicitly replaced this exact pattern — *"Replaced the main-thread `new Function` SCADA script eval (no-implied-eval)... with the existing Web Worker ScriptExecutor sandbox"* and *"Deleted dead services/ScriptEngine.ts"*. This untracked file predates that fix by 2 days; it is the insecure pattern the fix removed. The safe replacement already ships at `web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts`. |
| `web/apps/aquamobil/src/utils/webauthn-credentials.ts` | Backend GraphQL contract is real (`apps/auth-service/.../webauthn.resolver.ts` has all 7 operations), but aquamobil already has a **committed, wired** implementation with the same helpers inlined in `web/apps/aquamobil/src/hooks/useWebAuthn.ts`, consumed by `LoginPage.tsx`. This file is a redundant re-extraction. |
| `e2e/tsconfig.eslint.{root,integration,security,workflow,water-chemistry,modules-farm,modules-hr,modules-sensor,modules-tenant-admin}.json` (9 files) | `eslint.config.mjs`'s `NON_PROVENANCE_TS_PROJECTS` mechanism (added in #591, "end affected-lint OOM") already points every e2e file at a single, already-tracked `e2e/tsconfig.eslint.json`. None of these 9 split files are referenced anywhere. They are an earlier, superseded attempt at the same OOM fix. |
| `e2e/types/jest-lite.d.ts` | Hand-rolled `describe/it/expect` ambient globals. `e2e/tsconfig.json` already declares `"types": ["jest","node"]` and the real `@types/jest` (v30) is installed at root `node_modules`. No file references `jest-lite`. Keeping it risks a duplicate global-declaration conflict with the real `@types/jest` ambient types if ever pulled in. |

**Action:** delete these paths (untracked — nothing to `git rm`) before staging anything else, so they can never accidentally get swept into a commit.

---

## Group B — COMPLETE + WIRE (real gap, no duplicate — confirmed via user)

### B1. `apps/gateway-api/src/common/error-normalization.ts` (`toError`)
No existing equivalent. ~9 call sites currently reimplement `error instanceof Error ? error : new Error(String(error))` ad hoc, strictly worse than `toError`'s `JSON.stringify` fallback:
- `apps/gateway-api/src/upload/upload.controller.ts` (5 sites: L313, L392, L558, L637, L741)
- `apps/gateway-api/src/proxy/circuit-breaker.service.ts:552`
- `apps/gateway-api/src/middleware/timeout.middleware.ts:273`
- `apps/gateway-api/src/websocket/adapters/redis-io.adapter.ts` (2 sites: L171, L181)

**Do:** keep `toError`, add `error-normalization.spec.ts`, replace all 9 sites with `toError(error)`.

### B2. `libs/backend-common/src/redis/redis-options.builder.spec.ts` + `.service.spec.ts`
`redis.service.spec.ts` needs no changes. `redis-options.builder.spec.ts` expects a 4th `overrides` param that `buildRedisOptions` doesn't have. Confirm whether `apps/ai-service/src/app.module.ts:238` calls `buildRedisOptions(config, 'ai', ...)` — if so, `ai-service`'s keys (`ai:tokens:{tenantId}:{month}`) get double-prefixed to `ai:ai:tokens:...`. If confirmed live: add `overrides?: { keyPrefix?: string }` to `buildRedisOptions` and pass `{ keyPrefix: '' }` at the ai-service call site. If not live, trim the test instead.

### B3. `web/shell/src/utils/remoteIntegrity.spec.ts`
Add a minimal exported `remoteIntegrityPolicy = { isFederationScript, isAllowedRemoteUrl }` test seam in `remoteIntegrity.ts` (no behavior change to the SH-SEC-04 guard), then land the spec.

### B4. `apps/alert-engine/src/__tests__/support/{redis-service.mock.ts,alert-rule-query-builder.mock.ts}`
Consumed by zero existing specs. Identify what spec these were built for and write it; if no plausible missing spec can be identified, discard both.

### B5. `web/apps/aquamobil/src/utils/async-action.ts` — full scope
Wire `runAsyncAction`/`createAsyncActionHandler` into all ad-hoc silent-swallow sites across aquamobil (`useAuth.tsx`, `useMessages.ts`, `ChatRoomPage.tsx`, and the rest of the ~20 sites) so failures get logged via `logger.error` instead of vanishing.

### B6. `e2e/helpers/env.helper.ts` + `types/js-yaml.d.ts` — rewire `db.helper.ts`
Rewire `TestDatabase`'s hardcoded `DEFAULT_DATABASE_URL` to resolve via `env.helper.ts`'s `.env`/docker-compose parser. `@types/js-yaml` is declared in `e2e/package.json` but not actually installed — prefer installing it for real over the hand-rolled ambient stub.

### B7. `tools/testing/vitest-resource-policy.{ts,json}` — wire in
Wire `loadVitestResourceProfile()` into `web/apps/aquamobil/vitest.config.ts`, replacing its local `testTimeout: 15_000` literal, as the first adopter.

---

## Group C — COMMIT AS-IS (clean, no drift, no wiring needed)

- `web/modules/hr-module/src/components/leave/LeaveBalanceWidget.spec.tsx`
- `web/modules/{admin-panel,hr-module}/src/test-setup.ts`
- 6× `project.json` for already-tracked projects missing only their Nx registration: `libs/farm-shared`, `libs/node-components`, `libs/sensor-automation-types`, `mcp/farm-management`, `scripts`, `tools/executors/cargo`.
- `e2e/project.json` — brings e2e into `nx affected` scope for the first time.

---

## Execution Order

1. Persist this plan to `docs/plans/2026-07-02-untracked-worktree-remediation/PLAN.md`. ✅ (this file)
2. Delete Group A paths from disk.
3. Implement Group B items one at a time (B1→B7), each followed by its own `nx affected --target=test` / `--target=lint` run for the touched project(s).
4. Stage Group C files (explicit paths, never `git add -A`) and commit alongside verified Group B changes, grouped by logical unit.
5. Dispatch domain expert agents for audit validation before each commit: `auth-security-expert`, `alert-engine-expert`, `platform-kernel-expert`, `frontend-expert`.
6. Final full-repo `nx affected --target=test && nx affected --target=lint` before any commit lands.
7. `git push` only after explicit confirmation.

## Verification

- Each Group B wiring change gets its own scoped `nx affected --target=test --target=lint` run immediately after the change.
- B1: new `error-normalization.spec.ts` plus re-run gateway-api's existing upload/circuit-breaker/timeout/websocket suites.
- B2: if the ai-service double-prefix bug is confirmed live, add a regression test asserting no `ai:ai:` double prefix.
- B5: spot-check in the running aquamobil dev app that a forced failure now produces a `logger.error` line instead of silently vanishing.
- B6: run the e2e suite against the actual `docker-compose.infra.yml` Postgres container to confirm `TestDatabase` still connects through the new resolver path.
- Full gate before any commit: `nx affected --target=test && nx affected --target=lint` clean.
