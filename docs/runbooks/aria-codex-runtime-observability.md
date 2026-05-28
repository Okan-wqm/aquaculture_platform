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

## 10-Cycle Soak Gate

Before enabling v2 as source of truth:

- 10 consecutive cycles complete.
- Every cycle reports all expected tools `ok`.
- `0 evidence_error`.
- final integrity is `ok`.
- artifact hash re-read is `ok`.
- summary stdout stays under 32KB.
- missing/corrupt/path-escape negative tests fail closed.
