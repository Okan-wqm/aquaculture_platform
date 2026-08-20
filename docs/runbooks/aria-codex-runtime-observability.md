<!-- ARIA-CURRENT-STATE-NOTICE: Historical/compatibility runbook. The Codex runtime decision of
2026-05-25 was reversed (ADR-040) — the live runtime is the Claude Code CLI. For live ARIA
runtime authority, see docs/aria/CURRENT_STATE.md and executable contracts. -->

# ARIA Codex Runtime Observability

ARIA Codex runs expose bounded summaries plus artifact-backed evidence. Operators should monitor both error signals and silence signals.

## Required Checks

```bash
aria-kernel autonomy run --output summary
aria-kernel runtime verify-artifacts
aria-kernel integrity verify
```

The summary must include non-ok tools, evidence errors, artifact refs, artifact hash status, failed phases, suppressed/truncated counts, and incomplete lifecycle count.

## SLOs

- Rolling window: 30 cycles.
- Warning: cycle duration over 600s or 1.5x rolling p50.
- Degraded: cycle duration over 900s or 2x rolling p50.
- Sustained degradation for 3 cycles blocks rollout.

## Silence Alerts

Investigate when any of these change abruptly:

- finding-count cliff
- raw-to-ledger mismatch
- adapter output size collapse
- high-severity finding drop
- artifact indexing lag
- verification backlog
- abnormal truncation or suppression rate

## v2-Shadow Soak Gate

Before treating `v2` as a candidate:

- 10 consecutive cycles complete.
- Every cycle reports all expected tools `ok`.
- `0 evidence_error`.
- final integrity is `ok`.
- artifact hash re-read is `ok`.
- summary stdout stays under 32KB.
- missing/corrupt/path-escape negative tests fail closed.

Any bug fix resets the count to 0. A cycle with fewer recorded tools than expected is acceptable only when the orchestrator explicitly documents the selection and no hidden non-ok tool exists.

## Short v2 Smoke

After a clean `v2-shadow` soak, run 2-3 isolated cycles with `ARIA_RUN_LEDGER_FORMAT=v2`. Verify artifacts and integrity after every cycle, then exercise retention dry-run, apply, restore, rollback, and final verification.

This smoke proves candidate mechanics only. It does not make `v2` source of truth.

## Real v2 Promotion

Real promotion requires ADR-backed operator approval and an evidence bundle containing the run ledgers, by-cycle indexes, raw finding pointers, artifact index, manifest, retention events, artifact inventory, `verify-artifacts` output, `integrity verify` output, and the operator approval record. `v2-shadow` remains default until that bundle passes review.
