# Open-surface hunt — jest configs no Nx project owns

**Cycle:** 2026-07-29-as-never-open-surface-hunt
**Scope:** repository-wide test-lane reachability, found while surveying `as never` usage
**Method:** measurement, not inspection — every claim below was reproduced by running the
suite in question.

---

## Summary

Four libraries ship a working `jest.config.*` and no `project.json`. With no Nx project
there is no target; with no target `nx affected --target=test` cannot select them, the root
aggregate config (`getJestProjectsAsync()`) skips them, and no workflow names their config
in a `run:` step. **127 spec files had therefore never executed in CI.**

| library                   | spec files | measured result on first run |
| ------------------------- | ---------- | ---------------------------- |
| `libs/backend-common`     | 116        | **10 suites / 35 tests RED** |
| `platform/libs/event-bus` | 5          | 35 tests green               |
| `platform/libs/outbox`    | 3          | 32 tests green               |
| `libs/storage`            | 3          | 26 tests green               |

`libs/backend-common` is the platform's security foundation: tenant RLS install, tenant
context middleware, the schema-drift registry, the MODULE_SCHEMAS fan-out pin, HMAC service
identity. It had rotted exactly as FARM-MEDIUM-301 predicted an unrun lane would.

This is the third instance of one shape. FARM-MEDIUM-301 was `farm-service:test:integration`
declared and invoked by nothing. FARM-MEDIUM-303 was `schema-invariants.spec.ts` listed under
a workflow's `paths:` filter and never in a `run:` step. Both were closed by wiring the
specific lane. Neither closed the class, because
`tests/invariants/test-target-ci-reachability.spec.ts` checks reachability in two directions
and **both read the Nx project graph** — a jest config with no owning project produces no
target and is invisible to both.

---

## PLAT-CRITICAL-905 — four jest configs owned by no Nx project

**Evidence.** `npx nx show projects` omits `backend-common`, `storage`, `event-bus` and
`outbox`. `npx jest --config libs/backend-common/jest.config.ts --listTests` returns 116
files, proving the config is functional rather than abandoned. `npx jest --config
apps/farm-service/jest.config.ts --listTests | grep -c libs/backend-common` returns 0 — no
sibling project's config reaches into them. `rg 'jest' .github/workflows/` shows the only
by-path invocations are sensor-service, e2e and messaging-e2e.

**Fix (tier-2 → tier-3).** Five `project.json` files (`backend-common`, `storage`,
`testing`, `event-bus`, `outbox`), each declaring a `test` target. `ci-affected.yml` already
drives `--target test` through `affected-target-policy.sh`, and the policy is strict unless
a project is explicitly quarantined — so declaring the target is sufficient to gate it, and
**none of the five is quarantined.**

Then the class itself: a third direction in `test-target-ci-reachability.spec.ts` — every
`jest.config.*` in `git ls-files` must be owned by a project whose test target is
CI-reachable, or invoked by path in a workflow, or carry a written exemption. The exemption
map has its own honesty check, and writing that check immediately deleted two of the five
exemptions I had drafted, because those configs turned out to be genuinely owned.

Non-vacuity was verified by removing `libs/backend-common/project.json` and confirming the
new assertion fails naming that config.

---

## SEC-HIGH-058 — pool-patch failure was swallowed in both connection bootstraps

`getPgPoolFromDataSource()` returned `null` when the TypeORM driver exposed no `master`
pool. Both callers did `logger.error(...)` and `return`:

- `RlsConnectionBootstrap` — `app.current_tenant` is then never set on a checked-out
  connection, so `tenant_isolation_policy` evaluates against an unset GUC.
- `TenantConnectionBootstrap` — `search_path` is then never set per checkout, so a
  schema-per-tenant service stops routing to `tenant_<uuid>`.

Both are load-bearing for tenant isolation, and the service booted anyway.

Three separate docblocks asserted the opposite behaviour: the util's own
("refuse to start the service"), `rls.module.ts`'s ("throws an actionable error at boot"),
and `rls.module.spec.ts`'s assertion `rejects.toThrow(/REMEDIATION/)`. The string
`REMEDIATION` did not appear anywhere in production code. Thirteen services register
`RlsModule.forPoolService`.

**Fix (tier-1).** The null return is gone. `getPgPoolFromDataSource(dataSource, context)`
throws with the actionable message the docblocks promised. Removing the null removes the
branch the two callers could drift apart on — there is nothing left to handle.

---

## SEC-HIGH-059 — the subdomain spec pinned the fail-open behaviour

`tenant-context-subdomain.spec.ts` asserted that with `ALLOWED_BASE_DOMAINS` unset in
production, a UUID subdomain on **any** host is accepted as that tenant. Production had
since been hardened to reject all in that case, and documents it in
`isAllowedBaseDomain`'s docblock; CLAUDE.md states the same rule.

The spec was not merely stale — it pinned a vulnerability, and the default state of any
deploy that forgets the env var is exactly the state it blessed. Production behaviour was
correct throughout; nothing surfaced the disagreement because the suite never ran.

**Fix.** The test now asserts fail-closed, renamed to say so.

---

## PLAT-MEDIUM-906 — `logger.error(err)` dropped the stack trace

`StructuredLoggerService.writeLog()` extracted `stack` only while looping `optionalParams`.
`logger.error(err)` puts the Error in `message`, so the loop never saw it and the emitted
entry carried `err.message` with no `stack` field. The same function already had a
`message instanceof Error` branch for extracting the message, so the shape was expected.

**Fix.** After the loop, `if (!stack && message instanceof Error) stack = message.stack` —
an explicitly supplied stack still wins, so existing param-driven behaviour is unchanged.

---

## DATA-MEDIUM-011 — migration-harness did not carry drift Class K

`drift-classes.ts` registers `foreign_key_presence` (label K) and the production validator
implements `scanForeignKeyDrift`, but `migration-harness`'s `DriftClass` union stopped at
Class J. `drift-class-parity.spec.ts` exists precisely to catch that, and
`drift-classes.spec.ts` still pinned "exactly 10 classes registered" against a registry of
11 — the commit that added Class K updated the class-K assertion below it and not the count.

**Fix.** Class K mirrored into the harness with the production validator's exact semantics
(count-based against `pg_constraint contype='f'`, no definition-text equality, because PG
canonicalizes FK definitions). Counts re-pinned.

---

## PLAT-HIGH-907 — NOT DONE THIS SESSION

`watchdog.integration.spec.ts` and `schema-integrity.integration.spec.ts` open a TypeORM
connection to a **migrated** PostgreSQL at `DATABASE_HOST:DATABASE_PORT`. They are not
Testcontainers suites, so they cannot pass in a unit lane and fail with `ECONNREFUSED`.
They are excluded from `backend-common:test` by the same pattern
`apps/farm-service/jest.config.ts` uses.

That leaves them in the declared-but-unrun state this whole finding is about. Owner
**Okan-Wqm**, deadline **2026-08-26**. Options: convert to Testcontainers behind a
`backend-common:test:integration` target on the existing `test:integration` lane; move them
to the migrated-DB lane under `e2e/tests/integration`; or delete them if they are proved
redundant against `schema-invariants` + `bootstrap-from-scratch`.

---

## Also corrected while making the lane green

`tenant-isolation-static.spec.ts` pins the tenant-scoped fan-out table count as a
"consciousness check". It had drifted to 183 against an actual 191 (farm 85→92, ai 3→4),
across many merges, because the check never ran. The pins are now measured values and the
lane that enforces them exists.

## Verification

`npx jest --config libs/backend-common/jest.config.ts --ci` → **114 suites, 1257 tests, all
green.** `nx run-many --target=test --projects=storage,event-bus,outbox,testing` → green.
`npm run type-check` → 40 projects green.
