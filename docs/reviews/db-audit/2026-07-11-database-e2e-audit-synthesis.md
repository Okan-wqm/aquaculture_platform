# Database End-to-End Audit — Synthesis (2026-07-11)

**Lane:** Lane-D `db-audit` (8 partitions). **Cycle:** 2026-07-11. **Operator:** platform owner request — column-level provenance, dead/unused columns, orphan/missing tables, FE↔BE disconnects, duplicate structures, plus mandatory incidental-defect capture.

## Scope & coverage

359 `@Entity` classes (334 `apps/` + 25 `libs/`) + raw-SQL tables, 149 live migrations. Every partition wrote a report under `docs/reviews/db-audit/<agent>/2026-07-11-*.md` with a per-column provenance matrix (Appendix A) and an incidental-findings appendix (Appendix B).

| Partition | Report | Entities | Verdict |
|---|---|---|---|
| farm-production (batch/tank/growth/health/water/harvest/species) | `db-audit-farm-production/…-farm-production-biology.md` | 23 | CONDITIONAL |
| farm-operations (feed/feeding/storage/stock/consumable/supplier/chemical/finance) | `db-audit-farm-operations/…-farm-operations-stock.md` | 31 | CONDITIONAL |
| farm-platform (farm/site/equipment/maintenance/task/worker/document/regulatory/…) | `db-audit-farm-platform/…-farm-platform-assets.md` | 35 | CONDITIONAL |
| sensor (readings/calibration/VFD/automation/edge/SCADA) | `db-audit-sensor/…-sensor-industrial.md` | 51 + 3 raw-SQL | **BLOCK** |
| platform-admin (admin-api 72 + notification 3) | `db-audit-platform-admin/…-platform-admin-notification.md` | 75 | **BLOCK** |
| identity-billing (auth + billing + shared + libs) | `db-audit-identity-billing/…-identity-rbac-billing.md` | 30 grp | CONDITIONAL |
| people-messaging (hr + messaging + ai) | `db-audit-people-messaging/…-hr-messaging-ai.md` | 53 | CONDITIONAL |
| ops-infra (alert/hydroponics/config/event-store/observability/gateway + cross-cut) | `db-audit-ops-infra/…-ops-infra-crosscut.md` | ~19 | CONDITIONAL |

## Aggregate finding tally

**Formal findings:** 1 CRITICAL · 19 HIGH · 27 MEDIUM · 8 LOW = 55. **Incidental (Appendix B across all 8):** ~57. **Overall verdict: BLOCK** (one CRITICAL cross-tenant leak + two BLOCK partitions).

## Cross-partition themes

The audit's core question — *"where is a datum written, and is it single-owned?"* — surfaced eleven multi-owned/duplicate structures spanning services. These are the highest-leverage fixes: each is one SSoT decision that closes several findings.

### A. Duplicate / multi-owned structures

| # | Datum | Owners (should collapse to one) | Findings | SSoT target |
|---|---|---|---|---|
| A1 | Tank fish count | `tank_batches.currentQuantity`+`currentBiomassKg` (mirrors) · `tanks.currentCount` · `equipment.currentCount` | FARMPROD-HIGH-001, FARMPLAT-HIGH-002 | `tank_batches` / `batchDetails` (derived read) — caused the prod 900-vs-719 bug |
| A2 | Feed stock quantity | `feed_inventory.quantityKg` · `storage_inventory.quantity` · `feeds.quantity` | FARMOPS-HIGH-001, HIGH-002 | `storage_inventory` (+ movement ledger); convergence exists ONLY in untracked WIP, not shipped |
| A3 | RBAC permission catalogue | `shared.user_permissions` (`PanelPermissions`, admin-api only) · `auth.tenant_role_permissions` (live, guards+token) | IDENT-HIGH-001, ADMIN dup | `auth.tenant_role_permissions`; `shared.user_permissions` is dead + falsely documented as canonical |
| A4 | Tenant record writes | auth-service command · admin-api direct `save(Tenant)` cross-schema into `auth.tenants` | ADMIN-HIGH-004 | auth-service only (admin-api must call, not write) |
| A5 | Subscription pricing | `billing` (D14 SSoT) · `auth.modules.price`/`isCore` | IDENT-MEDIUM-003 | `billing` |
| A6 | Usage metering | `billing.tenant_usage_metrics` · `usage_aggregations`/`usage_hourly_data` | IDENT-MEDIUM-002 | one declared billing model |
| A7 | Support conversations | `auth.message_threads`/`messages` · `auth.support_tickets`/`ticket_comments` | IDENT-MEDIUM-001, ADMIN drift | one support model |
| A8 | Worker/employee PII | `farm.farm_workers` (encrypted placeholders) · `hr.employees` | FARMPLAT-MEDIUM-001 | `hr.employees` |
| A9 | AI conversation history | `messaging.messages` · `ai.agent_conversations.messages` | PEOPLE-MEDIUM-004 | one declared owner |
| A10 | Fired-alert lifecycle | `alert_incidents` (incident lifecycle) · `alert_history` (triggered-alert audit log) | INFRA-HIGH-002 → **CORRECTED, see [[ORPHAN-MEDIUM-355]]** | **NOT duplicates — keep BOTH.** `alert_incidents` is a live incident-lifecycle model (read+written by alert-evaluation dedup at `alert-evaluation.service.ts:390` + escalation status transitions), FK-referenced by farm `health_events.alertIncidentId`; `alert_history` is the cooldown/audit log. Real gap = missing incident read resolver/FE, not a drop |
| A11 | Edge device model | `edge_devices` (v1) · `devices`/`policies`/`licenses`/… (v2) | SENSOR (dup) | v2 family (retire v1 or document coexistence) |

### B. Orphan tables (durable surface, no product path)

`farm_documents` (full DMS: FSM + presign, only MinIO cleanup reads it — FARMPLAT-HIGH-001) · `feeding_tables` (entity+DTOs, no CRUD path — FARMOPS-MEDIUM-002) · `shared.access_logs` (no writer, no reader; cited invariant test absent — IDENT-HIGH-002) · config `configurations`/`effectiveConfiguration` engine (write-only, no consumer — INFRA-HIGH-001) · admin `GlobalConfig` (dead undecorated class — RESOLVED, ORPHAN-LOW-354). NOTE: `alert_incidents` (INFRA-HIGH-002) was listed here but is NOT an orphan — it is a live incident-lifecycle model (see A10 correction / [[ORPHAN-MEDIUM-355]]); do not drop it. Farm health-capture tables (`lice_counts`/`treatment_applications`/`welfare_assessments`/`escape_incidents`) have `record*` mutations with no FE caller (FARMPROD-HIGH-002); the report side is honest (drafts persist `MANUAL_REQUIRED` when capture is absent — FARMPLAT), so the gap is the missing capture UI, not fabricated data.

### C. Missing tables (code/FE expects, does not exist)

`scada_tag_history` — written by DAQ historian, no migration creates it (SENSOR-HIGH-004) · `ai.conversation_turns` — per-invocation cost SSoT absent; enforcement rides an ephemeral Redis counter (PEOPLE-MEDIUM-002) · hydroponics "grow cycles" — CLAUDE.md promises the table; all state dumped in one `settings` jsonb (INFRA-MEDIUM-001).

### D. FE↔BE contract drift (frontend field ⇄ backend field mismatch)

`impersonation` FE contract resolves entirely to `undefined` (superAdminId/targetTenantId/createdAt vs FE adminId/tenantId/startedAt — ADMIN-HIGH-001) · tenant suspension metadata + `lastActivityAt` assigned to non-`@Column` transient fields TypeORM drops → panel always `undefined` (ADMIN-HIGH-003) · tenant list omits FE-required `tier`/`limits`/`farmCount`/`sensorCount` (ADMIN-HIGH-005) · hr-module payroll+performance GraphQL ops structurally invalid vs live `hr` subgraph — beyond the documented 2-field floor: 5 queries/mutations absent, object fields selected as scalars (PEOPLE-HIGH-001 → **CORRECTED (partial), see [[ORPHAN-MEDIUM-374]]**: the "5 ops absent" half — `teamPerformanceOverview`/`reviewCycleStatus`/`goalProgressTrend`/`departmentKPIs`/`bulkCreateReviews` — is a FALSE POSITIVE from the stale Jun-19 `dist/graphql/subgraphs/hr.graphql` artifact; all five have live registered resolvers at `performance.resolver.ts:173/186/201/278/344` (added by #697) and compose into a fresh supergraph. The scalar-selection half was real: `PerformanceReviewFull.competencyRatings` selected an object type as a scalar — fixed under ORPHAN-MEDIUM-374).

### E. Security (beyond the CRITICAL)

`DB-SENSOR-CRITICAL-001` — `scada_alarms`/`scada_alarm_chronicle`/`scada_tag_history` have NO `tenant_id`, live in the shared `sensor` schema (created as `sensor.scada_alarms`, never per-tenant-cloned), read via unfiltered `SELECT * FROM scada_alarms` → **cross-tenant SCADA alarm/history leak** · `ADMIN-HIGH-002` — impersonation GET endpoints return `originalSessionToken` (stored plaintext `text`) + impersonation token · `SENSOR-HIGH-003` — VFD/SCADA control commands (start/stop/setFrequency/emergencyStop, operator tag-writes) fire with only a log line, no durable command/audit record (life-safety adjacent) · `INFRA-HIGH-003` — event-store + config store raw `tenantId`, `payload` jsonb can embed PII, no GDPR erasure cascade · `PEOPLE-MEDIUM-001` — employee home address + personal/emergency phone exposed to broad `MODULE_USER` role, no object-level scoping · `PEOPLE-MEDIUM-003` — `tool_execution_audit` writes are fail-open (a DB/grant error silently drops actuation-audit rows).

### F. Governance / schema registration

`billing` classified as neither tenant nor platform in `MODULE_SCHEMAS` (INFRA-MEDIUM-002) · `compliance` schema created ownerless, in no registry → drift-invisible (INFRA-MEDIUM-003) · raw-SQL-created tables (SCADA family) are registry-invisible platform-wide (SENSOR + INFRA B6).

### G. Write-only accumulation

`farm_workers` 6 NOT-NULL AES-256-GCM PII columns filled with hardcoded placeholders, never surfaced (FARMPLAT-MEDIUM-001) · ai-insights growth/feeding "insights" computed from hardcoded defaults, not tenant data — identical for every entity (FARMPLAT incidental) · `sensor_readings` all columns write-only (legacy default-off path — SENSOR).

## Corrections to prior signals (agents self-corrected the methodology's stale hints)

- **No live farm views:** the "3 live farm CREATE VIEW migrations" hint is stale — zero live views in tracked source (farm-operations B1). Sensor has its 2.
- **`_constants.ts` violations resolved:** event-store/config `@Entity()`-without-`schema:` (the recorded historical violation) is fixed; config/event-store/observability ARE platform-registered via db-migrate `SCHEMA_REGISTRY` + `003-schemas.sql` — NOT unregistered (ops-infra).
- **gateway-api has 0 entities** (scope's "1" was stale — it reads `shared.audit_logs` via a Postgres role, not an entity).
- **messaging holds no third support-conversation model** (people-messaging cross-check of IDENT-MEDIUM-001).

## Operational hazard (not a schema finding — flag to the WIP-migration author)

The untracked working-tree migration `1801300000000-BackfillFeedInventoryIntoStorageLedger.ts` shares its timestamp with the tracked `AddCullMortalityAuditEnumValues1801300000000`. If committed as-is, the migration runner has two classes at the same version → non-deterministic ordering / manifest collision. The WIP author must renumber before landing. (Lane-D did not touch these files.)

## Spot-check verification (5 findings confirmed first-hand by the lead)

1. **SENSOR-CRITICAL-001** ✓ — `1800200000000-CreateScadaAlarmStorage.ts:8` creates `sensor.scada_alarms` with no `tenant_id`; `alarm-storage.service.ts:210` reads `SELECT * FROM scada_alarms` unfiltered.
2. **ADMIN-HIGH-004** ✓ — `tenant/entities/tenant.entity.ts:49` maps `@Entity('tenants', { schema: 'auth' })`; `suspend-tenant.handler.ts` calls `save(Tenant)` at 4 sites + `tenant-erasure.handler.ts:710`.
3. **ADMIN-HIGH-002** ✓ — `impersonation-session.entity.ts:101` `originalSessionToken?: string` populated at `impersonation.service.ts:503` from `generateSecureToken()`.
4. **FARMPROD-HIGH-001** ✓ — `tank.entity.ts:174,462` + `equipment.entity.ts:306` both carry `currentCount`; tank_batches carries the count mirrors.
5. **FARMOPS-HIGH-001** ✓ — `feeding/entities/feed-inventory.entity.ts` is a distinct table from `storage_inventory` (dual ledger).

## Remediation packages (priority order)

**P0 — Security (BLOCK-lifting):**
- SENSOR-CRITICAL-001: add `tenant_id` to SCADA tables + tenant-scope every read (or route them per-tenant); this is a live cross-tenant data leak.
- ADMIN-HIGH-002: stop returning session/impersonation tokens on GET; response DTO with explicit field allow-list.
- SENSOR-HIGH-003: durable command/audit table for VFD/SCADA actuation.
- INFRA-HIGH-003 / PEOPLE-MEDIUM-001 / PEOPLE-MEDIUM-003: GDPR erasure cascade for event-store/config PII; object-level scoping on employee PII; make `tool_execution_audit` fail-closed.

**P1 — SSoT collapse (closes the most findings per fix):** A1 tank count, A2 feed stock, A3 RBAC catalogue, A4 admin→auth.tenants write. Each is Tier-1/Tier-2: make the mirror derived or remove the second writer.

**P2 — FE↔BE contract repair:** ADMIN-HIGH-001/003/005 (impersonation + tenant DTOs), PEOPLE-HIGH-001 (hr-module ops vs subgraph — scope shrunk by the [[ORPHAN-MEDIUM-374]] correction above: the 5 "absent" performance ops exist live; the remaining real drift is the fragment-level field mismatches). Root cause is the two uncontracted boundaries — admin-panel hand-written REST types and codegen-unvalidated module GraphQL ops; the durable fix is to close the contract gap (generate FE types), Tier-3.

**P3 — Dead/orphan cleanup + governance:** decide keep-and-wire vs drop for farm_documents, feeding_tables, shared.access_logs, alert_incidents, config engine, GlobalConfig; register `billing` and `compliance` in the schema registry; create the missing tables (scada_tag_history, ai.conversation_turns, hydroponics grow-cycles) or remove their writers/claims.

Registry (`docs/reviews/_registry/findings.jsonl`) entries are minted per fix commit with `Closes:` discipline as each package lands — not during the audit.
