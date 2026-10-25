# Closes Footer Check — the job budget predates its self-test step (2026-10-25)

`validate-closes` failed on PR #2103 (F1.7). The failure was not a refused trailer: the job was
cancelled by its own 5-minute timeout while the gate self-tests were finishing, before the
`Validate Closes trailers` step started. On the same commit range the trailer validator and the
registry chain verify both pass locally.

---

## PROC-MEDIUM-061 — validate-closes is cancelled by a budget set before the self-tests joined it

- **Severity:** MEDIUM; owner: Okan-wqm; deadline: 2026-11-01.
- **Evidence:**
  - `.github/workflows/closes-footer-check.yml:29` (at 6659c432b): `timeout-minutes: 5`, from when
    the job ran only the trailer validator.
  - `.github/workflows/closes-footer-check.yml:67-69`: the `Gate self-tests` step
    (`npm run gates:test`) runs before the validator at `:71`.
  - `tools/gates/run-all.mjs:63-68`: 28 gate suites, one ts-node process each, run one after
    another.
  - Run 40154016007, job 121051359855: checkout 56 s, npm ci 67 s, self-tests 181 s
    (`run-all: 28 gate suite(s) passed.`), then `The operation was canceled.` at 5.0 minutes.
  - Over the 20 newest runs (2026-10-24 .. 2026-10-25): job median 4.18, p90 4.43, max 4.63
    minutes; self-test step 1.37 .. 3.02 minutes; everything outside that step at most 2.2
    minutes. Every spec slowed by the same factor in the slow runs (plan-coverage-witness 26.8 s
    against 57.9 s, ripple-tracer 24.1 s against 51.6 s), so this is runner variance, not a
    regression in one suite.
- **Rule:** a CI timeout is a hang detector derived from the job's measured duration, and an
  overrun fails as the named step that overran (`tests/invariants/ci-timeout-budget-ssot.spec.ts`).
- **Failure scenario:** on a slow runner the job reaches 5 minutes inside the self-tests, is
  cancelled, and the PR shows `validate-closes` red although no trailer was examined.
- **Fix:** the job budget is 10 minutes and the self-test step has its own 5-minute budget, both
  derived from the measured distribution with the factors the spec already applies to `ci-full`
  (step at least 1.35 x its maximum, job at least 1.5 x its maximum and its kill point; the
  largest prologue plus the step budget stays below the job budget). The spec now records the
  distribution (`MEASURED_CLOSES`) and pins both budgets, so changing either without
  re-measuring fails the invariant.
