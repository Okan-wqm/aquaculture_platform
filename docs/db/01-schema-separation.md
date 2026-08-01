# Schema Separation Guide

Authoritative reference for which tables belong in which schema tier. All services and migrations MUST conform to this document. Any deviation is a bug.

---

## Rules

1. **System-wide data** (tenants, users, billing, plans, analytics, security audit) --> System schemas (`auth` / `admin` / `billing`)
2. **Module operational data** (farms, tanks, sensors, employees, etc.) --> Tenant schemas (`tenant_xxx`)
3. **Source/template schemas** (`farm`, `sensor`, `hr`, `hydroponics`) --> NEVER contain tenant data, only table structure templates used by `CREATE TABLE ... (LIKE source INCLUDING ALL)`
4. **Reference/seed data** (equipment_types, sensor_protocols, etc.) --> Copied to tenant schemas during provisioning via `SchemaManagerService.copyReferenceDataTable()`
5. **Separate databases** (config_service, aquaculture_events, notification_service, aquaculture_observability) --> Completely isolated, not covered by this document

---

## System Schema: `auth`

Owner service: **auth-service**
Isolation: Row-level (`WHERE tenantId = :id`)

| Table                          | Justification                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `tenants`                      | Platform-wide tenant registry. Every service references this.                                                |
| `users`                        | Platform-wide user accounts. Users belong to tenants but are managed centrally.                              |
| `invitations`                  | Tenant invitations tied to users, not to module operational data.                                            |
| `refresh_tokens`               | Auth tokens bound to user sessions, not tenant operational data.                                             |
| `webauthn_credentials`         | Passkey/FIDO2 credentials for user authentication.                                                           |
| `modules`                      | System-wide module definitions (sensor, farm, hr, hydroponics).                                              |
| `tenant_modules`               | Which modules are enabled per tenant. Platform-level configuration.                                          |
| `user_module_assignments`      | Which modules a user can access. Platform-level RBAC.                                                        |
| `announcements`                | Platform-wide announcements from admins to all tenants.                                                      |
| `announcement_acknowledgments` | Per-user acknowledgment of platform announcements.                                                           |
| `messages`                     | Cross-tenant messaging system. Messages can span tenant boundaries.                                          |
| `message_threads`              | Conversation threads for cross-tenant messaging.                                                             |
| `support_tickets`              | Support system between tenants and platform admins.                                                          |
| `ticket_comments`              | Comments on support tickets.                                                                                 |
| `audit_logs`                   | Auth-level audit trail (login events, token operations, user changes).                                       |
| `mobile_user_settings`         | User preference data (theme, language, notifications). Linked to user identity, not tenant operational data. |
| `user_consents`                | GDPR consent records. Linked to user identity, legally must be centralized.                                  |

**Total: 17 tables**

---

## System Schema: `admin`

Owner service: **admin-api-service**
Isolation: Row-level (most tables have tenantId; some are global system tables)

### Tenant Management

| Table                   | Justification                                           |
| ----------------------- | ------------------------------------------------------- |
| `tenant_configurations` | Per-tenant config overrides managed by platform admins. |
| `tenant_activities`     | Admin-visible tenant activity feed.                     |
| `tenant_notes`          | Internal notes about tenants (admin-only).              |
| `tenant_billing_info`   | Billing contact/address info for each tenant.           |

### Plan & Pricing

| Table                     | Justification                                                |
| ------------------------- | ------------------------------------------------------------ |
| `plan_definitions`        | SaaS plan tiers (Free, Pro, Enterprise). Global definitions. |
| `plan_module_assignments` | Which modules are included in each plan.                     |
| `module_pricing`          | Per-module pricing rules.                                    |
| `custom_plans`            | Custom plan overrides for specific tenants.                  |
| `discount_codes`          | Promotional discount codes. Global scope.                    |
| `discount_redemptions`    | Record of which tenant redeemed which discount.              |

### Analytics & Reporting

| Table                 | Justification                                                     |
| --------------------- | ----------------------------------------------------------------- |
| `analytics_snapshots` | Platform-wide analytics aggregations (MRR, churn, tenant counts). |
| `report_definitions`  | Saved report configurations for admin dashboard.                  |
| `report_executions`   | Execution history of admin reports.                               |

### Security Audit (SYSTEM-LEVEL)

These are **platform-wide** security tables. They track security events across ALL tenants from the admin perspective. They are NOT per-tenant operational data.

| Table                 | Justification                                                   |
| --------------------- | --------------------------------------------------------------- |
| `activity_logs`       | System-wide admin activity log (who did what in admin panel).   |
| `security_events`     | Platform-wide security events (brute force, suspicious logins). |
| `security_incidents`  | Escalated security incidents requiring admin attention.         |
| `threat_intelligence` | Known threat IPs/patterns. Global blocklist.                    |
| `login_attempts`      | Failed/successful login tracking across all tenants.            |
| `api_usage_logs`      | API call tracking for rate limiting and abuse detection.        |
| `user_sessions`       | Active session tracking for admin visibility.                   |

### Compliance (SYSTEM-LEVEL)

| Table                | Justification                                                  |
| -------------------- | -------------------------------------------------------------- |
| `compliance_reports` | Platform-level compliance reports (SOC2, GDPR audits).         |
| `data_requests`      | GDPR data access/deletion requests managed by platform admins. |
| `retention_policies` | Data retention rules applied platform-wide.                    |

### System Settings & Configuration

| Table               | Justification                                          |
| ------------------- | ------------------------------------------------------ |
| `system_settings`   | Global platform settings (SMTP config, feature flags). |
| `email_templates`   | Email templates used by all services.                  |
| `ip_access_rules`   | IP whitelist/blacklist rules.                          |
| `feature_toggles`   | Feature flag definitions.                              |
| `maintenance_modes` | Scheduled maintenance windows.                         |
| `system_versions`   | Platform version history.                              |
| `global_configs`    | Key-value global configuration store.                  |

### Performance & Error Monitoring

| Table                   | Justification                            |
| ----------------------- | ---------------------------------------- |
| `performance_metrics`   | System performance data points.          |
| `performance_snapshots` | Periodic performance snapshots.          |
| `error_occurrences`     | Individual error events across services. |
| `error_groups`          | Grouped/deduplicated errors.             |
| `error_alert_rules`     | Rules for error alerting thresholds.     |

### Background Jobs

| Table                | Justification                     |
| -------------------- | --------------------------------- |
| `background_jobs`    | Scheduled/queued job definitions. |
| `job_execution_logs` | Job execution history.            |
| `job_queues`         | Job queue state.                  |

### Database Management

| Table               | Justification                                       |
| ------------------- | --------------------------------------------------- |
| `tenant_schemas`    | Registry of provisioned tenant schemas.             |
| `schema_migrations` | Migration tracking per tenant schema.               |
| `schema_backups`    | Backup metadata for tenant schemas.                 |
| `schema_restores`   | Restore operation history.                          |
| `database_metrics`  | Database health metrics (size, connections, locks). |
| `slow_query_logs`   | Slow query tracking.                                |

### Impersonation & Debug

| Table                       | Justification                               |
| --------------------------- | ------------------------------------------- |
| `impersonation_sessions`    | Admin impersonation session tracking.       |
| `impersonation_permissions` | Who is allowed to impersonate whom.         |
| `debug_sessions`            | Admin debug session metadata.               |
| `captured_queries`          | SQL queries captured during debug sessions. |
| `captured_api_calls`        | API calls captured during debug sessions.   |
| `cache_entries_snapshot`    | Cache state snapshots for debugging.        |
| `feature_flag_overrides`    | Per-tenant/per-user feature flag overrides. |

### Admin Audit & RBAC

| Table                     | Justification                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `audit_logs`              | Admin-level audit trail (admin panel operations).                                                      |
| `user_permissions`        | RBAC permissions for admin panel users. Currently in `public` schema -- should be migrated to `admin`. |
| `tenant_roles`            | Role definitions per tenant (read-only from admin).                                                    |
| `user_role_assignments`   | User-to-role mappings (read-only from admin).                                                          |
| `tenant_role_permissions` | Permission sets for tenant roles (read-only from admin).                                               |
| `onboarding_progress`     | Tenant onboarding step tracking.                                                                       |

**Total: 53 tables**

---

## System Schema: `billing`

Owner service: **billing-service**
Isolation: Row-level (`WHERE tenantId = :id`)

| Table                       | Justification                                                            |
| --------------------------- | ------------------------------------------------------------------------ |
| `plans`                     | Billing plan definitions (mirrors plan_definitions for billing context). |
| `subscriptions`             | Active subscriptions per tenant.                                         |
| `subscription_module_items` | Line items within a subscription (per-module).                           |
| `invoices`                  | Generated invoices.                                                      |
| `payments`                  | Payment transaction records.                                             |
| `tenant_usage_metrics`      | Usage counters per tenant (sensors, users, storage).                     |
| `usage_aggregations`        | Aggregated usage data for billing cycles.                                |
| `usage_hourly_data`         | Granular hourly usage data for metering.                                 |

**Total: 8 tables**

---

## Tenant Schema Tables

Format: `tenant_{first16hex_of_uuid}` (e.g., `tenant_4b529829ea7948da`)

Created during provisioning via `CREATE TABLE ... (LIKE {source_schema}.{table} INCLUDING ALL)`. Runtime routing via `SET search_path TO "tenant_xxx", {source_schema}, public`.

Registered in `MODULE_SCHEMAS` at `libs/backend-common/src/database/schema-manager.service.ts`.

---

### Farm Module (source schema: `farm`)

Owner service: **farm-service**

#### Core Entities

| Table              | Purpose                                     |
| ------------------ | ------------------------------------------- |
| `farms`            | Farm definitions (name, location, type).    |
| `sites`            | Physical sites within a farm.               |
| `site_contacts`    | Contact persons per site.                   |
| `departments`      | Organizational departments within a farm.   |
| `ponds`            | Open-water ponds.                           |
| `tanks`            | Indoor/recirculation tanks.                 |
| `tank_allocations` | Tank capacity allocation records.           |
| `tank_batches`     | Junction: which batches are in which tanks. |
| `tank_operations`  | Tank operation log (fill, drain, transfer). |

#### Batch Management

| Table                    | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `batches`                | Fish batch (legacy v1).                           |
| `batches_v2`             | Fish batch (current version with full lifecycle). |
| `batch_documents`        | Documents attached to batches.                    |
| `batch_feed_assignments` | Feed type assignments per batch.                  |
| `batch_locations`        | Batch location history.                           |
| `species`                | Aquaculture species definitions.                  |

#### Equipment Hierarchy

| Table                 | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `systems`             | Top-level systems (aeration, filtration, etc.).                               |
| `sub_systems`         | Sub-systems within a system.                                                  |
| `equipment_types`     | Equipment type definitions. **Reference data -- copied during provisioning.** |
| `equipment`           | Individual equipment instances.                                               |
| `equipment_systems`   | Junction: equipment-to-system assignments.                                    |
| `sub_equipment_types` | Sub-equipment type definitions. **Reference data.**                           |
| `sub_equipment`       | Sub-equipment instances (probes, valves, etc.).                               |
| `feeder_calibrations` | Feeder calibration records.                                                   |

#### Maintenance

| Table                   | Purpose                      |
| ----------------------- | ---------------------------- |
| `maintenance_schedules` | Scheduled maintenance plans. |
| `work_orders`           | Maintenance work orders.     |
| `spare_parts`           | Spare parts inventory.       |

#### Feed Management

| Table                      | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `feed_types`               | Feed type definitions. **Reference data.**      |
| `feed_type_species`        | Feed suitability per species.                   |
| `feeds`                    | Feed inventory items.                           |
| `feed_inventory`           | Current feed stock levels.                      |
| `feed_sites`               | Feed storage locations per site.                |
| `feeding_protocols`        | Standard feeding protocols.                     |
| `feeding_records`          | Individual feeding event records.               |
| `feeding_tables`           | Feeding table definitions (weight-based rates). |
| `feeding_programs`         | Automated feeding programs.                     |
| `feeding_program_tanks`    | Junction: feeding program-to-tank assignments.  |
| `daily_feeding_executions` | Daily feeding execution log.                    |

#### Chemical Management

| Table            | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `chemical_types` | Chemical type definitions. **Reference data.** |
| `chemicals`      | Chemical inventory items.                      |
| `chemical_sites` | Chemical storage per site.                     |

#### Production Tracking

| Table                        | Purpose                                  |
| ---------------------------- | ---------------------------------------- |
| `growth_measurements`        | Fish growth sampling data.               |
| `mortality_records`          | Mortality event records.                 |
| `water_quality_measurements` | Manual water quality readings.           |
| `health_events`              | Fish health events (disease, treatment). |
| `harvest_plans`              | Harvest planning records.                |
| `harvest_records`            | Completed harvest records.               |

#### Suppliers

| Table            | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `supplier_types` | Supplier type definitions. **Reference data.** |
| `suppliers`      | Supplier records.                              |
| `supplier_sites` | Supplier delivery locations.                   |

#### Storage & Stock Management

| Table                  | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `storage_locations`    | Physical storage locations.             |
| `consumables`          | Consumable item definitions.            |
| `storage_inventory`    | Current inventory levels per location.  |
| `stock_movements`      | Stock movement log (in, out, transfer). |
| `purchase_orders`      | Purchase orders.                        |
| `purchase_order_items` | Line items in purchase orders.          |

#### Regulatory & External

| Table                   | Purpose                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `regulatory_settings`   | Maskinporten credentials, company registration.                                                                          |
| `sentinel_hub_settings` | Frozen legacy CDSE credential rows used only by the audited one-shot cutover; active credentials live in config-service. |

#### Weather & Marine

| Table                  | Purpose                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `weather_observations` | Canonical provenance-bearing MET Norway rows plus read-isolated legacy rows.              |
| `marine_observations`  | Canonical provenance-bearing Copernicus Marine model rows plus read-isolated legacy rows. |
| `weather_settings`     | Frozen legacy compatibility table with no runtime reader, writer, resolver, or tenant UI. |

#### Supporting Tables

| Table                 | Purpose                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `code_sequences`      | Auto-increment code generators (batch codes, etc.).                                                                                   |
| `farm_audit_logs`     | Farm-module-specific audit trail. Named `farm_audit_logs` to avoid collision with auth/admin `audit_logs`.                            |
| `tasks`               | Operational task management (feeding, water quality checks).                                                                          |
| `auto_rules`          | Automated task generation rules.                                                                                                      |
| `recurring_templates` | Recurring task templates.                                                                                                             |
| `farm_workers`        | Farm-specific worker assignments. Renamed from `employees` to avoid collision with HR `employees` table. Maps to the `Worker` entity. |

**Reference data tables** (copied during provisioning): `equipment_types`, `sub_equipment_types`, `supplier_types`, `chemical_types`, `feed_types`

**Total: 66 tables** (per MODULE_SCHEMAS)

> **RESOLVED (2026-03-18):** The 14 phantom security/compliance tables (activity_logs, api_usage_logs, login_attempts, user_sessions, user_permissions, user_consents, compliance_reports, gdpr_data_requests, data_requests, retention_policies, security_events, security_incidents, threat_intelligence, mobile_user_settings) that were erroneously listed in farm MODULE_SCHEMAS have been removed. These tables belong in `admin` and `auth` schemas only.

---

### Sensor Module (source schema: `sensor`)

Owner service: **sensor-service**

#### Core Sensor Entities

| Table                  | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `sensors`              | Sensor device registrations.                            |
| `sensor_readings`      | Time-series sensor data points.                         |
| `sensor_metrics`       | Aggregated sensor metrics.                              |
| `sensor_data_channels` | Data channel definitions per sensor.                    |
| `sensor_protocols`     | Communication protocol definitions. **Reference data.** |
| `processes`            | Industrial process definitions.                         |

#### VFD (Variable Frequency Drive)

| Table                   | Purpose                            |
| ----------------------- | ---------------------------------- |
| `vfd_devices`           | VFD device registrations.          |
| `vfd_readings`          | VFD telemetry readings.            |
| `vfd_register_mappings` | Modbus register mappings for VFDs. |

#### Dashboard & Edge Devices

| Table               | Purpose                                |
| ------------------- | -------------------------------------- |
| `dashboard_layouts` | Per-tenant dashboard configurations.   |
| `edge_devices`      | Edge gateway device registrations.     |
| `device_io_configs` | I/O pin configuration per edge device. |

#### PLC Control

| Table                | Purpose                            |
| -------------------- | ---------------------------------- |
| `plc_connections`    | PLC connection configurations.     |
| `plc_alarms`         | PLC alarm definitions and history. |
| `plc_telemetry`      | PLC telemetry data points.         |
| `feeding_parameters` | PLC-controlled feeding parameters. |

#### Automation (IEC 61131-3)

| Table                 | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `automation_programs` | Automation program definitions (SFC/ST/LD). |
| `program_steps`       | Steps within an automation program.         |
| `program_transitions` | Transitions between program steps.          |
| `program_variables`   | Variables used in automation programs.      |
| `step_actions`        | Actions executed at each program step.      |

#### Dynamic Sensor Type System

| Table                     | Purpose                                                 |
| ------------------------- | ------------------------------------------------------- |
| `sensor_type_definitions` | User-defined sensor types. **Reference data.**          |
| `industry_templates`      | Industry-standard sensor templates. **Reference data.** |
| `channel_detection_log`   | Auto-detection log for sensor channels.                 |

#### Edge Gateway - Self-Registration & Deployment

| Table                      | Purpose                                 |
| -------------------------- | --------------------------------------- |
| `tenant_provisioning_keys` | Keys for edge device self-registration. |
| `device_events`            | Edge device event log.                  |
| `deployment_logs`          | Firmware/config deployment history.     |

#### SCADA & Unified Tags

| Table               | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `scada_packages`    | SCADA visualization packages.                |
| `scada_deploy_logs` | SCADA deployment history.                    |
| `unified_tags`      | Unified tag namespace for SCADA integration. |

**Reference data tables** (copied during provisioning): `sensor_protocols`, `sensor_type_definitions`, `industry_templates`

**Total: 34 tables** (per MODULE_SCHEMAS)

> **RESOLVED (2026-03-18):** The following 4 tables have been added to MODULE_SCHEMAS and `audit_logs` has been renamed to `sensor_audit_logs`:
>
> - `lora_devices` -- LoRaWAN device registrations
> - `sensor_audit_logs` -- Sensor-module audit trail (renamed from `audit_logs` to avoid collision)
> - `device_groups` -- Logical device grouping
> - `device_group_members` -- Junction: devices-to-groups

---

### HR Module (source schema: `hr`)

Owner service: **hr-service**

#### Core Employee & Payroll

| Table            | Purpose                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `employees`      | Employee records. **COLLISION WARNING**: Same table name used by farm-service `Worker` entity. Farm-service should rename to `farm_workers`. |
| `payrolls`       | Payroll records.                                                                                                                             |
| `departments_hr` | HR departments. Named `departments_hr` to avoid collision with farm-service `departments`.                                                   |

#### Leave Management

| Table            | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `leave_types`    | Leave type definitions (annual, sick, etc.). **Reference data.** |
| `leave_balances` | Current leave balances per employee.                             |
| `leave_requests` | Leave request records.                                           |

#### Attendance & Scheduling

| Table                 | Purpose                                |
| --------------------- | -------------------------------------- |
| `shifts`              | Shift definitions. **Reference data.** |
| `schedules`           | Schedule assignments.                  |
| `schedule_entries`    | Individual schedule entries.           |
| `scheduling_settings` | Scheduling configuration.              |
| `attendance_records`  | Clock-in/clock-out records.            |

#### Weekly Planning

| Table                 | Purpose                             |
| --------------------- | ----------------------------------- |
| `weekly_plans`        | Weekly work plans.                  |
| `weekly_plan_entries` | Individual entries in weekly plans. |

#### Holidays

| Table      | Purpose                       |
| ---------- | ----------------------------- |
| `holidays` | Holiday calendar definitions. |

#### Training

| Table                  | Purpose                        |
| ---------------------- | ------------------------------ |
| `training_courses`     | Training course definitions.   |
| `training_enrollments` | Employee training enrollments. |

#### Certifications (Aquaculture-specific)

| Table                     | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `certification_types`     | Certification type definitions. **Reference data.** |
| `employee_certifications` | Employee certification records.                     |

#### Aquaculture-specific HR

| Table                     | Purpose                                                 |
| ------------------------- | ------------------------------------------------------- |
| `work_areas`              | Work area definitions (hatchery, grow-out, processing). |
| `work_rotations`          | Rotation schedules for work areas.                      |
| `safety_training_records` | Safety training completion records.                     |

#### Performance Management

| Table                 | Purpose                     |
| --------------------- | --------------------------- |
| `goals`               | Employee goal definitions.  |
| `performance_reviews` | Performance review records. |
| `employee_kpis`       | Employee KPI tracking.      |

**Reference data tables** (copied during provisioning): `leave_types`, `certification_types`, `shifts`

**Total: 24 tables** (per MODULE_SCHEMAS)

> **RESOLVED (2026-03-18):** The 3 performance management tables (`goals`, `performance_reviews`, `employee_kpis`) have been added to MODULE_SCHEMAS.

---

### Hydroponics Module (source schema: `hydroponics`)

Owner service: **hydroponics-service**

| Table                | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `hydroponics_config` | Hydroponics system configuration per tenant. |

**Reference data tables**: None

**Total: 1 table**

---

### Alert Engine (source schema: `alert`)

Owner service: **alert-engine**
Isolation: Schema-level (via TenantSchemaMiddleware + TenantConnectionBootstrap)

| Table                 | Purpose                            |
| --------------------- | ---------------------------------- |
| `alert_rules`         | Alert rule definitions per tenant. |
| `alert_incidents`     | Active/resolved alert incidents.   |
| `alert_history`       | Historical alert event log.        |
| `escalation_policies` | Escalation policy definitions.     |
| `alert_audit_log`     | Alert-specific audit trail.        |

**Total: 5 tables** (per MODULE_SCHEMAS)

> **RESOLVED (2026-03-18):** Alert-engine now has schema-level isolation. TenantSchemaMiddleware, TenantConnectionBootstrap, and MODULE_SCHEMAS entry have all been added. Existing data in the shared `alert` schema still needs to be migrated to tenant schemas (see `07-migration-plan.md` Phase 4.2).

---

## Separate Databases

These services use their own databases and are not part of the `aquaculture` database schema separation:

| Database                    | Service               | Tables                                                                  |
| --------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `config_service`            | config-service        | `configurations`, `configuration_history`                               |
| `aquaculture_events`        | event-store-service   | `stored_events`, `event_streams`, `snapshots`, `projection_checkpoints` |
| `notification_service`      | notification-service  | (separate)                                                              |
| `aquaculture_observability` | observability-service | (separate)                                                              |

---

## Anti-patterns

### 1. NEVER put security/compliance tables in module (tenant) schemas

Tables like `activity_logs`, `security_events`, `compliance_reports`, `login_attempts`, `user_sessions`, `user_permissions`, `user_consents`, `data_requests`, `gdpr_data_requests`, `retention_policies`, `security_incidents`, `threat_intelligence`, and `mobile_user_settings` are **system-level** tables. They belong in the `admin` or `auth` schema.

Putting them in tenant schemas causes:

- Data fragmentation (security events scattered across hundreds of schemas)
- Impossible cross-tenant security analysis
- Schema bloat (14 unnecessary tables per tenant)
- Confusion about source of truth

### 2. NEVER use the same table name across modules

Previously bad examples (now resolved in MODULE_SCHEMAS):

- `employees` -- was used by both farm-service (`Worker` entity) and hr-service (`Employee` entity). **Fixed:** Farm-service renamed to `farm_workers` in MODULE_SCHEMAS (entity decorator update pending).
- `audit_logs` -- was used by auth-service, admin-api-service, AND sensor-service. **Fixed:** Sensor-service renamed to `sensor_audit_logs` in MODULE_SCHEMAS (entity decorator update pending).

Convention for module-prefixed names:

- `farm_audit_logs` (already done for farm-service)
- `sensor_audit_logs` (done in MODULE_SCHEMAS, entity decorator pending)
- `farm_workers` (done in MODULE_SCHEMAS, entity decorator pending)

### 3. NEVER hardcode schema names in @Entity() decorators

Bad:

```typescript
@Entity('equipment_types', { schema: 'farm' })  // WRONG
```

This bypasses the `SET search_path` mechanism and always hits the source schema instead of the tenant schema. The `schema` option in `@Entity()` should ONLY be used for:

- Read-only cross-schema references (e.g., admin-api reading from `auth` or `billing`)
- Entities that genuinely live in a fixed system schema

For tenant-schema entities, use:

```typescript
@Entity('equipment_types')  // CORRECT - resolved via search_path
```

### 4. NEVER fall back to source schema on error

If `SET search_path` fails or the tenant schema does not exist, the request MUST be rejected with a 500 error. Silently falling back to the source schema would:

- Expose template data as if it were tenant data
- Allow writes to corrupt the source template
- Create data that belongs to no tenant

### 5. NEVER put GDPR/consent tables in tenant schemas

`user_consents` and `gdpr_data_requests` are legally required to be centrally managed. Scattering them across tenant schemas makes GDPR subject access requests and right-to-erasure impossible to fulfill reliably.

---

## Reference Data Provisioning

When a new tenant schema is created, reference data is copied from source schemas:

| Module      | Reference Tables                                                                           |
| ----------- | ------------------------------------------------------------------------------------------ |
| sensor      | `sensor_protocols`, `sensor_type_definitions`, `industry_templates`                        |
| farm        | `equipment_types`, `sub_equipment_types`, `supplier_types`, `chemical_types`, `feed_types` |
| hr          | `leave_types`, `certification_types`, `shifts`                                             |
| hydroponics | (none)                                                                                     |

After provisioning, tenant reference data is independent. Changes to source schema reference data do NOT propagate to existing tenants. New reference data must be distributed via migrations or the `syncTenantSchema()` method.
