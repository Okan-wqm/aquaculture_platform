# DB Audit — Ops, Infra & Unregistered-Services Partition (Lane-D)

**Agent:** db-audit-ops-infra
**Cycle:** 2026-07-11
**Mode:** CATCHER (review-only)
**Finding prefix:** `DB-INFRA-{SEVERITY}-{NNN}`

## Scope

Entity + column provenance for the ops/infra partition and the three platform-wide cross-cutting checks this lane owns.

Entity inventory (all `@Entity` classes located; scope estimates corrected against the working tree):

| Service | Schema | Entities found | Notes |
|---|---|---|---|
| alert-engine | alert | 6 | alert_rules, alert_incidents, escalation_policies, alert_history (per-tenant); alert_audit_log, alert_outbox (cross-tenant infra, `schema:'alert'`) |
| hydroponics-service | hydroponics | 2 (+outbox) | hydroponics_config (per-tenant); hydroponics_outbox (infra) |
| config-service | config | 2 | configurations, configuration_history (both `schema:'config'`) |
| event-store-service | event_store | 5 | stored_events, event_streams, snapshots, projection_checkpoints, projection_rebuilds (all `schema:'event_store'`) |
| observability-service | observability | 4 | migration_events, emergency_overrides, migration_backfill_progress, schema_object_history (all `schema:'observability'`) + `tenant_cost_rollup` **retired** (archived migration, no entity) |
| gateway-api | — (schemaless) | **0** | Scope estimate of "1 entity" is STALE — no `@Entity` anywhere under `apps/gateway-api/src`; the only match is a comment. Matches `_constants.ts` SCHEMALESS classification. |

## Executive summary

Schema-placement discipline in this partition is clean: the recorded `@Entity()`-without-`schema:` violations for event-store/config (`tests/invariants/_constants.ts:15-16`) are **resolved** — all 7 entities now declare `schema:`; the constants note is stale. The two-registry model is correct: `MODULE_SCHEMAS` (tenant-clone) legitimately omits config/event_store/observability, which are platform-registered via db-migrate `SCHEMA_REGISTRY` + `003-schemas.sql`. No unregistered *product* service exists in this partition.

Top findings: (1) **config-service is a fully-built configuration-resolution engine (`effectiveConfiguration` API with cache policy, restart flags, secret redaction) that NO backend service consumes** — a WRITE-ONLY system; operators' toggles (its own examples: `max_login_attempts`, `session_timeout`) never change behavior. (2) **alert_incidents** — a rich incident-lifecycle table (timeline/assign/escalate/resolve) has no GraphQL/REST/FE read surface and double-owns "fired-alert" ack/resolve state with the product-facing alert_history. (3) **event-store + config store raw tenantId with no GDPR erasure cascade** (event_store also has plain-jsonb `payload` that can embed PII); observability, by contrast, is compliant (HMAC-pseudonymised + GDPR export). (4) **hydroponics** persists all domain state in one generic `settings` jsonb; the CLAUDE.md-promised "grow cycles" has no table. (5) **`billing` classified as neither tenant nor platform** in schema-manager, and the ownerless **`compliance`** schema is unregistered.

## Findings (by severity)

### CRITICAL
_None confirmed. No cross-tenant leak or active data-loss found; the erasure gap (HIGH-003) is a compliance/retention exposure, not an active leak._

### HIGH

#### DB-INFRA-HIGH-001 — config-service configuration-resolution engine has zero backend consumers (WRITE-ONLY system)
**Severity:** HIGH · **Layer:** 2 (pattern) · **State:** OPEN

**Evidence**
- Full consumption API exists: `apps/config-service/src/configuration/configuration.resolver.ts:79` (`effectiveConfiguration`), `:94` (`effectiveConfigurationsByService`); DTO `dto/effective-configuration.dto.ts` carries `requiresRestart`, `cachePolicy{cacheable,ttlSeconds}`, `contentHash`, `sourceChain` (system→tenant fallback) — clearly designed for runtime consumption.
- Writers: `configuration/handlers/{create,update,delete,upsert}-configuration.handler.ts`; management read/write FE: `web/modules/admin-panel/src/pages/TenantConfigurationPage.tsx`.
- Consumer search across `apps/**` (`CONFIG_SERVICE_URL|ConfigurationClient|configurationService.|dynamicConfig|/api/config|getConfigValue`) and `libs/**`: no service imports a config client, no service queries the config subgraph. The engine's output reaches nobody.

**Rule violated**
Domain invariant *"Config keys need consumers … config written via admin but read by nobody is WRITE-ONLY."* Consequence: operators believe security/performance toggles (the entity's own examples `max_login_attempts`, `session_timeout`) take effect; they never do.

**Proposed fix direction**
- Wire a `ConfigurationClient` in `libs/backend-common` (cache + `config.updated` invalidation) that consuming services consult, closing the loop the DTO already anticipates (`requiresRestart`/`cachePolicy`), OR
- If config is display-only today, stop presenting it as an operational control and mark the surface accordingly.

**Affected surface:** `libs/backend-common/src/**`, each consuming service bootstrap, `apps/config-service/src/configuration/*`.
**Expected closer:** platform-kernel-expert / data-expert WRITER mode.

#### DB-INFRA-HIGH-002 — alert_incidents has no product read surface; double-owns fired-alert state with alert_history
**Severity:** HIGH · **Layer:** 2 (pattern — DUPLICATE-STRUCTURE) · **State:** OPEN

**Evidence**
- `apps/alert-engine/src/database/entities/alert-incident.entity.ts:89` — full lifecycle: status, `timeline` jsonb, assignedTo, acknowledgedBy/At, resolvedBy/At, resolutionNotes, escalationLevel, occurrenceCount + resolve/close/reopen/suppress/escalate helpers.
- Writers (EVENT): `alert/services/{farm-signal-incident,mortality-alert,water-quality-critical-alert,alert-evaluation}.service.ts`.
- Internal reads only (BE-INTERNAL): `escalation/escalation-manager.service.ts`, `notification/notification-dispatcher.service.ts`, `audit/alert-audit.service.ts`.
- No `@Resolver` for AlertIncident (only `alert.resolver.ts` [AlertRule+AlertHistory] `:34` and `escalation-policy.resolver.ts` exist); no REST controller; web has no incident query.
- Overlap: the operator-facing ack/resolve lives on alert_history (`alert.resolver.ts:155` `acknowledgeAlert`, `:175` `resolveAlert`); alert_incidents carries a *second* stateful ack/resolve/escalate model operators cannot see.

**Rule violated**
Domain invariant *"Alert rules must be product-manageable"* (extended: life-safety incident state operators cannot observe is operational risk) + methodology `DUPLICATE-STRUCTURE` (two fired-alert models, no single declared owner).

**Proposed fix direction**
- Pick one owner of "a fired alert": promote alert_incidents to the product (incident resolver + FE incident console) and reduce alert_history to an append-only audit projection, OR fold incidents into history. Do not keep two stateful ack/resolve models.

**Affected surface:** `apps/alert-engine/src/alert/resolvers/*`, `web/modules/sensor-module/src/pages/AlertsPage.tsx` + alert hooks, alert entities.
**Expected closer:** alert-engine-expert WRITER mode.

#### DB-INFRA-HIGH-003 — event-store & config store raw tenantId with no GDPR erasure cascade
**Severity:** HIGH · **Layer:** 3 (ADR / GDPR) · **State:** OPEN

**Evidence**
- Cross-cutting deliverable 3 (`tenant_erasure_target_proofs` per service): wired via `TenantErasureTargetModule.forService(...)` in alert-engine (`app.module.ts:163`) and hydroponics (`app.module.ts:218`).
- **event-store-service:** `app.module.ts:81` registers only `SchemaDriftModule`; grep for `TenantErased|erasure|gdpr|crypto.?shred|tenant.*delete` across `apps/event-store-service/src` returns **zero** files. `stored_events` (`entities/stored-event.entity.ts:109`) stores raw `tenantId` + plain-jsonb `payload`/`metadata` that can embed PII; there is no crypto-shred or erasure path. `event_streams`, `snapshots`, `projection_checkpoints`, `projection_rebuilds` all carry raw `tenantId` too.
- **config-service:** `app.module.ts:186` registers only `SchemaDriftModule`; no `TenantErasureTargetModule`, no `TenantErased` consumer. `configurations.tenantId` (raw) persists after tenant deletion.
- Positive contrast (not a finding): observability pseudonymises (`migration_events.tenant_id_hash` = HMAC, `migration-event.entity.ts:101`), has a GDPR export handler (`gdpr/handlers/export-observability-tenant-data.handler.ts`), and a documented `TenantErased` delete-by-hash cascade.

**Rule violated**
GDPR right-to-erasure + Layer-2 tenant-isolation + cross-cutting deliverable 3. Immutable event history with PII and no crypto-shred is data-retention exposure.

**Proposed fix direction**
- event_store: define the crypto-shred / key-destruction contract for event payloads (encrypt PII at write with a per-tenant key, destroy key on erasure) and wire an erasure target + proof ledger.
- config: wire `TenantErasureTargetModule.forService('config-service')`.

**Affected surface:** `apps/event-store-service/src/**`, `apps/config-service/src/app.module.ts`, `libs/backend-common/src/compliance/**`, `INFRASTRUCTURE_AUDIT_LEDGERS` SSoT.
**Expected closer:** data-expert / multi-tenant-saas-expert WRITER mode.

### MEDIUM

#### DB-INFRA-MEDIUM-001 — hydroponics persists all domain state in one generic `settings` jsonb; no grow-cycle table
**Severity:** MEDIUM · **Layer:** 1 (TypeORM jsonb dumping ground) · **State:** OPEN
**Evidence**
- `apps/hydroponics-service/src/setup/entities/hydroponics-config.entity.ts:31` — the ONLY durable hydroponics table; a single `@Column({type:'jsonb'}) settings` keyed by (tenantId, configName).
- FE hydroponics-module ships nutrient profiles (`hooks/useNutrientProfiles.ts`), solution chemistry (`context/SolutionContext.tsx`, `lib/calculator/balance.ts`), PID simulator — but `graphql/hydroponics.operations.ts` exposes only config CRUD.
- CLAUDE.md Architecture Map: hydroponics = "Hydroponics config, **grow cycles**". No `grow_cycles`/`grow_cycle` entity or table exists.
**Rule violated:** Layer-1 *"jsonb may NOT be a dumping ground to avoid typed columns"*; methodology `UI-WITHOUT-DB`.
**Proposed fix direction:** Model nutrient profiles / solution targets / grow cycles as typed tables; reserve jsonb for genuinely open-ended settings.
**Expected closer:** hydroponics domain owner WRITER mode.

#### DB-INFRA-MEDIUM-002 — `billing` classified as neither tenant-scoped nor platform-level in schema-manager
**Severity:** MEDIUM · **Layer:** 3 (ADR-011 registry completeness) · **State:** OPEN
**Evidence**
- `schema-manager.service.ts:774,784` — `TENANT_SCOPED_MODULES`={sensor,farm,hr,hydroponics,alert,ai,messaging}; `PLATFORM_LEVEL_MODULES`={admin,auth,notification}. `billing` is in `MODULE_SCHEMAS` (`:657`) but in **neither** set.
- CLAUDE.md D14: billing is cross-tenant/platform (subscription SSoT keyed by tenantId) → belongs in `PLATFORM_LEVEL_MODULES`.
- Runtime impact low: `PLATFORM_LEVEL_MODULES` is consumed only by `libs/backend-common/src/database/__tests__/tenant-isolation-static.spec.ts`; `DEFAULT_TENANT_MODULES` correctly excludes billing.
**Proposed fix direction:** Add `billing` to `PLATFORM_LEVEL_MODULES`; add an invariant asserting `MODULE_SCHEMAS == TENANT_SCOPED ∪ PLATFORM_LEVEL` (no orphan classification).
**Expected closer:** data-expert WRITER mode.

#### DB-INFRA-MEDIUM-003 — `compliance` schema created but unregistered and unowned
**Severity:** MEDIUM · **Layer:** 3 (ADR-011) · **State:** OPEN — needs table enumeration
**Evidence**
- `apps/db-migrate/src/sql/platform-bootstrap/003-schemas.sql:35` — `CREATE SCHEMA IF NOT EXISTS compliance;` with **no** `AUTHORIZATION` (superuser-owned); appears in the required-schemas verification (`:77`).
- Absent from `MODULE_SCHEMAS`, from db-migrate `SCHEMA_REGISTRY`, and owns no `*_service` role — no declared migration owner → no drift coverage.
**Rule violated:** *"Registry is the map; unmapped tables are invisible."*
**Proposed fix direction:** Enumerate `compliance.*`; fold into an owning service schema with a registry entry, or give `compliance` a formal owner + registry entry.
**Expected closer:** platform-kernel-expert / data-expert.

### LOW

#### DB-INFRA-LOW-001 — stale `_constants.ts` note claims fixed ADR-011 violations
`tests/invariants/_constants.ts:15-16` states event-store/config "have @Entity() classes without schema:" — all 7 now declare `schema:`. Update/remove the note.

#### DB-INFRA-LOW-002 — stale observability "no @Entity()" comment + stale registry reasons + retired cost-rollup
- `apps/observability-service/src/app.module.ts:107-110` claims the service "has no @Entity() declarations" while 4 entities exist (self-contradicted by the `:62` comment referencing on-disk migrations).
- db-migrate `SCHEMA_REGISTRY` reasons for observability ("no migrations today", `schema-registry.ts:340`) and hydroponics ("No migration files yet", `:248`) are stale — both now have live Baseline migrations.
- `_constants.ts:35-41` says observability "owns a cost rollup hypertable"; `tenant_cost_rollup` was **retired** (`apps/observability-service/src/database/data-source.ts:15`; creating migration is archived) — not created by the live Baseline and referenced by no live code. Update the note.

## Cross-cutting reconciliation (deliverable 1)

| Service | Schema | MODULE_SCHEMAS | SCHEMA_REGISTRY (db-migrate) | 003-schemas.sql | Verdict |
|---|---|---|---|---|---|
| alert-engine | alert | YES (tables+infra) | YES | YES | OK (tenant-scoped) |
| hydroponics-service | hydroponics | YES | YES | YES | OK (tenant-scoped) |
| config-service | config | NO (not cloned) | YES | YES | OK (platform-registered) |
| event-store-service | event_store | NO | YES | YES | OK (platform-registered) |
| observability-service | observability | NO | YES | YES | OK (platform-registered) |
| gateway-api | gateway (reserved, empty) | NO | NO | YES | OK (schemaless) |
| billing-service | billing | YES | YES | YES | **MEDIUM-002 (dual-orphan classification)** |
| (compliance) | compliance | NO | NO | YES (no owner) | **MEDIUM-003 (unregistered/unowned)** |

Conclusion: no unregistered *product* service in this partition. config/event_store/observability are correctly platform-registered (db-migrate `SCHEMA_REGISTRY` + `003-schemas.sql`) and correctly excluded from `MODULE_SCHEMAS` (they are not per-tenant cloned). The recorded event-store/config `@Entity()`-without-`schema:` violations are resolved (LOW-001). Only real registry defects: billing classification (MEDIUM-002) and ownerless `compliance` (MEDIUM-003).

## Cross-cutting: outbox/inbox/DLQ family + drain paths (deliverable 2)

| Service | Outbox | Shape | Drain | Verdict |
|---|---|---|---|---|
| alert-engine | `AlertOutbox` (`outbox/alert-outbox.entity.ts:13`) | `extends OutboxEntityBase` (uniform) | `OutboxModule.forFeature` (`@platform/outbox` worker) | OK |
| hydroponics-service | `HydroponicsOutbox` | `extends OutboxEntityBase` | `HydroponicsOutboxModule` → `OutboxModule.forFeature` | OK |
| config-service | none | — | — | OK (emits no events — no `eventBus.publish`, nothing to drain) |
| event-store-service | none | — | — | OK (event sink, not a producer) |
| observability-service | none | — | — | OK (consumer only) |
| gateway-api | none | — | — | OK (no DB) |

Both event-emitting services in the partition use the uniform `OutboxEntityBase` + `@platform/outbox` drain; the alert outbox carries the standard `idx_*_poll_entity` / `idx_*_idempotency_entity` partial indexes. No written-but-never-drained outbox found in this partition.

## Cross-cutting: erasure-proof ledgers (deliverable 3)

`tenant_erasure_target_proofs` (via `TenantErasureTargetModule.forService`): PRESENT in alert-engine + hydroponics (both wired). ABSENT in config + event-store (HIGH-003 — raw tenantId, no erasure). observability handles erasure differently and compliantly (HMAC pseudonymisation + GDPR export handler + documented TenantErased delete-by-hash), so it is not part of HIGH-003.

## Frontend reachability summary

- alert (federated subgraph): alert_rules / alert_history / escalation_policies all product-reachable via `web/modules/sensor-module` (`AlertsPage.tsx`, `useAlerts`, `useAlertRules`, `useEscalationPolicies`, `graphql/alertRule.operations.ts`, `graphql/escalationPolicy.operations.ts`). alert_incidents NOT reachable (HIGH-002).
- hydroponics (federated): hydroponics_config reachable via `web/modules/hydroponics-module` (`useHydroponicsConfig`, `SolutionPage`, `graphql/hydroponics.operations.ts`).
- config (federated): reachable only through management FE `web/modules/admin-panel/TenantConfigurationPage.tsx`; no backend consumer (HIGH-001).
- event-store / observability: no product FE (BE/ops infra consumed by projections, Grafana, aqua-ctl CLI). Correct per methodology expectation ("likely none").

## Verdict
**CONDITIONAL** — partition schema placement, registries, outbox family are sound. Conditions before clean: HIGH-001 (config write-only system), HIGH-002 (alert_incidents unreachable + double-owned), HIGH-003 (event-store/config GDPR erasure gap).

## References
- Layer-1 TypeORM (schema ownership, jsonb boundary), Layer-2 patterns (outbox, tenant isolation), Layer-2 defect catalog (WRITE-ONLY, DUPLICATE).
- ADR-011 (schema ownership), ADR-012 (drift), ADR-006 (event flat / event-store payload boundary).
- SSoT: `libs/backend-common/src/database/schema-manager.service.ts` (MODULE_SCHEMAS), `apps/db-migrate/src/schema-registry.ts` (SCHEMA_REGISTRY), `apps/db-migrate/src/sql/platform-bootstrap/003-schemas.sql`, `tests/invariants/_constants.ts`.

---

## Appendix A — Provenance matrix

### alert_rules (alert — per-tenant, `@Entity('alert_rules')` no schema: — OK placement)
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,name,description,tenantId,farmId,pondId,sensorId,conditions(jsonb),severity,isActive,notificationChannels,recipients,cooldownMinutes,createdBy,createdAt,updatedAt | FE-FORM (createAlertRule/updateAlertRule) | GRAPHQL (alertRule/alertRules) | sensor-module/AlertsPage,useAlertRules | OK |

### alert_history (alert — per-tenant)
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,ruleId,ruleName,tenantId,farm/pond/sensorId,severity,message,triggeringData,triggeredAt,createdAt | EVENT (alert-evaluation.service) | GRAPHQL (alertHistory) | sensor-module/useAlerts,AlertsPage | OK |
| acknowledged,acknowledgedAt,acknowledgedBy,acknowledgementNote | FE-FORM (acknowledgeAlert) | GRAPHQL | sensor-module/AlertsPage | OK |
| resolved,resolvedAt | FE-FORM (resolveAlert) | GRAPHQL | sensor-module/AlertsPage | OK |

### alert_incidents (alert — per-tenant) — DB-INFRA-HIGH-002
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,tenantId,ruleId,title,description,severity,status,riskScore,triggerData,farm/pond/sensorId,assignedTo,acknowledgedBy/At,resolvedBy/At,resolutionNotes,escalationLevel,lastEscalatedAt,timeline,relatedIncidentIds,parentIncidentId,occurrenceCount,lastOccurredAt,metadata,createdAt,updatedAt | EVENT (farm-signal/mortality/water-quality/evaluation services) | BE-INTERNAL (escalation-manager, notification-dispatcher, alert-audit) | NONE | BE-ONLY + DUPLICATE (double-owns fired-alert ack/resolve with alert_history) |

### escalation_policies (alert — per-tenant)
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,tenantId,name,description,severity,levels,onCallSchedule,suppressionWindows,repeatIntervalMinutes,maxRepeats,isActive,isDefault,priority,conditions,timezone,ruleIds,farmIds,createdBy,createdAt,updatedAt | FE-FORM (create/update/clone/addSuppressionWindow/updateOnCallSchedule) | GRAPHQL (escalationPolicy/escalationPolicies/defaultEscalationPolicy/currentOnCallUser) | sensor-module/useEscalationPolicies,escalationPolicy.operations | OK |

### alert_audit_log (`schema:'alert'` infra) / alert_outbox (`schema:'alert'` infra)
| column | writer | read | fe | class |
|---|---|---|---|---|
| audit rows | SYSTEM (AuditLogInterceptor/alert-audit) | BE-INTERNAL | NONE | OK (infra ledger) |
| outbox rows (OutboxEntityBase) | SYSTEM (outbox publisher) | BE-INTERNAL (drain worker) | NONE | OK (infra) |

### hydroponics_config (hydroponics — per-tenant) — DB-INFRA-MEDIUM-001
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,tenantId,configName,createdAt,updatedAt | FE-FORM (createHydroponicsConfiguration/update) | GRAPHQL (hydroponicsConfigurations/hydroponicsConfiguration) | hydroponics-module/useHydroponicsConfig,SolutionPage | OK |
| settings (jsonb) | FE-FORM | GRAPHQL | hydroponics-module (nutrient profiles/solution) | jsonb dumping ground (MEDIUM-001) |

### configurations (config — `schema:'config'`) — DB-INFRA-HIGH-001
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,tenantId,service,key,value,valueType,environment,description,isSecret,isActive,category,tags,validationRules,defaultValue,suppressFallback,version,createdBy,updatedBy,createdAt,updatedAt,deletedAt/By,deleteReason,retentionUntil | FE-FORM (config admin handlers) | GRAPHQL (effectiveConfiguration; secrets redacted by DTO) | admin-panel/TenantConfigurationPage | WRITE-ONLY system (no backend consumer of resolved values) |

### configuration_history (config — `schema:'config'`)
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,configurationId,tenantId,service,key,previousValue,newValue,changedBy,changedAt,changeReason | SYSTEM (config change handlers) | GRAPHQL (audit) | admin-panel/TenantConfigurationPage | OK (audit) |

### stored_events (event_store) — event-sourcing infra; upcaster read path present
| column | writer | read | fe | class |
|---|---|---|---|---|
| id,streamName,globalPosition,streamPosition,producer,producerEventId,aggregateType,aggregateId,version,eventType,payload(jsonb),metadata(jsonb),tenantId,correlationId,causationId,userId,occurredAt,storedAt,schemaVersion | SYSTEM/EVENT (event-store ingest) | BE-INTERNAL (projections + replay via upcaster chain — event-store.service/projections.service reference `upcast`) | NONE | OK (infra; jsonb payload=allowed boundary). Erasure gap → HIGH-003 |

### event_streams / snapshots / projection_checkpoints / projection_rebuilds (event_store)
| column | writer | read | fe | class |
|---|---|---|---|---|
| all (each carries raw tenantId; stream/version/position/lease/status/generation bookkeeping) | SYSTEM (event-store + projection workers) | BE-INTERNAL (replay/projection orchestration) | NONE | OK (infra). Erasure gap → HIGH-003 |

### migration_events / emergency_overrides / migration_backfill_progress / schema_object_history (observability)
| column | writer | read | fe | class |
|---|---|---|---|---|
| migration_events: occurredAt,serviceName,migrationName,eventType,tenant_id_hash(HMAC),driftClassId,durationMs,errorDetail(jsonb-sanitized),environment | SYSTEM (record-migration-event handler / schema-migration-events consumer) | BE-INTERNAL (Grafana, aqua-ctl, GDPR export) | NONE | OK (ops audit; PII-safe via HMAC + sanitize) |
| emergency_overrides: serviceName,kind,reason,actor,createdAt,expiresAt,environment,revokedReason/At | SYSTEM (aqua-ctl CLI) | BE-INTERNAL (drift validator gates) | NONE | OK (ops audit) |
| migration_backfill_progress / schema_object_history | SYSTEM | BE-INTERNAL | NONE | OK (ops infra) |

## Appendix B — Incidental findings (operator directive)

- **B1 — event-store payload PII + retention (reinforces HIGH-003):** `stored_events.payload`/`metadata` are plain jsonb that can embed PII from source events; no crypto-shred/erasure exists. Immutable history + PII + no key-destruction is a GDPR right-to-erasure exposure across ALL tenant-keyed event-store tables (stored_events, event_streams, snapshots, projection_checkpoints, projection_rebuilds).
- **B2 — config schema-build smoke-gate gap (repeat-incident risk):** `configuration.entity.ts:110-116` documents a 2026-06-11 production boot-loop (#375) from GraphQL union-type reflection, invisible to CI because no job builds the config subgraph schema (INFRA-HIGH-009). The smoke gate is still absent — recurrence risk for any future union/nullable `@Field` on this subgraph.
- **B3 — config read queries lack `checkAdminAccess`:** `configuration.resolver.ts:79,94` (`effectiveConfiguration*`) do not call `checkAdminAccess` (only the mutation `:135` does). Impact is bounded — results are tenant-scoped by JWT (`getTenantId`) and secret values are redacted by the DTO (`effective-configuration.dto.ts:79-84`) — so any authenticated tenant member can read their tenant's NON-secret config. Likely acceptable; flagged for the config owner to confirm intent.
- **B4 — gateway-api "1 entity" scope question resolved:** there is no gateway `@Entity`. `apps/gateway-api/src/app.module.ts:195-198` reads `shared.audit_logs` via the `gateway_service` Postgres role grant (`shared_schema_owner` membership), not a TypeORM entity. The reserved `gateway` schema (003-schemas.sql:34) is empty by design. No finding; scope estimate was stale.
- **B5 — positive contrast for synthesis:** observability-service is the GDPR-mature model in this partition (HMAC tenant pseudonymisation + `export-observability-tenant-data` handler + `sanitizePgError`/`assertNoPgRowLeak` on error_detail). Recommend event-store/config adopt the same pseudonymise-or-shred posture (HIGH-003 closer).
- **B6 — cross-partition (sensor, verified):** the two-registry reconciliation confirms raw-SQL/TimescaleDB tables with no `@Entity` are invisible to `MODULE_SCHEMAS` and the entity-metadata drift validator (e.g., the retired `observability.tenant_cost_rollup`). This is the same class as wave-1's `scada_tag_history` (DB-SENSOR-CRITICAL-001/HIGH-004): raw-SQL tables need an explicit registry entry to gain drift/bootstrap coverage. Recommend a platform-wide raw-SQL-table registry so hypertables are not registry-invisible.
