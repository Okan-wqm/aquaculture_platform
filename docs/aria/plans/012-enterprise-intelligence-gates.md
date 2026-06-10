<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 012: Enterprise Intelligence Gates

## Summary

Plan 012 turns the enterprise roadmap foundations into explicit decision gates. ARIA can compare baseline and worktree validation, require architecture evidence packs before ADR drafts, enforce research source policy, score fitness with trend evidence, and record code-change plans that cannot cross forbidden scopes.

Plan 012's later sub-phases — internally labeled **Phase 012-D through Phase 012-G** — extend those foundations into the first enterprise autonomy spine: validation comparison is now a mandatory apply/PR gate, adapter calibration can prove ACTIVE readiness, generated diffs are constrained to approved `CodeChangePlan` scope, agent genesis has a PR lane, and ARIA records its own cycle metrics plus PR lifecycle recommendations. (The earlier "Phase 012D-015" wording could be misread as separate plan numbers 013-015; those numbers are reserved unused, and the convergent-gate / bound-async-execution work lives canonically in Plan 016.)

## Key Changes

- Validation comparisons produce `regression_status` from baseline and worktree validation plan refs.
- Architecture evidence packs require repo fit, current stable, authoritative refs, migration risk, and repo value before ADR draft readiness.
- Research fetches can be constrained by recorded or per-call domain allowlists while preserving sanitized content hashes.
- Fitness reports include trend deltas, low-dimension blockers, and a deterministic next-action candidate.
- Code generation remains gated by `CodeChangePlan`; forbidden globs and missing validation refs block review readiness.
- Apply actions can become `ready_for_pr` only after a validation gate proves the candidate has no regression and green validation.
- PR opening rejects ungated apply actions; PR bodies carry validation gate refs and local validation evidence.
- Adapter calibration reports check fixture pass, five clean SHADOW runs, precision, and critical false positives before ACTIVE readiness.
- Generated diff packets must match the approved intended files and allowed globs before candidate worktree application.
- Agent genesis PR lanes are scoped to `.claude/agents/aria-*.md` and block duplicate existing agent targets.
- Observability records cycle durations, artifact count, cost units, validation duration, and PR stale/split recommendations.

## Acceptance

- A passing baseline and failing worktree validation emits `validation_regression`.
- A high-adoption technology can produce an ADR draft only when a complete evidence pack is attached.
- Research policy blocks non-allowlisted hosts even when content is otherwise fetchable.
- Fitness reports identify the lowest evidence dimension without emitting an automatic recommendation.
- Code-change plans block kernel, infra, secret, and migration scopes by default.
- A candidate apply action cannot open a PR until `validation gate -> apply gate -> ready_for_pr` is complete.
- Generated diffs touching files outside `CodeChangePlan.intended_files` are blocked before write.
- Adapter calibration marks ACTIVE-ready only after fixture pass and five clean SHADOW runs.
- Agent genesis can prepare a PR lane only after sandbox pass and operator approval.
- Observability dashboards expose cycle trend, validation totals, and cost summary.

## Assumptions

- Code generation still does not write repo files; it records auditable plans for an approved apply lane.
- Research evidence informs architecture and fitness but never replaces repo-local evidence.
- Runtime and kernel changes remain outside auto-merge.
- Code synthesis v0 accepts generated diffs as data packets; the LLM/provider still cannot directly write to the developer worktree.
- PR lifecycle actions are recommendation-only until an operator enables a production GitHub action lane.
