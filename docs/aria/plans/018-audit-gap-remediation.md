<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 018: Audit Gap Remediation

## Summary

Plan 017 closed the operationalization debt the 2026-05-07 review recorded — bound-agent traffic, impact graph computation, architectural debt records with auditable lifecycle, and review records all landed on snowball with live ledger evidence. The 2026-05-08 sign-off review (`docs/aria/reviews/2026-05-08-plan-017-implementation-review.md`) accepted that work but the post-sign-off audit isolated seven gaps between Plan 017's acceptance criteria and the snowball state at HEAD `695e737d`. Three gaps are HIGH, two MEDIUM, two LOW. None reverses Plan 017's gains; together they prevent Plan 017's "tam kontrol + izlenebilirlik" claim from landing in full. Plan 018 closes each gap with a concrete phase, every change carrying ledger evidence + governance event — no prose-only acknowledgement.

The seven gaps:

- **G1 [HIGH]** `aria-tools/reports/daily/2026-05-07.md` predates the Phase 6 reflection.py change and lacks the Gate Activity section the Plan 017 acceptance gate required (`grep -c "Gate Activity" aria-tools/reports/daily/2026-05-07.md` returns 0).
- **G2 [HIGH]** `aria-debts/DEBT-2026-05-07-002.json`, `-003.json`, `-004.json` all carry `originating_finding_id: F-001` despite having zero content link to the F-001 TypeORM duplication finding. The originating-finding linkage is fictitious.
- **G3 [HIGH]** Plan 017 Phase 4 "live e2e walkthrough" used Python-synthesized envelope responses written by an operator script, not a real Claude Code `Agent(subagent_type=...)` invocation. The sign-off review records this as "synthesized" but no DEBT row tracks it.
- **G4 [MEDIUM]** `tools/aria-poc/banned_phrase_adapter.py` was registered + smoke-tested at module level but never invoked through `aria_kernel.tool_runner.run_tool`. `aria-tools/runs.jsonl` has zero rows with `tool_id: banned-phrase-adapter`.
- **G5 [MEDIUM]** `tools/gates/commit-msg-validator.ts` ARIA lane checks JSON file existence but does not parse the JSON to verify the `finding_id` / `debt_id` field matches the trailer ID. A trailer like `Closes: aria-findings/F-001.json#F-002` currently passes.
- **G6 [LOW]** `tools/gates/commit-msg-validator.spec.ts` "ARIA finding trailer routes to filesystem" test depends on the snowball-resident F-001 file. Spec runs are flaky if the working tree state changes.
- **G7 [LOW]** `aria_kernel/pr_manager.py:open_pr_for_action` enforces base=snowball through a hardcoded subprocess argv, not an explicit function-level guard. The convention is correct but the structural rule is not surfaced.

## Key Changes

### Phase 0 — Preflight + Plan 018 doc

- `aria-kernel worktree preflight` emits a fresh gate event before any Plan 018 work.
- This document persists at `docs/aria/plans/018-audit-gap-remediation.md`.

### Phase 1 — Daily report Gate Activity refresh (G1)

- `run_reflection(cycle_id="aria-20260506T135419Z", base_dir=aria-tools/, repo_root=.)` regenerates the daily report. Output lands at `aria-tools/reports/daily/2026-05-08.md` with the Gate Activity section the post-Phase-6 reflection writer produces.
- One `reflection_completed` governance event + one `aria-tools/reflections.jsonl` row.

### Phase 2 — F-002 emit + 3 DEBT re-link (G2)

- `aria_kernel.finding.emit_finding` writes `aria-findings/F-002.json` with claim_type `convention_inconsistency`, severity MEDIUM, originating_skill `manual:operator-review-2026-05-07`. Evidences cite Plan 016 review sections. The claim_summary names the four impact-source stubs + nine adapter rows + zero PR pipeline test gap as a single architectural pattern.
- DEBT-2026-05-07-002, -003, -004 are read, their `originating_finding_id` and `originating_finding_evidence_chain_id` fields are re-linked to F-002, and a `status_history` entry records the re-link reason. `aria-debts/_index.json` refreshes. Three `debt_originating_relinked` governance events emit.

### Phase 3 — DEBT-005 emit (G3 acknowledgment)

- `aria_kernel.debt.emit_debt` writes `aria-debts/DEBT-2026-05-07-005.json`. Severity MEDIUM, due now+30d. originating_finding F-002. short_term_action ref points at the Python-synthesized envelopes. permanent_fix_required names the real Agent() invocation Phase 7 will execute.

### Phase 4 — Closes-trailer ID-content cross-check (G5)

- `tools/gates/commit-msg-validator.ts` extends the ARIA lane to read the JSON file at the trailer path, parse `finding_id` (for `aria-findings/`) or `debt_id` (for `aria-debts/`), and compare it to the trailer ID. Mismatch + parse error → distinct violation messages.
- Three new `commit-msg-validator.spec.ts` cases cover ID match, ID mismatch, and malformed JSON.

### Phase 5 — banned-phrase-adapter live SHADOW invoke (G4)

- `aria_kernel.tool_runner.run_tool` executes `banned-phrase-adapter` against the snowball workspace under cycle id `plan-018-phase-5`. `aria-tools/runs.jsonl` gains the first non-stub adapter run. One `tool_run_completed` governance event emits.

### Phase 6 — spec test fixture + pr_manager guard (G6 + G7)

- `tools/gates/commit-msg-validator.spec.ts` "ARIA finding trailer" test moves to `os.tmpdir()` synthetic fixtures so the spec is independent of snowball working-tree state.
- `aria_kernel/pr_manager.py:open_pr_for_action` gains an explicit `base: str = "snowball"` parameter + a `GovernanceError` when `base != "snowball"`. The subprocess argv stays `--base snowball` as defense-in-depth. One new `test_pr_manager_e2e.py` case asserts the explicit reject.

### Phase 7 — Real Agent() walkthrough → DEBT-005 RESOLVED

- F-001 (or F-002) seeds two new judge request envelopes. The operator pulls them via `aria-kernel agent next-pending`, runs `Agent(subagent_type="aria-evidence-judge")` and `Agent(subagent_type="aria-adversarial-judge")` from a Claude Code session, and submits the model-generated envelopes via `aria-kernel agent submit-result`. `consensus run` follows; the dashboard regenerates.
- `aria-tools/agent-invocations/{requests,claims,results}.jsonl` each gain two real-Agent rows. `aria-tools/operator-feedback.jsonl` gains two ai_judge + one ai_consensus rows where the agent_id field is a real Claude Code session identifier. DEBT-005 transitions to RESOLVED with `closes_in_commit` + `status_history` populated; one `debt_resolved` governance event emits.

### Phase 8 — Verification + sign-off review v3

- Full kernel regression: `unittest discover` ≥469 tests green (466 baseline + Phase 4 commit-msg + Phase 6 pr_manager).
- Per-phase ledger evidence audit (governance event delta + ledger row delta).
- `git push origin snowball`.
- `docs/aria/reviews/2026-05-08-plan-018-implementation-review.md` records the seven-gap closure with live evidence references for each.

## Acceptance

- Phase 0: `worktree_preflight` event with `gate_pass: true`. Plan 018 doc on disk.
- Phase 1: `aria-tools/reports/daily/2026-05-08.md` exists, contains a "Gate Activity" section with eight or more distinct gate kinds.
- Phase 2: `aria-findings/_index.json` carries two entries (F-001, F-002). Three DEBT JSONs (-002, -003, -004) carry `originating_finding_id: F-002`. Three `debt_originating_relinked` governance events.
- Phase 3: `aria-debts/_index.json` carries five records. DEBT-005 status OPEN, severity MEDIUM, due_date now+30d.
- Phase 4: `commit-msg-validator.spec.ts` reaches 33 passing tests. A synthetic mismatch trailer fails with a distinct ARIA violation message.
- Phase 5: `aria-tools/runs.jsonl` carries at least one row with `tool_id: banned-phrase-adapter` and `cycle_id: plan-018-phase-5`.
- Phase 6: `commit-msg-validator.spec.ts` ARIA finding test no longer reads from snowball working tree. `test_pr_manager_e2e.py` rejects `base="main"` invocation.
- Phase 7: requests.jsonl and results.jsonl each carry four rows (two from Plan 017 Phase 4 + two from Phase 7). agent_id field is a Claude Code session identifier on the new rows. DEBT-005 status RESOLVED with `closes_in_commit` populated.
- Phase 8: `docs/aria/reviews/2026-05-08-plan-018-implementation-review.md` exists, references each of the seven gaps with the corresponding live ledger row, and lands on `origin/snowball`.

## Assumptions

- `run_reflection` is idempotent: calling it again with the same cycle_id but a newer impl writes the regenerated daily report alongside the older one (the older 2026-05-07 file remains a historical snapshot the audit references). The Gate Activity section comes from the 2026-05-08 file.
- DEBT JSON in-place re-link via `Edit` keeps the rest of the record stable; the kernel's `_refresh_index` step regenerates the index without changing the hash chain semantics. `status_history` append records the re-link reason.
- Phase 7 is operator-supervised. Claude Code session identifiers (uuid or operator-driven label) replace the synthesized labels. Real LLM cost is bounded by the existing budget gate.
- Banned-phrase scan over this plan + the future review v3 stays clean. EXEMPT_PATHS already covers `docs/aria/plans/` + `docs/aria/reviews/` per Plan 017 Phase 1.2.
- Plan 018 does not modify SPEC.md, IDENTITY.md, CONTRACTS.md, or ROADMAP.md. Future spec changes land in a separate plan document.
