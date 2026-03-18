# Cron Job / Background Task Patterns

## The Problem

Cron jobs and background tasks run **outside HTTP request context**. There is no incoming
request, no JWT, no middleware chain. `AsyncLocalStorage` has no `schemaName`.
`TenantConnectionBootstrap` will use the default `search_path` (`source_schema`, `public`).
**ALL queries will hit the shared source schema, NOT tenant schemas.**

This means:

1. **ORM repositories** (`@InjectRepository`) resolve tables against the source schema
   (e.g. `farm`, `sensor`). If a table only exists in tenant schemas, queries return
   zero rows or throw "relation does not exist."
2. **Raw SQL** (`manager.query(...)`) runs against whatever `search_path` the connection
   was initialized with -- again, the source schema.
3. **Cross-tenant data leakage**: If the table exists in the source schema *and* tenant
   schemas (common with `DATABASE_SYNC=true`), the cron reads/writes rows from the
   source schema copy, silently mixing or losing tenant data.

### Why middleware doesn't help

The tenant schema middleware (`TenantSchemaMiddleware`) intercepts HTTP requests, extracts
`tenantId` from the JWT, derives `schemaName`, and stores it in `AsyncLocalStorage`.
`TenantConnectionBootstrap` picks it up on every new connection checkout and runs
`SET search_path TO "tenant_xxx", {source}, public`.

Cron jobs bypass all of this. There is no HTTP request, no JWT, no middleware invocation.
The `AsyncLocalStorage` store is empty. `TenantConnectionBootstrap` falls through to its
default path and sets `search_path` to just the source schema.

---

## Correct Pattern

**Reference implementation:**
`apps/farm-service/src/feeding/services/feeding-cron.service.ts` -- `cleanupOldExecutions()` (lines 612-734)

### Step-by-step

1. **Discover tenant schemas** -- use `listTenantSchemas()` from `@platform/backend-common`
   to query all `tenant_%` schemas from `information_schema.schemata`.
2. **For each tenant**, create a dedicated `QueryRunner`, set `search_path`, execute
   business logic, then release the runner.
3. **Isolate errors per tenant** -- one tenant's failure must not abort processing for
   the remaining tenants.
4. **Use advisory locks** for distributed deployments (multiple pods running the same
   cron).

### Complete reference code

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { listTenantSchemas } from '@platform/backend-common';

@Injectable()
export class ExampleCronService {
  private readonly logger = new Logger(ExampleCronService.name);

  // The source schema for this service (farm, sensor, hr, hydroponics, etc.)
  private readonly SOURCE_SCHEMA = 'farm';

  constructor(
    @InjectRepository(SomeEntity)
    private readonly someRepo: Repository<SomeEntity>,
    private readonly dataSource: DataSource,
  ) {}

  @Cron('0 */30 * * * *')
  async processAllTenants(): Promise<void> {
    this.logger.log('Starting cross-tenant cron job...');

    // ---------------------------------------------------------------
    // Step 1: Discover tenant schemas using shared utility
    // ---------------------------------------------------------------
    const tenantSchemas = await listTenantSchemas(this.dataSource);

    if (tenantSchemas.length === 0) {
      this.logger.debug('No tenants to process');
      return;
    }

    this.logger.log(`Processing ${tenantSchemas.length} tenants`);

    // ---------------------------------------------------------------
    // Step 2: Process each tenant with dedicated QueryRunner
    // ---------------------------------------------------------------
    for (const schemaName of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        // SET search_path for this tenant
        await queryRunner.query(
          `SET search_path TO "${schemaName}", ${this.SOURCE_SCHEMA}, public`,
        );

        // -----------------------------------------------------------
        // Step 3: Execute business logic using the queryRunner
        // -----------------------------------------------------------
        // Use queryRunner.query() or queryRunner.manager for all DB operations.
        // Do NOT use this.someRepo here -- it won't respect the queryRunner's search_path.
        const results = await queryRunner.query(
          `SELECT * FROM some_table WHERE status = $1 LIMIT $2`,
          ['PENDING', 100],
        );

        // Or use queryRunner.manager for TypeORM entity operations:
        // const items = await queryRunner.manager.find(SomeEntity, {
        //   where: { status: 'PENDING' },
        //   take: 100,
        // });

        for (const item of results) {
          await queryRunner.query(
            `UPDATE some_table SET status = $1 WHERE id = $2`,
            ['PROCESSED', item.id],
          );
        }

        this.logger.debug(`Schema ${schemaName}: processed ${results.length} items`);

      } catch (error) {
        // -----------------------------------------------------------
        // Step 3b: Error isolation -- log and continue to next tenant
        // -----------------------------------------------------------
        this.logger.error(
          `Failed to process schema ${schemaName}: ${(error as Error).message}`,
        );
        // Do NOT rethrow -- continue processing remaining tenants
      } finally {
        // -----------------------------------------------------------
        // Step 4: ALWAYS release the QueryRunner
        // -----------------------------------------------------------
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }

    this.logger.log('Cross-tenant cron job completed');
  }
}
```

### Key rules

| Rule | Why |
|------|-----|
| Use `listTenantSchemas()` from `@platform/backend-common` | Single source of truth for tenant discovery; eliminates duplicate inline SQL |
| Create a **new QueryRunner** per tenant | Each runner holds a single PG connection with its own `search_path` |
| Use `queryRunner.query()` or `queryRunner.manager` | The injected `@InjectRepository` does NOT use your queryRunner's connection |
| **RESET search_path** in `finally` | Prevents leaking tenant context if the connection returns to the pool |
| **Release the QueryRunner** in `finally` | Prevents connection pool exhaustion |
| **Catch per tenant**, don't rethrow | One tenant's error must not block others |

---

## Broken Examples

### 1. `cron-jobs.service.ts` -- All 7 cron methods (maintenance, alerts, reports)

**File:** `apps/farm-service/src/scheduler/cron-jobs.service.ts`

**Affected methods (lines):**
- `generateMaintenanceWorkOrders()` (line 219)
- `checkOverdueMaintenance()` (line 265)
- `checkOverdueWorkOrders()` (line 323)
- `checkLowStock()` (line 380)
- `weeklyMaintenanceSummary()` (line 437)
- `monthlyComplianceReport()` (line 497)
- `cleanupOldData()` (line 537)

**What's wrong:** These methods iterate over tenants (via `loadTenantConfigs()` which
queries distinct `tenantId` values), but they use `@InjectRepository` repositories
directly (`this.scheduleRepository.find(...)`, `this.workOrderRepository.find(...)`,
`this.sparePartRepository.find(...)`) without ever setting `search_path`. Every query
runs against the `farm` source schema, not tenant schemas.

The `tenantId` WHERE clause provides a false sense of security -- it filters by the
column value, but the query hits the *wrong table* (the source schema copy, not the
tenant's copy). If the source schema table is empty, zero rows are returned. If
`DATABASE_SYNC=true` populated both, you get stale or incorrect data.

**Broken pattern (all methods share this shape):**

```typescript
// BROKEN -- runs against farm schema, NOT tenant_xxx schema
async checkOverdueMaintenance(): Promise<void> {
  await this.loadTenantConfigs();
  const tenantIds = Array.from(this.tenantConfigs.keys());

  for (const tenantId of tenantIds) {
    // this.scheduleRepository uses the default connection's search_path
    // which is "farm, public" -- NOT "tenant_xxx, farm, public"
    const overdueSchedules = await this.scheduleRepository.find({
      where: {
        tenantId,
        status: MaintenanceScheduleStatus.ACTIVE,
      },
    });
    // ...
  }
}
```

---

### 2. `task.service.ts` -- `detectOverdueTasks()`

**File:** `apps/farm-service/src/task/services/task.service.ts`
**Line:** 518-577

**What's wrong:** Uses `this.taskRepository.manager.transaction()` with raw SQL
(`SELECT * FROM tasks ... FOR UPDATE SKIP LOCKED`) and `UPDATE tasks SET status = ...`.
No `search_path` is set. The transaction runs against the `farm` source schema.

The query `SELECT * FROM tasks WHERE status IN (...) AND "dueDate" < $3` will scan the
`farm.tasks` table (source schema), not any tenant's table. If `farm.tasks` is empty
(normal in production -- data lives in tenant schemas), zero rows are found and no
tasks are ever marked overdue.

```typescript
// BROKEN -- no search_path, hits farm.tasks instead of tenant_xxx.tasks
@Cron('0 */30 * * * *')
async detectOverdueTasks(): Promise<void> {
  await this.taskRepository.manager.transaction(async (manager) => {
    // This query runs against the default search_path (farm, public)
    const overdueTasks: Task[] = await manager.query(
      `SELECT * FROM tasks
       WHERE status IN ($1, $2)
       AND "dueDate" < $3
       AND "deletedAt" IS NULL
       FOR UPDATE SKIP LOCKED`,
      [TaskStatus.PENDING, TaskStatus.IN_PROGRESS, now],
    );
    // ...updates also hit wrong schema...
  });
}
```

---

### 3. `recurring-task.service.ts` -- `generateDueTasks()`

**File:** `apps/farm-service/src/task/services/recurring-task.service.ts`
**Line:** 143-210+

**What's wrong:** Same pattern as `detectOverdueTasks()`. Uses
`this.templateRepository.manager.transaction()` with raw SQL against
`recurring_templates` and `tasks` tables. No `search_path` is set. All reads and
writes hit the `farm` source schema.

```typescript
// BROKEN -- no search_path
@Cron('0 */15 * * * *')
async generateDueTasks(): Promise<Task[]> {
  await this.templateRepository.manager.transaction(async (manager) => {
    // Hits farm.recurring_templates, not tenant_xxx.recurring_templates
    const dueTemplates = await manager.query(
      `SELECT * FROM recurring_templates WHERE ...`,
    );
    // ...creates tasks in farm.tasks, not tenant schemas...
  });
}
```

---

### 4. `auto-rule-trigger.service.ts` -- `processScheduleRules()`

**File:** `apps/farm-service/src/task/services/auto-rule-trigger.service.ts`
**Line:** 187-227

**What's wrong:** Uses `this.autoRuleRepository.find()` without `search_path`. The
`find()` call hits the `farm` source schema. Schedule-type auto rules stored in tenant
schemas will never be found.

```typescript
// BROKEN -- no search_path
@Cron('0 0 * * * *')
async processScheduleRules(): Promise<void> {
  // Hits farm.auto_rules, not tenant_xxx.auto_rules
  const scheduleRules = await this.autoRuleRepository.find({
    where: {
      trigger: AutoRuleTrigger.SCHEDULE,
      isActive: true,
    },
  });
  // ...
}
```

---

### 5. `edge-device.service.ts` -- `markStaleDevicesOffline()`

**File:** `apps/sensor-service/src/edge-device/edge-device.service.ts`
**Line:** 688-714

**What's wrong:** Uses `this.deviceRepository.createQueryBuilder().update(...).execute()`
with no `search_path` set. The `@Interval(60_000)` decorator fires every 60 seconds
outside any request context. The UPDATE hits `sensor.edge_devices` (source schema),
not any tenant's edge_devices table.

Additionally, there is **no tenant iteration at all** -- the query runs once globally,
which means if data exists in the source schema, it would update across all tenants
indiscriminately (violating tenant isolation).

```typescript
// BROKEN -- no search_path, no tenant iteration, hits sensor.edge_devices
@Interval(60_000)
async markStaleDevicesOffline(timeoutMinutes = 5): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  // Runs against sensor schema -- not any tenant schema
  const result = await this.deviceRepository
    .createQueryBuilder()
    .update(EdgeDevice)
    .set({
      isOnline: false,
      lifecycleState: DeviceLifecycleState.OFFLINE,
    })
    .where('isOnline = :online', { online: true })
    .andWhere('lastSeenAt < :cutoff', { cutoff })
    .andWhere('lifecycleState NOT IN (:...excluded)', {
      excluded: [
        DeviceLifecycleState.DECOMMISSIONED,
        DeviceLifecycleState.MAINTENANCE,
      ],
    })
    .execute();

  return result.affected || 0;
}
```

---

### 6. `feeding-scheduler.service.ts` -- All 6 cron methods

**File:** `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`

**Affected methods (lines):**
- `generateDailyFeedingPlan()` (line 732)
- `sendFeedingReminders()` (line 762)
- `dailyFeedingSummary()` (line 803)
- `analyzeFCR()` (line 842)
- `checkFeedStock()` (line 887)
- `weeklyFeedForecast()` (line 937)

**What's wrong:** Same pattern as `cron-jobs.service.ts`. These methods call helper
methods (e.g. `generateTenantFeedingPlan()`, `getUpcomingFeedings()`, `checkFCRAlerts()`,
`getLowStockFeeds()`) which likely use injected repositories without `search_path`
context. The tenant iteration exists but the database queries run against the `farm`
source schema.

---

## Migration Guide

### Fix 1: `cron-jobs.service.ts` -- Add QueryRunner per tenant

**Before (broken):**

```typescript
@Cron(CronExpression.EVERY_DAY_AT_7AM, { name: 'checkOverdueMaintenance', timeZone: 'Europe/Istanbul' })
async checkOverdueMaintenance(): Promise<void> {
  await this.loadTenantConfigs();
  const tenantIds = Array.from(this.tenantConfigs.keys());

  for (const tenantId of tenantIds) {
    const config = this.getTenantConfig(tenantId);
    if (!config?.alertsEnabled) continue;

    try {
      const overdueSchedules = await this.scheduleRepository.find({
        where: { tenantId, status: MaintenanceScheduleStatus.ACTIVE },
      });

      const actuallyOverdue = overdueSchedules.filter((s) => s.isOverdue());
      // ... emit events ...
    } catch (error) {
      this.logger.error(`Failed for tenant ${tenantId}: ${error}`);
    }
  }
}
```

**After (fixed):**

```typescript
@Cron(CronExpression.EVERY_DAY_AT_7AM, { name: 'checkOverdueMaintenance', timeZone: 'Europe/Istanbul' })
async checkOverdueMaintenance(): Promise<void> {
  await this.loadTenantConfigs();
  const tenantIds = Array.from(this.tenantConfigs.keys());

  for (const tenantId of tenantIds) {
    const config = this.getTenantConfig(tenantId);
    if (!config?.alertsEnabled) continue;

    const schemaName = `tenant_${tenantId.replace(/-/g, '').substring(0, 16).toLowerCase()}`;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query(`SET search_path TO "${schemaName}", farm, public`);

      const overdueSchedules = await queryRunner.manager.find(MaintenanceSchedule, {
        where: { tenantId, status: MaintenanceScheduleStatus.ACTIVE },
      });

      const actuallyOverdue = overdueSchedules.filter((s) => s.isOverdue());

      if (actuallyOverdue.length > 0) {
        this.eventEmitter.emit('maintenance.overdue', { tenantId, schedules: actuallyOverdue });
      }

      const upcoming = overdueSchedules.filter((s) => {
        const days = s.getDaysUntilDue();
        return days >= 0 && days <= 3;
      });

      if (upcoming.length > 0) {
        this.eventEmitter.emit('maintenance.upcoming', { tenantId, schedules: upcoming });
      }
    } catch (error) {
      this.logger.error(`Failed to check overdue maintenance for tenant ${tenantId}: ${error}`);
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }
}
```

**Required changes to `CronJobsService`:**
1. Add `DataSource` injection to the constructor:
   ```typescript
   constructor(
     // ... existing injections ...
     private readonly dataSource: DataSource,  // ADD THIS
   ) {}
   ```
2. Apply the same QueryRunner pattern to all 6 active cron methods.

---

### Fix 2: `task.service.ts` -- `detectOverdueTasks()`

**Before (broken):**

```typescript
@Cron('0 */30 * * * *')
async detectOverdueTasks(): Promise<void> {
  const now = new Date();

  await this.taskRepository.manager.transaction(async (manager) => {
    const overdueTasks: Task[] = await manager.query(
      `SELECT * FROM tasks
       WHERE status IN ($1, $2) AND "dueDate" < $3 AND "deletedAt" IS NULL
       FOR UPDATE SKIP LOCKED`,
      [TaskStatus.PENDING, TaskStatus.IN_PROGRESS, now],
    );

    // ... single transaction across all tenants ...
    const ids = overdueTasks.map(t => t.id);
    await manager.query(
      `UPDATE tasks SET status = $1, "updatedAt" = NOW() WHERE id = ANY($2::uuid[])`,
      [TaskStatus.OVERDUE, ids],
    );
  });
}
```

**After (fixed):**

```typescript
@Cron('0 */30 * * * *')
async detectOverdueTasks(): Promise<void> {
  this.logger.log('Running overdue task detection...');
  const now = new Date();

  // Step 1: Discover all tenant schemas
  const tenantSchemas: { schemaName: string }[] = await this.dataSource.query(`
    SELECT schema_name AS "schemaName"
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
    ORDER BY schema_name
  `);

  if (tenantSchemas.length === 0) {
    this.logger.debug('No tenant schemas found');
    return;
  }

  // Step 2: Process each tenant with its own QueryRunner
  for (const { schemaName } of tenantSchemas) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query(`SET search_path TO "${schemaName}", farm, public`);

      // Use a transaction within the tenant's schema context
      await queryRunner.startTransaction();

      const overdueTasks: Task[] = await queryRunner.query(
        `SELECT * FROM tasks
         WHERE status IN ($1, $2)
         AND "dueDate" < $3
         AND "deletedAt" IS NULL
         FOR UPDATE SKIP LOCKED`,
        [TaskStatus.PENDING, TaskStatus.IN_PROGRESS, now],
      );

      if (overdueTasks.length === 0) {
        await queryRunner.commitTransaction();
        continue;
      }

      const ids = overdueTasks.map(t => t.id);
      await queryRunner.query(
        `UPDATE tasks SET status = $1, "updatedAt" = NOW() WHERE id = ANY($2::uuid[])`,
        [TaskStatus.OVERDUE, ids],
      );

      await queryRunner.commitTransaction();

      // Emit events per tenant (group by tenantId from results)
      if (this.eventBus) {
        for (const task of overdueTasks) {
          try {
            const hoursOverdue = Math.round(
              (now.getTime() - new Date(task.dueDate).getTime()) / 3600000,
            );
            await this.eventBus.publish({
              ...createBaseEvent('TaskOverdue', task.tenantId),
              taskId: task.id,
              title: task.title,
              assignedTo: task.assignedTo,
              dueDate: new Date(task.dueDate).toISOString(),
              priority: task.priority,
              hoursOverdue,
            });
          } catch (eventError) {
            this.logger.warn(
              `Failed to publish TaskOverdue event for task ${task.id}: ${(eventError as Error).message}`,
            );
          }
        }
      }

      this.logger.log(
        `Schema ${schemaName}: marked ${overdueTasks.length} tasks as overdue`,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction().catch(() => {});
      this.logger.error(
        `Failed to detect overdue tasks in ${schemaName}: ${(error as Error).message}`,
      );
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }
}
```

**Required changes to `TaskService`:**
1. Add `DataSource` injection:
   ```typescript
   constructor(
     // ... existing injections ...
     private readonly dataSource: DataSource,  // ADD THIS
   ) {}
   ```

---

### Fix 3: `recurring-task.service.ts` -- `generateDueTasks()`

**Before (broken):**

```typescript
@Cron('0 */15 * * * *')
async generateDueTasks(): Promise<Task[]> {
  const now = new Date();
  const generatedTasks: Task[] = [];

  await this.templateRepository.manager.transaction(async (manager) => {
    const dueTemplates = await manager.query(
      `SELECT * FROM recurring_templates
       WHERE "isActive" = true AND "nextGeneration" <= $1 AND "deletedAt" IS NULL
       FOR UPDATE SKIP LOCKED`,
      [now],
    );
    // ... creates tasks in wrong schema ...
  });

  return generatedTasks;
}
```

**After (fixed):**

```typescript
@Cron('0 */15 * * * *')
async generateDueTasks(): Promise<Task[]> {
  this.logger.log('Running recurring task generation...');
  const now = new Date();
  const generatedTasks: Task[] = [];

  const tenantSchemas: { schemaName: string }[] = await this.dataSource.query(`
    SELECT schema_name AS "schemaName"
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
    ORDER BY schema_name
  `);

  for (const { schemaName } of tenantSchemas) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query(`SET search_path TO "${schemaName}", farm, public`);
      await queryRunner.startTransaction();

      const dueTemplates: RecurringTemplate[] = await queryRunner.query(
        `SELECT * FROM recurring_templates
         WHERE "isActive" = true
         AND "nextGeneration" <= $1
         AND "deletedAt" IS NULL
         FOR UPDATE SKIP LOCKED`,
        [now],
      );

      if (dueTemplates.length === 0) {
        await queryRunner.commitTransaction();
        continue;
      }

      for (const template of dueTemplates) {
        try {
          const dueDate = this.calculateDueDate();

          const task = queryRunner.manager.create(Task, {
            tenantId: template.tenantId,
            title: template.title,
            description: template.description,
            category: template.category,
            priority: template.priority,
            status: TaskStatus.PENDING,
            assignedTo: template.assignedTo,
            assignedToName: template.assignedToName,
            createdBy: template.assignedTo,
            dueDate,
            location: template.location,
            estimatedMinutes: template.estimatedMinutes,
            checklistItems: template.checklistItems ? [...template.checklistItems] : [],
            notes: [],
            tags: template.tags,
            isRecurring: true,
            recurringTemplateId: template.id,
            isAutoGenerated: true,
          });

          const saved = await queryRunner.manager.save(Task, task);
          generatedTasks.push(saved);

          // Update nextGeneration on the template
          // ... (existing logic using queryRunner.manager) ...

        } catch (err) {
          this.logger.error(
            `Failed to generate task from template ${template.id}: ${(err as Error).message}`,
          );
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction().catch(() => {});
      this.logger.error(
        `Failed recurring task generation in ${schemaName}: ${(error as Error).message}`,
      );
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }

  return generatedTasks;
}
```

---

### Fix 4: `auto-rule-trigger.service.ts` -- `processScheduleRules()`

**Before (broken):**

```typescript
@Cron('0 0 * * * *')
async processScheduleRules(): Promise<void> {
  const scheduleRules = await this.autoRuleRepository.find({
    where: { trigger: AutoRuleTrigger.SCHEDULE, isActive: true },
  });
  // ...
}
```

**After (fixed):**

```typescript
@Cron('0 0 * * * *')
async processScheduleRules(): Promise<void> {
  this.logger.debug('Checking SCHEDULE-type AutoRules...');

  const tenantSchemas: { schemaName: string }[] = await this.dataSource.query(`
    SELECT schema_name AS "schemaName"
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
    ORDER BY schema_name
  `);

  const now = new Date();

  for (const { schemaName } of tenantSchemas) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query(`SET search_path TO "${schemaName}", farm, public`);

      const scheduleRules = await queryRunner.manager.find(AutoRule, {
        where: { trigger: AutoRuleTrigger.SCHEDULE, isActive: true },
      });

      if (scheduleRules.length === 0) continue;

      for (const rule of scheduleRules) {
        try {
          const intervalHours = parseInt(rule.triggerCondition, 10);
          if (isNaN(intervalHours) || intervalHours <= 0) {
            this.logger.warn(`Invalid SCHEDULE interval for rule ${rule.id}: "${rule.triggerCondition}"`);
            continue;
          }

          if (rule.lastTriggered) {
            const elapsed = (now.getTime() - new Date(rule.lastTriggered).getTime()) / 3600000;
            if (elapsed < intervalHours) continue;
          }

          await this.executeRule(rule, { tenantId: rule.tenantId });
        } catch (err) {
          this.logger.error(`Failed to process SCHEDULE rule ${rule.id}: ${(err as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to process schedule rules in ${schemaName}: ${(error as Error).message}`,
      );
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }
}
```

---

### Fix 5: `edge-device.service.ts` -- `markStaleDevicesOffline()`

**Before (broken):**

```typescript
@Interval(60_000)
async markStaleDevicesOffline(timeoutMinutes = 5): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const result = await this.deviceRepository
    .createQueryBuilder()
    .update(EdgeDevice)
    .set({ isOnline: false, lifecycleState: DeviceLifecycleState.OFFLINE })
    .where('isOnline = :online', { online: true })
    .andWhere('lastSeenAt < :cutoff', { cutoff })
    .andWhere('lifecycleState NOT IN (:...excluded)', {
      excluded: [DeviceLifecycleState.DECOMMISSIONED, DeviceLifecycleState.MAINTENANCE],
    })
    .execute();

  return result.affected || 0;
}
```

**After (fixed):**

```typescript
@Interval(60_000)
async markStaleDevicesOffline(timeoutMinutes = 5): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
  let totalAffected = 0;

  // Discover tenant schemas
  const tenantSchemas: { schemaName: string }[] = await this.dataSource.query(`
    SELECT schema_name AS "schemaName"
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
    ORDER BY schema_name
  `);

  for (const { schemaName } of tenantSchemas) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query(`SET search_path TO "${schemaName}", sensor, public`);

      const result = await queryRunner.query(
        `UPDATE edge_devices
         SET "isOnline" = false,
             "lifecycleState" = $1
         WHERE "isOnline" = true
         AND "lastSeenAt" < $2
         AND "lifecycleState" NOT IN ($3, $4)`,
        [
          DeviceLifecycleState.OFFLINE,
          cutoff,
          DeviceLifecycleState.DECOMMISSIONED,
          DeviceLifecycleState.MAINTENANCE,
        ],
      );

      const affected = result?.rowCount ?? result?.affected ?? 0;
      if (affected > 0) {
        this.logger.log(`Schema ${schemaName}: marked ${affected} devices as offline`);
        totalAffected += affected;
      }
    } catch (error) {
      this.logger.error(
        `Failed to mark stale devices in ${schemaName}: ${(error as Error).message}`,
      );
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }

  if (totalAffected > 0) {
    this.logger.log(`Total: marked ${totalAffected} devices as offline across all tenants`);
  }

  return totalAffected;
}
```

**Note:** The source schema for sensor-service is `sensor`, not `farm`.

---

## Summary of all broken crons

| Service | File | Method | Line | Issue |
|---------|------|--------|------|-------|
| farm | `scheduler/cron-jobs.service.ts` | `generateMaintenanceWorkOrders` | 219 | No `search_path`, uses injected repos |
| farm | `scheduler/cron-jobs.service.ts` | `checkOverdueMaintenance` | 265 | No `search_path`, uses injected repos |
| farm | `scheduler/cron-jobs.service.ts` | `checkOverdueWorkOrders` | 323 | No `search_path`, uses injected repos |
| farm | `scheduler/cron-jobs.service.ts` | `checkLowStock` | 380 | No `search_path`, uses injected repos |
| farm | `scheduler/cron-jobs.service.ts` | `weeklyMaintenanceSummary` | 437 | No `search_path`, uses injected repos |
| farm | `scheduler/cron-jobs.service.ts` | `monthlyComplianceReport` | 497 | No `search_path`, uses injected repos |
| farm | `scheduler/cron-jobs.service.ts` | `cleanupOldData` | 537 | No `search_path` (stub, but pattern wrong) |
| farm | `scheduler/feeding-scheduler.service.ts` | `generateDailyFeedingPlan` | 732 | No `search_path` in helper methods |
| farm | `scheduler/feeding-scheduler.service.ts` | `sendFeedingReminders` | 762 | No `search_path` in helper methods |
| farm | `scheduler/feeding-scheduler.service.ts` | `dailyFeedingSummary` | 803 | No `search_path` in helper methods |
| farm | `scheduler/feeding-scheduler.service.ts` | `analyzeFCR` | 842 | No `search_path` in helper methods |
| farm | `scheduler/feeding-scheduler.service.ts` | `checkFeedStock` | 887 | No `search_path` in helper methods |
| farm | `scheduler/feeding-scheduler.service.ts` | `weeklyFeedForecast` | 937 | No `search_path` in helper methods |
| farm | `task/services/task.service.ts` | `detectOverdueTasks` | 518 | No `search_path`, single transaction |
| farm | `task/services/recurring-task.service.ts` | `generateDueTasks` | 143 | No `search_path`, single transaction |
| farm | `task/services/auto-rule-trigger.service.ts` | `processScheduleRules` | 187 | No `search_path`, uses injected repo |
| sensor | `edge-device/edge-device.service.ts` | `markStaleDevicesOffline` | 688 | No `search_path`, no tenant iteration |

**Correct reference:** `apps/farm-service/src/feeding/services/feeding-cron.service.ts`
-- `cleanupOldExecutions()` (line 612) demonstrates the proper QueryRunner + `SET search_path`
pattern with per-tenant error isolation.
