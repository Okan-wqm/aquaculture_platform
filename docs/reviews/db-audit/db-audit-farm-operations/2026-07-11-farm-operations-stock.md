# DB Audit — Farm Operations & Stock Partition — 2026-07-11

Lane-D end-to-end column-provenance audit. Agent: `db-audit-farm-operations`.
Finding prefix: `DB-FARMOPS-{SEVERITY}-{NNN}`. Read-only over source; report is the only write surface.

## Scope

Backend `apps/farm-service` (schema-per-tenant `farm`), domains: **feed** (5 entities),
**feeding** (6), **storage** (8), **farm-stock** (2), **consumable** (1), **supplier** (3),
**chemical** (3), **finance** (3) = **31 `@Entity` classes** enumerated per class. Every durable
column traced for provenance (writer), read exposure, and frontend reachability. Also audited: the
`feed_inventory` → `storage_inventory` convergence state (from the TRACKED migration manifest), the
claimed "3 live CREATE VIEW migrations", and the movement-ledger / protocol-rate domain invariants.
Frontend traced via `web/modules/farm-module/src/**` (feeding + storage + finance pages/hooks/graphql)
and `web/apps/aquamobil/src/**`. Farm subgraph is federated (`infrastructure/apollo-router/subgraphs.json:22`),
so farm GraphQL fields reach the product.

## Executive summary

Feed stock is currently persisted in **two independent live ledgers** — `feed_inventory.quantityKg`
(feeding domain) and `storage_inventory.quantity` + its `feeds.quantity` roll-up (storage domain) —
with **no reconciliation** between them, both **operator-reachable from different UI tabs**
(feeding `FeedInventoryTab` vs storage `FeedStockTab`). The convergence that would collapse them
exists ONLY in the two UNTRACKED working-tree migrations (`1801300000000` / `1801310000000`), which
are **absent from the tracked manifest** (`FARM_MIGRATIONS`); the current live schema still has
`feed_inventory` as a base table never dropped (**DB-FARMOPS-HIGH-001**). The two ledgers take
disjoint inputs (add-feed-inventory tops up only `feed_inventory`; receive-delivery tops up only
`storage_inventory`), so they are guaranteed to diverge. Compounding this, `feed_inventory`
add/consume/adjust mutate quantity with **no `stock_movements` ledger row**, violating the
movement-ledger-balance invariant (**DB-FARMOPS-HIGH-002**). Remaining findings are MEDIUM/LOW:
a multi-source feed-rate cluster, a fully dead `feeding_tables` table, and minor GraphQL/DB type
drifts. The finance domain is exemplary (derived costs projected at read time — the model feed-stock
should adopt). Verdict: **CONDITIONAL** — two HIGH data-integrity findings on live core stock data.

Prior-signal correction: the "3 live farm CREATE VIEW migrations" is **stale** — ZERO CREATE VIEW
exists in tracked farm-service source (see Appendix B).

## Findings (by severity)

### CRITICAL

None. All 31 tables carry `tenantId` + tenant-scoped indexes; all traced write/read paths use
`runInTenantTransaction` / `runInTenantRead` / `tenantManagerRepo` (tenant-scoped). No cross-tenant,
RLS, or data-loss defect observed in this partition.

### HIGH

#### DB-FARMOPS-HIGH-001 — Feed stock is double-owned across two live, unreconciled ledgers

**Severity:** HIGH **Layer:** 2 (tenant/ownership pattern) + domain invariant "one physical owner
per stock quantity" **State:** OPEN

**Evidence**

- `apps/farm-service/src/feeding/entities/feed-inventory.entity.ts:83,137` — `feed_inventory.quantityKg` is a per-lot feed-stock owner (feeding domain).
- `apps/farm-service/src/storage/entities/storage-inventory.entity.ts:28,49` — `storage_inventory.quantity` is the storage-domain feed-stock owner (`itemType=FEED`).
- `apps/farm-service/src/storage/services/stock-movement.service.ts:1-38` — the service header itself documents "Feed stock lives in TWO ledgers … `feed_inventory` … and `storage_inventory` (+ the `Feed.quantity` roll-up)"; Phase A is "write-path only: no table merge, no `feed_inventory` drop, no read re-points."
- `apps/farm-service/src/storage/services/stock-movement.service.ts:646-676` — `Feed.quantity` is rolled up from `storage_inventory` ONLY (SUM over storage rows), so `feeds.quantity` and `feed_inventory.quantityKg` measure different populations.
- Disjoint inputs → guaranteed divergence: `feeding/handlers/add-feed-inventory.handler.ts:75-128` writes ONLY `feed_inventory` (no `storage_inventory`); `storage/handlers/receive-delivery.handler.ts:80-126` writes ONLY `storage_inventory` + `stock_movements` (no `feed_inventory`).
- Both FE-reachable, different tabs: `web/modules/farm-module/src/pages/feeding/components/FeedInventoryTab.tsx` (reads `feedInventory`) vs `web/modules/farm-module/src/pages/storage/components/FeedStockTab.tsx` (reads storage feed stock). A tenant using only one workflow sees zero in the other tab.
- Convergence NOT live: `apps/farm-service/src/database/migrations/manifest.ts:68-121` (`FARM_MIGRATIONS`) contains neither `BackfillFeedInventoryIntoStorageLedger` nor `DropFeedInventoryCreateConvergedView`. `feed_inventory` created as a base table in `1800000000000-Baseline.ts:370-378` and dropped by NO tracked migration (grep of tracked migrations for `feed_inventory` → only Baseline). The two convergence migrations exist only as untracked working-tree files (another session's WIP — read-only context, not applied).
- No bridge consumer: grep for `FeedInventoryReceived|FeedInventoryConsumed|FeedInventoryAdjusted` outside the producing handlers → no listener; nothing syncs the feeding ledger into `storage_inventory`.

**Rule violated** Domain invariant "Feed-stock single ledger — one physical owner per stock
quantity" (agent brief); Layer-2 duplicate-structure (`DUPLICATE-STRUCTURE` verdict). Regulatory
feed-trace divergence risk.

**Proposed fix direction**

- Land the convergence architecturally (single physical owner = `storage_inventory`), then re-point the `feedInventory` read + `FeedInventoryTab` at the storage ledger and delete the `feed_inventory` write path — the untracked WIP pair is that direction but must be landed by the owning session, not this lane.
- Until then: this is a live data-integrity defect, not merely a transitional state; treat `feed_inventory` mutation paths (add/adjust) that skip `storage_inventory` as the divergence source.

**Affected surface (ripple set)** `feeding/entities/feed-inventory.entity.ts`, `feeding/handlers/{add,consume,adjust}-feed-inventory.handler.ts`, `feeding/resolvers/feeding.resolver.ts`, `storage/services/stock-movement.service.ts`, `web/modules/farm-module/src/pages/feeding/components/FeedInventoryTab.tsx`.

**Expected closer** `farm-expert` WRITER (primary owner) with `database-reviewer` on DB-state; land the tracked convergence migration.

#### DB-FARMOPS-HIGH-002 — `feed_inventory` quantity mutations carry no `stock_movements` ledger row

**Severity:** HIGH **Layer:** domain invariant "Movement-ledger balance" **State:** OPEN

**Evidence**

- `apps/farm-service/src/feeding/handlers/add-feed-inventory.handler.ts:91-128` — increments `quantityKg`, emits only `FeedInventoryReceived`; no `StockMovement` insert.
- `apps/farm-service/src/feeding/handlers/consume-feed-inventory.handler.ts:83-109` — decrements `quantityKg`, emits `FeedInventoryConsumed`; no `StockMovement` insert.
- `apps/farm-service/src/feeding/handlers/adjust-feed-inventory.handler.ts:84-117` — INCREASE/DECREASE/SET_QUANTITY on `quantityKg`, emits `FeedInventoryAdjusted`; no `StockMovement` insert.
- Contrast the compliant storage path: `storage/services/stock-movement.service.ts:248-267` always writes an immutable `stock_movements` row for every `storage_inventory` mutation.
- All three feeding mutations are FE-reachable: `feeding/resolvers/feeding.resolver.ts:1285-1362` (`addFeedInventory`, `consumeFeedInventory`, `adjustFeedInventory`).

**Rule violated** Domain invariant "Movement-ledger balance — every stock quantity change must carry
a `stock_movements` (or equivalent) ledger row" (agent brief; flagged HIGH by that invariant).
Feed lot traceability (EU 178/2002) on the `feed_inventory` path relies solely on outbox events,
which are not queryable as a balancing ledger.

**Proposed fix direction**

- Route `feed_inventory` quantity changes through (or fold into) the `stock_movements`-backed sink so every gram in/out has an immutable, queryable movement row — this converges with HIGH-001's single-owner fix.

**Affected surface (ripple set)** `feeding/handlers/{add,consume,adjust}-feed-inventory.handler.ts`, `storage/services/stock-movement.service.ts`, `storage/entities/stock-movement.entity.ts`.

**Expected closer** `farm-expert` WRITER (primary), converged with HIGH-001.

### MEDIUM

#### DB-FARMOPS-MEDIUM-001 — Multi-source feed-rate cluster alongside the protocol-rate SSoT

**Severity:** MEDIUM **Layer:** domain invariant "Protocol drives feed rate" **State:** OPEN

**Evidence**

- Protocol SSoT is used: `feeding/services/daily-feeding-execution.service.ts:61,160,399-406,1363-1371` (`FeedingProtocolRateService` overrides when non-null).
- But feed-entity rate columns are consulted as fallback BEFORE the protocol result, and persisted independently: `feeds.feedingMatrix2D` / `feeds.feedingCurve` read at `daily-feeding-execution.service.ts:371-386`; also `feeds.feedingTable` (jsonb). Additional hand-entered rate source: `feed_type_species.feedingRatePercent` + `feedingRateConfig` (`feed/entities/feed-type-species.entity.ts:183-191`) with its own `getFeedingRateForTemperature`/`calculateDailyFeed` business methods.
- So four+ persisted rate sources exist: `feeding_protocols.growthStageProtocols[].feedPercent` (SSoT), `feeds.feedingMatrix2D`, `feeds.feedingCurve`, `feed_type_species.feedingRatePercent`.

**Rule violated** Domain invariant "Protocol drives feed rate — hand-entered rate columns that bypass
it are DUPLICATE/SUSPECT." Protocol wins when present, but the fallback columns are a second rate
source that makes regulatory feed-trace reproducibility ambiguous when protocol rate is null.

**Proposed fix direction**

- Make the protocol-rate service the single resolution entry; demote `feeds.feeding{Matrix2D,Curve,Table}` and `feed_type_species.feedingRatePercent` to explicit, labelled fallbacks (or fold into protocol seeding) so the rate provenance is single-valued per computation.

**Expected closer** `farm-expert` (feeding-protocol traceability initiative — see MEMORY `Farm Feeding Protocol + Traceability`).

#### DB-FARMOPS-MEDIUM-002 — `feeding_tables` is an ORPHAN table (entity + DTOs, no write/read/FE path)

**Severity:** MEDIUM **Layer:** table-level verdict `ORPHAN-TABLE` / `DEAD` **State:** OPEN

**Evidence**

- Entity registered: `feeding/entities/feeding-table.entity.ts` + `feeding/feeding.module.ts` (TypeOrm.forFeature). Input DTOs exist: `feeding/dto/{create,update}-feeding-table.input.ts`, `feeding-table-filter.input.ts`.
- No consumer: grep `FeedingTable` across `feeding/**` (non-test) returns only the entity, module, and DTOs — no resolver mutation/query, no command/query handler, no service reads or writes it. Not present in `feeding.resolver.ts` or `feeding-program.resolver.ts`.
- Therefore every column (`parameters`, `schedule`, `summary`, `targetFCR`, `actualFCR`, `version`, …) has writer `NONE` and read `NONE`.

**Rule violated** `ORPHAN-TABLE` (no meaningful write/read/FE role). Scaffolded-but-unwired durable
surface — DDL + validation exist while the feature was never landed.

**Proposed fix direction** Either wire the generate/read path (a resolver + handler) or drop the
table + DTOs; do not leave a shipped table with input DTOs and no path.

**Expected closer** `farm-expert`.

#### DB-FARMOPS-MEDIUM-003 — `storage_lot_mixes.totalQuantityKg` persisted as raw string decimal, exposed as GraphQL Float

**Severity:** MEDIUM **Layer:** 1 (TypeORM/GraphQL type discipline) **State:** OPEN

**Evidence**

- `storage/entities/storage-lot-mix.entity.ts:84-86` — `@Field(() => Float) @Column('decimal', { precision: 14, scale: 2 }) totalQuantityKg!: string;` — declared TS type `string`, no `DecimalTransformer`, but surfaced as GraphQL `Float`. Every sibling decimal in the partition uses `DecimalTransformer` to return `number`; this one returns a raw pg string, so the Float field serializes a string.

**Rule violated** Layer-1 TypeORM "declare explicit types / decimal via transformer"; inconsistent
with the partition's `DecimalTransformer` convention (money/quantity precision).

**Proposed fix direction** Add `transformer: new DecimalTransformer()` and type the field `number`
to match every other decimal column.

**Expected closer** `farm-expert` / `database-reviewer`.

### LOW

#### DB-FARMOPS-LOW-001 — `AddFeedInventoryInput.createdBy` is a required GraphQL arg the resolver discards

**Severity:** LOW **Layer:** contract drift (`UI-WITHOUT-DB`) **State:** OPEN

- `feeding/resolvers/feeding.resolver.ts:331-333` declares `createdBy!: string` `@IsUUID()` REQUIRED on the input, but `addFeedInventory` (`:1287-1312`) ignores it and passes `userId` from `@CurrentUser('sub')`. The client is forced to send a UUID that the server throws away. Remove the field (source `createdBy` from the JWT only).

#### DB-FARMOPS-LOW-002 — `feed_type_species.feedingFrequencyPerDay` is `@Field(Float)` over an `int` column

**Severity:** LOW **Layer:** 1 (GraphQL/DB type mismatch) **State:** OPEN

- `feed/entities/feed-type-species.entity.ts:185-187` — `@Field(() => Float) @Column({ type: 'int' }) feedingFrequencyPerDay?` — a meal-count exposed as Float; should be `Int`.

## Cross-domain dependencies flagged

- **DB-FARMOPS-HIGH-001/002**: recommend `farm-expert` (primary owner of `apps/farm-service`) WRITER + `database-reviewer` (DB-state) to land the tracked feed-stock convergence. This lane is secondary reviewer only.
- **Fish-count fan-out (wave-1 DB-FARMPROD-HIGH-001)**: `farm_stock_container_snapshots.currentQuantity` / `farm_stock_batch_snapshots.quantity`/`biomassKg` are SYSTEM-written read-projections (via `events/listeners/farm-stock-projection.listener.ts`) that re-express fish count/biomass — additional copies beyond the quad-persisted tank count. Legitimate as federated read models, but confirms the fan-out breadth; flag to `db-audit-farm-production` for the count-ownership finding.
- **MEDIUM-001**: overlaps the "Farm Feeding Protocol + Traceability" initiative — route rate-source consolidation there.

## Verdict

**CONDITIONAL** — two HIGH data-integrity findings (DB-FARMOPS-HIGH-001, HIGH-002) on live, core,
operator-reachable feed-stock data. No CRITICAL (tenant isolation intact across the partition). The
convergence that resolves both HIGHs is a known in-flight effort owned by another session/`farm-expert`;
this audit records the CURRENT live state as defective, not merely transitional.

## References

- Layer-1 TypeORM/NestJS/React, Layer-2 patterns + defect-catalog, Layer-3 ADR-011/012 (schema/drift), agent brief domain invariants.
- `apps/farm-service/src/storage/services/stock-movement.service.ts` (dual-SSoT header — primary evidence).
- `apps/farm-service/src/database/migrations/manifest.ts` (tracked/live migration list).
- MEMORY: "Farm Feeding Protocol + Traceability", "Batch Lifecycle SSoT", "Gateway Assertion Intermittent + Feed Status Enum" (ORPHAN-HIGH-090b sibling enum cluster).
- Prior: `docs/reviews/2026-06-24-graphql-fe-be-contract-drift-audit.md`, `docs/reviews/orphan-findings.md`.

---

## Appendix A — Column provenance matrix

Convention: business columns listed individually. The uniform **audit block** — `createdAt`,
`updatedAt`, `createdBy`, `updatedBy`, `version`/`@VersionColumn`, `isDeleted`/`deletedAt`/`deletedBy`
where present — is collapsed to one row per table (all `SYSTEM`/`FE-FORM` writer, mixed read, `OK`)
to keep the matrix scannable. Deep file:line evidence is in Findings above for every non-`OK` row.
`writer` ∈ FE-FORM/EVENT/SYSTEM/EXTERNAL/MIGRATION/NONE; `read` ∈ GRAPHQL/BE-INTERNAL/NONE; `fe` = module surface.
All 31 tables OMIT `schema:` (per-tenant, ADR-011 correct — cloned into `tenant_<uuid>`).

### feed domain

#### feeds (`Feed`) — table verdict: OK (with dual-quantity per HIGH-001, rate cluster per MEDIUM-001)

| column                                                                                            | writer                                                                           | read                                    | fe                | class                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| id, tenantId                                                                                      | SYSTEM/FE-FORM                                                                   | GRAPHQL                                 | farm/FeedsPage    | OK                                                                      |
| name, code, description, brand, manufacturer, type, targetSpecies, pelletSize, floatingType, unit | FE-FORM                                                                          | GRAPHQL                                 | farm feed forms   | OK                                                                      |
| supplierId                                                                                        | FE-FORM                                                                          | GRAPHQL                                 | farm feed form    | OK                                                                      |
| nutritionalContent, feedingTable(jsonb), environmentalImpact, documents                           | FE-FORM                                                                          | GRAPHQL                                 | farm feed form    | OK                                                                      |
| feedingCurve, feedingMatrix2D                                                                     | FE-FORM                                                                          | BE-INTERNAL(rate calc)+GRAPHQL          | farm feed form    | SUSPECT (MEDIUM-001 rate cluster)                                       |
| status                                                                                            | FE-FORM/SYSTEM                                                                   | GRAPHQL                                 | farm              | OK (enum default `available`)                                           |
| quantity                                                                                          | SYSTEM (storage roll-up, `stock-movement.service.ts:670`) + FE-FORM(create seed) | GRAPHQL                                 | farm FeedStockTab | DUPLICATE (HIGH-001; storage-owned roll-up, parallel to feed_inventory) |
| minStock                                                                                          | FE-FORM                                                                          | GRAPHQL+BE-INTERNAL(low-stock)          | farm              | OK                                                                      |
| pricePerKg, currency, unitPrice, unitSize, pelletSizeLabel, productStage, composition             | FE-FORM                                                                          | GRAPHQL                                 | farm              | OK                                                                      |
| storageTempMin/Max, storageHumidityMin/Max, storageRequirements, shelfLifeMonths, expiryDate      | FE-FORM                                                                          | GRAPHQL+BE-INTERNAL(condition warnings) | farm              | OK                                                                      |
| minFishWeightG, maxFishWeightG                                                                    | FE-FORM                                                                          | GRAPHQL                                 | farm              | OK                                                                      |
| isActive, audit block (incl. soft delete + version)                                               | FE-FORM/SYSTEM                                                                   | GRAPHQL                                 | farm              | OK                                                                      |

#### feed_types (`FeedTypeEntity`) — verdict: OK (per-tenant catalog, no tenantId col — see Appendix B)

| id, name, code(unique), description, icon, isActive, isSystem, sortOrder, createdAt/updatedAt | FE-FORM/MIGRATION(seed) | GRAPHQL | farm feed-type picker | OK |

#### feed_sites (`FeedSite`) — verdict: OK

| id, tenantId, feedId, siteId, isApproved, approvedBy, approvedAt, createdAt, createdBy | FE-FORM | GRAPHQL | farm feed-site N:M | OK |

#### feeding_protocols (`FeedingProtocol`) — verdict: OK (rate SSoT)

| id, tenantId, name, description, feedId, species, stage | FE-FORM | GRAPHQL+BE-INTERNAL | farm protocol drawer | OK |
| temperatureRanges, growthStageProtocols, defaultSchedule, targetFcr, minDissolvedOxygen, optimalTemperature, specialConditions | FE-FORM | BE-INTERNAL(`FeedingProtocolRateService`)+GRAPHQL | farm | OK (rate SSoT — MEDIUM-001 references) |
| notes, isActive, isDefault, audit block+version | FE-FORM/SYSTEM | GRAPHQL | farm | OK |

#### feed_type_species (`FeedTypeSpecies`) — verdict: SUSPECT (rate cluster, MEDIUM-001)

| id, tenantId, feedId, speciesId, growthStage, recommendedWeightMin/MaxG, recommendation, priority, expectedPerformance, isActive, notes, metadata, audit+soft-delete+version | FE-FORM(create-feed)/SYSTEM | GRAPHQL(via feed)+BE-INTERNAL(feed-selector) | farm feed form | OK |
| feedingRatePercent, feedingRateConfig | FE-FORM | BE-INTERNAL(feed-selector fallback) | farm | SUSPECT (2nd rate source, MEDIUM-001) |
| feedingFrequencyPerDay | FE-FORM | GRAPHQL | farm | OK (LOW-002 Float-over-int) |

### feeding domain

#### feed_inventory (`FeedInventory`) — table verdict: DUPLICATE-STRUCTURE (HIGH-001) + no movement ledger (HIGH-002)

| column                                                 | writer                                | read                           | fe                            | class                                                                         |
| ------------------------------------------------------ | ------------------------------------- | ------------------------------ | ----------------------------- | ----------------------------------------------------------------------------- |
| id, tenantId, feedId, siteId, departmentId             | FE-FORM                               | GRAPHQL                        | farm feeding/FeedInventoryTab | OK(keys)                                                                      |
| quantityKg                                             | FE-FORM (add/consume/adjust handlers) | GRAPHQL                        | feeding/FeedInventoryTab      | DUPLICATE (HIGH-001; parallel to storage_inventory; HIGH-002 no movement row) |
| minStockKg                                             | FE-FORM                               | GRAPHQL+BE-INTERNAL(low-stock) | feeding                       | DUPLICATE (parallel to feeds.minStock / storage low-stock)                    |
| status                                                 | SYSTEM(`updateStatus`)                | GRAPHQL                        | feeding                       | OK                                                                            |
| lotNumber, manufacturingDate, expiryDate, receivedDate | FE-FORM                               | GRAPHQL                        | feeding                       | OK                                                                            |
| unitPricePerKg, totalValue, currency                   | FE-FORM/SYSTEM                        | GRAPHQL                        | feeding                       | OK                                                                            |
| storageLocation, storageTemperature, notes             | FE-FORM                               | GRAPHQL                        | feeding                       | OK                                                                            |
| audit block                                            | SYSTEM/FE-FORM                        | GRAPHQL                        | feeding                       | OK                                                                            |

#### feeding_programs (`FeedingProgram`) — verdict: OK

| id, tenantId, siteId, name, code, description, feedAssignments(jsonb), fcrTable(jsonb), status, startDate, endDate, pausedAt/activatedAt/completedAt, settings(jsonb), totalTanks, totalFeedTransitions, totalFeedConsumed, createdBy/lastModifiedBy, audit+soft-delete(DeleteDateColumn)+version | FE-FORM/SYSTEM | GRAPHQL | farm/FeedingProgram pages | OK |

#### feeding_program_tanks (`FeedingProgramTank`) — verdict: OK

| id, tenantId, feedingProgramId, equipmentId, equipmentType, equipmentName/Code(denorm), currentFeedId, currentFeedCode(denorm), currentWeightRangeIndex, lastFeedTransitionAt, totalFeedTransitions, temperatureSensorId, temperatureSensorCode(denorm), isActive, addedAt, removedAt, notes, audit block | FE-FORM/SYSTEM | GRAPHQL | farm/FeedingProgram | OK |

#### daily_feeding_executions (`DailyFeedingExecution`) — verdict: OK

| id, tenantId, feedingProgramId, feedingProgramTankId, executionDate, equipmentId/Type/Name/Code(denorm), calculations(jsonb), actualResults(jsonb), status, completedAt, growthAppliedAt(idempotency key), completedBy, feederEquipmentId, feederName, feedingMethod, notes, skipReason, createdBy/lastModifiedBy, audit | FE-FORM/SYSTEM(cron) | GRAPHQL | farm/feeding execution | OK |

#### feeding_records (`FeedingRecord`) — verdict: OK

| id, tenantId, batchId, tankId, pondId, batchLocationId, feedingDate, feedingTime(varchar), feedingSequence, totalMealsToday, feedId, feedBatchNumber, plannedAmount, actualAmount, variance, variancePercent, wasteAmount, environment(jsonb), fishBehavior(jsonb), feedingMethod, equipmentId, feedingDurationMinutes, feedCost, currency, fedBy, verifiedBy, verifiedAt, notes, skipReason, createdAt/updatedAt | FE-FORM | GRAPHQL | farm/FeedingPage | OK (drives storage feed OUT via `stock-movement.service`) |

#### feeding_tables (`FeedingTable`) — table verdict: ORPHAN-TABLE / DEAD (MEDIUM-002)

| id, tenantId, batchId, feedId, version, previousVersionId, recalculationReason, parameters(jsonb), schedule(jsonb), summary(jsonb), targetFCR, actualFCR, startDate, endDate, status, isActive, notes, calculatedAt, calculatedBy, audit, entityVersion | NONE | NONE | NONE | DEAD (all columns — no resolver/handler/service) |

### storage domain

#### storage_inventory (`StorageInventory`) — verdict: OK (converged physical owner per invariant, currently dual per HIGH-001)

| id, tenant_id, storage_location_id, item_type(FEED/CHEMICAL/CONSUMABLE/HEALTHCARE), item_id, quantity, unit, lot_number, expiry_date, received_date(FEFO tiebreak), notes, version(optimistic lock), audit | FE-FORM(receive/movement)/EVENT(feeding OUT) | GRAPHQL | farm/StoragePage + aquamobil | OK |

#### stock_movements (`StockMovement`) — verdict: OK (the balancing ledger)

| id, tenant_id, movement_type, item_type, item_id, item_name(denorm), quantity, unit, from_location_id, to_location_id, reference, reason, lot_number, expiry_date, idempotency_key(unique partial), performed_by, performed_by_name(denorm), performed_at, created_at | FE-FORM/EVENT(feeding)/SYSTEM | GRAPHQL | farm/StockMovementsTab + aquamobil | OK |

#### storage_locations (`StorageLocation`) — verdict: OK

| id, tenant_id, site_id, name, code(unique), type, description, capacity, capacity_unit, used_capacity, temperature/humidity min/max, is_active, soft delete, audit, version | FE-FORM/SYSTEM | GRAPHQL | farm/StorageLocationsTab | OK |

#### storage_lot_mixes (`StorageLotMix`) — verdict: OK (except MEDIUM-003)

| id, tenantId, storageLocationId, itemType, itemId, effectiveLotNumber, contributingLots(jsonb, contributionPct derived), mixedAt, createdBy, createdAt | SYSTEM(`LotMixService.detect`) | GRAPHQL(via trace-lot) | farm (lot trace) | OK |
| totalQuantityKg | SYSTEM | GRAPHQL | farm | MEDIUM-003 (string decimal exposed as Float) |

#### inventory_counts (`InventoryCount`) — verdict: OK

| id, tenant_id, count_number(unique), storage_location_id, status(PLANNED→APPROVED), started_at/completed_at/approved_at, performed_by(+name), approved_by(+name; SOC2 CC3.4 ≠ performer), notes, total_variance(denorm), audit, version | FE-FORM/SYSTEM | GRAPHQL | farm/InventoryCountTab | OK |

#### inventory_count_items (`InventoryCountItem`) — verdict: OK

| id, tenant_id, inventory_count_id, item_type, item_id, item_name(denorm snapshot), unit, lot_number, expected_quantity(frozen snapshot), actual_quantity, variance(derived), notes, audit | FE-FORM/SYSTEM | GRAPHQL | farm/InventoryCountDetailModal | OK |

#### purchase_orders (`PurchaseOrder`) — verdict: OK

| id, tenant_id, order_number(unique), category, supplier_name/contact, status(maker-checker DRAFT→…→RECEIVED), expected/actual_delivery_date, notes, total_amount, currency, created_by, approved_by(+name), approved_at, is_deleted, audit, version | FE-FORM/SYSTEM | GRAPHQL | farm/PurchaseOrdersTab | OK |

#### purchase_order_items (`PurchaseOrderItem`) — verdict: OK

| id, tenant_id, purchase_order_id, item_id, item_name, item_code, quantity, unit, unit_price, total_price, quantity_received, is_fully_received, notes, audit | FE-FORM/SYSTEM | GRAPHQL | farm/CreatePurchaseOrderModal + ReceiveDeliveryModal | OK |

### farm-stock domain (federated read projections — `@key(fields:"id")`)

#### farm_stock_container_snapshots (`FarmStockContainerSnapshot`) — verdict: OK (read model)

| id, tenantId, containerId, containerSource, name, code, departmentId, siteId, status, volume, maxBiomassKg, currentQuantity, currentBiomassKg, capacityUsedPercent, isOverCapacity, hasActiveBatch, isActive, lastStockEventAt, audit | SYSTEM(`farm-stock-projection.listener`) | GRAPHQL | farm stock views | OK (cross-lane: fish-count fan-out, DB-FARMPROD-HIGH-001) |

#### farm_stock_batch_snapshots (`FarmStockBatchSnapshot`) — verdict: OK (read model)

| id, tenantId, containerId, batchId, batchNumber, batchStatus, quantity, biomassKg, avgWeightG, densityKgM3, totalMortality, totalCull, harvestedQuantity, isPrimary, lastMortalityAt, audit | SYSTEM(projection) | GRAPHQL | farm stock views | OK (cross-lane count fan-out) |

### consumable domain

#### consumables (`Consumable`) — verdict: OK (quantity = storage-owned roll-up cache)

| id, tenant_id, name, code(unique), category, description, unit, brand, supplier_id | FE-FORM | GRAPHQL | farm consumable/storage tabs | OK |
| quantity | SYSTEM(`stock-movement.service:690` roll-up) + FE-FORM(create seed) | GRAPHQL | farm ConsumablesStockTab | OK (single owner = storage_inventory; denorm cache — contrast feed's dual) |
| min_stock, status, unit_price, currency, storage temp/humidity, storage_requirements, notes, is_active, soft delete, audit, version | FE-FORM/SYSTEM | GRAPHQL | farm | OK |

Note: `StorageItemType.HEALTHCARE` items are stored as `consumables` rows (`stock-movement.service:468-483`) — one physical table backs both categories (documented design).

### supplier domain

#### suppliers (`Supplier`) — verdict: OK

| id, tenantId, name, code(unique), type, supplyTypes(simple-array), contactPerson, email, phone, website, address(jsonb), city, country, rating, paymentTerms, taxId, products(simple-array), status, isActive, notes, audit, soft delete, version | FE-FORM/SYSTEM | GRAPHQL | farm supplier pages | OK |

#### supplier_types (`SupplierType`) — verdict: OK (per-tenant catalog, no tenantId col)

| id, name, code(unique), description, icon, isActive, isSystem, sortOrder, createdAt/updatedAt | FE-FORM/MIGRATION(seed) | GRAPHQL | farm supplier-type picker | OK |

#### supplier_sites (`SupplierSite`) — verdict: OK

| id, tenantId, supplierId, siteId, isPreferred, notes, createdAt, createdBy | FE-FORM | GRAPHQL | farm supplier-site N:M | OK |

### chemical domain

#### chemicals (`Chemical`) — verdict: OK (quantity = storage-owned roll-up cache)

| id, tenantId, name, code(unique), description, type, brand, activeIngredient, concentration, formulation, supplierId | FE-FORM | GRAPHQL | farm chemical/storage tabs | OK |
| status, quantity(SYSTEM roll-up `stock-movement.service:682`), minStock, unit | SYSTEM/FE-FORM | GRAPHQL | farm ChemicalsStockTab | OK (single owner = storage_inventory) |
| requiresApproval, withdrawalPeriodDays, usageProtocol(jsonb), safetyInfo(jsonb), storageRequirements, storage temp/humidity, shelfLifeMonths, expiryDate, usageAreas(simple-array), documents(jsonb), unitPrice, currency, notes, isActive, audit, soft delete, version | FE-FORM/SYSTEM | GRAPHQL | farm | OK |

#### chemical_types (`ChemicalType`) — verdict: OK (per-tenant catalog, no tenantId col)

| id, name, code(unique), description, icon, isActive, isSystem, sortOrder, createdAt/updatedAt | FE-FORM/MIGRATION(seed) | GRAPHQL | farm chemical-type picker | OK |

#### chemical_sites (`ChemicalSite`) — verdict: OK

| id, tenantId, chemicalId, siteId, isApproved, approvedBy, approvedAt, createdAt, createdBy | FE-FORM | GRAPHQL | farm chemical-site N:M | OK |

### finance domain (exemplary — derived costs projected at read time, no dual ledger)

#### finance_categories (`FinanceCategory`) — verdict: OK

| id, tenantId, name, code(system-only, partial unique), scope, kind, computedRule(jsonb, read-time PERCENT_OF_SCOPE_TOTAL), isSystem, isActive, displayOrder, createdBy/updatedBy, audit | FE-FORM/MIGRATION(seed system cats) | GRAPHQL | farm/finance | OK |

#### finance_expense_entries (`FinanceExpenseEntry`) — verdict: OK

| id, tenantId, categoryId, entryDate, periodStart/End, amount, currency, description, siteId, batchId, createdBy/updatedBy, isDeleted, deletedAt, version, audit | FE-FORM | GRAPHQL | farm/finance | OK (MANUAL rows only; derived costs projected, not persisted — the anti-dual-ledger model) |

#### finance_settings (`FinanceSettings`) — verdict: OK

| id, tenantId(unique), defaultCurrency(currency SSoT → outbox `FinanceSettingsUpdated`), fiscalYearStartMonth, updatedBy, audit | FE-FORM | GRAPHQL+BE-INTERNAL(currency default) | farm/finance settings | OK |

---

## Appendix B — Incidental findings (operator directive 2026-07-11; includes out-of-partition)

1. **Stale prior signal — "3 live farm CREATE VIEW migrations" is FALSE.** Grep for
   `CREATE VIEW|CREATE OR REPLACE VIEW|CREATE MATERIALIZED VIEW` across tracked
   `apps/farm-service/src/**` (excluding `.archive/`) returns ZERO. No live farm view exists. The
   only view-creating migration is `1801310000000-DropFeedInventoryCreateConvergedView` in the
   UNTRACKED working-tree pair (not in `manifest.ts`, so not applied). The methodology/agent-brief
   "farm ×3 views" claim should be corrected in the Lane-D SSoT.

2. **Migration timestamp collision (untracked WIP vs tracked).** The untracked
   `1801300000000-BackfillFeedInventoryIntoStorageLedger.ts` shares timestamp `1801300000000` with
   the already-tracked `AddCullMortalityAuditEnumValues1801300000000` (`manifest.ts:14,82`). If that
   WIP session lands as-numbered, the runner gets two `1801300000000` classes → ordering/uniqueness
   hazard (the migration-immutability + array-completeness invariants will likely fail). Read-only
   context per brief — flagged for the owning session, NOT edited/committed by this lane.

3. **Good-pattern contrast worth propagating.** `finance_expense_entries` header + `stock-movement.service`
   `updateItemTotalQuantity` show the CORRECT single-owner-plus-derived-cache pattern
   (consumables/chemicals/feeds.quantity are read-time caches over `storage_inventory`; finance
   derives costs at query time). `feed_inventory` is the outlier: a _second independent owner_, not a
   cache. The convergence should make feed match the finance/consumable pattern.

4. **Per-tenant catalog tables lack a `tenantId` column.** `feed_types`, `supplier_types`,
   `chemical_types` have no `tenantId` and a unique index on `code` alone. They rely solely on
   schema-per-tenant cloning for isolation (no in-row tenant scoping). Acceptable under ADR-011
   cloning, but note: any query that ever runs on these without a correct `search_path` has no
   tenant column to fall back on. Low risk; recorded for completeness.

5. **`consumables` table backs two `StorageItemType` categories** (`CONSUMABLE` + `HEALTHCARE`) via
   `stock-movement.service.ts:468-483`. Medications/vaccines are consumable rows. Documented design,
   but means a "healthcare product" master has no dedicated table — worth confirming with the product
   owner that healthcare-specific fields (batch/withdrawal on medication) aren't needed beyond the
   `chemicals` table which is the actual medication master.

6. **Denormalized display names stored across storage/PO/count tables** (`performed_by_name`,
   `approved_by_name`, `item_name`) captured from JWT at write time. Intentional (self-contained
   audit trail, SOC2), not PII-in-immutable-event misuse — recorded as observed, not a defect.

7. **`feeds.status` enum-default gate (historical FARM-HIGH-097 / ORPHAN-HIGH-090b cluster).** Verified
   `feeds.status` now has `default: FeedStatus.AVAILABLE` and create-feed supplies quantity default
   (`create-feed.handler.ts:135`). Sibling status-like enum defaults in this partition all carry a
   valid `default` (feed_inventory.status `available`, consumable.status `available`, chemical.status
   `available`, purchase_order.status `DRAFT`, inventory_count.status `PLANNED`, feeding_program.status
   `draft`, daily_feeding_execution.status `planned`, feeding_table.status `draft`) — the enum-default
   write-gate invariant holds across this partition. No open enum-default create-break found here.
