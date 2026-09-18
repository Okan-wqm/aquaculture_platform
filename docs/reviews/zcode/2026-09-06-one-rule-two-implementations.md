# One rule, two implementations — second branch sweep, 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `5cf4757b9`.

Two gates on main each restated a rule that already had an owner elsewhere, and both copies had
drifted. Recovered while evaluating what `feat/new-aria-standalone-copy` and
`wip/codex-config-ssot-20260816` still add to main; neither branch was merged — only these
derivations were taken.

## ARIA-MEDIUM-038 — the narrative token budget was copied, diverged, and enforced by nothing

**Severity:** MEDIUM. **Owner:** aria-prompt-writer. **State:** IN-PROGRESS.

**Evidence.** `tools/gates/narrative-prompt-lint.ts:47` declared `const TOKEN_BUDGET_PER_FILE =
2000` and applied it to every agent prompt regardless of tier. The rule's SSoT,
`aria-kernel/aria_kernel/narrative_prompt_validator.py:92`, declares
`TOKEN_BUDGET_PER_TIER = {1: 1500, 2: 2800, 3: 3500}` and exposes `token_budget_for_tier`, whose
docstring says new code MUST use it. The lint already parsed `pedagogy-tier:` from frontmatter — it
had the tier in hand and ignored it.

The two implementations disagree on real files: `aria-prompt-writer.md` measures 3390 approximate
tokens and `aria-adversarial-judge.md` 2668, both Tier-3, both inside the kernel's 3500 budget and
both over the lint's flat 2000.

That disagreement never surfaced, and the reason is the second half of this finding: **the lint is
invoked by nothing.** `git grep narrative-prompt-lint -- package.json .github tools/gates/run-all.mjs
scripts tests` returns no hits. `run-all.mjs` globs `tools/gates/*.spec.ts`, so a bare CLI in that
directory is invisible to it — the same silently-green failure class that
`tests/invariants/test-target-ci-reachability.spec.ts` covers for Nx targets and root `test:*`
scripts, and `spec-has-a-runner.spec.ts` for specs. A `tools/gates/*.ts` executable with no runner
falls between all three.

**Rule violated.** One rule has one implementation. A gate that duplicates an SSoT must derive from
it, and a gate nothing invokes is not a gate.

**Fix.** The lint reads `TOKEN_BUDGET_PER_TIER` out of the kernel validator and applies the tier's
budget, failing loudly if that table ever stops being parseable — divergence becomes impossible
rather than merely detectable. `tools/gates/narrative-prompt-lint.spec.ts` is the runner, shaped so
the existing glob finds it without a second registration; it smoke-tests the binary end to end and
pins the derivation rather than the numbers, so it stays correct when the SSoT is retuned. The
validator's own prose said "Tier-2 ≤2200 … Tier-3 ≤2500" against its table's 2800/3500 — a third
statement of the same rule — and now matches.

**Closure criterion.** `run-all.mjs` reports the suite (17, up from 16) and the lint passes on all
20 prompts; changing the kernel table changes what the lint enforces, verified by temporarily
setting tier 3 to 100 and observing the lint fail with `budget 100 for tier 3`.

## PROC-MEDIUM-028 — the breaker gate's exclusion copy outlived the entry it excluded

**Severity:** MEDIUM. **Owner:** circuit-breaker-auditor. **State:** IN-PROGRESS.

**Evidence.** `tests/invariants/no-new-adhoc-circuit-breaker.spec.ts` holds the grandfathered ad-hoc
breakers in `KNOWN_ADHOC_BREAKERS` (4 entries, each annotated with its W3 migration target) and then
repeated those paths by hand as `git grep` exclusions — five of them. The extra one is
`apps/gateway-api/src/opa/opa-client.service.ts`, which the W3 sweep deleted. The ratchet list
correctly dropped it; the exclusion copy kept it.

A stale exclusion is not dead weight, it is a hole: an ad-hoc breaker reintroduced at that exact
path would be filtered out of the scan by the gate that exists to catch it. The file's own docblock
says the list is a ceiling that only ratchets down, which is precisely the property the second copy
cannot honour.

**Rule violated.** The list whose size a gate asserts must be the list the gate excludes.

**Fix.** The exclusions are spread from `KNOWN_ADHOC_BREAKERS`, so the two cannot disagree and the
stale path is gone.

**Closure criterion.** The spec passes (5 tests) with the exclusions derived, and removing an entry
from `KNOWN_ADHOC_BREAKERS` now removes its exclusion in the same edit.
