---
name: farm-service
description: Knowledge base for farm-service - The largest service (200+ files). Covers farm/tank/batch/species, feeding/growth/harvest, equipment/chemical/supplier, and system modules. CQRS throughout.
---

# Farm Service Knowledge Base

## Overview
The farm-service is the largest and most complex backend service. It manages all aquaculture farm operations: farms, ponds, sites, departments, tanks, batches, species, feeding programs, growth tracking, water quality, fish health, maintenance, harvests, equipment, chemicals, consumables, suppliers, feeds, storage, workers, weather data, Sentinel Hub satellite imagery, regulatory compliance, and system scheduling. Implements CQRS pattern throughout. Port 3002 in local dev.

## Directory Structure
```
apps/farm-service/src/
  app.module.ts              # Root - TypeORM (no fixed schema!), GraphQL Fed v2, CQRS, EventBus
  main.ts
  middleware/
    tenant-schema.middleware.ts   # Sets search_path: "tenant_xxx", farm, public
  filters/
    global-exception.filter.ts
  database/
    database.module.ts            # Audit service, code generator
    entities/
      base.entity.ts              # BaseEntity with tenantId, createdAt, updatedAt, version
      code-sequence.entity.ts     # Auto-increment code generation (FARM-001, TANK-001, etc.)
    services/
      code-generator.service.ts   # Generates human-readable codes
      audit-log.service.ts

  # ===================== CORE DOMAIN =====================
  farm/
    farm.module.ts
    commands/
      create-farm.command.ts
      update-farm.command.ts
      create-pond.command.ts
      harvest-batch.command.ts
    queries/
      get-farm.query.ts
      list-farms.query.ts
      get-pond.query.ts
    query-handlers/
      list-farms.handler.ts
      get-pond.handler.ts
    dto/
      create-farm.input.ts
      create-pond.input.ts
      harvest-batch.input.ts
    entities/ (farm.entity, pond.entity)
    resolvers/

  tank/
    tank.module.ts
    entities/
      tank.entity.ts              # Tank with type, capacity, status, location
    commands/
      create-tank.command.ts
      update-tank.command.ts
      update-tank-status.command.ts
    dto/
      create-tank.dto.ts
      update-tank.dto.ts
      tank-filter.dto.ts
    query-handlers/...

  batch/
    batch.module.ts
    entities/ (batch.entity - stocking batches)
    query-handlers/
      list-available-tanks.handler.ts  # Queries available tanks for new batch
    commands/...
    queries/...

  site/
    site.module.ts
    entities/ (site.entity - physical farm sites)
    commands/
      create-site.command.ts
      update-site.command.ts
    queries/
      get-site.query.ts
      list-sites.query.ts
    dto/
      site-filter.input.ts

  department/
    department.module.ts
    entities/ (department.entity)
    commands/
      create-department.command.ts
      update-department.command.ts
    queries/
      get-department.query.ts
      list-departments.query.ts

  species/
    species.module.ts
    entities/ (species.entity - aquaculture species definitions)
    commands/
      create-species.command.ts
      update-species.command.ts
      delete-species.command.ts
    queries/
      get-species.query.ts
      list-species.query.ts
      get-species-by-code.query.ts

  # ===================== OPERATIONS =====================
  feeding/
    feeding.module.ts
    entities/
      daily-feeding-execution.entity.ts  # Records of actual feeding events
    resolvers/
      feeding-program.resolver.ts
    dto/
      record-daily-feeding.input.ts

  feed/
    feed.module.ts
    entities/
      feeding-protocol.entity.ts
    commands/
      create-feed.command.ts
      update-feed.command.ts
      delete-feed.command.ts
    queries/
      get-feed.query.ts
    handlers/
      get-feed.handler.ts

  growth/
    growth.module.ts
    entities/ (growth-record.entity)

  water-quality/
    water-quality.module.ts
    entities/ (water-quality-record.entity)

  fish-health/
    fish-health.module.ts
    entities/ (health-record.entity, treatment.entity)

  maintenance/
    maintenance.module.ts
    entities/ (maintenance-record.entity)

  harvest/
    harvest.module.ts
    entities/ (harvest-record.entity)

  # ===================== ASSETS =====================
  equipment/
    equipment.module.ts
    equipment.resolver.ts
    entities/
      equipment.entity.ts
      sub-equipment-type.entity.ts
      feeder-calibration.entity.ts  (new - untracked)
    commands/
      create-equipment.command.ts
      update-equipment.command.ts
      save-feeder-calibrations.command.ts  (new - untracked)
    queries/
      get-equipment.query.ts
      get-equipment-types.query.ts
      list-feeder-calibrations.query.ts  (new - untracked)
    handlers/
      get-equipment-types.handler.ts
      list-feeder-calibrations.handler.ts  (new - untracked)
      save-feeder-calibrations.handler.ts  (new - untracked)
    seeds/
      equipment-types.seed.ts       # Seeds equipment types into shared farm schema
    dto/
      feeder-calibration.input.ts   (new - untracked)
      feeder-calibration.response.ts  (new - untracked)

  species/ (see core above)

  chemical/
    chemical.module.ts
    entities/ (chemical.entity)
    commands/
      create-chemical.command.ts
      update-chemical.command.ts
      delete-chemical.command.ts
    queries/
      get-chemical.query.ts
    handlers/
      get-chemical.handler.ts

  supplier/
    supplier.module.ts
    entities/ (supplier.entity)
    commands/
      create-supplier.command.ts
      update-supplier.command.ts
      delete-supplier.command.ts
    queries/
      get-supplier.query.ts
      list-suppliers.query.ts
    handlers/
      update-supplier.handler.ts
      get-supplier.handler.ts

  consumable/
    consumable.module.ts
    entities/ (consumable.entity)

  storage/
    storage.module.ts
    entities/ (storage-location.entity)

  worker/
    worker.module.ts
    entities/ (worker.entity - farm workers, linked to HR employees)

  # ===================== SYSTEM =====================
  system/
    system.module.ts          # Module visibility, feature flags per tenant
  cache/
    farm-cache.service.ts     # Redis-backed caching for farm data
  events/
    event-listeners.module.ts  # NATS event listeners
  scheduler/
    scheduler.module.ts       # Cron job scheduling
  sentinel-hub/
    sentinel-hub.module.ts    # Satellite imagery integration (Sentinel Hub API)
  regulatory/
    regulatory.module.ts      # Regulatory compliance tracking
  weather/
    weather.module.ts         # Weather data integration
  modules/
    system-optimizer/
      cost-calculator.service.ts
      energy-optimizer.service.ts
      resource-planner.service.ts
    tank-telemetry/
      services/
        circulation-optimizer.service.ts
        energy-efficiency.service.ts
        tank-monitoring.service.ts
      workflows/
        circulation-control.workflow.ts
        maintenance-schedule.workflow.ts
  health/
    health.module.ts
    health.controller.ts
  database/
    migrations/               # TypeORM migration files
      1774000000000-AddFeederCalibrations.ts   (new - untracked)
      1775000000000-AddFeederFieldsToExecution.ts  (new - untracked)
```

## Modules & Features

### Core Domain (Group 1)
- **FarmModule**: Farm and pond management; farms have sites, departments, ponds
- **TankModule**: Tank lifecycle (ACTIVE, INACTIVE, MAINTENANCE, QUARANTINE); tracks capacity, species
- **BatchModule**: Stocking batches - links species to tanks; `ListAvailableTanksHandler` finds tanks suitable for new batches
- **SiteModule**: Physical locations (sites) that contain farms
- **DepartmentModule**: Organizational departments within a farm

### Operations (Group 2)
- **FeedingModule**: Feeding program execution; `DailyFeedingExecution` records actual vs planned feeding; feeder calibration support (new)
- **FeedModule**: Feed types and feeding protocols (`FeedingProtocol`)
- **GrowthModule**: Growth records and FCR (Feed Conversion Ratio) tracking
- **WaterQualityModule**: Water parameter records (pH, DO, temperature, salinity)
- **FishHealthModule**: Health records and treatment tracking
- **MaintenanceModule**: Equipment maintenance schedules and records
- **HarvestModule**: Harvest records with weight and biomass tracking

### Assets (Group 3)
- **EquipmentModule**: Farm equipment CRUD; equipment types seeded into shared `farm` schema; feeder calibration (new feature)
- **SpeciesModule**: Aquaculture species catalog (salmon, tilapia, shrimp, etc.)
- **ChemicalModule**: Chemical inventory and usage tracking
- **SupplierModule**: Supplier management
- **ConsumableModule**: Consumable items inventory
- **StorageModule**: Storage location management

### System (Group 4)
- **SystemModule**: System-level configuration per tenant
- **SentinelHubModule**: Satellite imagery via Sentinel Hub API (NDWI, turbidity)
- **RegulatoryModule**: Regulatory compliance documents and tracking
- **WeatherModule**: Weather data fetch and storage
- **SchedulerModule**: Cron-based job scheduling
- **EventListenersModule**: Handles incoming NATS events
- **DatabaseModule**: Code generator (FARM-001, TANK-001), audit logging
- Tank telemetry and system optimizer services for advanced analytics

## Key Entities

### BaseEntity (all entities extend this)
- `id` (uuid), `tenantId`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `version` (optimistic locking)
- CRITICAL: No explicit `schema` in entity decorators - schema comes from search_path

### Tank
- `name`, `type` (RAS/POND/CAGE/etc.), `status`, `capacity` (liters), `currentBiomass`
- `siteId`, `farmId`, `departmentId`
- Has many batches

### Batch (stocking batch)
- `batchCode` (auto-generated), `speciesId`, `tankId`, `startDate`
- `initialCount`, `currentCount`, `mortalityCount`
- `averageWeight`, `biomass`

### Equipment
- `name`, `type`, `subType`, `serialNumber`, `status`
- `farmId`, `siteId`, `tankId` (nullable - can be farm-level)
- Feeder calibration data (new)

### DailyFeedingExecution
- `feedingProgramId`, `tankId`, `date`, `plannedAmount`, `actualAmount`
- `executedBy`, `notes`

## API / GraphQL (farm subgraph)
Resolvers exist for all core entities. CQRS pattern: resolvers dispatch commands/queries via the `@platform/cqrs` CqrsModule.

### Key Mutations
- `createFarm`, `updateFarm`
- `createTank`, `updateTank`, `updateTankStatus`
- `createBatch`, `transferBatch`
- `recordDailyFeeding`
- `createEquipment`, `updateEquipment`, `saveFeederCalibrations`
- `createSpecies`, `updateSpecies`, `deleteSpecies`
- `createChemical`, `updateChemical`, `deleteChemical`
- `createSupplier`, `updateSupplier`, `deleteSupplier`
- `recordGrowth`, `recordWaterQuality`, `recordFishHealth`
- `createMaintenanceRecord`
- `recordHarvest`

### Key Queries
- `farms`, `farm`, `ponds`, `pond`
- `tanks`, `tank`, `availableTanks`
- `batches`, `batch`
- `species`, `speciesByCode`
- `equipment`, `equipmentTypes`, `feederCalibrations`
- `chemicals`, `suppliers`, `feeds`
- `feedingPrograms`, `dailyFeedingExecutions`

## Patterns Used
- **CQRS** via `@platform/cqrs` - every write is a Command, every read is a Query
- **Repository pattern** via TypeORM repositories injected per entity
- **Event sourcing light** - publishes domain events via NATS after mutations
- **TenantSchemaMiddleware** - sets `search_path = "tenant_xxx", farm, public` per request
- **Code generation** - human-readable codes (FARM-001, BATCH-2024-001) via CodeSequence entity
- **Optimistic locking** via `@VersionColumn()` on all entities

## Inter-Service Communication
Publishes NATS events:
- `BatchCreated`, `BatchTransferred`, `HarvestCompleted`
- `FeedingRecorded`, `WaterQualityRecorded`
- `EquipmentMaintenanceDue`

Consumes NATS events (via EventListenersModule):
- Sensor readings (for automated recording)
- HR events (worker assignments)

## Key Dependencies
- `@platform/cqrs` - CQRS bus (CommandBus, QueryBus)
- `@platform/event-bus` - NATS JetStream publishing/subscribing
- `@platform/backend-common` - TenantGuard, middleware, TenantSchemaMiddleware pattern
- TypeORM with PostgreSQL (no fixed schema - uses search_path)

## Known Gotchas
- **No hardcoded schema in entities** - farm-service uses dynamic `search_path` set by TenantSchemaMiddleware. NEVER add `{ schema: 'farm' }` to entity decorators for tenant-scoped tables.
- **Exception: equipment_types** - `equipment_types` table lives in the shared `farm` schema (not tenant-scoped). The `farm` fallback in search_path covers this: `search_path = "tenant_xxx", farm, public`
- **DatabaseModule must be imported first** - CodeGenerator and AuditLog services are used by all other modules
- **CQRS handler registration** - every handler must be listed in the module's `providers` array AND in the `CqrsModule.forRoot()` (handled by `@platform/cqrs`)
- **Feeder calibrations are new** - files in `equipment/` related to feeder calibration are untracked (new feature in progress). Check migration files `1774*` and `1775*`.
- **TenantSchemaMiddleware order** - must run AFTER UserContextMiddleware and TenantContextMiddleware (tenantId must be set before setting search_path)
- **MODULE_SCHEMAS** in `libs/backend-common/src/database/schema-manager.service.ts` must list all farm-service entity tables, or they won't be created in new tenant schemas

## Related Services
- sensor-service: sends sensor readings that may trigger farm data updates
- hr-service: farm workers linked to HR employees via `worker.entity`
- admin-api-service: provisions farm module tables during tenant creation
- alert-engine: monitors farm thresholds
