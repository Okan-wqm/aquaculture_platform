# ARIA Cycle Snapshot — cyc-20260510T0156Z

**Date:** 2026-05-10
**Operator-conducted cycle**
**Repo HEAD at cycle:** `6ed058a2af2e8ef91142a5b13d25e9342ebd84f5` (claude/aria-self-audit-F-006, F-006 closure verified)
**Workspace base:** `/tmp/aria-sandbox/ws/`
**Tools dir:** `/tmp/aria-sandbox/tools/`
**Mode:** `--shadow-only` (no operator-facing emit)
**Adapters registered:** 13 (all SHADOW)

## Files

| File | Lines | Description |
|---|---|---|
| `raw-findings.jsonl` | 1086 | Per-adapter raw observations + findings (cycle's actual output, preserved for F-007 evidence chain) |
| `runs.jsonl` | 23 | Tool run envelopes (multiple adapter invocations across cycles) |
| `health.jsonl` | 23 | Per-tool health decisions (action: none / quarantine / calibrate) |
| `governance.jsonl` | 8 | Tool governance events (bootstrap, fitness compute, etc.) |

## Summary (per `tool_id`)

| Adapter | raw_obs | raw_find | emit_obs | emit_find | status |
|---|---:|---:|---:|---:|---|
| banned-phrase-adapter | 0 | 0 | 0 | 0 | ok |
| dual-alias-adapter | 1 | 0 | 0 | 0 | ok |
| event-contracts-adapter | 191 | 0 | 0 | 0 | ok |
| migration-runner-adapter | 1 | 0 | 0 | 0 | ok |
| nats-cert-identity-adapter | 1 | 0 | 0 | 0 | ok |
| schema-drift-adapter | 1628 | 75 | 0 | 0 | ok |
| security-boundary-adapter | 1710 | 14 | 0 | 0 | ok |
| tenant-scoping-adapter | 5130 | 53 | 0 | 0 | ok |
| test-gap-adapter | 1199 | 265 | 0 | 0 | ok |
| typeorm-entity-schema-adapter | 1628 | 75 | 0 | 0 | ok |
| cqrs-adapter | 0 | 2 | 0 | 0 | evidence_error |
| outbox-adapter | 0 | 95 | 0 | 0 | scope_violation |
| agent-harness-security-adapter | 0 | 25 | 0 | 0 | invalid_evidence |

## Linked artifacts

- `aria-findings/F-007.json` (4-anchor adapter promotion blocker)
- `docs/reviews/data-expert/2026-05-10-migration-registry-drift.md` (Phase B production escalation)
- `docs/plans/2026-05-10-aria-self-audit-followups.md` (full plan)

## Why preserved

Plan v2 OQ6 mitigation for risk R8 (sandbox `/tmp/aria-sandbox/` data is session-ephemeral). F-007's evidence chain references specific raw-findings rows; without this preservation those references would dangle after sandbox cleanup. ARIA cycle replay is not yet supported (each cycle produces a different `cycle_id`), so capturing the artifact is the only durable evidence path.

## How to inspect

```bash
# Count raw findings by tool_id
python3 -c "
import json
from collections import Counter
c = Counter()
for line in open('docs/aria/cycle-snapshots/cyc-20260510T0156Z/raw-findings.jsonl'):
    c[json.loads(line)['tool_id']] += 1
for tid, n in c.most_common():
    print(f'{tid:35} {n}')
"

# Find findings with status:invalid_evidence (cqrs/outbox/agent-harness)
grep '"status":"invalid_evidence"' docs/aria/cycle-snapshots/cyc-20260510T0156Z/raw-findings.jsonl | head -5

# Migration-related schema-drift findings (the Phase B input)
grep "migration_registry_missing_entry" docs/aria/cycle-snapshots/cyc-20260510T0156Z/raw-findings.jsonl | head -5
```
