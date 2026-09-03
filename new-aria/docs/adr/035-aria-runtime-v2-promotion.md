# ADR-035: ARIA Runtime v2 Artifact-Backed Promotion

## Status

Proposed

## Context

ARIA runtime output is now bounded for Codex operation while full evidence is persisted as hash-verified artifacts. A `v2-shadow` soak completed 10 consecutive clean isolated cycles, and a short isolated `v2` smoke passed with artifact verification, integrity verification, retention apply, restore, and rollback.

That evidence proves the candidate path. It does not by itself authorize making `v2` the runtime source of truth.

## Decision

Keep `ARIA_RUN_LEDGER_FORMAT=v2-shadow` as the default. Promote to `v2` only through an operator-approved evidence bundle that proves no audit evidence was hidden, reduced, silently skipped, or made unverifiable.

The promotion gate requires:

- 10 clean isolated `v2-shadow` cycles with artifact verification and integrity verification after every cycle.
- A short isolated `v2` smoke with the same verification plus retention dry-run, apply, restore, rollback, and final verification.
- Parity checks showing no raw finding count regression, emitted finding count regression, raw-to-ledger mismatch, artifact indexing lag, output-size cliff, or abnormal suppression/truncation.
- Fail-closed negative tests for missing artifact, corrupt artifact, hash mismatch, path escape, artifact write failure, restore failure, summary over 32KB, and failed lifecycle before planner/worker drains.
- Proof that every run consumer uses `aria_kernel.runs_reader` rather than ad hoc `runs.jsonl` parsing.

## Non-Decisions

This ADR does not approve autonomous merge authority, lease bypass, tool removal, known-failure allowlisting, or weakening of adapter scope. Those remain separate gates.

`--output full --artifact <path>` remains an operator export. It can be included in review evidence, but it is not authoritative unless the exported content is also represented by indexed runtime artifacts.

## Consequences

`v2` promotion is blocked when any artifact hash status is not `ok`, any raw finding pointer cannot resolve to artifact payload, any covered runtime ledger drifts, or any omission/truncation/suppression lacks an artifact ref, hash, count, reason code, and verification status.

The current summary contract exposes `suppressed_count` and `truncated_count`, but real source-of-truth promotion remains blocked until those values are derived from runtime evidence and tested. Hard-coded zero counters are acceptable for smoke evidence only.

Rollback to `v1` must preserve all already-written `v2-shadow` and `v2` artifacts and ledgers. Rollback must not rewrite or delete audit evidence.

## Evidence Bundle

Operator approval must retain:

- `runs.jsonl`
- `runs/by-cycle/*`
- `raw-findings.jsonl`
- `run-artifacts/artifact-index.jsonl`
- `run-artifacts/manifest.jsonl`
- `retention/events.jsonl`
- `observability/alerts.jsonl`
- `observability/artifact-inventory.jsonl`
- `runtime verify-artifacts` output
- `integrity verify` output
- operator approval record
