# ARIA Plan 007: Enterprise Intelligence Foundation

## Summary

Plan 007 is split into sub-phases. This implementation covers Phase 007a only: Memory v1 plus cycle diff. Pressure scoring, richer reflection, adapter expansion, proposal generation, and web research execution stay in later phases.

## Phase 007a Scope

- Memory beliefs become lifecycle records with confidence, support count, contradiction count, evidence refs, first/last seen cycle, and status.
- Repeated cycles append new ledger rows but `memory list --kind beliefs` returns the latest state per `belief_id`.
- v0 belief rows that used `evidence` remain readable through normalization.
- Self-output evidence from `aria-tools/`, `agent-workspace/`, and `.aria-poc/` is rejected for beliefs.
- Cycle diff compares discovery artifacts between cycles and writes `aria-tools/cycle-diff/<cycle-id>.json` plus `cycle-diffs.jsonl`.

## Later Phases

- 007b: scored pressure queue, richer daily report, budget caps.
- 007c: event-contracts, tenant-scoping, security-boundary, and test-gap SHADOW adapters.
- 008: proposal generator, after stable memory and pressure operation.
- 009: sandboxed web research execution tier.

## Acceptance

- Repeated shadow cycles produce stable belief state without duplicate listing.
- Cycle diff reports changed paths between discovery runs.
- Integrity verification remains valid across memory and diff ledgers.
- No app code mutation is allowed by ARIA cycles.
