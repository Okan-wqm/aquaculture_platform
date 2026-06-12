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
| `apps/x/src/y.spec.ts` | **6** (test override's redefinition is INEFFECTIVE via the basename `*.spec.ts` glob) | **YES** |
| `e2e/tests/x.ts` | **2** (test override IS effective via the `e2e/**/*.ts` path glob) | **NO** |
| `web/shell/x.tsx` | 0 (no main no-restricted-syntax on web) | NO |

So the test override behaves OPPOSITELY for basename-glob (`.spec.ts`) vs path-glob (`e2e/**`) — a genuinely inconsistent, surprising semantics that nothing previously documented. The baseline pins the ACTUAL behaviour via a `SEMANTIC PIN` test + a per-path selector-count config snapshot.

**Why this matters for PR-2:** flat config's "last matching object wins" is STRICTER/cleaner than eslintrc cascade. A faithful flat translation may make the test override actually take effect on `.spec.ts` (dropping JWT_SECRET there) — a behaviour CHANGE. The `SEMANTIC PIN` test goes red if so, forcing PR-2 to decide consciously (preserve the quirk, or intentionally fix it) rather than drift silently. This is A2's entire reason to exist.

---

## ORPHAN-LOW (recorded, not fixed here): `require-entity-schema.exemptPatterns` is dead code

The rule declares an `exemptPatterns` option (schema + defaultOptions `['**/*.spec.ts', '**/__tests__/**', '**/*.entity.base.ts']`) but `create()` NEVER reads it (no `getFilename`/minimatch). Exemption is enforced ENTIRELY by the `.eslintrc.json` file-pattern overrides, so the option is inert. Not a security issue and out of A2's scope; flagged so a future cleanup either wires the option or removes it. The baseline does not assert a rule-level filename exemption for this rule (there is none).

---

## Validation
- `tools/lint-gates/lint-gates.spec.ts`: **19/19** node:test pass (10 gates firing/clean + cross-context + SEMANTIC PIN + 6-path config snapshot).
- `tools/lint-gates/custom-rules.spec.ts`: **17/17** RuleTester pass (6 rules, valid+invalid per messageId).
- Wired into the pre-commit gate runner (`tools/*gates/*.spec.ts` glob) + `npm run gates:lint-baseline:test`.

## NOT done here (PR-2 scope)
The flat-config cutover itself: `eslint.config.mjs`, `eslint ^9`, `@eslint/js`/`globals`, deleting `.eslintrc.json` + `libs/migration-harness/.eslintrc.json`, web `--ext` script cleanup, CI path-filter update. PR-2 must keep THESE PR-1 tests green unchanged.
