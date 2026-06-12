# ESLint 8→9 flat-config migration — gate-preservation baseline (A2 PR-1)

**Date:** 2026-06-12
**Agent:** security-reviewer (lead-verified)
**Scope:** `tools/lint-gates/lint-gates.spec.ts` (new), `tools/lint-gates/custom-rules.spec.ts` (new), `.husky/pre-commit` (glob widened), `package.json` (gate script). `.eslintrc.json` is UNCHANGED.

---

## PLAT-HIGH-001 — ESLint 8.57.1 is EOL; its 16 architectural lint gates had no executable baseline before the v9 flat-config migration

**Problem.** ESLint 8.57.1 has been EOL since 2025-10 — no security patches. The repo runs **16 architectural gates** on top of it (10 `no-restricted-*` core gates + 6 custom `eslint-plugin-aquaculture` rules), several of which prevent specific past outages (the JWT_SECRET ban references the 2026-04-14 hydroponics boot crash; the getRepository ban prevents IDOR). Migrating to ESLint 9 flat config (PR-2) re-writes the config format and re-wires plugin loading; without a behavioural baseline, a gate could silently lose severity, scope, or firing semantics in translation.

**This PR (PR-1) = the proof mechanism.** It captures the CURRENT gate behaviour as an executable spec on ESLint 8 + unchanged `.eslintrc.json`. PR-2 translates the config; these specs must stay green UNCHANGED. Green-on-both = no gate silently lost.

### The 10 core gates (`no-restricted-imports` / `no-restricted-syntax`)
1–2. `no-restricted-imports`: ban `@aquaculture/backend-common` + `@platform/backend-common` root-barrel imports.
3–4. `no-restricted-syntax` (main TS): `getRepository()`, `JSON.stringify(x,y,2)` (>2 args).
5–8. `no-restricted-syntax` (main TS): the 4 `JWT_SECRET` selectors (`.get`, `.getOrThrow`, `process.env.JWT_SECRET`, `process.env['JWT_SECRET']`).
9–10. `no-restricted-syntax` (test override): `getRepository()`, `JSON.stringify(>2)`.

### The 6 custom rules (all pure AST, ESLintUtils.RuleCreator, severity `warn`)
`require-entity-schema`, `no-bare-tenant-query-key`, `no-direct-event-publish`, `no-high-cardinality-metric-label`, `no-claude-sdk-raw-call`, `no-bare-graphql-query-string` — each had ZERO tests before this PR. RuleTester units pin every `messageId`.

### How the baseline is built (technical note)
The config sets `parserOptions.project` (type-aware). `ESLint.lintText` on a virtual path NOT in any tsconfig makes the parser throw before any rule runs; disabling the project makes the type-aware rules throw instead. The 10 core gates are pure AST-selector rules needing NO type info, so the baseline: (1) resolves the REAL per-file config via `eslint.calculateConfigForFile` (ESLint's own resolver — exactly what a lint run uses, incl. override cascade), then (2) runs ONLY the gate rules through `Linter` with espree. This proves both config RESOLUTION and firing BEHAVIOUR without the type-aware-parser obstacle. The 6 custom rules use ESLint core `RuleTester` bound to node:test, with `@typescript-eslint/parser` (no project).

---

## VERIFIED-FIRSTHAND semantic — corrects a prior audit claim (the load-bearing finding)

A prior audit asserted "the JWT_SECRET selectors do NOT fire in test files (the test override replaces the no-restricted-syntax array)." **Firsthand measurement REFUTES this.** Under the ESLint 8 eslintrc override cascade, `calculateConfigForFile` resolves:

| Path kind | `no-restricted-syntax` selectors | JWT_SECRET fires? |
|---|---|---|
| `apps/x/src/y.ts` | 6 | YES |
| `apps/x/src/y.spec.ts` | **6** | **YES** |
| `e2e/tests/x.ts` | **2** | **NO** |
| `web/shell/x.tsx` | 0 | NO |

> **CORRECTION (PR-2, firsthand re-verified):** PR-1 explained `.spec.ts`=6 as
> "the test override's basename `*.spec.ts` glob is INEFFECTIVE" and web=0 as
> "no main no-restricted-syntax on web." **Both explanations were wrong** (the
> *values* were right). The real mechanism, confirmed against the full ESLint 8
> resolved config: every project carries a `root: true` `.eslintrc.cjs`, so the
> ROOT test override never reaches any project file. `.spec.ts`=6 because the
> app's OWN cjs carries the 6-selector gate (via `typedRules`) and its cjs test
> sub-override doesn't touch the rule; web/shell=0 because web/shell's cjs sets
> `no-restricted-syntax: 'off'`; e2e=2 because e2e is a non-project zone where
> the ROOT test override (2-selector subset) DOES apply. These are now recorded
> as faithfully-preserved policy (ORPHAN-MEDIUM-092), not quirks to "fix".

The baseline pins the ACTUAL behaviour via a `SEMANTIC PIN` test + a per-path selector-count config snapshot. The PR-2 cutover reproduces every value EXACTLY (see Validation below).

---

## ORPHAN-LOW (recorded, not fixed here): `require-entity-schema.exemptPatterns` is dead code

The rule declares an `exemptPatterns` option (schema + defaultOptions `['**/*.spec.ts', '**/__tests__/**', '**/*.entity.base.ts']`) but `create()` NEVER reads it (no `getFilename`/minimatch). Exemption is enforced ENTIRELY by the `.eslintrc.json` file-pattern overrides, so the option is inert. Not a security issue and out of A2's scope; flagged so a future cleanup either wires the option or removes it. The baseline does not assert a rule-level filename exemption for this rule (there is none).

---

## Validation
- `tools/lint-gates/lint-gates.spec.ts`: **19/19** node:test pass (10 gates firing/clean + cross-context + SEMANTIC PIN + 6-path config snapshot).
- `tools/lint-gates/custom-rules.spec.ts`: **17/17** RuleTester pass (6 rules, valid+invalid per messageId).
- Wired into the pre-commit gate runner (`tools/*gates/*.spec.ts` glob) + `npm run gates:lint-baseline:test`.

---

## PR-2 (flat-config cutover) — DONE, with a SCOPE CORRECTION the plan missed

PR-1 scoped PR-2 as: write `eslint.config.mjs`, bump to `eslint ^9`, add `@eslint/js`/`globals`, delete `.eslintrc.json` (+ `libs/migration-harness`), web `--ext` cleanup, CI path-filter. **Firsthand validation found this scope materially incomplete.**

### The missed dimension (firsthand-discovered, plan was wrong)
The repo's real lint policy did **not** live only in the root `.eslintrc.json`. **31 projects** each carried a `root: true` `.eslintrc.cjs` (apps/* ×16, libs/event-contracts, libs/node-components, web/* ×9, mcp/farm-management, scripts, tests/invariants, **tools/eslint-rules**) — each pinning its own `tsconfig.eslint.json` (tools/eslint-rules: `tsconfig.json`) and **2–35 per-project rule relaxations**. Under `root: true` these projects did NOT inherit the root overrides. A root-only flat translation would have:
- applied `flat/strict` + `flat/recommended-type-checked` with NO per-project relaxation → **proven** to flood errors (a 2-file sample of auth-service produced 9 `no-unsafe-*` errors that auth's cjs turns off), and
- silently re-enabled gates that projects deliberately disabled (web/shell sets `no-restricted-syntax: 'off'`).

### What PR-2 actually shipped (faithful, zero-drift)
- `eslint.config.mjs` — shared presets apply everywhere; every root-derived override is `ignores`-gated on the 31 `PROJECT_GLOBS` to reproduce the `root: true` cascade boundary; a preset-reconciliation block pins the 7 rules where ESLint 8 eslintrc presets and ESLint 9 flat presets diverge (4 restored `error`s + 3 `off`s that would otherwise flood `no-mixed-spaces-and-tabs` etc.).
- `eslint.project-overrides.mjs` (NEW SSoT) — the 31 per-project policies, `rules`/`testOverrides` captured VERBATIM from the cjs, `tsProjects` re-based to repo root. Replaces all 31 `.eslintrc.cjs`.
- `libs/migration-harness` special-cased: it has a nested `.eslintrc.json` that `extends` root (NOT `root: true`); ESLint 8 re-bases the extended parent's path-globs to the child dir so the lib-scoped `aquaculture/*` rules never matched there — reproduced via `CUSTOM_LIB_IGNORES`. Its `@nx/dependency-checks` on package.json is replicated too.
- 33 config files deleted (root + migration-harness `.eslintrc.json`, 31 `.eslintrc.cjs`).
- `package.json`: `eslint ^9.39.4`, explicit `@eslint/js ^9.39.4` + `globals ^17.6.0`; 3 nested `eslint ^8` web devDeps removed; 9 web `--ext` scripts cleaned. CI path-filter `.eslintrc.* → eslint.config.mjs` + `tools/lint-gates/**`.

### Proof of zero drift (the enterprise-grade core)
A migration-time verifier captured the ESLint 8 **full resolved rule map** (492 rules) for **71 representative files** across every zone and diffed it against the ESLint 9 flat resolved map, per rule: **0 mismatches** (off≡undefined normalised). Committed as the durable `tools/lint-gates/eslintrc-flat-parity.spec.ts` (curated 11-zone subset, **11/11**). End-to-end: the same auth-service files that produced 9 errors under a root-only config lint **clean** under the faithful config.

### PR-1 baselines stay green UNCHANGED (gate-preservation proof held)
- `lint-gates.spec.ts`: **19/19** (the 2 snapshot values I had briefly mis-edited to `6/6` as a fake "improvement" were reverted to the faithful `e2e=2`, `web/shell=0`; the SEMANTIC PIN explanation corrected — see the CORRECTION box above).
- `custom-rules.spec.ts`: **17/17**.

### Findings spawned (firsthand, recorded — NOT smuggled into this migration)
- **ORPHAN-HIGH-091** — the 6 custom `aquaculture/*` architectural-invariant rules are INERT inside all 31 projects (root:true shadowing); live only in non-project lib zones. `require-entity-schema` (ADR-011) never runs on any app entity. Activation is a separate, measured PR.
- **ORPHAN-MEDIUM-092** — `no-restricted-syntax` (incl. the 4 JWT_SECRET selectors) is `off` in 5 web modules and 2-selector in e2e. Re-activation (JWT_SECRET-everywhere block) is a separate PR.

Both are faithfully PRESERVED here (zero-drift migration never "improves" silently) and tracked in `docs/reviews/orphan-findings.md`.
