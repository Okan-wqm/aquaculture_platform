<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 006: Enterprise Cycle Engine

## Summary

This phase turns the governed runner into a cycle-capable ARIA kernel. It adds deterministic discovery, local memory, pressure scoring, reflection reports, proposal/research ledgers, and tamper-evident JSONL audit chains while preserving the existing no-auto-merge and no-production boundaries.

## Interfaces

- `PYTHONPATH=aria-kernel python3 -m aria_kernel bootstrap init --workspace-root .`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel cycle run --workspace-root . --cycle-id <id> [--discovery-only] [--shadow-only]`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel discovery run --workspace-root . --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel memory update --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel pressure run --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel reflection run --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel integrity verify`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel proposal record|list`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel research record-source|list-sources`

## Safety

Cycles write only ARIA artifacts under `aria-tools/`. Normal tool execution still uses the existing detect-and-quarantine runner, so repository mutation attempts quarantine the responsible tool. Research and architecture changes are proposal records only; they do not mutate application code.

## Cycle Event Types

The append-only `aria-tools/cycles.jsonl` ledger records terminal events of the form `{at, cycle_id, event, ledger_hash, previous_ledger_hash, schema_version, ...}`. The kernel emits at minimum:

- `started` — opens a new cycle. Carries `previous_ledger_hash: null` if it is the first cycle, otherwise the hash of the prior closed cycle.
- `discovery_complete` — discovery engine finished, fates assigned. Carries `file_counts` summary.
- `memory_updated` — belief candidates evaluated; supported / contradicted / needs_revalidation counts attached.
- `pressure_recorded` — pressure scoring run; carries the count and the highest-score pressure_id.
- `reflection_written` — daily report rendered; carries the report path.
- `completed` — cycle closed cleanly. Includes `tool_decision_count` and `tool_governance_decision_count`.
- `aborted` — cycle stopped before completion (kill switch, integrity drift, fatal validation). Carries `reason`.

Plan 016 Faz A and Faz C extend this set with `finding_emitted`, `debt_emitted`, `judge_invocation`, `consensus_event`, `plan_converged`, and `pr_created`; those additions are tracked in their respective plans, not duplicated here.

## Acceptance

- `bootstrap init` is idempotent: re-running on a bootstrapped workspace does not duplicate `repo_identity.json` or rewrite a valid `integrity_index.json`.
- `cycle run` writes one `started` and one terminal event (`completed` or `aborted`) per `--cycle-id`. A second invocation with the same id refuses to re-open the cycle.
- `cycle run --discovery-only` produces `started` and `discovery_complete` events but no `pressure_recorded` or `reflection_written`; the cycle closes with a clearly marked terminal state.
- `cycle run --shadow-only` runs all engines but suppresses operator-facing emission (no `finding_emitted` / no `debt_emitted` events).
- Each engine sub-command (`discovery run`, `memory update`, `pressure run`, `reflection run`) is idempotent for a given `cycle-id` and reuses prior artifacts when present.
- `integrity verify` reports `valid: true` on every covered ledger after a clean cycle and reports the offending ledger when a hash chain is broken.
- `proposal record` requires the full proposal contract (id, source_authority, risk_class, validation_scope) and `proposal list` returns the recorded rows in append order.
- `research record-source` enforces the allowlist defined in Plan 009 / Plan 012; non-allowlisted hosts are rejected even when content is otherwise fetchable.
- A repository mutation attempt by any tool quarantines that tool and emits a governance event; no cycle terminal event is produced before the quarantine event.
- Full kernel regression passes: `PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'`.
