# ARIA judgment pipeline — why consensus confirmed detector-shaped findings (2026-10-03)

Context: of ARIA's six "AI consensus confirmed true positive" findings on `origin/aria/state`
(F-009..F-014, `originating_skill` `ai_consensus:judgment_pipeline`), two are product defects. The
rest were confirmed because the judges were asked whether the rule fired, not whether the product
is wrong, and because the promotion path admitted ARIA's own detector source as evidence. Each gap
below was re-checked against `main` at 405f2ecac before it was registered.

Owner: claude (implementation), okan (review). Deadline 2026-10-17.

## ARIA-HIGH-324

The judge envelope never says what a true positive is. `judge_fanout` asks whether an adapter
finding is a true or false positive, with one generic `must_satisfy` item and `allowed_scope`
`["**"]`. Nothing defines a true positive as a product defect someone must change, so the judges
checked whether the rule's predicate held: Opus on F-011, "Rule predicate … both halves hold"; GLM
noted Vite's 500 kB default and still voted true_positive "because the rule under test is
no_bundle_budget_declared". Three judges sharing that framing agreed at 0.815–0.877, above the 0.80
floor: correlated agreement, not a threshold problem.

Evidence:

- `aria-kernel/aria_kernel/judge_fanout.py:73` (`_render_prompt` defines neither verdict)
- `aria-kernel/aria_kernel/judge_fanout.py:233` (one generic `verdict` obligation; the rule's
  premises are never obligations)
- `aria-kernel/aria_kernel/judge_fanout.py:234` (`allowed_scope` `["**"]`, no forbidden scope)
- `aria-kernel/aria_kernel/feedback_store.py:83` (`CONSENSUS_MIN_CONFIDENCE` 0.80)
- `tools/aria-adapters/bundle-budget-adapter.tool.json:31` (manifests declare tool-level
  `claim_types` only; no rule declares its claim, severity cap or premises)

Rule: A judge asked about an adapter finding is told what the rule claims about the product. The
rule's premises are obligations the judge answers; a true positive needs every premise to hold as a
product fact and a change a person must make to product code or config; the judge bridge refuses a
true_positive whose premise obligations are not all satisfied.

## ARIA-HIGH-325

ARIA admits its own detector source as true-positive evidence and locates a promoted finding at the
alphabetically first cited file. The consensus row takes the union of the agreeing judges' refs,
promotion filters refs only for existence, and the summary names `scope_files[0]`. F-009, F-010 and
F-011 carry nine refs into `tools/aria-adapters/`; F-011 is "at
tools/aria-adapters/bundle-budget-adapter.ts", and F-009 names a platform-admin guard spec while its
subject is hr-service's `gql-auth.guard.ts`.

Evidence:

- `aria-kernel/aria_kernel/feedback_store.py:1071` (consensus `evidence_refs` = union of judge refs)
- `aria-kernel/aria_kernel/feedback_store.py:824` (`_has_unverifiable_evidence` grades existence,
  never admissibility)
- `aria-kernel/aria_kernel/evidence_trust.py:15` (`SELF_OUTPUT_PREFIXES`: detector source has no
  evidence class)
- `aria-kernel/aria_kernel/finding_promotion.py:83` (`_repo_file_refs`: existence is the only
  filter)
- `aria-kernel/aria_kernel/finding_promotion.py:175` (location = `scope_files[0]`)

Rule: Evidence for a true positive and for its promotion lies in the producing tool's declared
scope. ARIA's detector source (`tools/aria-adapters/`, `tools/aria-poc/`, `aria-kernel/`) outside
that scope is the `aria_detector_source` class and is refused at consensus and at promotion. A
promoted finding is located at the adapter finding's own path, resolved by its fingerprint.

## ARIA-MEDIUM-326

Consensus promotion stamps every finding `wrong_code` and folds `critical` into `HIGH`.
`_CLAIM_TYPE` is a module constant and `_SEVERITY_MAP` maps critical to HIGH although `CRITICAL`
exists, so the test-coverage gaps F-009 and F-010 became HIGH `wrong_code` findings and the doc
staleness findings F-012 and F-013 never read as a `currency_gap`.

Evidence:

- `aria-kernel/aria_kernel/finding_promotion.py:42` (`_CLAIM_TYPE = "wrong_code"`)
- `aria-kernel/aria_kernel/finding_promotion.py:38` (`"critical": "HIGH"`)
- `aria-kernel/aria_kernel/finding.py:42` (`SEVERITIES` carries `CRITICAL`)
- `aria-kernel/aria_kernel/finding.py:87` (`absence_in_scope` and `currency_gap` exist)

Rule: A promoted finding carries the claim type its rule's manifest contract declares and a severity
no higher than the contract's cap and no lower than the claim type's floor; a critical consensus
under a CRITICAL cap stays CRITICAL.

## ARIA-MEDIUM-327

`bundle-budget-adapter`'s `no_bundle_budget_declared` tells the judge "nothing warns when the bundle
grows" for a vite config without `chunkSizeWarningLimit`. That is false: Vite warns above 500 kB by
default. The rule also counts `chunkSizeWarningLimit`, a warning, as a budget. The question a person
can act on is whether a CI-enforced size budget exists.

Evidence:

- `tools/aria-adapters/bundle-budget-adapter.ts:113` (`hasBudget` accepts a warning limit)
- `tools/aria-adapters/bundle-budget-adapter.ts:136` ("nothing warns when the bundle grows")
- `web/modules/farm-module/vite.config.ts:89` (`chunkSizeWarningLimit: 600` warns, fails nothing)

Rule: A rule's message states only what is true of the product. The bundle rule asks whether a
CI-enforced size budget exists (`bundle_budget_not_enforced`, LOW, `absence_in_scope`) and makes no
claim about warnings.

## ARIA-MEDIUM-329

`test-gap-adapter` marks a file security-sensitive when `@Public` appears anywhere in its text,
never reads `e2e/` or `tests/`, and matches coverage by import or basename only. A `@Public` health
resolver that returns a constant and is queried by an e2e spec (F-010) was promoted as an untested
security source.

Evidence:

- `tools/aria-adapters/test-gap-adapter.ts:271` (`@Public`, `AuthGuard` or an `/auth/` path anywhere
  makes a file security-sensitive)
- `tools/aria-adapters/test-gap-adapter.tool.json:20` (`default_input.roots` exclude `e2e/` and
  `tests/`)
- `tools/aria-adapters/test-gap-adapter.ts:296` (`matchingTests`: basename or import only)
- `apps/ai-service/src/health/health.resolver.ts:9` (`aiServiceHealth` returns `'ok'`, no
  dependencies)
- `e2e/tests/mobile/ai-action-confirm.spec.ts:68` (the e2e spec queries `aiServiceHealth`)

Rule: Security-sensitive means a public write or a guard implementation. Specs under `e2e/` and
`tests/` are coverage providers when they call the GraphQL field or the route. A class that takes no
dependencies and whose methods return constants is not high-risk.
