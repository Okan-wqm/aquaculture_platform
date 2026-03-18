# MODULE_SCHEMAS Registry Reference

## What is MODULE_SCHEMAS?

`MODULE_SCHEMAS` is the central registry defined in `libs/backend-common/src/database/schema-manager.service.ts` that controls tenant schema provisioning.

- **Defines which tables belong to each module.** Each entry maps a `moduleName` to its `sourceSchema`, its `tables` array, and an optional `referenceDataTables` array.
- **Used by `SchemaManagerService.createTenantSchema()`** to create tenant-specific tables. The method iterates over `MODULE_SCHEMAS`, finds each requested module by name, and uses `CREATE TABLE ... (LIKE source INCLUDING ALL)` to clone every listed table from the source schema into the new tenant schema.
- **If a table is NOT in MODULE_SCHEMAS, it will NOT be created in tenant schemas.** The table will only exist in the shared source schema.
- **Missing table = tenant data goes to shared source schema = ISOLATION VIOLATION.** Because `search_path` falls back to the source schema, queries will silently read/write shared data instead of tenant-isolated data.
- **Reference data tables** listed in `referenceDataTables` are copied (data included) into every new tenant schema during provisioning. These are typically lookup/seed tables (e.g., `feed_types`, `sensor_protocols`).

### How createTenantSchema() Works

```
createTenantSchema(tenantId, modules = DEFAULT_TENANT_MODULES)
```

Where `DEFAULT_TENANT_MODULES` is derived from `MODULE_SCHEMAS.map(m => m.moduleName)`, currently resolving to `['sensor', 'farm', 'hr', 'hydroponics', 'alert', 'ai']`.

1. Generates schema name: `tenant_{first16chars_of_uuid}`
2. Acquires a PostgreSQL advisory lock (prevents race conditions)
3. Creates the schema: `CREATE SCHEMA "tenant_abc123..."`
4. For each requested module, finds its `MODULE_SCHEMAS` entry
5. For each table in the entry, clones structure from `sourceSchema` via `CREATE TABLE ... (LIKE ... INCLUDING ALL)`
6. Copies reference data rows from source schema tables listed in `referenceDataTables`

**Note:** The default `modules` parameter uses `DEFAULT_TENANT_MODULES`, which is automatically kept in sync with `MODULE_SCHEMAS`. Adding a new module to `MODULE_SCHEMAS` automatically includes it in all default-parameter calls.

---

## Current State (After Fixes)

Below is the exact content of `MODULE_SCHEMAS` as it exists in the codebase. Each module lists its tables alphabetically for easy scanning. Cross-referenced against actual `@Entity()` declarations in each service to confirm alignment.

---

### Sensor Module (`sourceSchema: 'sensor'`)

**Tables (34):**

| # | Table Name | Category |
|---|-----------|----------|
| 1 | `automation_programs` | Automation (IEC 61131-3) |
| 2 | `channel_detection_log` | Dynamic sensor type system |
| 3 | `dashboard_layouts` | Dashboard |
| 4 | `deployment_logs` | Edge Gateway |
| 5 | `device_events` | Edge Gateway |
| 6 | `device_group_members` | Device Groups |
| 7 | `device_groups` | Device Groups |
| 8 | `device_io_configs` | Edge devices |
| 9 | `edge_devices` | Edge devices |
| 10 | `feeding_parameters` | PLC control |
| 11 | `industry_templates` | Dynamic sensor type system |
| 12 | `lora_devices` | LoRa |
| 13 | `plc_alarms` | PLC control |
| 14 | `plc_connections` | PLC control |
| 15 | `plc_telemetry` | PLC control |
| 16 | `processes` | Core |
| 17 | `program_steps` | Automation (IEC 61131-3) |
| 18 | `program_transitions` | Automation (IEC 61131-3) |
| 19 | `program_variables` | Automation (IEC 61131-3) |
| 20 | `scada_deploy_logs` | SCADA |
| 21 | `scada_packages` | SCADA |
| 22 | `sensor_audit_logs` | Audit |
| 23 | `sensor_data_channels` | Core |
| 24 | `sensor_metrics` | Core |
| 25 | `sensor_protocols` | Core |
| 26 | `sensor_readings` | Core |
| 27 | `sensor_type_definitions` | Dynamic sensor type system |
| 28 | `sensors` | Core |
| 29 | `step_actions` | Automation (IEC 61131-3) |
| 30 | `tenant_provisioning_keys` | Edge Gateway |
| 31 | `unified_tags` | SCADA |
| 32 | `vfd_devices` | VFD |
| 33 | `vfd_readings` | VFD |
| 34 | `vfd_register_mappings` | VFD |

**Reference data tables (3):** `industry_templates`, `sensor_protocols`, `sensor_type_definitions`

---

### Farm Module (`sourceSchema: 'farm'`)

**Tables (66):**

| # | Table Name | Category |
|---|-----------|----------|
| 1 | `auto_rules` | Task management |
| 2 | `batch_documents` | Batch management |
| 3 | `batch_feed_assignments` | Batch management |
| 4 | `batch_locations` | Batch management |
| 5 | `batches` | Batch management |
| 6 | `batches_v2` | Batch management |
| 7 | `chemical_sites` | Chemical management |
| 8 | `chemical_types` | Chemical management |
| 9 | `chemicals` | Chemical management |
| 10 | `code_sequences` | Supporting |
| 11 | `consumables` | Storage & Stock |
| 12 | `daily_feeding_executions` | Feed management |
| 13 | `departments` | Core |
| 14 | `equipment` | Equipment hierarchy |
| 15 | `equipment_systems` | Equipment hierarchy |
| 16 | `equipment_types` | Equipment hierarchy |
| 17 | `farm_audit_logs` | Supporting |
| 18 | `farm_workers` | Workers |
| 19 | `farms` | Core |
| 20 | `feed_inventory` | Feed management |
| 21 | `feed_sites` | Feed management |
| 22 | `feed_type_species` | Feed management |
| 23 | `feed_types` | Feed management |
| 24 | `feeder_calibrations` | Equipment hierarchy |
| 25 | `feeding_program_tanks` | Feed management |
| 26 | `feeding_programs` | Feed management |
| 27 | `feeding_protocols` | Feed management |
| 28 | `feeding_records` | Feed management |
| 29 | `feeding_tables` | Feed management |
| 30 | `feeds` | Feed management |
| 31 | `growth_measurements` | Production tracking |
| 32 | `harvest_plans` | Production tracking |
| 33 | `harvest_records` | Production tracking |
| 34 | `health_events` | Production tracking |
| 35 | `maintenance_schedules` | Maintenance |
| 36 | `marine_observations` | Weather |
| 37 | `mortality_records` | Production tracking |
| 38 | `ponds` | Core |
| 39 | `purchase_order_items` | Storage & Stock |
| 40 | `purchase_orders` | Storage & Stock |
| 41 | `recurring_templates` | Task management |
| 42 | `regulatory_settings` | Regulatory |
| 43 | `sentinel_hub_settings` | Regulatory |
| 44 | `site_contacts` | Core |
| 45 | `sites` | Core |
| 46 | `spare_parts` | Maintenance |
| 47 | `species` | Batch management |
| 48 | `stock_movements` | Storage & Stock |
| 49 | `storage_inventory` | Storage & Stock |
| 50 | `storage_locations` | Storage & Stock |
| 51 | `sub_equipment` | Equipment hierarchy |
| 52 | `sub_equipment_types` | Equipment hierarchy |
| 53 | `sub_systems` | Equipment hierarchy |
| 54 | `supplier_sites` | Suppliers |
| 55 | `supplier_types` | Suppliers |
| 56 | `suppliers` | Suppliers |
| 57 | `systems` | Equipment hierarchy |
| 58 | `tank_allocations` | Core |
| 59 | `tank_batches` | Core |
| 60 | `tank_operations` | Core |
| 61 | `tanks` | Core |
| 62 | `tasks` | Task management |
| 63 | `water_quality_measurements` | Production tracking |
| 64 | `weather_observations` | Weather |
| 65 | `weather_settings` | Weather |
| 66 | `work_orders` | Maintenance |

**Reference data tables (5):** `chemical_types`, `equipment_types`, `feed_types`, `sub_equipment_types`, `supplier_types`

---

### HR Module (`sourceSchema: 'hr'`)

**Tables (24):**

| # | Table Name | Category |
|---|-----------|----------|
| 1 | `attendance_records` | Attendance & Scheduling |
| 2 | `certification_types` | Certifications |
| 3 | `departments_hr` | Core |
| 4 | `employee_certifications` | Certifications |
| 5 | `employee_kpis` | Performance |
| 6 | `employees` | Core |
| 7 | `goals` | Performance |
| 8 | `holidays` | Scheduling |
| 9 | `leave_balances` | Leave management |
| 10 | `leave_requests` | Leave management |
| 11 | `leave_types` | Leave management |
| 12 | `payrolls` | Core |
| 13 | `performance_reviews` | Performance |
| 14 | `safety_training_records` | Aquaculture-specific |
| 15 | `schedule_entries` | Attendance & Scheduling |
| 16 | `schedules` | Attendance & Scheduling |
| 17 | `scheduling_settings` | Attendance & Scheduling |
| 18 | `shifts` | Attendance & Scheduling |
| 19 | `training_courses` | Training |
| 20 | `training_enrollments` | Training |
| 21 | `weekly_plan_entries` | Weekly Planning |
| 22 | `weekly_plans` | Weekly Planning |
| 23 | `work_areas` | Aquaculture-specific |
| 24 | `work_rotations` | Aquaculture-specific |

**Reference data tables (3):** `certification_types`, `leave_types`, `shifts`

---

### Hydroponics Module (`sourceSchema: 'hydroponics'`)

**Tables (1):**

| # | Table Name | Category |
|---|-----------|----------|
| 1 | `hydroponics_config` | Core |

**Reference data tables:** none

---

### Alert Module (`sourceSchema: 'alert'`)

**Tables (5):**

| # | Table Name | Category |
|---|-----------|----------|
| 1 | `alert_audit_log` | Audit |
| 2 | `alert_history` | Core |
| 3 | `alert_incidents` | Core |
| 4 | `alert_rules` | Core |
| 5 | `escalation_policies` | Core |

**Reference data tables:** none

> **RESOLVED (2026-03-18):** The alert module is now fully registered in `MODULE_SCHEMAS` with TenantSchemaMiddleware and TenantConnectionBootstrap in place. The `createTenantSchema()` default modules list includes `'alert'`.

---

### AI Module (`sourceSchema: 'ai'`)

**Tables (3):**

| # | Table Name | Category |
|---|-----------|----------|
| 1 | `agent_conversations` | Core |
| 2 | `tenant_agent_configs` | Configuration |
| 3 | `tool_execution_audit` | Audit |

**Reference data tables:** none

---

## Entity-to-Registry Alignment Summary

Cross-referencing `@Entity()` declarations in each service against `MODULE_SCHEMAS`:

| Module | Entities in Code | Tables in Registry | Status |
|--------|------------------|--------------------|--------|
| sensor | 34 | 34 | Aligned |
| farm | 66 | 66 | Aligned |
| hr | 24 | 24 | Aligned |
| hydroponics | 1 | 1 | Aligned |
| alert | 5 | 5 | Aligned |
| ai | 3 | 3 | Aligned |

---

## How to Add a New Table

1. **Create the entity** in the service module with `@Entity('table_name')`.
2. **Register the entity** in the module's `TypeOrmModule.forFeature([YourEntity])`.
3. **Add the table name** to `MODULE_SCHEMAS` in `libs/backend-common/src/database/schema-manager.service.ts` under the correct module's `tables` array.
4. **If the table contains seed/lookup data**, also add it to the module's `referenceDataTables` array so rows are copied to new tenant schemas.
5. **For existing tenants**, run `syncTenantSchema()` or re-provision to create the table in their schemas.

```typescript
// Example: adding a new "calibration_logs" table to the sensor module
{
  moduleName: 'sensor',
  sourceSchema: 'sensor',
  referenceDataTables: ['sensor_protocols', 'sensor_type_definitions', 'industry_templates'],
  tables: [
    // ... existing tables ...
    'calibration_logs',  // <-- add here
  ],
},
```

---

## How to Add a New Module

1. **Add a new entry to `MODULE_SCHEMAS`** in `libs/backend-common/src/database/schema-manager.service.ts`:
   ```typescript
   {
     moduleName: 'your_module',
     sourceSchema: 'your_module',
     referenceDataTables: [],
     tables: ['table_a', 'table_b'],
   },
   ```

   > **Note:** `DEFAULT_TENANT_MODULES` is automatically derived from `MODULE_SCHEMAS.map(m => m.moduleName)`.
   > Adding a new entry to `MODULE_SCHEMAS` automatically includes the module in the default
   > `modules` parameter of `createTenantSchema()` and `syncTenantSchema()`. No manual update
   > to function signatures is required.

2. **Create the source schema** in `infrastructure/database/init-schemas.sql`:
   ```sql
   CREATE SCHEMA IF NOT EXISTS your_module;
   ```

3. **Add `TenantSchemaMiddleware`** to the new service. Import shared utilities from `@platform/backend-common`:
   ```typescript
   import { SchemaLRUCache, getRequestContext } from '@platform/backend-common';
   // See docs/db/04-middleware-patterns.md for the full template
   private readonly DEFAULT_SCHEMA = 'your_module';
   private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);
   ```

4. **Add `TenantConnectionBootstrapService`** to configure the DataSource subscriber for schema switching.

5. **No manual update to `DEFAULT_TENANT_MODULES` needed** -- it is derived automatically from `MODULE_SCHEMAS`:
   ```typescript
   // In schema-manager.service.ts (already defined):
   export const DEFAULT_TENANT_MODULES: string[] = MODULE_SCHEMAS.map(m => m.moduleName);
   // createTenantSchema() and syncTenantSchema() use this as their default
   ```

6. **Test provisioning** by creating a new tenant and verifying all tables appear in the tenant schema.

---

## Verification

Every `@Entity('table_name')` in a module service MUST have a matching entry in `MODULE_SCHEMAS`. To detect drift:

### Manual Check

```bash
# Extract entity table names from a service
grep -rh "@Entity('" apps/sensor-service/src/ | sed "s/.*@Entity('//;s/').*//" | sort

# Compare with MODULE_SCHEMAS tables array for that module
# Any table in entities but NOT in MODULE_SCHEMAS = isolation violation risk
```

### Programmatic Validation

`SchemaManagerService` exposes a `validateModuleSchemas()` method. Call it in integration tests:

```typescript
const result = await schemaManagerService.validateModuleSchemas();
// Returns mismatches between entity definitions and MODULE_SCHEMAS
```

### Key Files

| File | Purpose |
|------|---------|
| `libs/backend-common/src/database/schema-manager.service.ts` | `MODULE_SCHEMAS` definition, `DEFAULT_TENANT_MODULES`, `createTenantSchema()`, `syncTenantSchema()` |
| `libs/backend-common/src/database/tenant-schema.utils.ts` | Shared utilities: `getTenantSchemaName()`, `isValidUUID()`, `listTenantSchemas()`, `SCHEMA_NAME_REGEX` |
| `libs/backend-common/src/database/schema-lru-cache.ts` | Shared `SchemaLRUCache` with dual-TTL and request coalescing |
| `infrastructure/database/init-schemas.sql` | Source schema creation |
| `apps/*/src/middleware/tenant-schema.middleware.ts` | Per-request `search_path` switching (imports `SchemaLRUCache` from backend-common) |
| `apps/*/src/infrastructure/tenant-connection-bootstrap.service.ts` | Pool-level search_path injection via monkey-patched `pg Pool.connect()` |
