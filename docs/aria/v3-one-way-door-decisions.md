# Plan ARIA-V10.6 — One-Way Door Decisions Risk Enumeration

**Branch:** `snowball`
**Phase:** Plan ARIA-V9 + V10 v3 — V10.6 (one-way-door decisions doc)
**Status:** RESOLVED — closes architectural-arbiter Theme A finding (one-way doors unlabeled).

## What this doc records

The 4-validator audit on the v3 plan flagged that several architectural decisions in V9+V10 are **one-way doors** — irreversible without significant cost. Each entry below identifies the decision, the irreversibility class, and the reversibility cost should it need to be undone.

## 1. EVENT_TYPES whitelist extension (V9.0-B)

**Decision:** Extended `plan_convergence.EVENT_TYPES` with 5 new types: `implementation_requested`, `implementation_started`, `implementation_outcome_recorded`, `implementation_merged`, `implementation_rejected`.

**Why one-way:** Every row in `events.jsonl` is content-hashed via `_idempotency_key`. Renaming or removing a recorded `event_type` invalidates the audit chain for every plan that has emitted such an event. The append-only ledger semantically anchors these strings.

**Reversibility cost:** A ledger migration with hash-chain re-keying. Effort: substantial — every existing autonomy run's events.jsonl must be re-canonicalized + the cache invariants in `_FOLD_PLAN_STATE_CACHE` must be cleared.

**Mitigation:** None feasible. The closed enum is the cost of safety.

## 2. TERMINAL_STATES extension (V9.0-B)

**Decision:** Added `IMPLEMENTATION_MERGED` and `IMPLEMENTATION_REJECTED` to `TERMINAL_STATES` while preserving `CONVERGED` as terminal (V8 invariant).

**Why one-way:** Same as EVENT_TYPES — every `state.terminal_state` value lands in audit rows. Removing a value orphans the audit history.

**Reversibility cost:** A ledger migration + cache invalidation. The V8-active-plan filter (`list_active_plans`) uses `TERMINAL_STATES`; any change ripples to the active-plan cache.

**Mitigation:** Future V11+ work can ADD terminal states (forward-compatible); removal requires the migration.

## 3. `snowball` branch as base for aria-implementer PRs (V9.1)

**Decision:** Every aria-implementer PR opens with `--base snowball`. The `aria-impl-<hex16>` feature branch is created per cycle.

**Why one-way:** Once merged PRs accumulate, the snowball commit history carries every implementer-authored commit. Moving the base to a different branch (e.g. `aria-snowball`) would require rebasing the entire ARIA history.

**Reversibility cost:** A branch rename + remote ref rewrite + every downstream consumer (CI workflows, branch protection rules, GitHub App installation scope) must be updated.

**Mitigation:** The `--base` value is a configuration constant on the `aria-implementer` agent file (V9.1) and the V9.0-D `ALLOWED_BASH_COMMANDS` regex `^gh\s+pr\s+create\s+--base\s+snowball`. Changing the base is a coordinated, multi-commit operation but possible.

## 4. `pattern_signature` hashing rule (V10.2)

**Decision:** V9.4 `compute_pattern_signature` hashes `(affected_surfaces, key_change_categories, validation_command_set)` after canonical normalization. V10.2 skill-genesis activation triggers on N=5 consecutive matching signatures.

**Why one-way:** Once cycles record `pattern_signature` values in `governance.jsonl`, switching the hashing rule orphans every prior signature. Skill-genesis history becomes uncomparable across the boundary.

**Reversibility cost:** A signature-recomputation pass over historical governance rows + cache invalidation of the V10.2 lookback window. Roughly: rerun `compute_pattern_signature` on every historical plan_content, append a new row carrying both `pattern_signature_v1` + `pattern_signature_v2` until the boundary cycle.

**Mitigation:** The signature has a `schema_version` field in its input canonical dict. Adding a `schema_version=2` lets new cycles emit a new signature shape while old rows still verify under v1. Tier-2 escape hatch.

## 5. `PlanCandidateSource` enum (V9.0-A)

**Decision:** Closed 5-member enum: `OPERATOR_FEEDBACK, FAILING_CI, ORPHAN_FINDING, F_FINDING, GIT_DIFF`. String values are lowercase_snake_case + stable.

**Why one-way:** These string values land in `governance.jsonl`, `cost-attribution.jsonl`, and `pressure-source-effectiveness.jsonl`. Renaming a value silently breaks every downstream rollup + dashboard.

**Reversibility cost:** A ledger-rewrite migration + dashboard reconfiguration. Adding a new member is forward-compatible (just extends the enum); removing or renaming a member is the painful operation.

**Mitigation:** I-V9-PRESSURE-01 invariant pins the exact 5-member set + lowercase_snake_case values + disjointness from `pressure.py` SOURCE_WEIGHTS. A refactor that drops a member would fail CI before merge.

## Themes

- **3 of 5 one-way doors are ledger-anchored** (events, terminal states, candidate sources). The append-only audit-chain semantics are the load-bearing safety guarantee that makes them irreversible without migration.
- **1 of 5 is branch-anchored** (snowball as base). The cost is in coordinated infra updates, not data migration.
- **1 of 5 is hash-anchored** (pattern_signature). Tier-2 mitigation via `schema_version` field.

## Invariants

- I-V10-MEM-04 — hash-chain integrity at every `lookup_pattern` call
- I-V9-PRESSURE-01 — `PlanCandidateSource` exact member set
- I-V9-EVENT-01 — `EVENT_TYPES` contains the 5 V9 implementation types
- I-V9-STATE-01 — `TERMINAL_STATES` contains both V9 terminal states
- V9.1 frontmatter pin — agent file references `--base snowball`

Future ADRs touching any of these decisions MUST cite this doc + carry an explicit migration plan.
