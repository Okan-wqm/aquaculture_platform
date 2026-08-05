# ARIA Wave R — PR reconciliation review (2026-08-02)

Program: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` (Wave R).
Scope: reconciliation of the two open ARIA PRs (#1041, #936) with `main`, and
salvage of registry substance that existed only on closed branches.

## Wave R outcomes

- **#1041 → #1045 (merged `fd963861`).** The RC-closeout branch was merged
  with `main@7e1563e6` (five migration re-timestampings, jest spec-constant
  merge, drained expired dormancy waivers, registry re-chain to 1324 rows,
  debt-closure repin, format-scope regeneration) and re-landed as a single
  compliant squash commit because the branch's pre-retrace history carried
  `Closes:` trailers whose ORPHAN IDs the #1024 retrace renumbered; the
  force-push ban forbids amending pushed commits, and the operator declined
  growing the frozen `PRE_PHASE6_SHAS` allowlist. Closes ORPHAN-CRITICAL-503,
  ORPHAN-MEDIUM-483, ORPHAN-HIGH-499, ORPHAN-HIGH-502, ORPHAN-HIGH-504.
- **#936 closed as superseded.** Its autonomous-cycle workflow mode is
  rebuilt on the Mission + signed-permit architecture in Waves 8/9. Two
  registry rows existed only on that branch and are re-registered below.

## ORPHAN-HIGH-518 — aria-debts/keys signing-key surface is stageable

Re-registration of #936's branch-local ORPHAN-HIGH-334.
`gh_token_factory.mint_signing_key` / `mint_installation_token`
(`aria-kernel/aria_kernel/gh_token_factory.py`) write per-cycle ed25519
private keys (mode 0600), `.pub` and `.token` files under `aria-debts/keys/`,
but `aria-debts/` is a tracked directory (debt JSONs) and `.gitignore`
carried no rule for the keys subtree — unlike every other ARIA runtime
surface (`aria-tools/`, `aria-findings/`). Any `git add -A` in a workspace
after a key-minting run would stage live private-key material.

**Fixed in the registering commit:** `.gitignore` gains `aria-debts/keys/`
(key material never stageable; `aria-debts/` debt JSONs stay tracked). The
companion workflow-contract write root (`^aria-debts/keys(/.*)?$`) lands with
the Wave 8/9 autonomous-lane rebuild — no scheduled lane mints keys today, so
the ignore rule alone closes the exfiltration surface. Owner:
aria-acceptance-gap-fixer. Deadline: 2026-08-16 (close ceremony after merge).

## ORPHAN-HIGH-519 — FAILING_CI plan source emits non-repo-verifiable evidence

Re-registration of #936's branch-local ORPHAN-HIGH-333. With a real main-CI
failure present, `rank_candidate_sources` selects the `failing_ci` candidate
(highest priority) and `convert_candidate_to_plan_content` produces
`evidence_refs=["gh-run-list:<run-id>"]` — a synthetic token
`classify_evidence_ref` can never grade `repo_verified` at any `target_sha`,
so the convergence gate rejects every envelope and the plan slot is wasted
whenever main is red. The same defect class was fixed for the
F_FINDING/ORPHAN sources (ORPHAN-312, #860) and for target-SHA grading
(ORPHAN-331, #861) but left open on the highest-priority source.

**Fix shape (ORPHAN-312 pattern):** resolve the failing run's `head_sha` +
failed job/step files via `gh api` into real repo paths; keep
`gh-run-list:<id>` as metadata only; skip the candidate
(`plan_candidate_conversion_skipped`) when no repo-verifiable surface can be
derived, so iterative fallback reaches the next source instead of wedging the
cycle. Scheduled into Wave 9 (runtime connectors). Owner:
aria-acceptance-gap-fixer. Deadline: 2026-09-30.
