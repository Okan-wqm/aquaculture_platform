# Frontend -> Backend -> Database Map

> Generated 2026-03-18 by tracing every GraphQL mutation and REST endpoint from frontend modules
> through backend resolvers/controllers to TypeORM entities and database tables.
>
> **Snapshot notice:** The platform continues to evolve after this generated
> inventory. The environmental-monitoring rows below were revalidated on
> 2026-07-31; other sections remain a 2026-03-18 snapshot and are not an API
> contract.

## Legend

- **Schema**: `auth` / `admin` / `billing` = system schemas (fixed); `tenant_xxx` = per-tenant schema-isolated
- **Status**: VERIFIED = full chain traced through code; LIKELY = pattern-based inference from naming conventions
- **tenant_xxx**: Schema name format is `tenant_{first16chars_of_uuid_without_hyphens}`

---

## Farm Module (`tenant_xxx` schema)

Frontend: `web/modules/farm-module/`
Backend: `apps/farm-service/`
Schema: Per-tenant via `TenantSchemaMiddleware` -> `search_path`

### Sites

| Frontend Form/Action | GraphQL Mutation | Backend Resolver                  | DB Table | Status   |
| -------------------- | ---------------- | --------------------------------- | -------- | -------- |
| Add Site             | `createSite`     | `site.resolver.ts` -> SiteService | `sites`  | VERIFIED |
| Edit Site            | `updateSite`     | `site.resolver.ts` -> SiteService | `sites`  | VERIFIED |
| Delete Site          | `deleteSite`     | `site.resolver.ts` -> SiteService | `sites`  | VERIFIED |

### Tanks

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver                  | DB Table | Status   |
| -------------------- | ------------------ | --------------------------------- | -------- | -------- |
| Add Tank             | `createTank`       | `tank.resolver.ts` -> TankService | `tanks`  | VERIFIED |
| Edit Tank            | `updateTank`       | `tank.resolver.ts` -> TankService | `tanks`  | VERIFIED |
| Change Tank Status   | `updateTankStatus` | `tank.resolver.ts` -> TankService | `tanks`  | VERIFIED |
| Delete Tank          | `deleteTank`       | `tank.resolver.ts` -> TankService | `tanks`  | VERIFIED |

### Systems

| Frontend Form/Action | GraphQL Mutation | Backend Resolver                      | DB Table  | Status   |
| -------------------- | ---------------- | ------------------------------------- | --------- | -------- |
| Add System           | `createSystem`   | `system.resolver.ts` -> SystemService | `systems` | VERIFIED |
| Edit System          | `updateSystem`   | `system.resolver.ts` -> SystemService | `systems` | VERIFIED |
| Delete System        | `deleteSystem`   | `system.resolver.ts` -> SystemService | `systems` | VERIFIED |

### Batches

| Frontend Form/Action   | GraphQL Mutation            | Backend Resolver                        | DB Table                                            | Status   |
| ---------------------- | --------------------------- | --------------------------------------- | --------------------------------------------------- | -------- |
| Create Batch           | `createBatch`               | `batch.resolver.ts` -> BatchService     | `batches_v2`                                        | VERIFIED |
| Update Batch           | `updateBatch`               | `batch.resolver.ts` -> BatchService     | `batches_v2`                                        | VERIFIED |
| Update Batch Status    | `updateBatchStatus`         | `batch.resolver.ts` -> BatchService     | `batches_v2`                                        | VERIFIED |
| Record Mortality       | `recordMortality`           | `batch.resolver.ts` -> BatchService     | `batches_v2`, `mortality_records`                   | VERIFIED |
| Record Cull            | `recordCull`                | `batch.resolver.ts` -> BatchService     | `batches_v2`, `mortality_records`                   | VERIFIED |
| Transfer Batch         | `transferBatch`             | `batch.resolver.ts` -> BatchService     | `batches_v2`, `tank_operations`, `tank_allocations` | VERIFIED |
| Create Harvest Record  | `createHarvestRecord`       | `harvest.resolver.ts` -> HarvestService | `harvest_records`, `batches_v2`                     | VERIFIED |
| Assign Feed to Batch   | `createBatchFeedAssignment` | `batch-feed-assignment.resolver.ts`     | `batch_feed_assignments`                            | VERIFIED |
| Update Feed Assignment | `updateBatchFeedAssignment` | `batch-feed-assignment.resolver.ts`     | `batch_feed_assignments`                            | VERIFIED |
| Delete Feed Assignment | `deleteBatchFeedAssignment` | `batch-feed-assignment.resolver.ts`     | `batch_feed_assignments`                            | VERIFIED |

### Cleaner Fish

| Frontend Form/Action      | GraphQL Mutation         | Backend Resolver           | DB Table                          | Status   |
| ------------------------- | ------------------------ | -------------------------- | --------------------------------- | -------- |
| Create Cleaner Fish Batch | `createCleanerFishBatch` | `cleaner-fish.resolver.ts` | `batches_v2`                      | VERIFIED |
| Deploy Cleaner Fish       | `deployCleanerFish`      | `cleaner-fish.resolver.ts` | `batches_v2`, `tank_allocations`  | VERIFIED |
| Transfer Cleaner Fish     | `transferCleanerFish`    | `cleaner-fish.resolver.ts` | `batches_v2`, `tank_operations`   | VERIFIED |
| Record Cleaner Mortality  | `recordCleanerMortality` | `cleaner-fish.resolver.ts` | `batches_v2`, `mortality_records` | VERIFIED |
| Remove Cleaner Fish       | `removeCleanerFish`      | `cleaner-fish.resolver.ts` | `batches_v2`                      | VERIFIED |

### Species

| Frontend Form/Action | GraphQL Mutation | Backend Resolver                        | DB Table  | Status   |
| -------------------- | ---------------- | --------------------------------------- | --------- | -------- |
| Add Species          | `createSpecies`  | `species.resolver.ts` -> SpeciesService | `species` | VERIFIED |
| Edit Species         | `updateSpecies`  | `species.resolver.ts` -> SpeciesService | `species` | VERIFIED |
| Delete Species       | `deleteSpecies`  | `species.resolver.ts` -> SpeciesService | `species` | VERIFIED |

### Feeds & Feeding

| Frontend Form/Action    | GraphQL Mutation            | Backend Resolver                        | DB Table            | Status   |
| ----------------------- | --------------------------- | --------------------------------------- | ------------------- | -------- |
| Add Feed                | `createFeed`                | `feed.resolver.ts` -> FeedService       | `feeds`             | VERIFIED |
| Edit Feed               | `updateFeed`                | `feed.resolver.ts` -> FeedService       | `feeds`             | VERIFIED |
| Delete Feed             | `deleteFeed`                | `feed.resolver.ts` -> FeedService       | `feeds`             | VERIFIED |
| Create Feeding Protocol | `createFeedingProtocol`     | `feeding-protocol.resolver.ts`          | `feeding_protocols` | VERIFIED |
| Update Feeding Protocol | `updateFeedingProtocol`     | `feeding-protocol.resolver.ts`          | `feeding_protocols` | VERIFIED |
| Delete Feeding Protocol | `deleteFeedingProtocol`     | `feeding-protocol.resolver.ts`          | `feeding_protocols` | VERIFIED |
| Set Default Protocol    | `setDefaultFeedingProtocol` | `feeding-protocol.resolver.ts`          | `feeding_protocols` | VERIFIED |
| Record Feeding          | `createFeedingRecord`       | `feeding.resolver.ts` -> FeedingService | `feeding_records`   | VERIFIED |
| Update Feeding Record   | `updateFeedingRecord`       | `feeding.resolver.ts` -> FeedingService | `feeding_records`   | VERIFIED |
| Add Feed Inventory      | `addFeedInventory`          | `feeding.resolver.ts` -> FeedingService | `feed_inventory`    | VERIFIED |
| Consume Feed Inventory  | `consumeFeedInventory`      | `feeding.resolver.ts` -> FeedingService | `feed_inventory`    | VERIFIED |
| Adjust Feed Inventory   | `adjustFeedInventory`       | `feeding.resolver.ts` -> FeedingService | `feed_inventory`    | VERIFIED |

### Feeding Programs

| Frontend Form/Action       | GraphQL Mutation          | Backend Resolver              | DB Table                   | Status   |
| -------------------------- | ------------------------- | ----------------------------- | -------------------------- | -------- |
| Create Feeding Program     | `createFeedingProgram`    | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Update Feeding Program     | `updateFeedingProgram`    | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Delete Feeding Program     | `deleteFeedingProgram`    | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Activate Program           | `activateFeedingProgram`  | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Pause Program              | `pauseFeedingProgram`     | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Complete Program           | `completeFeedingProgram`  | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Cancel Program             | `cancelFeedingProgram`    | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Add Tank to Program        | `addTankToProgram`        | `feeding-program.resolver.ts` | `feeding_program_tanks`    | VERIFIED |
| Add Tanks (bulk)           | `addTanksToProgram`       | `feeding-program.resolver.ts` | `feeding_program_tanks`    | VERIFIED |
| Remove Tank from Program   | `removeTankFromProgram`   | `feeding-program.resolver.ts` | `feeding_program_tanks`    | VERIFIED |
| Reactivate Tank in Program | `reactivateTankInProgram` | `feeding-program.resolver.ts` | `feeding_program_tanks`    | VERIFIED |
| Assign Temp Sensor         | `assignTemperatureSensor` | `feeding-program.resolver.ts` | `feeding_program_tanks`    | VERIFIED |
| Transition Tank Feed       | `transitionTankFeed`      | `feeding-program.resolver.ts` | `feeding_program_tanks`    | VERIFIED |
| Generate Daily Plan        | `generateDailyPlan`       | `feeding-program.resolver.ts` | `daily_feeding_executions` | VERIFIED |
| Record Daily Feeding       | `recordDailyFeeding`      | `feeding-program.resolver.ts` | `daily_feeding_executions` | VERIFIED |
| Skip Daily Feeding         | `skipDailyFeeding`        | `feeding-program.resolver.ts` | `daily_feeding_executions` | VERIFIED |
| Bulk Record Feeding        | `recordBulkFeeding`       | `feeding-program.resolver.ts` | `daily_feeding_executions` | VERIFIED |
| Recalculate Daily Plan     | `recalculateDailyPlan`    | `feeding-program.resolver.ts` | `daily_feeding_executions` | VERIFIED |
| Add Feed Assignment        | `addFeedAssignment`       | `feeding-program.resolver.ts` | `feeding_programs` (JSON)  | VERIFIED |
| Update Feed Assignment     | `updateFeedAssignment`    | `feeding-program.resolver.ts` | `feeding_programs` (JSON)  | VERIFIED |
| Remove Feed Assignment     | `removeFeedAssignment`    | `feeding-program.resolver.ts` | `feeding_programs` (JSON)  | VERIFIED |
| Update FCR Table           | `updateFCRTable`          | `feeding-program.resolver.ts` | `feeding_programs` (JSON)  | VERIFIED |
| Clone Program              | `cloneFeedingProgram`     | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |
| Update Program Settings    | `updateProgramSettings`   | `feeding-program.resolver.ts` | `feeding_programs`         | VERIFIED |

### Growth

| Frontend Form/Action | GraphQL Mutation              | Backend Resolver                      | DB Table                            | Status   |
| -------------------- | ----------------------------- | ------------------------------------- | ----------------------------------- | -------- |
| Record Growth Sample | `recordGrowthSample`          | `growth.resolver.ts` -> GrowthService | `growth_measurements`               | VERIFIED |
| Update Batch Weight  | `updateBatchWeightFromSample` | `growth.resolver.ts` -> GrowthService | `growth_measurements`, `batches_v2` | VERIFIED |
| Verify Measurement   | `verifyMeasurement`           | `growth.resolver.ts` -> GrowthService | `growth_measurements`               | VERIFIED |

### Harvest Plans

| Frontend Form/Action  | GraphQL Mutation      | Backend Resolver           | DB Table        | Status   |
| --------------------- | --------------------- | -------------------------- | --------------- | -------- |
| Create Harvest Plan   | `createHarvestPlan`   | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Update Harvest Plan   | `updateHarvestPlan`   | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Delete Harvest Plan   | `deleteHarvestPlan`   | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Approve Harvest Plan  | `approveHarvestPlan`  | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Schedule Harvest Plan | `scheduleHarvestPlan` | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Start Harvest Plan    | `startHarvestPlan`    | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Complete Harvest Plan | `completeHarvestPlan` | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Cancel Harvest Plan   | `cancelHarvestPlan`   | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |
| Postpone Harvest Plan | `postponeHarvestPlan` | `harvest-plan.resolver.ts` | `harvest_plans` | VERIFIED |

### Workers

| Frontend Form/Action | GraphQL Mutation | Backend Resolver                      | DB Table       | Status   |
| -------------------- | ---------------- | ------------------------------------- | -------------- | -------- |
| Add Worker           | `createWorker`   | `worker.resolver.ts` -> WorkerService | `farm_workers` | VERIFIED |
| Edit Worker          | `updateWorker`   | `worker.resolver.ts` -> WorkerService | `farm_workers` | VERIFIED |
| Delete Worker        | `deleteWorker`   | `worker.resolver.ts` -> WorkerService | `farm_workers` | VERIFIED |

### Tasks

| Frontend Form/Action  | GraphQL Mutation      | Backend Resolver                  | DB Table       | Status   |
| --------------------- | --------------------- | --------------------------------- | -------------- | -------- |
| Create Task           | `createTask`          | `task.resolver.ts` -> TaskService | `tasks`        | VERIFIED |
| Update Task           | `updateTask`          | `task.resolver.ts` -> TaskService | `tasks`        | VERIFIED |
| Complete Task         | `completeTask`        | `task.resolver.ts` -> TaskService | `tasks`        | VERIFIED |
| Start Task            | `startTask`           | `task.resolver.ts` -> TaskService | `tasks`        | VERIFIED |
| Delete Task           | `deleteTask`          | `task.resolver.ts` -> TaskService | `tasks`        | VERIFIED |
| Toggle Checklist Item | `toggleChecklistItem` | `task.resolver.ts` -> TaskService | `tasks` (JSON) | VERIFIED |
| Add Task Note         | `addTaskNote`         | `task.resolver.ts` -> TaskService | `tasks` (JSON) | VERIFIED |

### Auto Rules (Task Automation)

| Frontend Form/Action | GraphQL Mutation       | Backend Resolver        | DB Table     | Status   |
| -------------------- | ---------------------- | ----------------------- | ------------ | -------- |
| Create Auto Rule     | `createAutoRule`       | `auto-rule.resolver.ts` | `auto_rules` | VERIFIED |
| Update Auto Rule     | `updateAutoRule`       | `auto-rule.resolver.ts` | `auto_rules` | VERIFIED |
| Delete Auto Rule     | `deleteAutoRule`       | `auto-rule.resolver.ts` | `auto_rules` | VERIFIED |
| Toggle Auto Rule     | `toggleAutoRuleActive` | `auto-rule.resolver.ts` | `auto_rules` | VERIFIED |

### Recurring Templates

| Frontend Form/Action | GraphQL Mutation                | Backend Resolver                 | DB Table              | Status   |
| -------------------- | ------------------------------- | -------------------------------- | --------------------- | -------- |
| Create Template      | `createRecurringTemplate`       | `recurring-template.resolver.ts` | `recurring_templates` | VERIFIED |
| Update Template      | `updateRecurringTemplate`       | `recurring-template.resolver.ts` | `recurring_templates` | VERIFIED |
| Delete Template      | `deleteRecurringTemplate`       | `recurring-template.resolver.ts` | `recurring_templates` | VERIFIED |
| Toggle Template      | `toggleRecurringTemplateActive` | `recurring-template.resolver.ts` | `recurring_templates` | VERIFIED |

### Equipment

| Frontend Form/Action     | GraphQL Mutation         | Backend Resolver                            | DB Table              | Status   |
| ------------------------ | ------------------------ | ------------------------------------------- | --------------------- | -------- |
| Add Equipment            | `createEquipment`        | `equipment.resolver.ts` -> EquipmentService | `equipment`           | VERIFIED |
| Edit Equipment           | `updateEquipment`        | `equipment.resolver.ts` -> EquipmentService | `equipment`           | VERIFIED |
| Delete Equipment         | `deleteEquipment`        | `equipment.resolver.ts` -> EquipmentService | `equipment`           | VERIFIED |
| Create Sub-Equipment     | `createSubEquipment`     | `sub-equipment.resolver.ts`                 | `sub_equipment`       | VERIFIED |
| Update Sub-Equipment     | `updateSubEquipment`     | `sub-equipment.resolver.ts`                 | `sub_equipment`       | VERIFIED |
| Delete Sub-Equipment     | `deleteSubEquipment`     | `sub-equipment.resolver.ts`                 | `sub_equipment`       | VERIFIED |
| Save Feeder Calibrations | `saveFeederCalibrations` | `equipment.resolver.ts`                     | `feeder_calibrations` | VERIFIED |

### Departments

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver         | DB Table      | Status   |
| -------------------- | ------------------ | ------------------------ | ------------- | -------- |
| Create Department    | `createDepartment` | `department.resolver.ts` | `departments` | VERIFIED |
| Update Department    | `updateDepartment` | `department.resolver.ts` | `departments` | VERIFIED |
| Delete Department    | `deleteDepartment` | `department.resolver.ts` | `departments` | VERIFIED |

### Suppliers

| Frontend Form/Action | GraphQL Mutation | Backend Resolver                          | DB Table    | Status   |
| -------------------- | ---------------- | ----------------------------------------- | ----------- | -------- |
| Add Supplier         | `createSupplier` | `supplier.resolver.ts` -> SupplierService | `suppliers` | VERIFIED |
| Edit Supplier        | `updateSupplier` | `supplier.resolver.ts` -> SupplierService | `suppliers` | VERIFIED |
| Delete Supplier      | `deleteSupplier` | `supplier.resolver.ts` -> SupplierService | `suppliers` | VERIFIED |

### Chemicals

| Frontend Form/Action     | GraphQL Mutation         | Backend Resolver                          | DB Table           | Status   |
| ------------------------ | ------------------------ | ----------------------------------------- | ------------------ | -------- |
| Add Chemical             | `createChemical`         | `chemical.resolver.ts` -> ChemicalService | `chemicals`        | VERIFIED |
| Edit Chemical            | `updateChemical`         | `chemical.resolver.ts` -> ChemicalService | `chemicals`        | VERIFIED |
| Delete Chemical          | `deleteChemical`         | `chemical.resolver.ts` -> ChemicalService | `chemicals`        | VERIFIED |
| Add Chemical Document    | `addChemicalDocument`    | `chemical.resolver.ts` -> ChemicalService | `chemicals` (JSON) | VERIFIED |
| Remove Chemical Document | `removeChemicalDocument` | `chemical.resolver.ts` -> ChemicalService | `chemicals` (JSON) | VERIFIED |

### Consumables

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver         | DB Table      | Status   |
| -------------------- | ------------------ | ------------------------ | ------------- | -------- |
| Add Consumable       | `createConsumable` | `consumable.resolver.ts` | `consumables` | VERIFIED |
| Edit Consumable      | `updateConsumable` | `consumable.resolver.ts` | `consumables` | VERIFIED |
| Delete Consumable    | `deleteConsumable` | `consumable.resolver.ts` | `consumables` | VERIFIED |

### Water Quality

| Frontend Form/Action  | GraphQL Mutation                | Backend Resolver            | DB Table                     | Status   |
| --------------------- | ------------------------------- | --------------------------- | ---------------------------- | -------- |
| Add WQ Measurement    | `createWaterQualityMeasurement` | `water-quality.resolver.ts` | `water_quality_measurements` | VERIFIED |
| Edit WQ Measurement   | `updateWaterQualityMeasurement` | `water-quality.resolver.ts` | `water_quality_measurements` | VERIFIED |
| Delete WQ Measurement | `deleteWaterQualityMeasurement` | `water-quality.resolver.ts` | `water_quality_measurements` | VERIFIED |

### Fish Health

| Frontend Form/Action | GraphQL Mutation             | Backend Resolver           | DB Table        | Status   |
| -------------------- | ---------------------------- | -------------------------- | --------------- | -------- |
| Create Health Event  | `createHealthEvent`          | `health-event.resolver.ts` | `health_events` | VERIFIED |
| Update Health Event  | `updateHealthEvent`          | `health-event.resolver.ts` | `health_events` | VERIFIED |
| Delete Health Event  | `deleteHealthEvent`          | `health-event.resolver.ts` | `health_events` | VERIFIED |
| Start Treatment      | `startHealthEventTreatment`  | `health-event.resolver.ts` | `health_events` | VERIFIED |
| End Treatment        | `endHealthEventTreatment`    | `health-event.resolver.ts` | `health_events` | VERIFIED |
| Start Quarantine     | `startHealthEventQuarantine` | `health-event.resolver.ts` | `health_events` | VERIFIED |
| End Quarantine       | `endHealthEventQuarantine`   | `health-event.resolver.ts` | `health_events` | VERIFIED |
| Resolve Health Event | `resolveHealthEvent`         | `health-event.resolver.ts` | `health_events` | VERIFIED |

### Maintenance - Work Orders

| Frontend Form/Action | GraphQL Mutation             | Backend Resolver         | DB Table      | Status   |
| -------------------- | ---------------------------- | ------------------------ | ------------- | -------- |
| Create Work Order    | `createWorkOrder`            | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Update Work Order    | `updateWorkOrder`            | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Complete Work Order  | `completeWorkOrder`          | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Delete Work Order    | `deleteWorkOrder`            | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Submit for Approval  | `submitWorkOrderForApproval` | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Approve Work Order   | `approveWorkOrder`           | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Start Work Order     | `startWorkOrder`             | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Verify Work Order    | `verifyWorkOrder`            | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Cancel Work Order    | `cancelWorkOrder`            | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Put On Hold          | `putWorkOrderOnHold`         | `work-order.resolver.ts` | `work_orders` | VERIFIED |
| Resume Work Order    | `resumeWorkOrder`            | `work-order.resolver.ts` | `work_orders` | VERIFIED |

### Maintenance - Schedules

| Frontend Form/Action | GraphQL Mutation            | Backend Resolver                   | DB Table                | Status   |
| -------------------- | --------------------------- | ---------------------------------- | ----------------------- | -------- |
| Create Schedule      | `createMaintenanceSchedule` | `maintenance-schedule.resolver.ts` | `maintenance_schedules` | VERIFIED |
| Update Schedule      | `updateMaintenanceSchedule` | `maintenance-schedule.resolver.ts` | `maintenance_schedules` | VERIFIED |
| Delete Schedule      | `deleteMaintenanceSchedule` | `maintenance-schedule.resolver.ts` | `maintenance_schedules` | VERIFIED |
| Pause Schedule       | `pauseMaintenanceSchedule`  | `maintenance-schedule.resolver.ts` | `maintenance_schedules` | VERIFIED |
| Resume Schedule      | `resumeMaintenanceSchedule` | `maintenance-schedule.resolver.ts` | `maintenance_schedules` | VERIFIED |

### Maintenance - Spare Parts

| Frontend Form/Action  | GraphQL Mutation      | Backend Resolver         | DB Table                   | Status   |
| --------------------- | --------------------- | ------------------------ | -------------------------- | -------- |
| Create Spare Part     | `createSparePart`     | `spare-part.resolver.ts` | `spare_parts`              | VERIFIED |
| Update Spare Part     | `updateSparePart`     | `spare-part.resolver.ts` | `spare_parts`              | VERIFIED |
| Delete Spare Part     | `deleteSparePart`     | `spare-part.resolver.ts` | `spare_parts`              | VERIFIED |
| Record Stock Movement | `recordStockMovement` | `spare-part.resolver.ts` | `spare_parts` (qty update) | VERIFIED |

### Storage & Inventory

| Frontend Form/Action    | GraphQL Mutation        | Backend Resolver      | DB Table                               | Status   |
| ----------------------- | ----------------------- | --------------------- | -------------------------------------- | -------- |
| Create Storage Location | `createStorageLocation` | `storage.resolver.ts` | `storage_locations`                    | VERIFIED |
| Update Storage Location | `updateStorageLocation` | `storage.resolver.ts` | `storage_locations`                    | VERIFIED |
| Delete Storage Location | `deleteStorageLocation` | `storage.resolver.ts` | `storage_locations`                    | VERIFIED |
| Record Stock Movement   | `recordStockMovement`   | `storage.resolver.ts` | `stock_movements`, `storage_inventory` | VERIFIED |
| Transfer Stock          | `transferStock`         | `storage.resolver.ts` | `stock_movements`, `storage_inventory` | VERIFIED |

### Purchase Orders

| Frontend Form/Action  | GraphQL Mutation            | Backend Resolver      | DB Table                                  | Status   |
| --------------------- | --------------------------- | --------------------- | ----------------------------------------- | -------- |
| Create Purchase Order | `createPurchaseOrder`       | `storage.resolver.ts` | `purchase_orders`, `purchase_order_items` | VERIFIED |
| Update PO Status      | `updatePurchaseOrderStatus` | `storage.resolver.ts` | `purchase_orders`                         | VERIFIED |
| Receive Delivery      | `receiveDelivery`           | `storage.resolver.ts` | `purchase_orders`, `storage_inventory`    | VERIFIED |
| Cancel Purchase Order | `cancelPurchaseOrder`       | `storage.resolver.ts` | `purchase_orders`                         | VERIFIED |

### Environmental Monitoring

| Frontend Form/Action         | GraphQL/REST operation                              | Backend boundary                                         | DB Table                                                                                                     | Status              |
| ---------------------------- | --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------- |
| View current site values     | `siteEnvironmentCurrent`                            | `environment.resolver.ts`                                | canonical rows in `weather_observations`, `marine_observations`                                              | VERIFIED 2026-07-31 |
| View site history/forecast   | `siteEnvironmentHistory`, `siteEnvironmentForecast` | `environment.resolver.ts`                                | canonical rows in `weather_observations`, `marine_observations`                                              | VERIFIED 2026-07-31 |
| View layer availability      | `environmentLayerCatalog`                           | `environment.resolver.ts`                                | provider sync state + canonical observations                                                                 | VERIFIED 2026-07-31 |
| View exact scene list        | `environmentScenes`                                 | `environment.resolver.ts`                                | `satellite_scene_observations`                                                                               | VERIFIED 2026-07-31 |
| Scheduled provider ingestion | no tenant mutation                                  | `EnvironmentCronService` → `EnvironmentIngestionService` | `weather_observations`, `marine_observations`, `satellite_scene_observations`, `site_environment_sync_state` | VERIFIED 2026-07-31 |

### Regulatory / Reports

| Frontend Form/Action         | GraphQL Mutation                | Backend Resolver         | DB Table              | Status   |
| ---------------------------- | ------------------------------- | ------------------------ | --------------------- | -------- |
| Update Regulatory Settings   | `updateRegulatorySettings`      | `regulatory.resolver.ts` | `regulatory_settings` | VERIFIED |
| Test Maskinporten Connection | `testMaskinportenConnection`    | `regulatory.resolver.ts` | (no DB write)         | VERIFIED |
| Submit Sea Lice Report       | `submitSeaLiceReport`           | `regulatory.resolver.ts` | (external API)        | VERIFIED |
| Submit Cleaner Fish Report   | `submitCleanerFishReport`       | `regulatory.resolver.ts` | (external API)        | VERIFIED |
| Submit Smolt Report          | `submitSmoltReport`             | `regulatory.resolver.ts` | (external API)        | VERIFIED |
| Submit Planned Slaughter     | `submitPlannedSlaughterReport`  | `regulatory.resolver.ts` | (external API)        | VERIFIED |
| Submit Executed Slaughter    | `submitExecutedSlaughterReport` | `regulatory.resolver.ts` | (external API)        | VERIFIED |

### Sentinel-2 imagery

| Frontend Form/Action                             | Operation                                           | Backend boundary                                                      | DB Table                                 | Status              |
| ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- | ------------------- |
| Render a catalogued scene for an authorized site | gateway `POST /api/marine/sites/{siteId}/render`    | signed proxy → farm `POST /api/internal/marine/sites/{siteId}/render` | reads `satellite_scene_observations`     | VERIFIED 2026-07-31 |
| Configure CDSE provider credentials              | company-only config-service operation; no tenant UI | config-service signed NATS boundary                                   | config-service SSoT                      | VERIFIED 2026-07-31 |
| Legacy credential cutover                        | one-shot startup migration; no tenant UI            | `SentinelCredentialCutoverService`                                    | reads and scrubs `sentinel_hub_settings` | VERIFIED 2026-07-31 |

### Farm (Legacy Pond-based)

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver   | DB Table  | Status   |
| -------------------- | ------------------ | ------------------ | --------- | -------- |
| Create Farm          | `createFarm`       | `farm.resolver.ts` | `farms`   | VERIFIED |
| Create Pond          | `createPond`       | `farm.resolver.ts` | `ponds`   | VERIFIED |
| Create Pond Batch    | `createPondBatch`  | `farm.resolver.ts` | `batches` | VERIFIED |
| Harvest Pond Batch   | `harvestPondBatch` | `farm.resolver.ts` | `batches` | VERIFIED |

---

## Sensor Module (`tenant_xxx` schema)

Frontend: `web/modules/sensor-module/`
Backend: `apps/sensor-service/`
Schema: Per-tenant via `TenantSchemaMiddleware` -> `search_path`

### Sensor Registration

| Frontend Form/Action        | GraphQL Mutation             | Backend Resolver           | DB Table                                              | Status   |
| --------------------------- | ---------------------------- | -------------------------- | ----------------------------------------------------- | -------- |
| Register Sensor             | `registerSensor`             | `registration.resolver.ts` | `sensors`, `sensor_protocols`, `sensor_data_channels` | VERIFIED |
| Activate Sensor             | `activateSensor`             | `registration.resolver.ts` | `sensors`                                             | VERIFIED |
| Suspend Sensor              | `suspendSensor`              | `registration.resolver.ts` | `sensors`                                             | VERIFIED |
| Reactivate Sensor           | `reactivateSensor`           | `registration.resolver.ts` | `sensors`                                             | VERIFIED |
| Update Sensor Protocol      | `updateSensorProtocol`       | `registration.resolver.ts` | `sensor_protocols`                                    | VERIFIED |
| Update Sensor Info          | `updateSensorInfo`           | `registration.resolver.ts` | `sensors`                                             | VERIFIED |
| Delete Sensor               | `deleteSensor`               | `registration.resolver.ts` | `sensors`                                             | VERIFIED |
| Register Parent w/ Children | `registerParentWithChildren` | `registration.resolver.ts` | `sensors`, `sensor_protocols`                         | VERIFIED |

### Data Channels

| Frontend Form/Action | GraphQL Mutation         | Backend Resolver      | DB Table               | Status   |
| -------------------- | ------------------------ | --------------------- | ---------------------- | -------- |
| Create Data Channel  | `createDataChannel`      | `channel.resolver.ts` | `sensor_data_channels` | VERIFIED |
| Update Data Channel  | `updateDataChannel`      | `channel.resolver.ts` | `sensor_data_channels` | VERIFIED |
| Bulk Update Channels | `bulkUpdateDataChannels` | `channel.resolver.ts` | `sensor_data_channels` | VERIFIED |
| Delete Data Channel  | `deleteDataChannel`      | `channel.resolver.ts` | `sensor_data_channels` | VERIFIED |
| Discover Channels    | `discoverDataChannels`   | `channel.resolver.ts` | `sensor_data_channels` | VERIFIED |

### Channel Detection (AI-assisted)

| Frontend Form/Action     | GraphQL Mutation         | Backend Resolver          | DB Table                                        | Status   |
| ------------------------ | ------------------------ | ------------------------- | ----------------------------------------------- | -------- |
| Detect Sensor Channels   | `detectSensorChannels`   | `sensor-type.resolver.ts` | `channel_detection_log`                         | VERIFIED |
| Approve Channel Proposal | `approveChannelProposal` | `sensor-type.resolver.ts` | `sensor_data_channels`, `channel_detection_log` | VERIFIED |
| Reject Channel Proposal  | `rejectChannelProposal`  | `sensor-type.resolver.ts` | `channel_detection_log`                         | VERIFIED |

### Sensor Types & Templates

| Frontend Form/Action    | GraphQL Mutation        | Backend Resolver          | DB Table                  | Status   |
| ----------------------- | ----------------------- | ------------------------- | ------------------------- | -------- |
| Create Sensor Type      | `createSensorType`      | `sensor-type.resolver.ts` | `sensor_type_definitions` | VERIFIED |
| Update Sensor Type      | `updateSensorType`      | `sensor-type.resolver.ts` | `sensor_type_definitions` | VERIFIED |
| Delete Sensor Type      | `deleteSensorType`      | `sensor-type.resolver.ts` | `sensor_type_definitions` | VERIFIED |
| Apply Industry Template | `applyIndustryTemplate` | `sensor-type.resolver.ts` | `sensor_type_definitions` | VERIFIED |

### Protocol Operations

| Frontend Form/Action     | GraphQL Mutation         | Backend Resolver           | DB Table      | Status   |
| ------------------------ | ------------------------ | -------------------------- | ------------- | -------- |
| Validate Protocol Config | `validateProtocolConfig` | `protocol.resolver.ts`     | (no DB write) | VERIFIED |
| Test Protocol Connection | `testProtocolConnection` | `protocol.resolver.ts`     | (no DB write) | VERIFIED |
| Apply Protocol Defaults  | `applyProtocolDefaults`  | `protocol.resolver.ts`     | (no DB write) | VERIFIED |
| Test Sensor Connection   | `testSensorConnection`   | `registration.resolver.ts` | (no DB write) | VERIFIED |

### VFD Devices

| Frontend Form/Action | GraphQL Mutation      | Backend Resolver         | DB Table      | Status   |
| -------------------- | --------------------- | ------------------------ | ------------- | -------- |
| Register VFD Device  | `registerVfdDevice`   | `vfd-device.resolver.ts` | `vfd_devices` | VERIFIED |
| Update VFD Device    | `updateVfdDevice`     | `vfd-device.resolver.ts` | `vfd_devices` | VERIFIED |
| Delete VFD Device    | `deleteVfdDevice`     | `vfd-device.resolver.ts` | `vfd_devices` | VERIFIED |
| Test VFD Connection  | `testVfdConnection`   | `vfd-device.resolver.ts` | (no DB write) | VERIFIED |
| Activate VFD         | `activateVfdDevice`   | `vfd-device.resolver.ts` | `vfd_devices` | VERIFIED |
| Deactivate VFD       | `deactivateVfdDevice` | `vfd-device.resolver.ts` | `vfd_devices` | VERIFIED |

### VFD Commands

| Frontend Form/Action | GraphQL Mutation    | Backend Resolver          | DB Table              | Status   |
| -------------------- | ------------------- | ------------------------- | --------------------- | -------- |
| Send VFD Command     | `sendVfdCommand`    | `vfd-command.resolver.ts` | (Modbus write, no DB) | VERIFIED |
| Start VFD            | `startVfd`          | `vfd-command.resolver.ts` | (Modbus write)        | VERIFIED |
| Stop VFD             | `stopVfd`           | `vfd-command.resolver.ts` | (Modbus write)        | VERIFIED |
| Set VFD Frequency    | `setVfdFrequency`   | `vfd-command.resolver.ts` | (Modbus write)        | VERIFIED |
| Set VFD Speed        | `setVfdSpeed`       | `vfd-command.resolver.ts` | (Modbus write)        | VERIFIED |
| Reset VFD Fault      | `resetVfdFault`     | `vfd-command.resolver.ts` | (Modbus write)        | VERIFIED |
| Emergency Stop VFD   | `emergencyStopVfd`  | `vfd-command.resolver.ts` | (Modbus write)        | VERIFIED |
| Read VFD Parameters  | `readVfdParameters` | `vfd-reading.resolver.ts` | `vfd_readings`        | VERIFIED |

### Edge Devices

| Frontend Form/Action           | GraphQL Mutation               | Backend Resolver          | DB Table                   | Status   |
| ------------------------------ | ------------------------------ | ------------------------- | -------------------------- | -------- |
| Register Edge Device           | `registerEdgeDevice`           | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Update Edge Device             | `updateEdgeDevice`             | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Approve Edge Device            | `approveEdgeDevice`            | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Set Maintenance Mode           | `setDeviceMaintenanceMode`     | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Decommission Device            | `decommissionEdgeDevice`       | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Ping Edge Device               | `pingEdgeDevice`               | `edge-device.resolver.ts` | (MQTT, no DB write)        | VERIFIED |
| Reboot Edge Device             | `rebootEdgeDevice`             | `edge-device.resolver.ts` | (MQTT, no DB write)        | VERIFIED |
| Create Provisioned Device      | `createProvisionedDevice`      | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Regenerate Device Token        | `regenerateDeviceToken`        | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Create Tenant Provisioning Key | `createTenantProvisioningKey`  | `edge-device.resolver.ts` | `tenant_provisioning_keys` | VERIFIED |
| Revoke Provisioning Key        | `revokeTenantProvisioningKey`  | `edge-device.resolver.ts` | `tenant_provisioning_keys` | VERIFIED |
| Update Firmware                | `updateEdgeDeviceFirmware`     | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Bulk Update Firmware           | `bulkUpdateEdgeDeviceFirmware` | `edge-device.resolver.ts` | `edge_devices`             | VERIFIED |
| Scan Hardware                  | `scanEdgeDeviceHardware`       | `edge-device.resolver.ts` | `device_events`            | VERIFIED |

### Edge Device I/O Config

| Frontend Form/Action      | GraphQL Mutation         | Backend Resolver          | DB Table            | Status   |
| ------------------------- | ------------------------ | ------------------------- | ------------------- | -------- |
| Add I/O Config            | `addDeviceIoConfig`      | `edge-device.resolver.ts` | `device_io_configs` | VERIFIED |
| Update I/O Config         | `updateDeviceIoConfig`   | `edge-device.resolver.ts` | `device_io_configs` | VERIFIED |
| Remove I/O Config         | `removeDeviceIoConfig`   | `edge-device.resolver.ts` | `device_io_configs` | VERIFIED |
| Bulk Add I/O Configs      | `bulkAddDeviceIoConfigs` | `edge-device.resolver.ts` | `device_io_configs` | VERIFIED |
| Push I/O Config to Device | `pushIoConfigToDevice`   | `edge-device.resolver.ts` | (MQTT push)         | VERIFIED |
| Set Digital Output        | `setDigitalOutput`       | `edge-device.resolver.ts` | (MQTT write)        | VERIFIED |

### LoRa Devices

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver          | DB Table         | Status   |
| -------------------- | ------------------ | ------------------------- | ---------------- | -------- |
| Add LoRa Device      | `addLoRaDevice`    | `edge-device.resolver.ts` | `lora_devices`   | VERIFIED |
| Remove LoRa Device   | `removeLoRaDevice` | `edge-device.resolver.ts` | `lora_devices`   | VERIFIED |
| Send LoRa Downlink   | `sendLoRaDownlink` | `edge-device.resolver.ts` | (LoRaWAN, no DB) | VERIFIED |

### Dashboard Layouts

| Frontend Form/Action    | GraphQL Mutation        | Backend Resolver        | DB Table            | Status   |
| ----------------------- | ----------------------- | ----------------------- | ------------------- | -------- |
| Save Dashboard Layout   | `saveDashboardLayout`   | `dashboard.resolver.ts` | `dashboard_layouts` | VERIFIED |
| Delete Dashboard Layout | `deleteDashboardLayout` | `dashboard.resolver.ts` | `dashboard_layouts` | VERIFIED |
| Set Layout as Default   | `setLayoutAsDefault`    | `dashboard.resolver.ts` | `dashboard_layouts` | VERIFIED |

### PLC Control

| Frontend Form/Action      | GraphQL Mutation          | Backend Resolver          | DB Table          | Status   |
| ------------------------- | ------------------------- | ------------------------- | ----------------- | -------- |
| Create PLC Connection     | `createPlcConnection`     | `plc-control.resolver.ts` | `plc_connections` | VERIFIED |
| Update PLC Connection     | `updatePlcConnection`     | `plc-control.resolver.ts` | `plc_connections` | VERIFIED |
| Delete PLC Connection     | `deletePlcConnection`     | `plc-control.resolver.ts` | `plc_connections` | VERIFIED |
| Test PLC Connection       | `testPlcConnection`       | `plc-control.resolver.ts` | (OPC-UA, no DB)   | VERIFIED |
| Activate PLC Connection   | `activatePlcConnection`   | `plc-control.resolver.ts` | `plc_connections` | VERIFIED |
| Deactivate PLC Connection | `deactivatePlcConnection` | `plc-control.resolver.ts` | `plc_connections` | VERIFIED |
| Call OPC-UA Method        | `callOpcUaMethod`         | `plc-control.resolver.ts` | (OPC-UA, no DB)   | VERIFIED |
| Write OPC-UA Node         | `writeOpcUaNode`          | `plc-control.resolver.ts` | (OPC-UA, no DB)   | VERIFIED |

### PLC Feeding Parameters

| Frontend Form/Action     | GraphQL Mutation            | Backend Resolver          | DB Table             | Status   |
| ------------------------ | --------------------------- | ------------------------- | -------------------- | -------- |
| Create Feeding Parameter | `createFeedingParameter`    | `plc-control.resolver.ts` | `feeding_parameters` | VERIFIED |
| Update Feeding Parameter | `updateFeedingParameter`    | `plc-control.resolver.ts` | `feeding_parameters` | VERIFIED |
| Delete Feeding Parameter | `deleteFeedingParameter`    | `plc-control.resolver.ts` | `feeding_parameters` | VERIFIED |
| Send Parameter to PLC    | `sendFeedingParameterToPlc` | `plc-control.resolver.ts` | (OPC-UA write)       | VERIFIED |
| Activate Parameter       | `activateFeedingParameter`  | `plc-control.resolver.ts` | `feeding_parameters` | VERIFIED |
| Clone Parameter          | `cloneFeedingParameter`     | `plc-control.resolver.ts` | `feeding_parameters` | VERIFIED |

### PLC Alarms

| Frontend Form/Action           | GraphQL Mutation                    | Backend Resolver          | DB Table     | Status   |
| ------------------------------ | ----------------------------------- | ------------------------- | ------------ | -------- |
| Acknowledge Alarm              | `acknowledgePlcAlarm`               | `plc-control.resolver.ts` | `plc_alarms` | VERIFIED |
| Bulk Acknowledge               | `bulkAcknowledgePlcAlarms`          | `plc-control.resolver.ts` | `plc_alarms` | VERIFIED |
| Acknowledge All for Connection | `acknowledgeAllAlarmsForConnection` | `plc-control.resolver.ts` | `plc_alarms` | VERIFIED |
| Add Alarm Notes                | `addAlarmNotes`                     | `plc-control.resolver.ts` | `plc_alarms` | VERIFIED |
| Approve Alarm                  | `approvePlcAlarm`                   | `plc-control.resolver.ts` | `plc_alarms` | VERIFIED |
| Escalate Alarm                 | `escalatePlcAlarm`                  | `plc-control.resolver.ts` | `plc_alarms` | VERIFIED |

### Processes (SCADA)

| Frontend Form/Action   | GraphQL Mutation           | Backend Resolver      | DB Table                         | Status   |
| ---------------------- | -------------------------- | --------------------- | -------------------------------- | -------- |
| Create Process         | `createProcess`            | `process.resolver.ts` | `processes`                      | VERIFIED |
| Update Process         | `updateProcess`            | `process.resolver.ts` | `processes`                      | VERIFIED |
| Delete Process         | `deleteProcess`            | `process.resolver.ts` | `processes`                      | VERIFIED |
| Duplicate Process      | `duplicateProcess`         | `process.resolver.ts` | `processes`                      | VERIFIED |
| Deploy Process to Edge | `deployProcessToEdge`      | `process.resolver.ts` | `processes`, `scada_deploy_logs` | VERIFIED |
| Create SCADA Package   | `createScadaPackage`       | `process.resolver.ts` | `scada_packages`                 | VERIFIED |
| Update SCADA Package   | `updateScadaPackage`       | `process.resolver.ts` | `scada_packages`                 | VERIFIED |
| Delete SCADA Package   | `deleteScadaPackage`       | `process.resolver.ts` | `scada_packages`                 | VERIFIED |
| Deploy SCADA to Edge   | `deployScadaPackageToEdge` | `process.resolver.ts` | `scada_deploy_logs`              | VERIFIED |

### Unified Tags

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver          | DB Table       | Status   |
| -------------------- | ------------------ | ------------------------- | -------------- | -------- |
| Create Unified Tag   | `createUnifiedTag` | `unified-tag.resolver.ts` | `unified_tags` | VERIFIED |
| Update Unified Tag   | `updateUnifiedTag` | `unified-tag.resolver.ts` | `unified_tags` | VERIFIED |
| Delete Unified Tag   | `deleteUnifiedTag` | `unified-tag.resolver.ts` | `unified_tags` | VERIFIED |
| Discover Tags        | `discoverTags`     | `unified-tag.resolver.ts` | `unified_tags` | VERIFIED |
| Auto Bind Tags       | `autoBindTags`     | `unified-tag.resolver.ts` | `unified_tags` | VERIFIED |

### Automation Programs

| Frontend Form/Action | GraphQL Mutation          | Backend Resolver         | DB Table                                 | Status   |
| -------------------- | ------------------------- | ------------------------ | ---------------------------------------- | -------- |
| Create Program       | `createAutomationProgram` | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Update Program       | `updateAutomationProgram` | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Delete Program       | `deleteAutomationProgram` | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Clone Program        | `cloneAutomationProgram`  | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Archive Program      | `archiveProgram`          | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Submit for Review    | `submitProgramForReview`  | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Approve Program      | `approveProgram`          | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Reject Program       | `rejectProgram`           | `automation.resolver.ts` | `automation_programs`                    | VERIFIED |
| Deploy Program       | `deployProgram`           | `automation.resolver.ts` | `automation_programs`, `deployment_logs` | VERIFIED |
| Add Step             | `addProgramStep`          | `automation.resolver.ts` | `program_steps`                          | VERIFIED |
| Remove Step          | `removeProgramStep`       | `automation.resolver.ts` | `program_steps`                          | VERIFIED |
| Add Variable         | `addProgramVariable`      | `automation.resolver.ts` | `program_variables`                      | VERIFIED |
| Remove Variable      | `removeProgramVariable`   | `automation.resolver.ts` | `program_variables`                      | VERIFIED |
| Sync Variables       | `syncProgramVariables`    | `automation.resolver.ts` | `program_variables`                      | VERIFIED |
| Add Transition       | `addProgramTransition`    | `automation.resolver.ts` | `program_transitions`                    | VERIFIED |
| Remove Transition    | `removeProgramTransition` | `automation.resolver.ts` | `program_transitions`                    | VERIFIED |
| Validate ST Code     | `validateST`              | `automation.resolver.ts` | (no DB write)                            | VERIFIED |

### Device Groups

| Frontend Form/Action      | GraphQL Mutation         | Backend Resolver           | DB Table               | Status   |
| ------------------------- | ------------------------ | -------------------------- | ---------------------- | -------- |
| Create Device Group       | `createDeviceGroup`      | `device-group.resolver.ts` | `device_groups`        | VERIFIED |
| Update Device Group       | `updateDeviceGroup`      | `device-group.resolver.ts` | `device_groups`        | VERIFIED |
| Delete Device Group       | `deleteDeviceGroup`      | `device-group.resolver.ts` | `device_groups`        | VERIFIED |
| Add Devices to Group      | `addDevicesToGroup`      | `device-group.resolver.ts` | `device_group_members` | VERIFIED |
| Remove Devices from Group | `removeDevicesFromGroup` | `device-group.resolver.ts` | `device_group_members` | VERIFIED |
| Batch Update Sensors      | `batchUpdateSensors`     | `device-group.resolver.ts` | `sensors`              | VERIFIED |
| Batch Activate Sensors    | `batchActivateSensors`   | `device-group.resolver.ts` | `sensors`              | VERIFIED |
| Batch Deactivate Sensors  | `batchDeactivateSensors` | `device-group.resolver.ts` | `sensors`              | VERIFIED |

---

## Alert Engine (`tenant_xxx` schema)

Frontend: `web/modules/sensor-module/` (alert rules & escalation) + `web/modules/dashboard/` (ack/resolve)
Backend: `apps/alert-engine/`
Schema: Per-tenant via `TenantSchemaMiddleware` -> `search_path`

### Alert Rules

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver    | DB Table        | Status   |
| -------------------- | ------------------ | ------------------- | --------------- | -------- |
| Create Alert Rule    | `createAlertRule`  | `alert.resolver.ts` | `alert_rules`   | VERIFIED |
| Update Alert Rule    | `updateAlertRule`  | `alert.resolver.ts` | `alert_rules`   | VERIFIED |
| Delete Alert Rule    | `deleteAlertRule`  | `alert.resolver.ts` | `alert_rules`   | VERIFIED |
| Acknowledge Alert    | `acknowledgeAlert` | `alert.resolver.ts` | `alert_history` | VERIFIED |
| Resolve Alert        | `resolveAlert`     | `alert.resolver.ts` | `alert_history` | VERIFIED |

### Escalation Policies

| Frontend Form/Action      | GraphQL Mutation          | Backend Resolver                | DB Table                     | Status   |
| ------------------------- | ------------------------- | ------------------------------- | ---------------------------- | -------- |
| Create Escalation Policy  | `createEscalationPolicy`  | `escalation-policy.resolver.ts` | `escalation_policies`        | VERIFIED |
| Update Escalation Policy  | `updateEscalationPolicy`  | `escalation-policy.resolver.ts` | `escalation_policies`        | VERIFIED |
| Delete Escalation Policy  | `deleteEscalationPolicy`  | `escalation-policy.resolver.ts` | `escalation_policies`        | VERIFIED |
| Add Suppression Window    | `addSuppressionWindow`    | `escalation-policy.resolver.ts` | `escalation_policies` (JSON) | VERIFIED |
| Remove Suppression Window | `removeSuppressionWindow` | `escalation-policy.resolver.ts` | `escalation_policies` (JSON) | VERIFIED |
| Update On-Call Schedule   | `updateOnCallSchedule`    | `escalation-policy.resolver.ts` | `escalation_policies` (JSON) | VERIFIED |
| Clone Policy              | `cloneEscalationPolicy`   | `escalation-policy.resolver.ts` | `escalation_policies`        | VERIFIED |

---

## HR Module (`tenant_xxx` schema)

Frontend: `web/modules/hr-module/`
Backend: `apps/hr-service/`
Schema: Per-tenant via `TenantSchemaMiddleware` -> `search_path`

### Employees

| Frontend Form/Action   | GraphQL Mutation             | Backend Resolver                  | DB Table    | Status   |
| ---------------------- | ---------------------------- | --------------------------------- | ----------- | -------- |
| Create Employee        | `createEmployee`             | `hr.resolver.ts` -> HRService     | `employees` | VERIFIED |
| Update Employee        | `updateEmployee`             | `hr.resolver.ts` -> HRService     | `employees` | VERIFIED |
| Update Employee Status | `updateEmployeeStatus`       | `hr.resolver.ts` (same as update) | `employees` | VERIFIED |
| Assign to Department   | `assignEmployeeToDepartment` | `hr.resolver.ts` (same as update) | `employees` | VERIFIED |
| Assign to Position     | `assignEmployeeToPosition`   | `hr.resolver.ts` (same as update) | `employees` | VERIFIED |
| Assign Manager         | `assignManager`              | `hr.resolver.ts` (same as update) | `employees` | VERIFIED |
| Update Avatar          | `updateEmployeeAvatar`       | `hr.resolver.ts` (same as update) | `employees` | VERIFIED |
| Toggle Farm Worker     | `toggleFarmWorker`           | `hr.resolver.ts`                  | `employees` | VERIFIED |
| Update Emergency Info  | `updateEmergencyInfo`        | `hr.resolver.ts` (same as update) | `employees` | VERIFIED |

### HR Departments

| Frontend Form/Action | GraphQL Mutation     | Backend Resolver | DB Table         | Status   |
| -------------------- | -------------------- | ---------------- | ---------------- | -------- |
| Create Department    | `createHRDepartment` | `hr.resolver.ts` | `departments_hr` | VERIFIED |
| Update Department    | `updateHRDepartment` | `hr.resolver.ts` | `departments_hr` | VERIFIED |

### Payroll

| Frontend Form/Action | GraphQL Mutation | Backend Resolver                   | DB Table   | Status   |
| -------------------- | ---------------- | ---------------------------------- | ---------- | -------- |
| Create Payroll       | `createPayroll`  | `hr.resolver.ts` -> PayrollService | `payrolls` | VERIFIED |
| Approve Payroll      | `approvePayroll` | `hr.resolver.ts` -> PayrollService | `payrolls` | VERIFIED |

### Leave Management

| Frontend Form/Action      | GraphQL Mutation          | Backend Resolver    | DB Table                           | Status   |
| ------------------------- | ------------------------- | ------------------- | ---------------------------------- | -------- |
| Create Leave Type         | `createLeaveType`         | `leave.resolver.ts` | `leave_types`                      | VERIFIED |
| Update Leave Type         | `updateLeaveType`         | `leave.resolver.ts` | `leave_types`                      | VERIFIED |
| Initialize Leave Balances | `initializeLeaveBalances` | `leave.resolver.ts` | `leave_balances`                   | VERIFIED |
| Adjust Leave Balance      | `adjustLeaveBalance`      | `leave.resolver.ts` | `leave_balances`                   | VERIFIED |
| Create Leave Request      | `createLeaveRequest`      | `leave.resolver.ts` | `leave_requests`                   | VERIFIED |
| Update Leave Request      | `updateLeaveRequest`      | `leave.resolver.ts` | `leave_requests`                   | VERIFIED |
| Submit Leave Request      | `submitLeaveRequest`      | `leave.resolver.ts` | `leave_requests`                   | VERIFIED |
| Approve Leave Request     | `approveLeaveRequest`     | `leave.resolver.ts` | `leave_requests`, `leave_balances` | VERIFIED |
| Reject Leave Request      | `rejectLeaveRequest`      | `leave.resolver.ts` | `leave_requests`                   | VERIFIED |
| Cancel Leave Request      | `cancelLeaveRequest`      | `leave.resolver.ts` | `leave_requests`                   | VERIFIED |
| Withdraw Leave Request    | `withdrawLeaveRequest`    | `leave.resolver.ts` | `leave_requests`                   | VERIFIED |
| Carry Over Balances       | `carryOverLeaveBalances`  | `leave.resolver.ts` | `leave_balances`                   | VERIFIED |

### Attendance & Shifts

| Frontend Form/Action     | GraphQL Mutation            | Backend Resolver         | DB Table             | Status   |
| ------------------------ | --------------------------- | ------------------------ | -------------------- | -------- |
| Create Shift             | `createShift`               | `attendance.resolver.ts` | `shifts`             | VERIFIED |
| Update Shift             | `updateShift`               | `attendance.resolver.ts` | `shifts`             | VERIFIED |
| Clock In                 | `clockIn`                   | `attendance.resolver.ts` | `attendance_records` | VERIFIED |
| Clock Out                | `clockOut`                  | `attendance.resolver.ts` | `attendance_records` | VERIFIED |
| Create Manual Attendance | `createManualAttendance`    | `attendance.resolver.ts` | `attendance_records` | VERIFIED |
| Approve Attendance       | `approveAttendance`         | `attendance.resolver.ts` | `attendance_records` | VERIFIED |
| Create Schedule          | `createSchedule`            | `attendance.resolver.ts` | `schedules`          | VERIFIED |
| Update Schedule          | `updateSchedule`            | `attendance.resolver.ts` | `schedules`          | VERIFIED |
| Create Schedule Entry    | `createScheduleEntry`       | `attendance.resolver.ts` | `schedule_entries`   | VERIFIED |
| Bulk Create Entries      | `bulkCreateScheduleEntries` | `attendance.resolver.ts` | `schedule_entries`   | VERIFIED |
| Delete Schedule Entry    | `deleteScheduleEntry`       | `attendance.resolver.ts` | `schedule_entries`   | VERIFIED |

### Weekly Scheduling

| Frontend Form/Action       | GraphQL Mutation           | Backend Resolver         | DB Table                              | Status   |
| -------------------------- | -------------------------- | ------------------------ | ------------------------------------- | -------- |
| Create Weekly Plan         | `createWeeklyPlan`         | `scheduling.resolver.ts` | `weekly_plans`                        | VERIFIED |
| Update Plan Entry          | `updatePlanEntry`          | `scheduling.resolver.ts` | `weekly_plan_entries`                 | VERIFIED |
| Bulk Assign Shifts         | `bulkAssignShifts`         | `scheduling.resolver.ts` | `weekly_plan_entries`                 | VERIFIED |
| Copy Weekly Plan           | `copyWeeklyPlan`           | `scheduling.resolver.ts` | `weekly_plans`, `weekly_plan_entries` | VERIFIED |
| Publish Weekly Plan        | `publishWeeklyPlan`        | `scheduling.resolver.ts` | `weekly_plans`                        | VERIFIED |
| Delete Weekly Plan         | `deleteWeeklyPlan`         | `scheduling.resolver.ts` | `weekly_plans`                        | VERIFIED |
| Update Scheduling Settings | `updateSchedulingSettings` | `scheduling.resolver.ts` | `scheduling_settings`                 | VERIFIED |

### Certifications & Training

| Frontend Form/Action       | GraphQL Mutation           | Backend Resolver       | DB Table                  | Status   |
| -------------------------- | -------------------------- | ---------------------- | ------------------------- | -------- |
| Create Certification Type  | `createCertificationType`  | `training.resolver.ts` | `certification_types`     | VERIFIED |
| Update Certification Type  | `updateCertificationType`  | `training.resolver.ts` | `certification_types`     | VERIFIED |
| Add Employee Certification | `addEmployeeCertification` | `training.resolver.ts` | `employee_certifications` | VERIFIED |
| Verify Certification       | `verifyCertification`      | `training.resolver.ts` | `employee_certifications` | VERIFIED |
| Revoke Certification       | `revokeCertification`      | `training.resolver.ts` | `employee_certifications` | VERIFIED |
| Renew Certification        | `renewCertification`       | `training.resolver.ts` | `employee_certifications` | VERIFIED |
| Create Training Course     | `createTrainingCourse`     | `training.resolver.ts` | `training_courses`        | VERIFIED |
| Update Training Course     | `updateTrainingCourse`     | `training.resolver.ts` | `training_courses`        | VERIFIED |
| Enroll in Training         | `enrollInTraining`         | `training.resolver.ts` | `training_enrollments`    | VERIFIED |
| Start Training             | `startTraining`            | `training.resolver.ts` | `training_enrollments`    | VERIFIED |
| Complete Training          | `completeTraining`         | `training.resolver.ts` | `training_enrollments`    | VERIFIED |
| Withdraw from Training     | `withdrawFromTraining`     | `training.resolver.ts` | `training_enrollments`    | VERIFIED |
| Bulk Enroll                | `bulkEnrollInTraining`     | `training.resolver.ts` | `training_enrollments`    | VERIFIED |

### Performance Management

| Frontend Form/Action      | GraphQL Mutation          | Backend Resolver          | DB Table              | Status   |
| ------------------------- | ------------------------- | ------------------------- | --------------------- | -------- |
| Create Performance Review | `createPerformanceReview` | `performance.resolver.ts` | `performance_reviews` | VERIFIED |
| Submit Self Assessment    | `submitSelfAssessment`    | `performance.resolver.ts` | `performance_reviews` | VERIFIED |
| Submit Manager Assessment | `submitManagerAssessment` | `performance.resolver.ts` | `performance_reviews` | VERIFIED |
| Finalize Review           | `finalizeReview`          | `performance.resolver.ts` | `performance_reviews` | VERIFIED |
| Acknowledge Review        | `acknowledgeReview`       | `performance.resolver.ts` | `performance_reviews` | VERIFIED |
| Reopen Review             | `reopenReview`            | `performance.resolver.ts` | `performance_reviews` | VERIFIED |
| Bulk Create Reviews       | `bulkCreateReviews`       | `performance.resolver.ts` | `performance_reviews` | VERIFIED |
| Create Goal               | `createGoal`              | `performance.resolver.ts` | `goals`               | VERIFIED |
| Update Goal               | `updateGoal`              | `performance.resolver.ts` | `goals`               | VERIFIED |
| Update Goal Progress      | `updateGoalProgress`      | `performance.resolver.ts` | `goals`               | VERIFIED |
| Complete Goal             | `completeGoal`            | `performance.resolver.ts` | `goals`               | VERIFIED |
| Cancel Goal               | `cancelGoal`              | `performance.resolver.ts` | `goals`               | VERIFIED |
| Defer Goal                | `deferGoal`               | `performance.resolver.ts` | `goals`               | VERIFIED |
| Add Key Result            | `addKeyResult`            | `performance.resolver.ts` | `goals` (JSON)        | VERIFIED |
| Update Key Result         | `updateKeyResult`         | `performance.resolver.ts` | `goals` (JSON)        | VERIFIED |
| Add Milestone             | `addMilestone`            | `performance.resolver.ts` | `goals` (JSON)        | VERIFIED |
| Complete Milestone        | `completeMilestone`       | `performance.resolver.ts` | `goals` (JSON)        | VERIFIED |

### Aquaculture-Specific HR

| Frontend Form/Action        | GraphQL Mutation                  | Backend Resolver          | DB Table                  | Status   |
| --------------------------- | --------------------------------- | ------------------------- | ------------------------- | -------- |
| Create Work Area            | `createWorkArea`                  | `aquaculture.resolver.ts` | `work_areas`              | VERIFIED |
| Update Work Area            | `updateWorkArea`                  | `aquaculture.resolver.ts` | `work_areas`              | VERIFIED |
| Deactivate Work Area        | `deactivateWorkArea`              | `aquaculture.resolver.ts` | `work_areas`              | VERIFIED |
| Create Work Rotation        | `createWorkRotation`              | `aquaculture.resolver.ts` | `work_rotations`          | VERIFIED |
| Update Work Rotation        | `updateWorkRotation`              | `aquaculture.resolver.ts` | `work_rotations`          | VERIFIED |
| Start Rotation              | `startRotation`                   | `aquaculture.resolver.ts` | `work_rotations`          | VERIFIED |
| End Rotation                | `endRotation`                     | `aquaculture.resolver.ts` | `work_rotations`          | VERIFIED |
| Cancel Rotation             | `cancelRotation`                  | `aquaculture.resolver.ts` | `work_rotations`          | VERIFIED |
| Approve Rotation            | `approveRotation`                 | `aquaculture.resolver.ts` | `work_rotations`          | VERIFIED |
| Bulk Create Rotations       | `bulkCreateRotations`             | `aquaculture.resolver.ts` | `work_rotations`          | VERIFIED |
| Create Safety Training      | `createSafetyTrainingRecord`      | `aquaculture.resolver.ts` | `safety_training_records` | VERIFIED |
| Confirm Training Attendance | `confirmSafetyTrainingAttendance` | `aquaculture.resolver.ts` | `safety_training_records` | VERIFIED |
| Bulk Create Safety Training | `bulkCreateSafetyTraining`        | `aquaculture.resolver.ts` | `safety_training_records` | VERIFIED |

---

## Hydroponics Module (`tenant_xxx` schema)

Frontend: `web/modules/hydroponics-module/`
Backend: `apps/hydroponics-service/`
Schema: Per-tenant via `TenantSchemaMiddleware` -> `search_path`

| Frontend Form/Action | GraphQL Mutation                 | Backend Resolver    | DB Table             | Status   |
| -------------------- | -------------------------------- | ------------------- | -------------------- | -------- |
| Create Configuration | `createHydroponicsConfiguration` | `setup.resolver.ts` | `hydroponics_config` | VERIFIED |
| Update Configuration | `updateHydroponicsConfiguration` | `setup.resolver.ts` | `hydroponics_config` | VERIFIED |
| Delete Configuration | `deleteHydroponicsConfiguration` | `setup.resolver.ts` | `hydroponics_config` | VERIFIED |

---

## Dashboard Module

Frontend: `web/modules/dashboard/`
Backend: Calls alert-engine mutations via federation

| Frontend Form/Action | GraphQL Mutation   | Backend Service | DB Table        | Schema     | Status   |
| -------------------- | ------------------ | --------------- | --------------- | ---------- | -------- |
| Acknowledge Alert    | `acknowledgeAlert` | alert-engine    | `alert_history` | tenant_xxx | VERIFIED |
| Resolve Alert        | `resolveAlert`     | alert-engine    | `alert_history` | tenant_xxx | VERIFIED |

---

## Tenant Admin Module (`auth` schema + `tenant_xxx` schema)

Frontend: `web/modules/tenant-admin/`
Backend: `apps/auth-service/`

### Tenant Settings (auth schema)

| Frontend Form/Action      | GraphQL Mutation                  | Backend Resolver                       | DB Table               | Schema | Status   |
| ------------------------- | --------------------------------- | -------------------------------------- | ---------------------- | ------ | -------- |
| Update Tenant Settings    | `updateTenantSettings`            | `tenant.resolver.ts`                   | `tenants`              | auth   | VERIFIED |
| Update Notification Prefs | `updateMyNotificationPreferences` | `notification-preferences.resolver.ts` | `users` (JSON column)  | auth   | VERIFIED |
| Update Mobile Settings    | `updateMobileUserSettings`        | `mobile-settings.resolver.ts`          | `mobile_user_settings` | auth   | VERIFIED |

### User Management (auth schema + tenant_xxx)

| Frontend Form/Action   | GraphQL Mutation       | Backend Resolver           | DB Table | Schema | Status   |
| ---------------------- | ---------------------- | -------------------------- | -------- | ------ | -------- |
| Create Tenant User     | `createTenantUser`     | `tenant-role.resolver.ts`  | `users`  | auth   | VERIFIED |
| Update Tenant User     | `updateTenantUser`     | `tenant-role.resolver.ts`  | `users`  | auth   | VERIFIED |
| Delete Tenant User     | `deleteTenantUser`     | `tenant-role.resolver.ts`  | `users`  | auth   | VERIFIED |
| Deactivate Tenant User | `deactivateTenantUser` | `tenant-admin.resolver.ts` | `users`  | auth   | VERIFIED |

### Tenant Roles (tenant_xxx schema - raw SQL)

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver                               | DB Table       | Schema     | Status   |
| -------------------- | ------------------ | ---------------------------------------------- | -------------- | ---------- | -------- |
| Create Tenant Role   | `createTenantRole` | `tenant-role.resolver.ts` -> TenantRoleService | `tenant_roles` | tenant_xxx | VERIFIED |
| Update Tenant Role   | `updateTenantRole` | `tenant-role.resolver.ts` -> TenantRoleService | `tenant_roles` | tenant_xxx | VERIFIED |
| Delete Tenant Role   | `deleteTenantRole` | `tenant-role.resolver.ts` -> TenantRoleService | `tenant_roles` | tenant_xxx | VERIFIED |
| Seed Tenant Roles    | `seedTenantRoles`  | `tenant-role.resolver.ts` -> TenantRoleService | `tenant_roles` | tenant_xxx | VERIFIED |

### Module Managers (auth schema)

| Frontend Form/Action  | GraphQL Mutation      | Backend Resolver           | DB Table                  | Schema | Status   |
| --------------------- | --------------------- | -------------------------- | ------------------------- | ------ | -------- |
| Assign Module Manager | `assignModuleManager` | `tenant-admin.resolver.ts` | `user_module_assignments` | auth   | VERIFIED |
| Remove Module Manager | `removeModuleManager` | `tenant-admin.resolver.ts` | `user_module_assignments` | auth   | VERIFIED |

### Edge Devices (from Tenant Admin)

| Frontend Form/Action    | GraphQL Mutation              | Backend Service | DB Table                   | Schema     | Status   |
| ----------------------- | ----------------------------- | --------------- | -------------------------- | ---------- | -------- |
| Approve Edge Device     | `approveEdgeDevice`           | sensor-service  | `edge_devices`             | tenant_xxx | VERIFIED |
| Ping Edge Device        | `pingEdgeDevice`              | sensor-service  | (no DB write)              | tenant_xxx | VERIFIED |
| Reboot Edge Device      | `rebootEdgeDevice`            | sensor-service  | (no DB write)              | tenant_xxx | VERIFIED |
| Set Maintenance Mode    | `setDeviceMaintenanceMode`    | sensor-service  | `edge_devices`             | tenant_xxx | VERIFIED |
| Decommission Device     | `decommissionEdgeDevice`      | sensor-service  | `edge_devices`             | tenant_xxx | VERIFIED |
| Create Provisioning Key | `createTenantProvisioningKey` | sensor-service  | `tenant_provisioning_keys` | tenant_xxx | VERIFIED |
| Revoke Provisioning Key | `revokeTenantProvisioningKey` | sensor-service  | `tenant_provisioning_keys` | tenant_xxx | VERIFIED |

---

## Admin Panel (`admin` schema) - REST API

Frontend: `web/modules/admin-panel/`
Backend: `apps/admin-api-service/`
Schema: `admin` (default DATABASE_SCHEMA)

### Tenant Management

| Frontend Form/Action | REST Endpoint                       | Controller             | DB Table                                      | Schema               | Status   |
| -------------------- | ----------------------------------- | ---------------------- | --------------------------------------------- | -------------------- | -------- |
| Create Tenant        | `POST /tenants`                     | `tenant.controller.ts` | `tenants` (auth), `tenant_activities` (admin) | auth + admin         | VERIFIED |
| Update Tenant        | `PUT /tenants/:id`                  | `tenant.controller.ts` | `tenants` (auth)                              | auth                 | VERIFIED |
| Suspend Tenant       | `PATCH /tenants/:id/suspend`        | `tenant.controller.ts` | `tenants` (auth)                              | auth                 | VERIFIED |
| Activate Tenant      | `PATCH /tenants/:id/activate`       | `tenant.controller.ts` | `tenants` (auth)                              | auth                 | VERIFIED |
| Deactivate Tenant    | `PATCH /tenants/:id/deactivate`     | `tenant.controller.ts` | `tenants` (auth)                              | auth                 | VERIFIED |
| Provision Tenant     | `POST /tenants/:id/provision`       | `tenant.controller.ts` | DB schema creation                            | (creates tenant_xxx) | VERIFIED |
| Delete Tenant        | `DELETE /tenants/:id`               | `tenant.controller.ts` | `tenants` (auth)                              | auth                 | VERIFIED |
| Bulk Suspend         | `POST /tenants/bulk/suspend`        | `tenant.controller.ts` | `tenants` (auth)                              | auth                 | VERIFIED |
| Bulk Activate        | `POST /tenants/bulk/activate`       | `tenant.controller.ts` | `tenants` (auth)                              | auth                 | VERIFIED |
| Create Tenant Note   | `POST /tenants/:id/notes`           | `tenant.controller.ts` | `tenant_notes`                                | admin                | VERIFIED |
| Update Tenant Note   | `PATCH /tenants/:id/notes/:noteId`  | `tenant.controller.ts` | `tenant_notes`                                | admin                | VERIFIED |
| Delete Tenant Note   | `DELETE /tenants/:id/notes/:noteId` | `tenant.controller.ts` | `tenant_notes`                                | admin                | VERIFIED |

### User Management (Super Admin)

| Frontend Form/Action | REST Endpoint                     | Controller            | DB Table                  | Schema | Status   |
| -------------------- | --------------------------------- | --------------------- | ------------------------- | ------ | -------- |
| Create User          | `POST /users`                     | `users.controller.ts` | `users`                   | auth   | VERIFIED |
| Update User          | `PUT /users/:id`                  | `users.controller.ts` | `users`                   | auth   | VERIFIED |
| Delete User          | `DELETE /users/:id`               | `users.controller.ts` | `users`                   | auth   | VERIFIED |
| Activate User        | `PATCH /users/:id/activate`       | `users.controller.ts` | `users`                   | auth   | VERIFIED |
| Deactivate User      | `PATCH /users/:id/deactivate`     | `users.controller.ts` | `users`                   | auth   | VERIFIED |
| Reset Password       | `PATCH /users/:id/reset-password` | `users.controller.ts` | `users`                   | auth   | VERIFIED |
| Force Logout         | `PATCH /users/:id/force-logout`   | `users.controller.ts` | `users`, `refresh_tokens` | auth   | VERIFIED |
| Invite User          | `POST /users/invite`              | `users.controller.ts` | `invitations`, `users`    | auth   | VERIFIED |
| Tenant Invite        | `POST /users/tenant/invite`       | `users.controller.ts` | `invitations`, `users`    | auth   | VERIFIED |
| Update Permissions   | `PUT /users/:id/permissions`      | `users.controller.ts` | `user_permissions`        | public | VERIFIED |

### Billing & Plans

| Frontend Form/Action  | REST Endpoint                                         | Controller              | DB Table                  | Schema  | Status   |
| --------------------- | ----------------------------------------------------- | ----------------------- | ------------------------- | ------- | -------- |
| Create Plan           | `POST /billing/plans`                                 | `billing.controller.ts` | `plan_definitions`        | admin   | VERIFIED |
| Update Plan           | `PUT /billing/plans/:id`                              | `billing.controller.ts` | `plan_definitions`        | admin   | VERIFIED |
| Deprecate Plan        | `POST /billing/plans/:id/deprecate`                   | `billing.controller.ts` | `plan_definitions`        | admin   | VERIFIED |
| Seed Plans            | `POST /billing/plans/seed`                            | `billing.controller.ts` | `plan_definitions`        | admin   | VERIFIED |
| Create Discount Code  | `POST /billing/discounts`                             | `billing.controller.ts` | `discount_codes`          | admin   | VERIFIED |
| Update Discount Code  | `PUT /billing/discounts/:id`                          | `billing.controller.ts` | `discount_codes`          | admin   | VERIFIED |
| Deactivate Discount   | `POST /billing/discounts/:id/deactivate`              | `billing.controller.ts` | `discount_codes`          | admin   | VERIFIED |
| Bulk Create Discounts | `POST /billing/discounts/bulk-create`                 | `billing.controller.ts` | `discount_codes`          | admin   | VERIFIED |
| Create Subscription   | `POST /billing/subscriptions`                         | `billing.controller.ts` | `subscriptions` (billing) | billing | VERIFIED |
| Change Plan           | `POST /billing/subscriptions/change-plan`             | `billing.controller.ts` | `subscriptions` (billing) | billing | VERIFIED |
| Cancel Subscription   | `POST /billing/subscriptions/tenant/:id/cancel`       | `billing.controller.ts` | `subscriptions` (billing) | billing | VERIFIED |
| Reactivate Sub        | `POST /billing/subscriptions/tenant/:id/reactivate`   | `billing.controller.ts` | `subscriptions` (billing) | billing | VERIFIED |
| Extend Trial          | `POST /billing/subscriptions/tenant/:id/extend-trial` | `billing.controller.ts` | `subscriptions` (billing) | billing | VERIFIED |
| Record Payment        | `POST /billing/payments`                              | `billing.controller.ts` | `payments` (billing)      | billing | VERIFIED |
| Refund Payment        | `POST /billing/payments/refund`                       | `billing.controller.ts` | `payments` (billing)      | billing | VERIFIED |
| Mark Invoice Paid     | `POST /billing/invoices/:id/mark-paid`                | `billing.controller.ts` | `invoices` (billing)      | billing | VERIFIED |
| Void Invoice          | `POST /billing/invoices/:id/void`                     | `billing.controller.ts` | `invoices` (billing)      | billing | VERIFIED |
| Set Module Pricing    | `POST /billing/module-pricing`                        | `billing.controller.ts` | `module_pricing`          | admin   | VERIFIED |
| Update Module Pricing | `PUT /billing/module-pricing/:id`                     | `billing.controller.ts` | `module_pricing`          | admin   | VERIFIED |
| Create Custom Plan    | `POST /billing/custom-plans`                          | `billing.controller.ts` | `custom_plans`            | admin   | VERIFIED |
| Update Custom Plan    | `PUT /billing/custom-plans/:id`                       | `billing.controller.ts` | `custom_plans`            | admin   | VERIFIED |
| Delete Custom Plan    | `DELETE /billing/custom-plans/:id`                    | `billing.controller.ts` | `custom_plans`            | admin   | VERIFIED |

### System Settings

| Frontend Form/Action      | REST Endpoint                          | Controller                     | DB Table            | Schema | Status   |
| ------------------------- | -------------------------------------- | ------------------------------ | ------------------- | ------ | -------- |
| Update Setting            | `PUT /settings/key/:key`               | `settings.controller.ts`       | `system_settings`   | admin  | VERIFIED |
| Bulk Update Settings      | `PUT /settings/bulk`                   | `settings.controller.ts`       | `system_settings`   | admin  | VERIFIED |
| Update Email Config       | `PUT /settings/config/email`           | `settings.controller.ts`       | `system_settings`   | admin  | VERIFIED |
| Update Security Config    | `PUT /settings/config/security`        | `settings.controller.ts`       | `system_settings`   | admin  | VERIFIED |
| Update Rate Limits        | `PUT /settings/config/rate-limits`     | `settings.controller.ts`       | `system_settings`   | admin  | VERIFIED |
| Update Billing Config     | `PUT /settings/config/billing`         | `settings.controller.ts`       | `system_settings`   | admin  | VERIFIED |
| Create Email Template     | `POST /settings/email-templates`       | `email-template.controller.ts` | `email_templates`   | admin  | VERIFIED |
| Update Email Template     | `PUT /settings/email-templates/:id`    | `email-template.controller.ts` | `email_templates`   | admin  | VERIFIED |
| Delete Email Template     | `DELETE /settings/email-templates/:id` | `email-template.controller.ts` | `email_templates`   | admin  | VERIFIED |
| Create IP Access Rule     | `POST /settings/ip-access`             | `ip-access.controller.ts`      | `ip_access_rules`   | admin  | VERIFIED |
| Update IP Access Rule     | `PUT /settings/ip-access/:id`          | `ip-access.controller.ts`      | `ip_access_rules`   | admin  | VERIFIED |
| Delete IP Access Rule     | `DELETE /settings/ip-access/:id`       | `ip-access.controller.ts`      | `ip_access_rules`   | admin  | VERIFIED |
| Create Feature Toggle     | (settings API)                         | `settings.controller.ts`       | `feature_toggles`   | admin  | VERIFIED |
| Update Feature Toggle     | (settings API)                         | `settings.controller.ts`       | `feature_toggles`   | admin  | VERIFIED |
| Delete Feature Toggle     | (settings API)                         | `settings.controller.ts`       | `feature_toggles`   | admin  | VERIFIED |
| Create Maintenance Window | (settings API)                         | `settings.controller.ts`       | `maintenance_modes` | admin  | VERIFIED |

### Tenant Configuration

| Frontend Form/Action | REST Endpoint                            | Controller                           | DB Table                       | Schema | Status   |
| -------------------- | ---------------------------------------- | ------------------------------------ | ------------------------------ | ------ | -------- |
| Create Tenant Config | `POST /tenant-config`                    | `tenant-configuration.controller.ts` | `tenant_configurations`        | admin  | VERIFIED |
| Update Tenant Config | `PUT /tenant-config/:tenantId`           | `tenant-configuration.controller.ts` | `tenant_configurations`        | admin  | VERIFIED |
| Delete Tenant Config | `DELETE /tenant-config/:tenantId`        | `tenant-configuration.controller.ts` | `tenant_configurations`        | admin  | VERIFIED |
| Create API Key       | `POST /tenant-config/:tenantId/api-keys` | `tenant-configuration.controller.ts` | `tenant_configurations` (JSON) | admin  | VERIFIED |
| Create Webhook       | `POST /tenant-config/:tenantId/webhooks` | `tenant-configuration.controller.ts` | `tenant_configurations` (JSON) | admin  | VERIFIED |

### Support & Communications

| Frontend Form/Action  | REST Endpoint                        | Controller                   | DB Table          | Schema | Status   |
| --------------------- | ------------------------------------ | ---------------------------- | ----------------- | ------ | -------- |
| Create Support Ticket | `POST /support/tickets`              | `ticket.controller.ts`       | `support_tickets` | admin  | VERIFIED |
| Update Ticket         | `PUT /support/tickets/:id`           | `ticket.controller.ts`       | `support_tickets` | admin  | VERIFIED |
| Add Ticket Reply      | `POST /support/tickets/:id/replies`  | `ticket.controller.ts`       | `ticket_comments` | admin  | VERIFIED |
| Update Ticket Status  | `POST /support/tickets/:id/status`   | `ticket.controller.ts`       | `support_tickets` | admin  | VERIFIED |
| Create Message Thread | `POST /support/threads`              | `messaging.controller.ts`    | `message_threads` | admin  | VERIFIED |
| Send Message          | `POST /support/threads/:id/messages` | `messaging.controller.ts`    | `messages`        | admin  | VERIFIED |
| Create Announcement   | `POST /support/announcements`        | `announcement.controller.ts` | `announcements`   | admin  | VERIFIED |
| Update Announcement   | `PUT /support/announcements/:id`     | `announcement.controller.ts` | `announcements`   | admin  | VERIFIED |
| Delete Announcement   | `DELETE /support/announcements/:id`  | `announcement.controller.ts` | `announcements`   | admin  | VERIFIED |

### Impersonation & Debug

| Frontend Form/Action        | REST Endpoint                          | Controller                    | DB Table                    | Schema | Status   |
| --------------------------- | -------------------------------------- | ----------------------------- | --------------------------- | ------ | -------- |
| Grant Impersonation         | `POST /impersonation/permissions`      | `impersonation.controller.ts` | `impersonation_permissions` | admin  | VERIFIED |
| Start Impersonation Session | `POST /impersonation/sessions/start`   | `impersonation.controller.ts` | `impersonation_sessions`    | admin  | VERIFIED |
| End Impersonation Session   | `POST /impersonation/sessions/:id/end` | `impersonation.controller.ts` | `impersonation_sessions`    | admin  | VERIFIED |
| Start Debug Session         | `POST /debug/sessions`                 | `debug-tools.controller.ts`   | `debug_sessions`            | admin  | VERIFIED |

---

## Auth Service (Shared - `auth` schema) - GraphQL

Backend: `apps/auth-service/`
Schema: `auth` (DATABASE_SCHEMA default)

### Authentication

| Frontend Form/Action | GraphQL Mutation   | Backend Resolver   | DB Table                  | Status   |
| -------------------- | ------------------ | ------------------ | ------------------------- | -------- |
| Login                | `login`            | `auth.resolver.ts` | `users`, `refresh_tokens` | VERIFIED |
| Register             | `register`         | `auth.resolver.ts` | `users`                   | VERIFIED |
| Social Login         | `socialLogin`      | `auth.resolver.ts` | `users`                   | VERIFIED |
| Accept Invitation    | `acceptInvitation` | `auth.resolver.ts` | `users`, `invitations`    | VERIFIED |
| Forgot Password      | `forgotPassword`   | `auth.resolver.ts` | `users`                   | VERIFIED |
| Reset Password       | `resetPassword`    | `auth.resolver.ts` | `users`                   | VERIFIED |
| Logout               | `logout`           | `auth.resolver.ts` | `refresh_tokens`          | VERIFIED |

### MFA

| Frontend Form/Action      | GraphQL Mutation             | Backend Resolver  | DB Table                  | Status   |
| ------------------------- | ---------------------------- | ----------------- | ------------------------- | -------- |
| Setup MFA                 | `setupMfa`                   | `mfa.resolver.ts` | `users`                   | VERIFIED |
| Verify MFA Setup          | `verifyMfaSetup`             | `mfa.resolver.ts` | `users`                   | VERIFIED |
| Disable MFA               | `disableMfa`                 | `mfa.resolver.ts` | `users`                   | VERIFIED |
| Regenerate Recovery Codes | `regenerateMfaRecoveryCodes` | `mfa.resolver.ts` | `users`                   | VERIFIED |
| Verify MFA Login          | `verifyMfa`                  | `mfa.resolver.ts` | `users`, `refresh_tokens` | VERIFIED |

### WebAuthn

| Frontend Form/Action         | GraphQL Mutation                | Backend Resolver       | DB Table               | Status   |
| ---------------------------- | ------------------------------- | ---------------------- | ---------------------- | -------- |
| Start Registration Challenge | `webauthnRegistrationChallenge` | `webauthn.resolver.ts` | (no DB write)          | VERIFIED |
| Register Credential          | `webauthnRegister`              | `webauthn.resolver.ts` | `webauthn_credentials` | VERIFIED |
| Remove Credential            | `webauthnRemove`                | `webauthn.resolver.ts` | `webauthn_credentials` | VERIFIED |
| Login Challenge              | `webauthnLoginChallenge`        | `webauthn.resolver.ts` | (no DB write)          | VERIFIED |
| WebAuthn Login               | `webauthnLogin`                 | `webauthn.resolver.ts` | `refresh_tokens`       | VERIFIED |

### Support (Tenant-facing via auth-service)

| Frontend Form/Action  | GraphQL Mutation      | Backend Resolver      | DB Table          | Status   |
| --------------------- | --------------------- | --------------------- | ----------------- | -------- |
| Create Support Ticket | `createSupportTicket` | `support.resolver.ts` | `support_tickets` | VERIFIED |
| Add Ticket Comment    | `addTicketComment`    | `support.resolver.ts` | `ticket_comments` | VERIFIED |
| Update Ticket Status  | `updateTicketStatus`  | `support.resolver.ts` | `support_tickets` | VERIFIED |
| Assign Ticket         | `assignTicket`        | `support.resolver.ts` | `support_tickets` | VERIFIED |
| Escalate Ticket       | `escalateTicket`      | `support.resolver.ts` | `support_tickets` | VERIFIED |

### Messaging (Tenant-facing via auth-service)

| Frontend Form/Action | GraphQL Mutation | Backend Resolver        | DB Table          | Status   |
| -------------------- | ---------------- | ----------------------- | ----------------- | -------- |
| Create Thread        | `createThread`   | `messaging.resolver.ts` | `message_threads` | VERIFIED |
| Send Message         | `sendMessage`    | `messaging.resolver.ts` | `messages`        | VERIFIED |
| Close Thread         | `closeThread`    | `messaging.resolver.ts` | `message_threads` | VERIFIED |
| Reopen Thread        | `reopenThread`   | `messaging.resolver.ts` | `message_threads` | VERIFIED |
| Archive Thread       | `archiveThread`  | `messaging.resolver.ts` | `message_threads` | VERIFIED |

### Announcements

| Frontend Form/Action | GraphQL Mutation          | Backend Resolver           | DB Table                       | Status   |
| -------------------- | ------------------------- | -------------------------- | ------------------------------ | -------- |
| Create Announcement  | `createAnnouncement`      | `announcement.resolver.ts` | `announcements`                | VERIFIED |
| Update Announcement  | `updateAnnouncement`      | `announcement.resolver.ts` | `announcements`                | VERIFIED |
| Publish Announcement | `publishAnnouncement`     | `announcement.resolver.ts` | `announcements`                | VERIFIED |
| Cancel Announcement  | `cancelAnnouncement`      | `announcement.resolver.ts` | `announcements`                | VERIFIED |
| Delete Announcement  | `deleteAnnouncement`      | `announcement.resolver.ts` | `announcements`                | VERIFIED |
| Acknowledge          | `acknowledgeAnnouncement` | `announcement.resolver.ts` | `announcement_acknowledgments` | VERIFIED |

### Tenant Management (via auth-service GraphQL)

| Frontend Form/Action   | GraphQL Mutation       | Backend Resolver     | DB Table         | Status   |
| ---------------------- | ---------------------- | -------------------- | ---------------- | -------- |
| Create Tenant          | `createTenant`         | `tenant.resolver.ts` | `tenants`        | VERIFIED |
| Update Tenant          | `updateTenant`         | `tenant.resolver.ts` | `tenants`        | VERIFIED |
| Suspend Tenant         | `suspendTenant`        | `tenant.resolver.ts` | `tenants`        | VERIFIED |
| Activate Tenant        | `activateTenant`       | `tenant.resolver.ts` | `tenants`        | VERIFIED |
| Deactivate Tenant      | `deactivateTenant`     | `tenant.resolver.ts` | `tenants`        | VERIFIED |
| Enable Module          | `enableModule`         | `tenant.resolver.ts` | `tenant_modules` | VERIFIED |
| Disable Module         | `disableModule`        | `tenant.resolver.ts` | `tenant_modules` | VERIFIED |
| Update Tenant Branding | `updateTenantBranding` | `tenant.resolver.ts` | `tenants`        | VERIFIED |

### GDPR / Consent

| Frontend Form/Action | GraphQL Mutation    | Backend Resolver           | DB Table              | Status |
| -------------------- | ------------------- | -------------------------- | --------------------- | ------ |
| Record Consent       | `recordConsent`     | `user-consent.resolver.ts` | `users` (JSON column) | LIKELY |
| Bulk Record Consent  | `bulkRecordConsent` | `user-consent.resolver.ts` | `users` (JSON column) | LIKELY |
| Withdraw Consent     | `withdrawConsent`   | `user-consent.resolver.ts` | `users` (JSON column) | LIKELY |

---

## Billing Service (`billing` schema) - GraphQL

Backend: `apps/billing-service/`
Schema: `billing` (DATABASE_SCHEMA default)

| Frontend Form/Action | GraphQL Mutation     | Backend Resolver      | DB Table        | Status   |
| -------------------- | -------------------- | --------------------- | --------------- | -------- |
| Create Subscription  | `createSubscription` | `billing.resolver.ts` | `subscriptions` | VERIFIED |
| Update Subscription  | `updateSubscription` | `billing.resolver.ts` | `subscriptions` | VERIFIED |
| Create Invoice       | `createInvoice`      | `billing.resolver.ts` | `invoices`      | VERIFIED |
| Finalize Invoice     | `finalizeInvoice`    | `billing.resolver.ts` | `invoices`      | VERIFIED |
| Void Invoice         | `voidInvoice`        | `billing.resolver.ts` | `invoices`      | VERIFIED |
| Record Payment       | `recordPayment`      | `billing.resolver.ts` | `payments`      | VERIFIED |
| Refund Payment       | `refundPayment`      | `billing.resolver.ts` | `payments`      | VERIFIED |
| Create Plan          | `createPlan`         | `billing.resolver.ts` | `plans`         | VERIFIED |
| Update Plan          | `updatePlan`         | `billing.resolver.ts` | `plans`         | VERIFIED |
| Archive Plan         | `archivePlan`        | `billing.resolver.ts` | `plans`         | VERIFIED |
| Apply Discount       | `applyDiscount`      | `billing.resolver.ts` | `subscriptions` | VERIFIED |

---

## Schema Summary

### `auth` schema (auth-service)

`users`, `tenants`, `tenant_modules`, `invitations`, `refresh_tokens`, `webauthn_credentials`, `user_module_assignments`, `mobile_user_settings`, `audit_logs`, `modules`, `support_tickets`, `ticket_comments`, `message_threads`, `messages`, `announcements`, `announcement_acknowledgments`

### `admin` schema (admin-api-service)

`system_settings`, `email_templates`, `ip_access_rules`, `tenant_configurations`, `plan_definitions`, `plan_module_assignments`, `custom_plans`, `discount_codes`, `discount_redemptions`, `module_pricing`, `tenant_activities`, `tenant_notes`, `tenant_billing_info`, `support_tickets`, `ticket_comments`, `message_threads`, `messages`, `announcements`, `announcement_acknowledgments`, `onboarding_progress`, `impersonation_sessions`, `impersonation_permissions`, `debug_sessions`, `captured_queries`, `captured_api_calls`, `cache_entries_snapshot`, `feature_flag_overrides`, `background_jobs`, `job_execution_logs`, `job_queues`, `performance_metrics`, `performance_snapshots`, `error_occurrences`, `error_groups`, `error_alert_rules`, `maintenance_modes`, `feature_toggles`, `system_versions`, `global_configs`, `activity_logs`, `security_events`, `security_incidents`, `threat_intelligence`, `data_requests`, `compliance_reports`, `retention_policies`, `login_attempts`, `api_usage_logs`, `user_sessions`, `analytics_snapshots`, `report_definitions`, `report_executions`, `tenant_schemas`, `schema_migrations`, `schema_backups`, `schema_restores`, `database_metrics`, `slow_query_logs`, `audit_logs`, `user_permissions`

### `billing` schema (billing-service)

`subscriptions`, `subscription_module_items`, `plans`, `invoices`, `payments`, `tenant_usage_metrics`, `usage_aggregations`, `usage_hourly_data`

### `tenant_xxx` schema (per-tenant, schema-isolated)

**farm-service tables**: `sites`, `tanks`, `systems`, `sub_systems`, `batches_v2`, `batches` (legacy), `farms`, `ponds`, `tank_batches`, `tank_operations`, `tank_allocations`, `batch_locations`, `batch_documents`, `batch_feed_assignments`, `mortality_records`, `species`, `feeds`, `feed_types`, `feed_type_species`, `feed_sites`, `feeding_protocols`, `feeding_records`, `feed_inventory`, `feeding_tables`, `feeding_programs`, `feeding_program_tanks`, `daily_feeding_executions`, `growth_measurements`, `harvest_plans`, `harvest_records`, `water_quality_measurements`, `health_events`, `equipment`, `equipment_types`, `equipment_systems`, `sub_equipment`, `sub_equipment_types`, `feeder_calibrations`, `farm_workers`, `tasks`, `auto_rules`, `recurring_templates`, `departments`, `suppliers`, `supplier_types`, `supplier_sites`, `chemicals`, `chemical_types`, `chemical_sites`, `consumables`, `storage_locations`, `storage_inventory`, `stock_movements`, `purchase_orders`, `purchase_order_items`, `work_orders`, `maintenance_schedules`, `spare_parts`, `weather_observations`, `weather_settings`, `marine_observations`, `regulatory_settings`, `sentinel_hub_settings`, `code_sequences`, `farm_audit_logs`

**sensor-service tables**: `sensors`, `sensor_protocols`, `sensor_data_channels`, `sensor_readings`, `sensor_metrics`, `sensor_type_definitions`, `channel_detection_log`, `industry_templates`, `vfd_devices`, `vfd_readings`, `vfd_register_mappings`, `edge_devices`, `device_events`, `device_io_configs`, `tenant_provisioning_keys`, `lora_devices`, `dashboard_layouts`, `plc_connections`, `plc_alarms`, `plc_telemetry`, `feeding_parameters`, `processes`, `scada_packages`, `scada_deploy_logs`, `unified_tags`, `automation_programs`, `program_steps`, `program_transitions`, `step_actions`, `deployment_logs`, `program_variables`, `device_groups`, `device_group_members`, `sensor_audit_logs`

**alert-engine tables**: `alert_rules`, `alert_history`, `alert_incidents`, `escalation_policies`, `alert_audit_log`

**hr-service tables**: `employees`, `departments_hr`, `payrolls`, `leave_types`, `leave_requests`, `leave_balances`, `shifts`, `attendance_records`, `schedules`, `schedule_entries`, `weekly_plans`, `weekly_plan_entries`, `scheduling_settings`, `holidays`, `certification_types`, `employee_certifications`, `training_courses`, `training_enrollments`, `performance_reviews`, `goals`, `employee_kpis`, `work_areas`, `work_rotations`, `safety_training_records`

**hydroponics-service tables**: `hydroponics_config`

**auth-service tables (in tenant_xxx via raw SQL)**: `tenant_roles`, `user_role_assignments`, `tenant_role_permissions`
