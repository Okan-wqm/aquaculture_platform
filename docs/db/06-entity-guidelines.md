# Entity Design Guidelines

Rules for designing TypeORM entities in module services (farm, sensor, hr, hydroponics). Every rule exists to protect tenant isolation or prevent runtime errors. Violations are treated as P0 bugs.

---

## Rule 1: Table Name Registration

Every `@Entity('table_name')` in a module service **MUST** have its `table_name` listed in `MODULE_SCHEMAS` in `libs/backend-common/src/database/schema-manager.service.ts`.

A missing entry means the table is never created in tenant schemas during provisioning. At runtime, TypeORM will silently read/write to the source schema instead --- this is an **isolation violation**.

```typescript
// schema-manager.service.ts
export const MODULE_SCHEMAS: Record<string, string[]> = {
  farm: ['sites', 'tanks', 'batches', /* ... every farm entity table */],
  sensor: ['sensors', 'readings', /* ... every sensor entity table */],
  // ...
};
```

**Checklist for new entities:**

1. Add the entity class to the module's `TypeOrmModule.forFeature([])`.
2. Add the table name string to the correct array in `MODULE_SCHEMAS`.
3. Verify the table appears in an existing tenant schema after sync.

---

## Rule 2: No Hardcoded Schema

Never use the `schema` option in `@Entity()`:

```typescript
// FORBIDDEN
@Entity('equipment_types', { schema: 'farm' })

// CORRECT
@Entity('equipment_types')
```

The `schema` option bypasses `search_path` entirely. TypeORM generates `SELECT ... FROM "farm"."equipment_types"` instead of the unqualified `SELECT ... FROM "equipment_types"`, which means every tenant's queries hit the shared source schema regardless of the connection's `search_path` setting.

**Exception: NONE.** Even reference/lookup tables must use `search_path`. Each tenant gets its own copy of reference data, seeded from the source schema during provisioning.

---

## Rule 3: Unique Table Names

All module services share a single tenant schema (`tenant_xxx`). Table names must be **globally unique** across every module.

**Naming convention:** Prefix with the module name when collision risk exists.

| Instead of | Use | Reason |
|---|---|---|
| `employees` (farm) | `farm_workers` | Collides with HR's `employees` |
| `audit_logs` (sensor) | `sensor_audit_logs` | Collides with admin's `audit_logs` |
| `audit_logs` (farm) | `farm_audit_logs` | Already correct in codebase |

**Before naming a new table**, grep all entity files across all services:

```bash
grep -r "@Entity(" apps/*/src --include="*.ts" | grep -i "your_table_name"
```

---

## Rule 4: tenantId Column

For module services that use schema-level isolation, `tenantId` is **redundant** (the schema itself is the isolation boundary) but is kept as **defense-in-depth**.

**Convention:**

- Inherit from the service's `BaseEntity` class, which provides `tenantId` automatically.
- Use snake_case in the database column name for consistency:

```typescript
@Column('uuid', { name: 'tenant_id' })
tenantId: string;
```

- Application-level guards can use `tenantId` as a secondary check even though `search_path` is the primary isolation mechanism.

---

## Rule 5: Orphan Prevention

Every entity must satisfy **all three** conditions:

1. **Registered in a module's `TypeOrmModule.forFeature([])`** --- otherwise TypeORM cannot create a repository for it and the entity is invisible to the DI container.
2. **Listed in `MODULE_SCHEMAS`** --- otherwise the table is never created in tenant schemas (Rule 1).
3. **Actually used by at least one service/handler via `@InjectRepository()`** --- otherwise the entity exists only as dead code that pollutes the schema.

If any condition fails, the entity is an **orphan** and must be either wired up or removed.

**Detection script:**

```bash
# Find entities not injected anywhere
for entity in $(grep -roh "@Entity('[^']*')" apps/farm-service/src --include="*.ts" | sort -u); do
  class=$(grep -B2 "$entity" apps/farm-service/src -r --include="*.ts" | grep "class " | awk '{print $2}')
  if ! grep -rq "InjectRepository($class)" apps/farm-service/src --include="*.ts"; then
    echo "ORPHAN: $class ($entity)"
  fi
done
```

---

## Rule 6: Legacy Entity Cleanup

Remove entities that fall into any of these categories:

| Category | Action | Example |
|---|---|---|
| **Superseded** | Delete the old entity file and remove from `MODULE_SCHEMAS` | `batches` replaced by `batches_v2` |
| **Empty files** | Delete the file (0 bytes, no class definition) | `sensor-metadata.entity.ts` (0 bytes) |
| **Interface-only** | Convert to a plain TypeScript interface, remove `@Entity` decorator | Entities used only to type raw SQL results |
| **Renamed** | Delete the old entity, keep only the new one | Avoid two entity files mapping to the same table |

After removal, verify:

1. No imports reference the deleted file.
2. The table name is removed from `MODULE_SCHEMAS` (if the table itself is being dropped).
3. Run `DATABASE_SYNC=true` against a test database to confirm no errors.

---

## Current Violations

The following violations were identified during the 24-agent audit. Resolved items are marked with their fix status.

### farm-service

| Entity | Issue | Severity | Status |
|---|---|---|---|
| `SiteContact` | Orphan --- not injected by any service | Medium | Open -- wire up or remove |
| `SupplierSite` | Orphan --- not injected by any service | Medium | Open -- wire up or remove |
| `PondBatch` | Legacy --- superseded by newer batch model | Medium | **RESOLVED** -- entity removed |
| `equipment_types` | Hardcoded `{ schema: 'farm' }` in `@Entity` | **Critical** | **RESOLVED** -- `schema` option removed, `@Entity('equipment_types')` now uses search_path |
| `Worker` entity | Maps to `employees` table --- collides with HR | **Critical** | **RESOLVED** -- entity decorator updated to `@Entity('farm_workers')`, MODULE_SCHEMAS aligned |

### sensor-service

| Entity | Issue | Severity | Status |
|---|---|---|---|
| `SensorMetadata` | Empty file (0 bytes) | Low | **RESOLVED** -- file deleted |
| `SensorMetric` | Used only to type raw SQL results, not a real entity | Low | Open -- consider converting to interface |
| `TenantProvisioningKey` | Missing from `TypeOrmModule.forFeature([])` entities list | **Critical** | **RESOLVED** -- added to entities array and `MODULE_SCHEMAS` |
| `DeviceEvent` | Missing from `TypeOrmModule.forFeature([])` entities list | **Critical** | **RESOLVED** -- added to entities array and `MODULE_SCHEMAS` |
| `audit_logs` table | Name collides with admin schema's `audit_logs` | **Critical** | **RESOLVED** -- renamed to `sensor_audit_logs` in both entity decorator and MODULE_SCHEMAS |

---

## Quick Reference

| Rule | One-liner | Violation Level |
|---|---|---|
| 1. Table Registration | Every `@Entity` table in `MODULE_SCHEMAS` | Critical (isolation) |
| 2. No Hardcoded Schema | Never use `{ schema: 'xxx' }` in `@Entity` | Critical (isolation) |
| 3. Unique Table Names | Prefix with module name if collision risk | Critical (data corruption) |
| 4. tenantId Column | Inherit from BaseEntity, snake_case in DB | Medium (defense-in-depth) |
| 5. Orphan Prevention | Registered + in MODULE_SCHEMAS + injected | Medium (dead code / missing table) |
| 6. Legacy Cleanup | Remove superseded, empty, and interface-only entities | Low (maintenance) |

---

## PR Checklist for New Entities

- [ ] `@Entity('table_name')` has no `schema` option.
- [ ] `table_name` is globally unique across all module services.
- [ ] `table_name` is added to the correct array in `MODULE_SCHEMAS`.
- [ ] Entity class is added to the module's `TypeOrmModule.forFeature([])`.
- [ ] At least one service injects the repository via `@InjectRepository()`.
- [ ] Entity inherits from the service's `BaseEntity` (includes `tenantId`).
- [ ] `DATABASE_SYNC=true` runs cleanly against a test tenant schema.
