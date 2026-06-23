# ESLint `nx affected --target=lint` OOM — root cause + masked-debt remediation

**Reviewer:** infra-expert (lint infrastructure)
**Date:** 2026-06-23
**Branch:** `fix/eslint-affected-lint-rootcause` (off `origin/main` @ a8ec4be52)
**Related memory:** `feedback_github_ci_build_loop`, `feedback_orphan_findings_doc`

---

## INFRA-HIGH-025 — `nx affected --target=lint` OOMs on projects with no scoped parser `project`

**Severity:** HIGH (CI gate is unrunnable for any change that touches a global lint input)

**Evidence:** `eslint.config.mjs` pins `parserOptions.project` to the monorepo-wide
`TS_PROJECTS` glob for every `**/*.ts` (base block). Projects listed in
`PROJECT_LINT_OVERRIDES` (the 31 former `root:true .eslintrc.cjs` trees) get a
`perProjectBlock` that overrides `project` to their own `tsconfig.eslint.json`.
Projects that own a (typed) ESLint lint target but were **never** `.eslintrc.cjs`
trees are absent from that parity-locked list, so their `*.ts` fall through to the
broad glob — typescript-eslint then builds a monorepo-sized `Program` per file and
exhausts the V8 heap before producing any lint result.

**Observed (pre-fix):** `nx affected --target=lint` aborts with
`FATAL ERROR: ... JavaScript heap out of memory` on `migration-harness:lint`,
`aquaculture-engines:lint`, and `service-catalog:lint`. The same class affects
`@aquaculture/farm-shared`, `@aquaculture/shared-contracts`,
`@platform/sensor-automation-types`, and `@aqua/cargo` (same shape, not reached
before the run was aborted).

**Why it hid:** `PROJECT_LINT_OVERRIDES` is parity-locked to the deleted
`.eslintrc.cjs` files (`tools/lint-gates/eslintrc-flat-parity.spec.ts`), so these
non-provenance projects could not simply be appended there. `aquamobil` already had
a bespoke scoped block; `e2e` lints via `nx:run-commands` and was already scoped.

**Fix (tier-2 — make the correct behaviour the zero-effort default):** add a
`NON_PROVENANCE_TS_PROJECTS` list in `eslint.config.mjs` that generates a scoped
parser block per project (mirroring `perProjectBlocks` and the aquamobil block),
pinning each to its own `tsconfig.eslint.json`. Created the 6 missing
`tsconfig.eslint.json` files (migration-harness already had one). This keeps the
type `Program` project-sized so lint runs to completion.

**Validation:** `nx run-many --target=lint` for the 7 projects completes with **zero
OOM**; 5 lint clean immediately, migration-harness + cargo surface the real
(previously masked) debt below.

---

### Remediation A (INFRA-HIGH-025) — migration-harness lint debt masked by the OOM

Once the OOM is fixed, `migration-harness:lint` runs and reports 150 errors that the
crash had hidden: untyped `QueryRunner.query()` results (`no-unsafe-assignment` /
`no-unsafe-member-access`), `ctx!` non-null assertions across the integration specs,
`as Function` / `as unknown as {…}` casts, and an in-source `declare global namespace
jest` block requiring an `eslint-disable`.

**Fix (architectural, no suppressions):**
- `query-runner.ts` — runtime-validated typed boundary (`queryRows`/`queryRequiredRow`)
  for raw SQL, the single typed replacement for `await qr.query()`.
- `__tests__/test-helpers.ts` — `expectHarnessContext` / `expectDefined` /
  `withHarnessSchema` to replace `ctx!` and `value!`.
- `jest-matchers.d.ts` — moves the `toHaveNoDrift` matcher augmentation out of the
  runtime module into an ambient `.d.ts` (removes the `no-namespace` suppression).
- `expect-no-drift.ts` — query sites routed through `queryRows`; `entity.checks` and
  `entity.target` narrowing replace the casts; encrypted-metadata Map typed.
- 12 integration specs refactored to the helpers (`ctx!` → `expectHarnessContext`).

**Validation:** `migration-harness:lint` and `migration-harness:build` both green.

---

### Remediation B (INFRA-HIGH-025) — `@aqua/cargo` unnecessary type assertion masked by the OOM

`tools/executors/cargo/src/run/executor.ts` cast `(err as Error).message` inside a
`child.on('error', (err) => …)` handler whose `err` is already typed `Error` by Node's
typings (`no-unnecessary-type-assertion`). Removed the cast.

---

### Note (INFRA-HIGH-025) — repo-wide latent lint debt now exposed in CI

Because the fix lives in `eslint.config.mjs` (a global lint input), any PR carrying it
makes **every** project "affected", so CI lints the whole repo rather than the usual
changed-project subset. This surfaces pre-existing lint debt in projects that the
affected-set had not been re-linting (e.g. `web/shell`: `prefer-const`, unused
`eslint-disable` directives, `unbound-method` on DOM-prototype patching, and a
`Definition for rule 'aquaculture/no-bare-graphql-query-string' was not found` config
gap). This debt is pre-existing (confirmed against `origin/main`), not introduced
here, and is remediated as part of the same branch so the lint gate lands green.
