# DB-Audit Agent Team — Database End-to-End Audit (Lane-D)

**Mission:** Audit the platform database uçtan uca — every durable column's provenance (which code writes it, from what source), read exposure, and frontend reachability — across the platform-admin side, the tenant-admin side, and every domain module. Detect dead/unused columns, orphan and missing tables, FE↔BE disconnects (table without frontend, frontend without backend), duplicate structures, and record every incidental defect (security, correctness, duplication) observed en route.

**Lane:** Lane-D — database-audit (distinct from Lane-A code-review, Lane-B product-audit, Lane-C edge-docs). Lane-D agents are read-only over source; their single write surface is their own report under `docs/reviews/db-audit/**`.

**Dispatch:** No lane orchestrator. The operator (main session) dispatches partitions directly and owns synthesis. Partitions are sized from the 2026-07-11 inventory (334 `@Entity` classes in `apps/`, 25 in `libs/`, 149 live migrations, 5 views).

**Method SSoT:** `.claude/agents/_shared/db-audit-methodology.md` — provenance matrix format, writer/read/fe/class vocabulary, trace recipes, report contract, severity calibration, incidental-findings mandate. Agent files reference it; they do not restate it.

## Roster

| Agent | Partition | Finding prefix |
|-------|-----------|----------------|
| `db-audit-farm-production` | farm-service biology: batch, tank, growth, fish-health, health, water-quality, harvest, species + farm-module/aquamobil surfaces | `DB-FARMPROD-*` |
| `db-audit-farm-operations` | farm-service logistics: feed, feeding, storage, farm-stock, consumable, supplier, chemical, finance + feed-inventory convergence state | `DB-FARMOPS-*` |
| `db-audit-farm-platform` | farm-service assets/ops: farm, site, department, equipment, maintenance, task, worker, document, regulatory, compliance, scheduler, weather, marine-data, sentinel-hub, mobile-command, mobile-dashboard, ai-insights, system | `DB-FARMPLAT-*` |
| `db-audit-sensor` | sensor-service (all ~50 entities incl. VFD/automation/edge-device) + sensor-module | `DB-SENSOR-*` |
| `db-audit-platform-admin` | admin-api-service (71 entity classes) + notification-service + admin-panel REST surface | `DB-ADMIN-*` |
| `db-audit-identity-billing` | auth-service (incl. tenant RBAC) + billing-service + `shared` schema canonical tables + `libs/**` shared entities + tenant-admin module | `DB-IDENT-*` |
| `db-audit-people-messaging` | hr-service + messaging-service + ai-service + hr-module/messaging-module/aquamobil surfaces | `DB-PEOPLE-*` |
| `db-audit-ops-infra` | alert-engine + hydroponics-service + config-service + event-store-service + observability-service + gateway-api + cross-cutting schema-registration/outbox/erasure-ledger checks | `DB-INFRA-*` |

## Output Tree

```
docs/reviews/db-audit/
├── <agent-name>/{YYYY-MM-DD}-{partition}.md   # one report per partition run
└── {YYYY-MM-DD}-database-e2e-audit-synthesis.md  # operator-owned synthesis
```

## Invocation Contract

- Each agent reads its own file plus the methodology shard and the shared contracts it cites, then audits ONLY its partition scope — except the incidental-findings mandate, which is deliberately partition-unbounded.
- Reports are written incrementally (re-Write after each domain) so late context loss cannot erase completed work; the final agent message is a receipt (path + counts + top findings), never the full report.
- Findings use `DB-<AREA>-{SEVERITY}-{NNN}` IDs per `.claude/shared/output-format.md`. Registry entries in `docs/reviews/_registry/findings.jsonl` are minted at remediation time by the closing workstream, not during the audit run.
- Lane-D never edits source, tests, migrations, or other agents' documents. Fixes belong to Lane-A owners via the remediation plan.

## Non-goals

- NOT a code fixer — findings route to remediation workstreams with `Closes:` discipline.
- NOT a replacement for Lane-B product-audit: Lane-B verifies product behavior; Lane-D verifies the durable data surface itself (schema-level completeness, provenance, and parity), column by column.
- NOT a migration author: schema defects are reported with a proposed fix direction, never a hand-edited migration.
