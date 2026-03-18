# NATS Event Handler Tenant Schema Isolation

## Problem Statement

NATS event handlers run OUTSIDE the HTTP request context. Unlike REST/GraphQL requests, they have:
- **NO AsyncLocalStorage context** (no `RequestContextMiddleware`)
- **NO TenantSchemaMiddleware** (which sets `schemaName` on the request context)
- **NO pool-level search_path injection** (because `TenantConnectionBootstrap` reads from AsyncLocalStorage, which is empty)

When a NATS handler uses TypeORM repositories, the database queries execute against the **default search_path** (the source schema, e.g., `farm, public` or `alert, public`). This means tenant-specific data is invisible -- queries return empty results or worse, hit the wrong schema.

---

## Event System Architecture

The platform has TWO event systems:

### 1. In-Process EventEmitter2 (`@OnEvent` decorator)
- Fires synchronously within the same Node.js process
- Runs in the SAME async context as the HTTP request that triggered it
- **AsyncLocalStorage is available** -- `TenantConnectionBootstrap` will set the correct `search_path`
- **STATUS: SAFE** -- no isolation issues

**Affected services:** All `@OnEvent` listeners in `farm-service/src/events/listeners/`

### 2. NATS JetStream EventBus (`eventBus.subscribe()`)
- Cross-process event delivery via NATS JetStream
- Handlers are invoked by the NATS consumer message loop, NOT from an HTTP request
- **AsyncLocalStorage is NOT available** -- `TenantConnectionBootstrap` cannot inject `search_path`
- **STATUS: VULNERABLE** -- any handler that queries tenant-specific tables will hit the source schema

**Affected services:** `farm-service`, `alert-engine`, `notification-service`, `sensor-service`

---

## Audit Findings

### SAFE: In-Process EventEmitter2 Handlers (farm-service)

These all use `@OnEvent` and execute within HTTP request context. AsyncLocalStorage is populated, so `TenantConnectionBootstrap` correctly sets `search_path` on every pool connection checkout.

| File | Handler | Status |
|------|---------|--------|
| `events/listeners/harvest-completed.listener.ts` | `handleHarvestCompleted` | SAFE |
| `events/listeners/batch-created.listener.ts` | `handleBatchCreated` | SAFE |
| `events/listeners/low-stock-alert.listener.ts` | `handleInventoryLowStock` | SAFE |
| `events/listeners/low-stock-alert.listener.ts` | `handleFeedingLowStock` | SAFE |
| `events/listeners/low-stock-alert.listener.ts` | `handleFeedingExpiryWarning` | SAFE |
| `events/listeners/mortality-recorded.listener.ts` | `handleMortalityRecorded` | SAFE |
| `events/listeners/maintenance-schedule-due.listener.ts` | `handleMaintenanceScheduleDue` | SAFE |
| `events/listeners/maintenance-schedule-due.listener.ts` | `handleWorkOrdersGenerated` | SAFE |
| `events/listeners/maintenance-schedule-due.listener.ts` | `handleMaintenanceOverdue` | SAFE |
| `events/listeners/maintenance-schedule-due.listener.ts` | `handleMaintenanceUpcoming` | SAFE |
| `events/listeners/maintenance-schedule-due.listener.ts` | `handleWorkOrderOverdue` | SAFE |
| `events/listeners/feeding-completed.listener.ts` | `handleFeedingCompleted` | SAFE |
| `events/listeners/feeding-completed.listener.ts` | `handleFeedingReminder` | SAFE |
| `events/listeners/feeding-completed.listener.ts` | `handleFeedingDailySummary` | SAFE |
| `events/listeners/feeding-completed.listener.ts` | `handleFeedingFCRAlerts` | SAFE |
| `events/listeners/feeding-completed.listener.ts` | `handleFeedingWeeklyForecast` | SAFE |

### RESOLVED: NATS JetStream Handlers

#### 1. `farm-service/src/task/services/auto-rule-trigger.service.ts`

**Subscriptions:** `inventory.lowStock`, `maintenance.schedule.due`, `alert.waterQuality`, `feeding.expiryWarning` (via `eventBus.subscribe`)

**What it does:**
- Receives NATS event with `tenantId` in payload
- Queries `autoRuleRepository.find({ where: { tenantId, trigger, isActive: true } })`
- Creates tasks via `taskRepository.save()`
- Publishes `TaskCreated` event via NATS

**Impact:** `auto_rules` and `tasks` tables live in **tenant schemas** (per `docs/db/01-schema-separation.md`). Without `search_path` being set, TypeORM queries against the `farm` source schema. Results:
- `autoRuleRepository.find()` returns empty (no rules in source schema) -- **silent failure, auto-rules never fire**
- `taskRepository.save()` would write to source schema if it ever executed -- **data corruption**
- `processScheduleRules()` cron also broken: queries all active SCHEDULE rules without tenant context

**Risk: HIGH** -- silent data loss, auto-generated tasks never created

#### 2. `alert-engine/src/alert/event-handlers/sensor-reading.handler.ts`

**Subscription:** `SensorReading` (via `eventBus.subscribe`)

**What it does:**
- Receives NATS event with `tenantId` in payload
- Calls `evaluationService.evaluateSensorReading()`
- Which calls `ruleRepository.createQueryBuilder('rule').where('rule.tenantId = :tenantId', { tenantId })`
- Writes to `alertHistoryRepository`, `alertIncidentRepository`

**Impact:** `alert_rules`, `alert_incidents`, `alert_history` tables live in **tenant schemas**. Without `search_path`:
- `findApplicableRules()` returns empty -- **alerts never trigger**
- `alertHistoryRepository.save()` / `alertIncidentRepository.save()` would write to source schema -- **data corruption**

**Risk: CRITICAL** -- water quality alerts, sensor threshold breaches, and all automated alerting silently broken for ALL tenants

#### 3. `sensor-service/src/automation/compiler/nats-handlers/st-language.handler.ts`

**Subscriptions:** `st.language.analyze`, `st.language.complete`, etc. (raw NATS, not JetStream)

**What it does:**
- Receives NATS request with `tenantId` from headers
- Passes `tenantId` to `STLanguageService` methods
- `STLanguageService` uses `tenantId` for program lookup

**Impact:** Needs investigation. If `STLanguageService` uses tenant schema for program storage, same issue applies. However, ST language operations may be stateless (code analysis only). **Risk: MEDIUM** -- depends on whether language service queries tenant DB.

### SAFE: NATS Handlers That Use Separate Databases

#### 4. `notification-service/src/notification/event-handlers/task-event.handler.ts`

**Subscriptions:** `TaskCreated`, `TaskAssigned`, `TaskStatusChanged`, `TaskCompleted`, `TaskOverdue`

**Status: SAFE** -- notification-service uses its own `notification_service` database (not the shared `aquaculture` DB). Its tables (`device_tokens`, `notification_logs`) are not schema-isolated. The handler has proper `tenantId` validation and uses it as a column filter.

#### 5. `notification-service/src/notification/event-handlers/alert-triggered.handler.ts`

**Subscription:** `AlertTriggered`

**Status: SAFE** -- Same reason. Uses `notification_service` database. No schema isolation needed.

#### 6. `notification-service/src/notification/event-handlers/task-assigned.handler.ts`

**Status: SAFE** -- Deprecated handler (superseded by `TaskEventHandler`), but same database isolation applies.

### NOT APPLICABLE: Services Without NATS Handlers

- `hr-service`: No NATS event handlers (NATS only used for outbound notifications, currently disabled)
- `hydroponics-service`: No NATS event handlers
- `ai-service`: No NATS event handlers (only configures EventBusModule in app.module)

---

## Fix Pattern

For any NATS handler that queries tenant-specific tables, use a dedicated `QueryRunner` with explicit `search_path`:

```typescript
import { DataSource } from 'typeorm';

@Injectable()
export class MyNatsHandler implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS') private readonly eventBus: NatsEventBus,
  ) {}

  async onModuleInit() {
    await this.eventBus.subscribe('SomeEvent', {
      getEventType: () => 'SomeEvent',
      handle: (event) => this.handleEvent(event),
    });
  }

  async handleEvent(event: any): Promise<void> {
    const tenantId = event?.tenantId;
    if (!tenantId) {
      this.logger.error('NATS event missing tenantId -- skipping');
      return;
    }

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      this.logger.error(`NATS event has invalid tenantId format: ${tenantId}`);
      return;
    }

    // Build tenant schema name (must match TenantSchemaMiddleware.getTenantSchemaName)
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    const schemaName = `tenant_${cleanId}`;

    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.query(`SET search_path TO "${schemaName}", {source_schema}, public`);

      // Use queryRunner.manager instead of repositories
      const rules = await queryRunner.manager.find(AutoRule, {
        where: { tenantId, trigger: triggerType, isActive: true },
      });

      // ... business logic ...
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }
}
```

### Key Rules

1. **Always validate `tenantId`** -- reject events without it
2. **Always use a dedicated QueryRunner** -- never rely on the shared pool `search_path`
3. **Always `RESET search_path` in `finally`** -- prevent connection pool pollution
4. **Always `release()` the QueryRunner** -- prevent connection leaks
5. **Match the schema name algorithm** from `TenantSchemaMiddleware.getTenantSchemaName()`
6. **Include the source schema in search_path** -- `"tenant_xxx", farm, public` (so shared/reference tables resolve)

---

## Event Contract

All NATS events use `BaseEvent` from `libs/event-contracts/src/base-event.ts`:

```typescript
export interface BaseEvent {
  eventId: string;
  eventType: string;
  timestamp: Date;
  tenantId: string;      // REQUIRED -- always at top level
  correlationId?: string;
  causationId?: string;
  userId?: string;
  version: number;
  retryCount?: number;
}
```

`tenantId` is **required** on `BaseEvent`. The `IEvent` interface in `@platform/event-bus` marks it as optional (`tenantId?: string`), so handlers MUST validate its presence.

---

## Fix Strategies Applied

### Strategy A: Dedicated QueryRunner (farm-service/auto-rule-trigger.service.ts)

Used when the handler directly queries the database. Creates a `QueryRunner`, explicitly `SET search_path`, and uses `queryRunner.manager` for all operations. This is the same pattern used by `cron-jobs.service.ts`.

```typescript
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
try {
  await queryRunner.query(`SET search_path TO "${schemaName}", farm, public`);
  const rules = await queryRunner.manager.find(AutoRule, { where: { ... } });
  // ... business logic using queryRunner.manager ...
} finally {
  await queryRunner.query('RESET search_path').catch(() => {});
  await queryRunner.release();
}
```

### Strategy B: AsyncLocalStorage Context Injection (alert-engine/sensor-reading.handler.ts)

Used when the handler delegates to a service that uses injected repositories (refactoring the service to accept QueryRunner would be too invasive). Creates a synthetic `RequestContext` in `AsyncLocalStorage` so that `TenantConnectionBootstrap`'s pool patch sets the correct `search_path` on every connection checkout within the execution context.

```typescript
import { requestContextStorage, RequestContext } from '@platform/backend-common';

const schemaName = this.getTenantSchemaName(event.tenantId);
const context: RequestContext = { tenantId: event.tenantId, schemaName };

await requestContextStorage.run(context, async () => {
  await this.evaluationService.evaluateSensorReading({ ... });
});
```

**Trade-off:** Strategy B relies on the `TenantConnectionBootstrap` pool patch being active in the service. If the service creates its own `DataSource` or bypasses the pool, this will not work. Strategy A is more explicit and robust.

---

## Status

| Handler | Fixed | Strategy | PR |
|---------|-------|----------|----|
| `farm-service/auto-rule-trigger.service.ts` (NATS events) | YES | A (QueryRunner) | This commit |
| `farm-service/auto-rule-trigger.service.ts` (SCHEDULE cron) | YES | A (QueryRunner) | This commit |
| `alert-engine/sensor-reading.handler.ts` | YES | B (AsyncLocalStorage) | This commit |
| `sensor-service/st-language.handler.ts` | NO (needs investigation) | -- | -- |
