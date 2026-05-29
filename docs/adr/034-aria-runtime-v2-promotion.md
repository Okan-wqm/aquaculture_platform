# ADR-034: ARIA Runtime v2 Artifact-Backed Promotion

## Status

Proposed

## Context

ARIA runtime output is now bounded for Codex operation while full evidence is persisted as hash-verified artifacts. A prior isolated `v2-shadow` run completed 10 lifecycle-clean cycles, but that run produced `artifact_count=0`; it is diagnostic lifecycle evidence only and is not promotion evidence for the artifact-backed runtime contract.

`v2` promotion requires a separate artifact-bearing evidence bundle tied to a clean commit SHA. The bundle must prove that bounded stdout did not reduce audit capacity and that readers, retention, restore, and rollback all fail closed on unverifiable artifacts.

## Decision

Keep `ARIA_RUN_LEDGER_FORMAT=v2-shadow` as the default. Promote to `v2` only through an operator-approved evidence bundle that proves no audit evidence was hidden, reduced, silently skipped, or made unverifiable.

The promotion gate requires:

- 10 clean isolated artifact-bearing `v2-shadow` cycles from a clean worktree and exact commit SHA.
- `runtime verify-artifacts` and `integrity verify` after every cycle, with non-empty verified artifact index and inventory rows unless the run is explicitly labeled lifecycle-only and excluded from promotion.
- A short isolated `v2` smoke with the same verification plus retention dry-run, apply, hot-artifact removal, restore, rollback, and final verification.
- Parity checks showing no raw finding count regression, emitted finding count regression, raw-to-ledger mismatch, artifact indexing lag, output-size cliff, or abnormal suppression/truncation.
- Fail-closed negative tests for missing artifact, corrupt artifact, hash mismatch, absolute/relative/encoded path escape, artifact write failure, restore failure, summary over 32KB, timeout, stale lock, and failed lifecycle before planner/worker drains.
- Proof that every run consumer uses `aria_kernel.runs_reader` rather than ad hoc `runs.jsonl` parsing.

## Non-Decisions

This ADR does not approve autonomous merge authority, lease bypass, tool removal, known-failure allowlisting, or weakening of adapter scope. Those remain separate gates.

`--output full --artifact <path>` remains an operator export. It can be included in review evidence, but it is not authoritative unless the exported content is also represented by indexed runtime artifacts.

## Consequences

`v2` promotion is blocked when any artifact hash status is not `ok`, any raw finding pointer cannot resolve to artifact payload, any covered runtime ledger drifts, or any omission/truncation/suppression lacks an artifact ref, hash, count, reason code, and verification status.

The summary contract exposes `suppressed_count` and `truncated_count`; those values must be derived from runtime evidence, not defaulted for green status. A zero value is promotion-valid only when the evidence bundle proves there was no suppressed or truncated record.

Rollback to `v1` must preserve all already-written `v2-shadow` and `v2` artifacts and ledgers. Rollback must not rewrite or delete audit evidence.

## Evidence Bundle

Operator approval must retain an immutable evidence bundle plus a small committed digest manifest containing the clean worktree commit SHA, commands, environment, tool manifest IDs, run IDs, artifact IDs, artifact SHA256 values, and hashes of verification outputs. The bundle must include:

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
