# Aquaculture Platform - Complete Database Architecture Map

> **Single authoritative reference** for every table in the platform.
> Generated from source code entity definitions and `MODULE_SCHEMAS` registry.
> Last updated: 2026-03-18

---

## Database: `aquaculture`

All services below connect to this database unless noted otherwise.

### ┌─────────────────────────────────────────────┐
### │          SYSTEM SCHEMAS (Shared)             │
### └─────────────────────────────────────────────┘

System schemas use **row-level isolation** via `tenantId` columns.
All tenants share the same tables; data is partitioned by tenant identifier.

---

#### `auth` schema (auth-service) — Row-level isolation via tenantId

| # | Table | Purpose |
|---|-------|---------|
| 1 | `tenants` | Tenant registry (company/organization) |
| 2 | `users` | All platform users across tenants |
| 3 | `refresh_tokens` | JWT refresh token storage |
| 4 | `invitations` | User invitation tokens with audit trail |
| 5 | `webauthn_credentials` | WebAuthn/FIDO2 passkey credentials |
| 6 | `user_module_assignments` | Per-user module access grants |
| 7 | `modules` | System module definitions (sensor, farm, hr, etc.) |
| 8 | `tenant_modules` | Module activation per tenant |
| 9 | `mobile_user_settings` | User mobile app preferences |
| 10 | `announcements` | Platform & tenant announcements |
| 11 | `announcement_acknowledgments` | User acknowledgment tracking for announcements |
| 12 | `message_threads` | Messaging conversation threads |
| 13 | `messages` | Individual messages within threads |
| 14 | `support_tickets` | User support tickets |
| 15 | `ticket_comments` | Comments on support tickets |
| 16 | `audit_logs` | Auth-service audit trail |

**Total: 16 tables**

---

#### `admin` schema (admin-api-service) — Row-level isolation via tenantId

| # | Table | Category | Purpose |
|---|-------|----------|---------|
| 1 | `audit_logs` | Audit | Admin action audit trail |
| 2 | `impersonation_sessions` | Impersonation | Admin impersonation session records |
| 3 | `impersonation_permissions` | Impersonation | Permissions granted during impersonation |
| 4 | `debug_sessions` | Debug | Debug session records (non-production) |
| 5 | `captured_queries` | Debug | SQL queries captured during debug sessions |
| 6 | `captured_api_calls` | Debug | API calls captured during debug sessions |
| 7 | `cache_entries_snapshot` | Debug | Redis cache snapshots for debugging |
| 8 | `feature_flag_overrides` | Debug | Per-session feature flag overrides |
| 9 | `discount_codes` | Billing | Promotional discount codes |
| 10 | `discount_redemptions` | Billing | Discount code usage tracking |
| 11 | `plan_definitions` | Billing | Subscription plan definitions |
| 12 | `plan_module_assignments` | Billing | Modules included in each plan |
| 13 | `module_pricing` | Billing | Per-module pricing tiers |
| 14 | `custom_plans` | Billing | Custom/negotiated plans |
| 15 | `background_jobs` | System Mgmt | Background job definitions |
| 16 | `job_execution_logs` | System Mgmt | Job execution history |
| 17 | `job_queues` | System Mgmt | Named job queues |
| 18 | `performance_metrics` | System Mgmt | System performance data points |
| 19 | `performance_snapshots` | System Mgmt | Periodic performance snapshots |
| 20 | `error_occurrences` | System Mgmt | Individual error events |
| 21 | `error_groups` | System Mgmt | Grouped/deduplicated errors |
| 22 | `error_alert_rules` | System Mgmt | Alert rules for error thresholds |
| 23 | `maintenance_modes` | System Mgmt | Maintenance window management |
| 24 | `feature_toggles` | System Mgmt | Platform feature flags |
| 25 | `system_versions` | System Mgmt | Service version tracking |
| 26 | `global_configs` | System Mgmt | Global configuration key-values |
| 27 | `analytics_snapshots` | Analytics | Pre-computed analytics snapshots |
| 28 | `report_definitions` | Analytics | Saved report templates |
| 29 | `report_executions` | Analytics | Report execution history |
| 30 | `message_threads` | Support | Admin-side messaging threads |
| 31 | `messages` | Support | Admin-side messages |
| 32 | `announcements` | Support | Admin-side announcements |
| 33 | `announcement_acknowledgments` | Support | Admin-side acknowledgment tracking |
| 34 | `support_tickets` | Support | Admin-side support tickets |
| 35 | `ticket_comments` | Support | Admin-side ticket comments |
| 36 | `onboarding_progress` | Support | Tenant onboarding step tracking |
| 37 | `tenant_schemas` | DB Mgmt | Tenant schema inventory |
| 38 | `schema_migrations` | DB Mgmt | Schema migration history |
| 39 | `schema_backups` | DB Mgmt | Schema backup records |
| 40 | `schema_restores` | DB Mgmt | Schema restore records |
| 41 | `database_metrics` | DB Mgmt | Database health metrics |
| 42 | `slow_query_logs` | DB Mgmt | Slow query tracking |
| 43 | `tenant_activities` | Tenant Mgmt | Tenant activity timeline |
| 44 | `tenant_notes` | Tenant Mgmt | Admin notes per tenant |
| 45 | `tenant_billing_info` | Tenant Mgmt | Tenant billing details |
| 46 | `activity_logs` | Security | User activity audit log |
| 47 | `security_events` | Security | Security event log |
| 48 | `security_incidents` | Security | Security incident tracking |
| 49 | `threat_intelligence` | Security | Threat intel entries |
| 50 | `data_requests` | Security | GDPR/privacy data requests |
| 51 | `compliance_reports` | Security | Compliance report records |
| 52 | `retention_policies` | Security | Data retention policy rules |
| 53 | `login_attempts` | Security | Login attempt log |
| 54 | `api_usage_logs` | Security | API usage tracking |
| 55 | `user_sessions` | Security | Active user session tracking |
| 56 | `system_settings` | Settings | System-level configuration |
| 57 | `email_templates` | Settings | Email template management |
| 58 | `ip_access_rules` | Settings | IP whitelist/blacklist rules |
| 59 | `tenant_configurations` | Settings | Per-tenant configuration overrides |

**Total: 59 tables**

> **Note:** admin-api-service also holds **read-only entity mappings** (with `synchronize: false`) to tables in other schemas for cross-schema analytics queries:
> - `auth.tenants`, `auth.users`, `auth.tenant_invitations` (auth schema)
> - `billing.subscriptions`, `billing.invoices`, `billing.usage_aggregations`, `billing.tenant_usage_metrics` (billing schema)
>
> These are NOT admin-owned tables; they are queried but never written by admin-api.

---

#### `billing` schema (billing-service) — Row-level isolation via tenantId

| # | Table | Purpose |
|---|-------|---------|
| 1 | `plans` | Available subscription plans |
| 2 | `subscriptions` | Active tenant subscriptions |
| 3 | `subscription_module_items` | Modules within a subscription |
| 4 | `invoices` | Generated invoices |
| 5 | `payments` | Payment records |
| 6 | `usage_aggregations` | Aggregated usage metrics |
| 7 | `usage_hourly_data` | Hourly usage data points |
| 8 | `tenant_usage_metrics` | Per-tenant usage dashboard metrics |

**Total: 8 tables**

---

#### `public` schema — Shared utilities

| # | Table | Purpose |
|---|-------|---------|
| 1 | `user_permissions` | Legacy user permission matrix (admin-api-service) |

**Total: 1 table**

---

### ┌─────────────────────────────────────────────┐
### │       SOURCE/TEMPLATE SCHEMAS                │
### │    (Structure only, NO tenant data)          │
### └─────────────────────────────────────────────┘

These schemas serve as **structural templates**. When a new tenant is provisioned,
`SchemaManagerService.createTenantSchema()` copies table structures (and reference
data where applicable) from these source schemas into the new `tenant_xxx` schema.

| Source Schema | Module | Tables | Reference Data Tables |
|---------------|--------|--------|-----------------------|
| `sensor` | Sensor | 34 | `sensor_protocols`, `sensor_type_definitions`, `industry_templates` |
| `farm` | Farm | 66 | `equipment_types`, `sub_equipment_types`, `supplier_types`, `chemical_types`, `feed_types` |
| `hr` | HR | 24 | `leave_types`, `certification_types`, `shifts` |
| `hydroponics` | Hydroponics | 1 | (none) |
| `alert` | Alert | 5 | (none) |
| `ai` | AI | 3 | (none) |

---

### ┌─────────────────────────────────────────────┐
### │        TENANT SCHEMAS (Per-tenant)           │
### │    tenant_{first16hex_of_uuid}               │
### │    e.g. tenant_4b529829ea7948da              │
### └─────────────────────────────────────────────┘

Each tenant gets a dedicated PostgreSQL schema containing **all module tables**.
Isolation is at the **schema level** — each tenant's data is physically separated.

Total tables per tenant schema: **136** (133 from MODULE_SCHEMAS + 3 RBAC tables managed by auth-service)

---

#### Sensor Module Tables (34)

| # | Table | Category | Reference Data? |
|---|-------|----------|-----------------|
| 1 | `automation_programs` | Automation (IEC 61131-3) | No |
| 2 | `channel_detection_log` | Dynamic Type System | No |
| 3 | `dashboard_layouts` | Dashboard | No |
| 4 | `deployment_logs` | Edge Gateway | No |
| 5 | `device_events` | Edge Gateway | No |
| 6 | `device_group_members` | Device Groups | No |
| 7 | `device_groups` | Device Groups | No |
| 8 | `device_io_configs` | Edge Devices | No |
| 9 | `edge_devices` | Edge Devices | No |
| 10 | `feeding_parameters` | PLC Control | No |
| 11 | `industry_templates` | Dynamic Type System | Yes |
| 12 | `lora_devices` | LoRa | No |
| 13 | `plc_alarms` | PLC Control | No |
| 14 | `plc_connections` | PLC Control | No |
| 15 | `plc_telemetry` | PLC Control | No |
| 16 | `processes` | Core | No |
| 17 | `program_steps` | Automation (IEC 61131-3) | No |
| 18 | `program_transitions` | Automation (IEC 61131-3) | No |
| 19 | `program_variables` | Automation (IEC 61131-3) | No |
| 20 | `scada_deploy_logs` | SCADA | No |
| 21 | `scada_packages` | SCADA | No |
| 22 | `sensor_audit_logs` | Audit | No |
| 23 | `sensor_data_channels` | Core | No |
| 24 | `sensor_metrics` | Core | No |
| 25 | `sensor_protocols` | Core | Yes |
| 26 | `sensor_readings` | Core | No |
| 27 | `sensor_type_definitions` | Dynamic Type System | Yes |
| 28 | `sensors` | Core | No |
| 29 | `step_actions` | Automation (IEC 61131-3) | No |
| 30 | `tenant_provisioning_keys` | Edge Gateway | No |
| 31 | `unified_tags` | SCADA | No |
| 32 | `vfd_devices` | VFD | No |
| 33 | `vfd_readings` | VFD | No |
| 34 | `vfd_register_mappings` | VFD | No |

---

#### Farm Module Tables (66)

| # | Table | Category | Reference Data? |
|---|-------|----------|-----------------|
| 1 | `auto_rules` | Task & Automation | No |
| 2 | `batch_documents` | Batch Management | No |
| 3 | `batch_feed_assignments` | Batch Management | No |
| 4 | `batch_locations` | Batch Management | No |
| 5 | `batches` | Batch Management | No |
| 6 | `batches_v2` | Batch Management | No |
| 7 | `chemical_sites` | Chemical Management | No |
| 8 | `chemical_types` | Chemical Management | Yes |
| 9 | `chemicals` | Chemical Management | No |
| 10 | `code_sequences` | Supporting | No |
| 11 | `consumables` | Storage & Stock | No |
| 12 | `daily_feeding_executions` | Feed Management | No |
| 13 | `departments` | Core | No |
| 14 | `equipment` | Equipment Hierarchy | No |
| 15 | `equipment_systems` | Equipment Hierarchy | No |
| 16 | `equipment_types` | Equipment Hierarchy | Yes |
| 17 | `farm_audit_logs` | Supporting | No |
| 18 | `farm_workers` | Workers | No |
| 19 | `farms` | Core | No |
| 20 | `feed_inventory` | Feed Management | No |
| 21 | `feed_sites` | Feed Management | No |
| 22 | `feed_type_species` | Feed Management | No |
| 23 | `feed_types` | Feed Management | Yes |
| 24 | `feeder_calibrations` | Equipment Hierarchy | No |
| 25 | `feeding_programs` | Feed Management | No |
| 26 | `feeding_program_tanks` | Feed Management | No |
| 27 | `feeding_protocols` | Feed Management | No |
| 28 | `feeding_records` | Feed Management | No |
| 29 | `feeding_tables` | Feed Management | No |
| 30 | `feeds` | Feed Management | No |
| 31 | `growth_measurements` | Production Tracking | No |
| 32 | `harvest_plans` | Production Tracking | No |
| 33 | `harvest_records` | Production Tracking | No |
| 34 | `health_events` | Production Tracking | No |
| 35 | `maintenance_schedules` | Maintenance | No |
| 36 | `marine_observations` | Weather & Marine | No |
| 37 | `mortality_records` | Production Tracking | No |
| 38 | `ponds` | Core | No |
| 39 | `purchase_order_items` | Storage & Stock | No |
| 40 | `purchase_orders` | Storage & Stock | No |
| 41 | `recurring_templates` | Task & Automation | No |
| 42 | `regulatory_settings` | Regulatory | No |
| 43 | `sentinel_hub_settings` | Regulatory | No |
| 44 | `site_contacts` | Core | No |
| 45 | `sites` | Core | No |
| 46 | `spare_parts` | Maintenance | No |
| 47 | `species` | Batch Management | No |
| 48 | `stock_movements` | Storage & Stock | No |
| 49 | `storage_inventory` | Storage & Stock | No |
| 50 | `storage_locations` | Storage & Stock | No |
| 51 | `sub_equipment` | Equipment Hierarchy | No |
| 52 | `sub_equipment_types` | Equipment Hierarchy | Yes |
| 53 | `sub_systems` | Equipment Hierarchy | No |
| 54 | `supplier_sites` | Suppliers | No |
| 55 | `supplier_types` | Suppliers | Yes |
| 56 | `suppliers` | Suppliers | No |
| 57 | `systems` | Equipment Hierarchy | No |
| 58 | `tank_allocations` | Core | No |
| 59 | `tank_batches` | Core | No |
| 60 | `tank_operations` | Core | No |
| 61 | `tanks` | Core | No |
| 62 | `tasks` | Task & Automation | No |
| 63 | `water_quality_measurements` | Production Tracking | No |
| 64 | `weather_observations` | Weather & Marine | No |
| 65 | `weather_settings` | Weather & Marine | No |
| 66 | `work_orders` | Maintenance | No |

---

#### HR Module Tables (24)

| # | Table | Category | Reference Data? |
|---|-------|----------|-----------------|
| 1 | `attendance_records` | Attendance | No |
| 2 | `certification_types` | Certifications | Yes |
| 3 | `departments_hr` | Core | No |
| 4 | `employee_certifications` | Certifications | No |
| 5 | `employee_kpis` | Performance | No |
| 6 | `employees` | Core | No |
| 7 | `goals` | Performance | No |
| 8 | `holidays` | Scheduling | No |
| 9 | `leave_balances` | Leave Management | No |
| 10 | `leave_requests` | Leave Management | No |
| 11 | `leave_types` | Leave Management | Yes |
| 12 | `payrolls` | Core | No |
| 13 | `performance_reviews` | Performance | No |
| 14 | `safety_training_records` | Aquaculture-specific | No |
| 15 | `schedule_entries` | Attendance | No |
| 16 | `schedules` | Attendance | No |
| 17 | `scheduling_settings` | Attendance | No |
| 18 | `shifts` | Attendance | Yes |
| 19 | `training_courses` | Training | No |
| 20 | `training_enrollments` | Training | No |
| 21 | `weekly_plan_entries` | Weekly Planning | No |
| 22 | `weekly_plans` | Weekly Planning | No |
| 23 | `work_areas` | Aquaculture-specific | No |
| 24 | `work_rotations` | Aquaculture-specific | No |

---

#### Hydroponics Module Tables (1)

| # | Table | Category |
|---|-------|----------|
| 1 | `hydroponics_config` | Config |

---

#### Alert Module Tables (5)

| # | Table | Category |
|---|-------|----------|
| 1 | `alert_audit_log` | Audit |
| 2 | `alert_history` | History |
| 3 | `alert_incidents` | Core |
| 4 | `alert_rules` | Core |
| 5 | `escalation_policies` | Core |

---

#### AI Module Tables (3)

| # | Table | Category |
|---|-------|----------|
| 1 | `agent_conversations` | Conversation |
| 2 | `tenant_agent_configs` | Configuration |
| 3 | `tool_execution_audit` | Audit |

---

#### RBAC Tables (3) — Managed by auth-service via raw SQL

These tables are **not** in `MODULE_SCHEMAS` but are created and managed by
`auth-service` in each tenant schema via raw SQL (not TypeORM entity sync).

| # | Table | Purpose |
|---|-------|---------|
| 1 | `tenant_roles` | Custom roles defined per tenant |
| 2 | `tenant_role_permissions` | Permission grants per role |
| 3 | `user_role_assignments` | User-to-role mappings |

---

### ┌─────────────────────────────────────────────┐
### │        SEPARATE DATABASES                    │
### └─────────────────────────────────────────────┘

These services use their own PostgreSQL databases, independent of `aquaculture`.

---

#### `config_service` DB (config-service)

| # | Table | Purpose |
|---|-------|---------|
| 1 | `configurations` | Key-value configuration entries per tenant/scope |
| 2 | `configuration_history` | Configuration change audit log |

**Total: 2 tables**

---

#### `aquaculture_events` DB (event-store-service)

| # | Table | Purpose |
|---|-------|---------|
| 1 | `event_streams` | Named event streams (aggregates) |
| 2 | `stored_events` | Persisted domain events |
| 3 | `snapshots` | Aggregate state snapshots |
| 4 | `projection_checkpoints` | Read-model projection offsets |

**Total: 4 tables**

---

#### `notification_service` DB (notification-service)

| # | Table | Purpose |
|---|-------|---------|
| 1 | `notification_logs` | Sent notification history |
| 2 | `device_tokens` | Push notification device tokens |

**Total: 2 tables**

---

#### `aquaculture_observability` DB (observability-service)

No application-level tables. This database is used by Prometheus metric aggregation
and tracing modules which store data via external tools (Prometheus TSDB, Jaeger),
not via TypeORM entities.

---

## Data Flow Diagram

```
Browser → nginx → gateway-api → [service] → PostgreSQL
                                    │
                          TenantSchemaMiddleware
                          (extracts tenantId from JWT)
                                    │
                        TenantConnectionBootstrap
                        (on module init, validates schema)
                                    │
                     SET search_path TO "tenant_xxx"
                                    │
                          Query hits tenant schema
```

**Schema-level services** (sensor, farm, hr, hydroponics, alert, ai):
1. `TenantSchemaMiddleware` extracts `tenantId` from the JWT token
2. Derives schema name: `tenant_` + first 16 hex chars of tenant UUID
3. Calls `SET search_path TO "tenant_xxx"` on the connection
4. All subsequent queries in the request hit the tenant's schema

**Row-level services** (auth, admin, billing):
1. All data lives in a single shared schema (`auth`, `admin`, `billing`)
2. Every query filters by `tenantId` column
3. No `search_path` switching needed

---

## Isolation Model Summary

| Service | Database | Schema | Isolation | Owned Tables |
|---------|----------|--------|-----------|--------------|
| auth-service | aquaculture | `auth` | Row-level (tenantId) | 16 |
| admin-api-service | aquaculture | `admin` | Row-level (tenantId) | 59 |
| billing-service | aquaculture | `billing` | Row-level (tenantId) | 8 |
| admin-api-service | aquaculture | `public` | Row-level | 1 |
| sensor-service | aquaculture | `tenant_xxx` | Schema-level | 34 |
| farm-service | aquaculture | `tenant_xxx` | Schema-level | 66 |
| hr-service | aquaculture | `tenant_xxx` | Schema-level | 24 |
| hydroponics-service | aquaculture | `tenant_xxx` | Schema-level | 1 |
| alert-engine | aquaculture | `tenant_xxx` | Schema-level | 5 |
| ai-service | aquaculture | `tenant_xxx` | Schema-level | 3 |
| auth-service (RBAC) | aquaculture | `tenant_xxx` | Schema-level | 3 |
| config-service | config_service | (default) | Row-level (tenantId) | 2 |
| event-store-service | aquaculture_events | (default) | Row-level (tenantId) | 4 |
| notification-service | notification_service | (default) | Row-level (tenantId) | 2 |
| observability-service | aquaculture_observability | (default) | N/A | 0 |

---

## Table Count Summary

| Location | Tables |
|----------|--------|
| `auth` schema | 16 |
| `admin` schema | 59 |
| `billing` schema | 8 |
| `public` schema | 1 |
| Per tenant schema (MODULE_SCHEMAS) | 133 |
| Per tenant schema (RBAC) | 3 |
| **Total per tenant schema** | **136** |
| `config_service` DB | 2 |
| `aquaculture_events` DB | 4 |
| `notification_service` DB | 2 |
| `aquaculture_observability` DB | 0 |
| **Grand total (system + 1 tenant)** | **228** |

---

## Shared Infrastructure

The following shared files in `libs/backend-common` provide the foundation for tenant schema management across all 6 module services. These eliminate code duplication and ensure consistent behavior.

| File | Export(s) | Purpose |
|------|-----------|---------|
| `libs/backend-common/src/database/schema-manager.service.ts` | `SchemaManagerService`, `MODULE_SCHEMAS`, `DEFAULT_TENANT_MODULES`, `REFERENCE_DATA_TABLES` | Central registry of module tables. `DEFAULT_TENANT_MODULES` is derived from `MODULE_SCHEMAS.map(m => m.moduleName)` and used as the default `modules` parameter in `createTenantSchema()` and `syncTenantSchema()`. |
| `libs/backend-common/src/database/tenant-schema.utils.ts` | `getTenantSchemaName()`, `isValidUUID()`, `isValidSchemaName()`, `listTenantSchemas()`, `UUID_V4_REGEX`, `SCHEMA_NAME_REGEX` | Pure utility functions for schema name derivation, UUID validation, and tenant discovery. No NestJS DI required -- usable in middleware, cron jobs, NATS handlers, and MQTT listeners. |
| `libs/backend-common/src/database/schema-lru-cache.ts` | `SchemaLRUCache` | LRU cache for schema existence checks with dual-TTL (5 min positive / 30s negative) and request coalescing via `getOrCheck()`. Used by all 6 `TenantSchemaMiddleware` implementations. |
| `libs/backend-common/src/database/source-schema-bootstrap.service.ts` | `SourceSchemaBootstrapService` | Creates template tables in source schemas on startup. |
| `libs/backend-common/src/logging/request-context.ts` | `getRequestContext()`, `requestContextStorage` | AsyncLocalStorage for per-request tenant context, read by `TenantConnectionBootstrap` on every pool connection checkout. |

All exports are re-exported from `@platform/backend-common` (via barrel files) for convenient importing.

---

## Key Architectural Notes

1. **Template schema pattern**: Source schemas (`sensor`, `farm`, `hr`, `hydroponics`, `alert`, `ai`) hold the table structure but NO tenant data. `SchemaManagerService` copies structure + reference data into new tenant schemas.

2. **Reference data tables**: Certain tables contain lookup/seed data that is copied from the source schema into each new tenant schema during provisioning. These are defined in `MODULE_SCHEMAS[].referenceDataTables`.

3. **RBAC tables**: `tenant_roles`, `tenant_role_permissions`, and `user_role_assignments` exist in each tenant schema but are managed by auth-service via raw SQL, NOT through TypeORM entity sync or MODULE_SCHEMAS.

4. **Cross-schema reads**: admin-api-service holds read-only entity mappings (with `synchronize: false`) to `auth` and `billing` schema tables for analytics dashboards.

5. **Schema naming**: Tenant schemas follow the pattern `tenant_{first16HexChars}` where the hex string is derived from the tenant's UUID (first 16 characters of the UUID without hyphens). Use `getTenantSchemaName()` from `@platform/backend-common` for consistency.

6. **DATABASE_SYNC**: When `DATABASE_SYNC=true`, TypeORM's `synchronize` creates/updates tables automatically. In production, migrations should be used instead.

7. **DEFAULT_TENANT_MODULES**: The default module list for `createTenantSchema()` and `syncTenantSchema()` is derived from `MODULE_SCHEMAS` at module load time. Adding a new module to `MODULE_SCHEMAS` automatically includes it in the default list.
