<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 007: Enterprise Intelligence Foundation

## Summary

Plan 007 is split into sub-phases. The current implementation now covers Phase 007a plus the bounded 007b foundation: Memory v1, cycle diff feedback, adapter-driven belief candidates, deterministic pressure scoring, and richer reflection. Phase 007c expands SHADOW adapter coverage. Proposal generation and web research execution remain later plans.

## Phase 007a Scope

- Memory beliefs become lifecycle records with confidence, support count, contradiction count, evidence refs, first/last seen cycle, and status.
- Belief statuses are `supported`, `contradicted`, `needs_revalidation`, `stale`, and `withdrawn`.
- Repeated cycles append new ledger rows but `memory list --kind beliefs` returns the latest state per `belief_id`.
- v0 belief rows that used `evidence` remain readable through normalization.
- Self-output evidence from `aria-tools/`, `agent-workspace/`, and `.aria-poc/` is rejected for beliefs.
- Cycle diff compares discovery artifacts between cycles and writes `aria-tools/cycle-diff/<cycle-id>.json` plus `cycle-diffs.jsonl`.
- Concrete evidence removed or changed by cycle diff moves the dependent belief to `needs_revalidation`; three consecutive revalidation cycles move it to `stale`.
- Glob evidence keeps match-count history. A glob with zero matches moves the belief to revalidation and follows the same three-cycle stale rule.

## Phase 007b Foundation Scope

- Operator feedback records `affected_belief_ids`; memory confidence no longer relies on substring matches in free-form notes.
- Tool output may include `belief_candidates`. The runner stores valid candidates in the run envelope as `memory_candidates`, and Memory ingests them after tool execution.
- Candidate evidence must pass the same repo-evidence guard as native beliefs. Self-output evidence is rejected and recorded as uncertainty.
- Repeated candidates are idempotent by `belief_id`: support count increases, evidence refs are unioned, and confidence remains governed by Memory scoring.
- `WITHDRAWN` beliefs are sticky. Adapter candidates with the same `belief_id` write a contradiction record and do not recreate the belief. Re-enabling requires explicit `memory unwithdraw`.
- Pressure items carry deterministic `score`, `score_components`, `candidate_tools`, `recommended_action`, and `blocked_by`.
- `pressure explain --cycle-id <id> --pressure-id <id>` returns the scored item for operator drilldown.
- Daily reflection reports coverage, beliefs, stale/revalidation state, top pressures, tool health, and next cycle plan.

## Pressure Scoring Formula

- Score range is `[0, 100]`.
- Formula: `min(100, source_weight * recency_decay * (1 + log10(occurrence_count)))`.
- Current-cycle `recency_decay` is `1.0`; historical decay is reserved for multi-cycle pressure rollups.
- Source weights:
  - `tool_quarantine`: 90
  - `evidence_gone`: 80
  - `discovery_incomplete`: 70
  - `contradiction`: 70
  - `belief_stale`: 60
  - `belief_revalidation`: 40
  - `migration_surface_repeat`: 30

## Next Cycle Plan

The next cycle plan is deterministic: it is the top three unresolved pressure items, preserving each pressure item's `recommended_action` and `candidate_tools`. No LLM step is involved.

## Phase 007c Adapter Expansion

- `event-contracts-adapter` remains SHADOW and uses AST/type-checker evidence for schema catalog counts, BaseEvent alias resolution, and validator runtime wiring.
- `tenant-scoping-adapter` runs in SHADOW and uses TypeChecker-backed repository/DataSource evidence plus tenant-owned entity catalogs before emitting findings.
- `security-boundary-adapter` runs in SHADOW and evaluates endpoints against service-level global `APP_GUARD` context before reporting missing guard boundaries.
- `test-gap-adapter` runs in SHADOW and maps high-risk source files through direct import/adjacent test evidence; symbol-only mentions are weak observations, not coverage proof.
- Tool definitions may declare `default_input`; cycle execution merges it into the runtime payload so full-repo SHADOW runs use calibrated scan roots/options.
- Adapter intelligence checks use AST/type-checker evidence where symbol-level precision matters; text-only matches are supporting signals, not the primary proof for findings.

## Later Phases

- 008: proposal generator, after stable memory and pressure operation.
- 009: sandboxed web research execution tier.

## Acceptance

- Repeated shadow cycles produce stable belief state without duplicate listing.
- Cycle diff reports changed paths between discovery runs.
- Missing concrete evidence reaches `stale` after three consecutive revalidation cycles.
- Glob evidence with zero matches records match-count history and enters revalidation.
- TypeORM adapter output emits at least one valid belief candidate and Memory converts it into a belief.
- Withdrawn adapter-sourced beliefs are not recreated automatically.
- Pressure scoring is deterministic and `pressure explain` exposes every score component.
- Reflection writes the six operator sections and the JSON reflection ledger remains the source of truth.
- Integrity verification remains valid across memory and diff ledgers.
- Self-output evidence in a full cycle quarantines the tool while integrity verification stays green.
- No app code mutation is allowed by ARIA cycles.
- Event-contracts schema catalog observations count `as const` catalogs correctly: farm has 10, sensor has 1, and ingest-backend-policy has 1.
- Event-contracts detects aliased BaseEvent heritage clauses and rejects empty or import-only schema catalog wiring.
- Tenant-scoping, security-boundary, and test-gap adapters run in SHADOW without operator-facing emissions or repository mutation.
- 007c adapters produce real-repo baseline observations for tenant sources, security boundaries, and high-risk test-gap coverage summaries.
- 007c adapters stay within calibrated budget caps on a full SHADOW cycle: tenant-scoping <= 3500 cost units, security-boundary <= 5000, and test-gap <= 5500.
- Post-hardening real-repo SHADOW findings remain bounded for calibration: tenant-scoping <= 150, security-boundary <= 150, and test-gap <= 250.
