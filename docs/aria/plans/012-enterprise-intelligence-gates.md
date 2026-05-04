# ARIA Plan 012: Enterprise Intelligence Gates

## Summary

Plan 012 turns the enterprise roadmap foundations into explicit decision gates. ARIA can compare baseline and worktree validation, require architecture evidence packs before ADR drafts, enforce research source policy, score fitness with trend evidence, and record code-change plans that cannot cross forbidden scopes.

## Key Changes

- Validation comparisons produce `regression_status` from baseline and worktree validation plan refs.
- Architecture evidence packs require repo fit, current stable, authoritative refs, migration risk, and repo value before ADR draft readiness.
- Research fetches can be constrained by recorded or per-call domain allowlists while preserving sanitized content hashes.
- Fitness reports include trend deltas, low-dimension blockers, and a deterministic next-action candidate.
- Code generation remains gated by `CodeChangePlan`; forbidden globs and missing validation refs block review readiness.

## Acceptance

- A passing baseline and failing worktree validation emits `validation_regression`.
- A high-adoption technology can produce an ADR draft only when a complete evidence pack is attached.
- Research policy blocks non-allowlisted hosts even when content is otherwise fetchable.
- Fitness reports identify the lowest evidence dimension without emitting an automatic recommendation.
- Code-change plans block kernel, infra, secret, and migration scopes by default.

## Assumptions

- Code generation still does not write repo files; it records auditable plans for an approved apply lane.
- Research evidence informs architecture and fitness but never replaces repo-local evidence.
- Runtime and kernel changes remain outside auto-merge.
