# Farm /sites/setup CRUD — write-boundary + audit-guard incident (2026-06-30)

Live investigation of "cannot add/edit records in /sites/setup". Reads were already fixed
(read-boundary migration); these are the WRITE-side root causes, found by probing the
production droplet (test tenant `7f6b08ab…`). Operator invariant confirmed: tenant modules
(farm/hr/sensor/hydroponics) write per-tenant data to the tenant schema, never the source
schema; cross-tenant infrastructure (outbox, audit ledger) lives in the source schema,
tenantId-stamped + RLS-protected.

## FARM-CRITICAL-061 — source-write guard wrongly installed on `farm.farm_audit_logs` (RESOLVED)
A `guard_source_write` BEFORE-trigger (function `farm.block_source_writes()`, ERRCODE P0999)
sat on `farm.farm_audit_logs` — a cross-tenant infrastructure ledger (like `farm.outbox_events`,
which is correctly unguarded). Every create/update command handler writes an audit row there,
so the guard rejected the INSERT and broke **all** farm mutations behind a masked "Bad Request".
The trigger is legacy drift (not created by any current migration).
**Fix:** live `DROP TRIGGER guard_source_write ON farm.farm_audit_logs` (operator-approved) +
durable forward migration `1801600000000-DropAuditLedgerSourceWriteGuard.ts` (idempotent).

## FARM-HIGH-089 — write-boundary: /sites/setup handlers wrote to the source schema (RESOLVED for setup domains)
43 of 92 farm command handlers wrote via pooled `@InjectRepository` connections whose
search_path defaulted to the source `farm` schema → guard-blocked (this is also why
suppliers/consumables/species read empty: writes were silently mis-routed pre-guard).
**Fix (this PR):** the 5 setup-tab domains — consumable, supplier, chemical, species, feed
(create/update/delete; chemical also add/remove-document), plus worker update/delete and the
fish-health `create` — now wrap their writes in `runInTenantTransaction` + `tenantManagerRepo`,
mirroring the gold `CreateSiteHandler`. (chemical-create's inner non-tenant `manager.transaction`
was collapsed into the boundary.)

## FARM-HIGH-090 — enum `defaultValue` breaks @nestjs/graphql coercion → createTank (RESOLVED for tank)
`@Field(() => Enum, { defaultValue: EnumMember })` on an INPUT field makes the raw uppercase
KEY reach `@IsEnum` (which validates the lowercase VALUE) → every client-supplied enum is
rejected at the ValidationPipe. **Fix (this PR):** `create-tank.dto.ts` tankType/material/
waterType/status drop `defaultValue`, become `@IsOptional`, and `CreateTankHandler` applies the
defaults server-side.

## FARM-HIGH-091 — createHealthEvent rejected by `reportedBy` @IsUUID (RESOLVED)
The frontend sends `reportedBy:'current-user'`; `CreateHealthEventInput.reportedBy` was a
required `@IsUUID`, rejected at the ValidationPipe before the service (which already overrides
`reportedBy` from the JWT subject) could run. **Fix (this PR):** field made optional + format
constraint dropped; server remains authoritative. Service `create` also moved into the tenant
write boundary.

## Deferred (tracked)
- **ORPHAN-HIGH-251** — write-boundary for the remaining ~30 handlers: storage (~13), batch,
  growth, water-quality, fish-health update/delete/treatment. Same `runInTenantTransaction`
  transform. Owner: farm-expert. Deadline: 2026-07-14.
- **ORPHAN-HIGH-090b** — enum `defaultValue` coercion also affects feeding + water-quality
  create-DTOs (create-feeding-protocol/table/record/program, create-feed-inventory,
  create-batch-water-quality); fix with their write-boundary work. Owner: farm-expert. Deadline: 2026-07-14.
- **ORPHAN-MEDIUM-255** — `EMPLOYEE_PII_BLIND_INDEX_KEY` (32-byte/64-hex HMAC) not set on the
  deployed farm-service → createWorker fails; set the secret in the droplet env. Owner: infra.
  Deadline: 2026-07-07.

## FARM-HIGH-092 — createSpecies + createFeed enum coercion (follow-up to FARM-HIGH-090, found in live E2E)
After #756 deployed, live E2E showed 3/5 setup domains (consumable/supplier/chemical) + tanks working, but **species** and **feed** still failed at the ValidationPipe.
- **Species:** `category` + `waterType` carried a GraphQL `defaultValue` (same class as FARM-HIGH-090) — missed earlier because the file is `create-species.dto.ts`, not `*.input.ts`. Fixed: drop defaultValue → `@IsOptional`; defaults applied in `CreateSpeciesHandler`.
- **Feed:** `FeedType`/`FloatingType`/`FeedStatus` were registered only in `feed/dto/feed.response.ts`, while `create-feed.input.ts` imports them from `feed/entities/feed.entity.ts` (which did NOT register them). Input enum coercion then passed the raw uppercase key to `@IsEnum`. Fixed: co-locate `registerEnumType` in `feed.entity.ts` (matching consumable/supplier/chemical, which register in their entity files).

## FARM-HIGH-093 — equipmentList read was fail-open (the "equipment appears then disappears" report)
`ListEquipmentHandler` read BOTH the `equipment` and `tanks` tables via raw injected repositories with NO `runInTenantRead` boundary (it was in the read-boundary allowlist). It resolved the tables through the pooled connection's ambient search_path, so on a lost/rotated tenant context it silently read the wrong/empty schema → equipment (incl. cage tanks, which surface in Equipment) intermittently showed N then 0 then N. Confirmed live: the 3 cage tanks are correctly in the tenant schema; only the READ flipped. Fixed: wrap both reads in `runInTenantRead` + `tenantManagerRepo` (auto tenant scoping), route the equipment_types lookup through the boundary connection, and remove the allowlist entry.
Remaining fail-open AUXILIARY reads in site-management (tracked ORPHAN-HIGH-094, fixing next): species `speciesTags`, supplier/chemical/feed `*Types` dropdown @Query reads, supplier `sites` @ResolveField, fish-health `batch-harvest-eligibility.service`, and the `get-equipment-types`/`get-sub-equipment-types` handlers. The main LIST views for those domains already route through tenant-pinned handlers.

## FARM-HIGH-095 — reference-data seed rolled back every boot (equipment create blocked platform-wide)
`FarmSeedService.seedReferenceDataStandalone()` seeds equipment_types/chemical_types/supplier_types/cleaner-fish-species in ONE transaction. The last step `seedGlobalCleanerFishSpecies` INSERTed without the NOT-NULL `version` (@VersionColumn, no DB default) → `null value in column "version"` → the WHOLE transaction rolled back on every boot → all reference catalogs empty in production. Live-confirmed: source farm.equipment_types=0 (63 expected); aqua-farm boot log shows the version error in seedGlobalCleanerFishSpecies. Consequence: the equipment-type dropdown is empty → equipment cannot be created. Fix: set `version=1` on each seeded cleaner-fish row so the transaction commits and all reference data persists. Existing tenant schemas additionally need the reference rows cloned from source (post-deploy live clone, since copyReferenceData runs at provisioning).

## FARM-HIGH-096 — auxiliary tenant-data reads were fail-open (species tags, fish-health harvest-eligibility)
Continuation of ORPHAN-HIGH-094. Two reads of tenant-SPECIFIC data bypassed the boundary (raw injected repos resolved via the ambient pooled search_path → could read another tenant's rows or flip empty):
- `species.resolver.getSpeciesTags` (reads the tenant's `species` tags) → wrapped in runInTenantRead + tenantManagerRepo(Species).
- `fish-health/services/batch-harvest-eligibility.service` (reads `health_events` for the harvest-withdrawal gate — a safety-relevant decision) → wrapped in runInTenantRead + tenantManagerRepo(HealthEvent).
STILL DEFERRED (ORPHAN-HIGH-094): the `*Types` reference-catalog reads (get-equipment-types/get-sub-equipment-types handlers, supplier/chemical/feed `*Types` @Query). Those tables are tenantId-LESS per-tenant clones (identical seed across tenants), so a fail-open read returns the same data (no leak) and they need a different primitive (source-read or a non-tenant-scoped boundary read), not tenantManagerRepo (which requires a tenantId column).
