# Finding registry — override reopen is structural, not a note (2026-09-04)

**Reviewer:** zcode (integration). **Scope:** `tools/gates/finding-registry.ts`,
`tools/gates/finding-traceability.ts`, `docs/reviews/_registry/`.

## Context

The closure-drift gate landed with the feeding W0–W8 integration: `RESOLVED` is derived from
`origin/main` history (`finding-registry reconcile`, `tests/invariants/finding-registry-closure-drift.spec.ts`).
The first full reconcile on the integration branch (467 findings) also re-closed PLAT-MEDIUM-901 from
commit `aa71b23c4` (2026-05-05). That finding had been reopened on 2026-07-03 with a free-text
"[REOPENED …]" note because the sweep that closed it was wrong: it is a version-gated tracking
finding (ARIA output-contract compat aliases must be removed at aria-kernel 0.3.0) and the aliases
are still present. `aria-kernel/tests/test_enterprise_cycle.py::test_output_contract_compat_finding_is_registered`
pins it OPEN and failed the pre-push suite.

## PROC-MEDIUM-021 — a reopen recorded only in `notes` is re-closed by the next derivation

**Severity:** MEDIUM. **Owner:** zcode. **State:** IN-PROGRESS.

**Evidence.**

- `tools/gates/finding-registry.ts` — `collectMergedClosures` took the oldest `Closes:` commit per
  finding with no notion of a rejected closer; `cmdReopen` refused any row with `closing_commits`
  and offered no override path, so the 2026-07-03 reopen was a hand edit plus a note.
- `docs/reviews/_registry/findings.jsonl` — PLAT-MEDIUM-901 carried the note and, after reconcile,
  `state: RESOLVED` with the same commit it was reopened against.
- `aria-kernel/tests/test_enterprise_cycle.py:832` — the only guard was a downstream test.

**Rule violated.** State derived from history must be able to represent the judgement that a
particular historical closer did not close the finding; otherwise the derivation and the human
decision fight forever.

**Fix (this change).**

- Rows carry `rejected_closing_commits` (schema, `Finding` type). `finding-registry reopen <id>
--reject-closure=<sha> --reason=<why>` moves every current closer there, reopens the row and
  stamps the reason into `notes` (`applyClosureRejection`, unit-tested). Rejecting only some closers
  is refused: a row still closed by another commit is still closed.
- `closureAdmissible` (shared by `close` and `reconcile`) refuses a rejected SHA;
  `collectMergedClosures` skips it, so the drift gate and the derivation agree with the decision.
  Only a NEW commit carrying the trailer can resolve the finding again.
- PLAT-MEDIUM-901 was reopened through the new command against `aa71b23c4` and the 2026-07-03
  sweep closer `8b98aba5c`; `reconcile --dry-run` is clean afterwards.

**Closure criterion.** The command exists and is documented in `docs/reviews/_registry/README.md`;
`finding-traceability.spec.ts` covers admission, derivation and the rejection state machine;
PLAT-MEDIUM-901 is OPEN with `aa71b23c4` and `8b98aba5c` in `rejected_closing_commits` and the ARIA
suite test passes; `reconcile --dry-run` reports the registry clean.
