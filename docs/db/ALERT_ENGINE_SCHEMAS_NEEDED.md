# Alert Engine - Tables Needed in MODULE_SCHEMAS

The alert-engine now has schema-level tenant isolation (TenantSchemaMiddleware + TenantConnectionBootstrap),
but its tables are NOT yet registered in `MODULE_SCHEMAS` in `libs/backend-common/src/database/schema-manager.service.ts`.

Without this registration, tenant provisioning will NOT create alert tables in new tenant schemas.

## Required MODULE_SCHEMAS Entry

Add the following entry to the `MODULE_SCHEMAS` array:

```typescript
{
  moduleName: 'alert',
  sourceSchema: 'alert',
  referenceDataTables: [],
  tables: [
    'alert_rules',
    'alert_incidents',
    'escalation_policies',
    'alert_history',
    'alert_audit_log',
  ],
},
```

## Table-to-Entity Mapping

| Table Name            | Entity File                                                        |
|-----------------------|--------------------------------------------------------------------|
| `alert_rules`         | `apps/alert-engine/src/database/entities/alert-rule.entity.ts`     |
| `alert_incidents`     | `apps/alert-engine/src/database/entities/alert-incident.entity.ts` |
| `escalation_policies` | `apps/alert-engine/src/database/entities/escalation-policy.entity.ts` |
| `alert_history`       | `apps/alert-engine/src/alert/entities/alert-history.entity.ts`     |
| `alert_audit_log`     | `apps/alert-engine/src/audit/entities/audit-entry.entity.ts`       |

## Also Update syncTenantSchema Default Modules

The `syncTenantSchema` method has a default modules list:
```typescript
modules: string[] = ['sensor', 'farm', 'hr', 'hydroponics', 'alert', 'ai']
```
This has been updated to include `'alert'` and `'ai'` so that all module tables are synced by default.

## Status

- [x] TenantSchemaMiddleware created for alert-engine
- [x] TenantConnectionBootstrap created for alert-engine
- [x] app.module.ts updated with middleware + bootstrap + search_path config
- [x] MODULE_SCHEMAS entry added (5 tables: alert_rules, alert_incidents, escalation_policies, alert_history, alert_audit_log)
- [x] syncTenantSchema default modules updated to include `'alert'` and `'ai'` (confirmed in code: `['sensor', 'farm', 'hr', 'hydroponics', 'alert', 'ai']`)
- [ ] Existing tenant schemas need alert tables created (see `07-migration-plan.md` Phase 4.1)
- [ ] Existing data in shared `alert` schema needs migration to tenant schemas (see `07-migration-plan.md` Phase 4.2)
