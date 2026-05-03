# ARIA Plan 007: Enterprise Intelligence Foundation

## Summary

Plan 007 is split into sub-phases. The current implementation now covers Phase 007a plus the bounded 007b foundation: Memory v1, cycle diff feedback, adapter-driven belief candidates, deterministic pressure scoring, and richer reflection. Adapter expansion, proposal generation, and web research execution remain later plans.

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

- Operator feedback records `affected_belief_ids`; memory confidence changes only through exact affected-belief ids. Legacy feedback rows are still loaded, but substring matches in free-form notes are intentionally ignored.
- Tool output may include `belief_candidates`. The runner stores valid candidates in the run envelope as `memory_candidates`, and Memory ingests them after tool execution.
- Candidate evidence must pass the same repo-evidence guard as native beliefs. Self-output evidence is rejected and recorded as uncertainty.
- Repeated candidates are idempotent by `belief_id`: support count increases, evidence refs are unioned, and candidate confidence is only an initial prior. Existing confidence remains governed by Memory scoring, support, feedback, contradictions, and revalidation penalties.
- `WITHDRAWN` beliefs are sticky. Adapter candidates with the same `belief_id` write a contradiction record and do not recreate the belief. Re-enabling requires explicit `memory unwithdraw`.
- QUARANTINED adapter sources propagate into Memory. Non-withdrawn beliefs with matching `source_tool_ids` move to revalidation, stale beliefs remain stale, withdrawn beliefs stay closed, and same-cycle candidates from quarantined tools are skipped with uncertainty and calibration records.
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

## Phase 007c Adapter Scope

Phase 007c starts with four SHADOW adapters: event-contracts, tenant-scoping, security-boundary, and test-gap. The event-contracts adapter is first because `libs/event-contracts` already exposes branded `EventId`, `createBaseEvent`, JSON Schema catalogs, and runtime validator dispatch. This gives ARIA a low false-positive, high-leverage contract surface before broader service scans.

- `event-contracts-adapter` runs in SHADOW and scope-locks reads to `libs/event-contracts/src/**/*.ts`.
- It records observations for the base event contract, `BaseEvent`-derived event interfaces, schema catalogs, and validator dispatch functions.
- It emits findings only for mechanical invariant breaks: missing branded `EventId`, missing required BaseEvent fields, missing `createBaseEvent`, empty schema catalogs, or schema catalogs not wired to the runtime validator.
- Adapter intelligence checks use AST/type-checker evidence, not text-only matching: `as const` catalog expressions are unwrapped, `BaseEvent` aliases are resolved, and validator wiring requires executable runtime references.
- It emits the memory candidate `event-contracts:runtime-schema-validation-surface`.

## Later Phases

- 007c remaining: tenant-scoping, security-boundary, and test-gap SHADOW adapters.
- 008: proposal generator, after stable memory and pressure operation.
- 009: sandboxed web research execution tier.

## Acceptance

- Repeated shadow cycles produce stable belief state without duplicate listing.
- Cycle diff reports changed paths between discovery runs.
- Missing concrete evidence reaches `stale` after three consecutive revalidation cycles.
- Glob evidence with zero matches records match-count history and enters revalidation.
- TypeORM adapter output emits at least one valid belief candidate and Memory converts it into a belief.
- Withdrawn adapter-sourced beliefs are not recreated automatically.
- Feedback note/body text does not affect confidence unless the target belief is listed in `affected_belief_ids`.
- Repeated adapter candidate confidence does not override the existing Memory confidence lifecycle.
- QUARANTINED adapter sources revalidate supported beliefs, preserve withdrawn/stale state, and do not create new beliefs from quarantined candidates.
- Event-contracts adapter runs in SHADOW without repository mutation and produces no operator-facing output.
- Event-contracts fixture suite passes on the real repo baseline with no findings.
- Event-contracts schema catalog observations count `as const` catalogs correctly: farm has 10, sensor has 1, and ingest-backend-policy has 1.
- Event-contracts adapter detects aliased `BaseEvent` heritage clauses and rejects empty or import-only schema catalog wiring.
- Pressure scoring is deterministic and `pressure explain` exposes every score component.
- Reflection writes the six operator sections and the JSON reflection ledger remains the source of truth.
- Integrity verification remains valid across memory and diff ledgers.
- Self-output evidence in a full cycle quarantines the tool while integrity verification stays green.
- No app code mutation is allowed by ARIA cycles.
