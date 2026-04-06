# Recommendations -- Farm Expert: S2 High Findings Audit
**Date:** 2026-04-05
**Linked Review:** `docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md`

---

## REC-001: Wrap UpdateBatchStatusHandler Save in QueryRunner Transaction

**Addresses:** HIGH-001
**File:** `apps/farm-service/src/batch/handlers/update-batch-status.handler.ts`
**Priority:** HIGH -- deploy blocker

### Root Cause
The handler uses `this.batchRepository.save(batch)` (bare ORM save) with no explicit transaction. The event is then published immediately after the save returns, before any commit guarantee. Reference implementation in `CloseBatchHandler` (lines 98-113) shows the correct pattern.

### Required Change

Inject `DataSource` and replace lines 78-97 with the following structure:

```typescript
constructor(
  private readonly dataSource: DataSource,           // ADD THIS
  @InjectRepository(Batch)
  private readonly batchRepository: Repository<Batch>,
  private readonly eventPublisher: DomainEventPublisher,
) {}

// Inside execute():
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction();

let savedBatch: Batch;
try {
  savedBatch = await queryRunner.manager.save(Batch, batch);
  await queryRunner.commitTransaction();
} catch (error) {
  await queryRunner.rollbackTransaction();
  throw error;
} finally {
  await queryRunner.release();
}

this.logger.log(`Batch ${batchId} status: ${previousStatus} → ${newStatus}, tenant: ${tenantId}`);

// Publish AFTER commit
await this.eventPublisher.publish(
  {
    eventId: crypto.randomUUID(),
    eventType: 'BatchStatusChanged',
    timestamp: new Date(),
    tenantId,
    batchId: savedBatch.id,
    previousStatus,
    newStatus,
    reason,
    userId: updatedBy,
    version: 1,
  },
  { handler: UpdateBatchStatusHandler.name, tenantId, aggregateId: batchId },
);

return savedBatch;
```

### Validation
- Unit test: mock `DataSource.createQueryRunner()` to throw on `commitTransaction()`; verify event is NOT published.
- Unit test: happy path -- verify event IS published after successful commit.

---

## REC-002: Fix generateCode() to Use QueryRunner Manager

**Addresses:** HIGH-002
**File:** `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
**Priority:** HIGH -- lot traceability / regulatory risk

### Root Cause
`generateCode()` uses the injected `this.harvestRepository` which operates on a separate pooled connection outside the QueryRunner transaction. Two concurrent calls will both read the same last sequence value and produce the same code.

### Required Change

Change the `generateCode` signature to accept an `EntityManager` parameter and execute against it:

```typescript
private async generateCode(
  manager: EntityManager,   // ADD: receives queryRunner.manager
  tenantId: string,
  prefix: string,
): Promise<string> {
  const year = new Date().getFullYear();

  // Query WITHIN the transaction using the provided manager
  const lastRecord = await manager
    .createQueryBuilder(HarvestRecord, 'hr')
    .where('hr.tenantId = :tenantId', { tenantId })
    .andWhere(
      prefix === 'HR'
        ? 'hr.recordCode LIKE :pattern'
        : 'hr.lotNumber LIKE :pattern',
      { pattern: `${prefix}-${year}-%` },
    )
    .orderBy(
      prefix === 'HR' ? 'hr.recordCode' : 'hr.lotNumber',
      'DESC',
    )
    .setLock('pessimistic_read')  // Prevent concurrent reads from racing
    .getOne();

  let sequence = 1;
  if (lastRecord) {
    const codeField = prefix === 'HR' ? lastRecord.recordCode : lastRecord.lotNumber;
    const match = codeField.match(new RegExp(`${prefix}-${year}-(\\d+)`));
    if (match?.[1]) {
      sequence = parseInt(match[1], 10) + 1;
    }
  }

  return `${prefix}-${year}-${sequence.toString().padStart(5, '0')}`;
}
```

Then update the call sites inside `execute()` (lines 102-103) to pass `queryRunner.manager`:

```typescript
const recordCode = await this.generateCode(queryRunner.manager, tenantId, 'HR');
const lotNumber  = await this.generateCode(queryRunner.manager, tenantId, 'LOT');
```

Add the `EntityManager` import from `typeorm` at the top of the file.

### Note on Long-Term Architecture
For high-throughput harvesting, consider replacing the sequence query with a PostgreSQL sequence object (`CREATE SEQUENCE hr_code_seq_<tenantId>`) or a dedicated `HarvestCodeGenerator` service backed by a `SELECT ... FOR UPDATE` on a counter table. This is a MEDIUM follow-up, not a blocker.

---

## REC-003: Add Transaction, Pessimistic Lock, and Audit Trail to UpdateHarvestRecordHandler

**Addresses:** HIGH-003
**File:** `apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts`
**Priority:** HIGH

### Root Cause
Three independent deficiencies: no QueryRunner transaction, no pessimistic lock, no `updatedBy` write-through.

### Required Change

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';      // ADD DataSource
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateHarvestRecordCommand } from '../commands/update-harvest-record.command';
import { HarvestRecord } from '../entities/harvest-record.entity';

@Injectable()
@CommandHandler(UpdateHarvestRecordCommand)
export class UpdateHarvestRecordHandler implements ICommandHandler<UpdateHarvestRecordCommand, HarvestRecord> {
  constructor(
    private readonly dataSource: DataSource,             // ADD
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
  ) {}

  async execute(command: UpdateHarvestRecordCommand): Promise<HarvestRecord> {
    const { tenantId, harvestRecordId, data, updatedBy } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Pessimistic lock prevents last-write-wins on concurrent updates
      const harvestRecord = await queryRunner.manager.findOne(HarvestRecord, {
        where: { id: harvestRecordId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!harvestRecord) {
        throw new NotFoundException(`Harvest record ${harvestRecordId} not found`);
      }

      // ... field assignments (unchanged) ...

      // Write audit trail
      harvestRecord.updatedBy = updatedBy;   // ADD -- requires field on entity

      const saved = await queryRunner.manager.save(HarvestRecord, harvestRecord);
      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
```

### Entity Prerequisite
Verify that `HarvestRecord` has an `updatedBy` column. If not, add:
```typescript
@Column({ name: 'updated_by', type: 'uuid', nullable: true })
updatedBy?: string;
```
This requires a migration. Flag for data-expert review.

---

## REC-004: Publish BatchHarvestedEvent in CreateHarvestRecordHandler

**Addresses:** HIGH-004
**File:** `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
**Priority:** HIGH -- CQRS architecture violation

### Root Cause
Handler commits harvest state to the database but publishes no domain event. `BatchHarvestedEvent` is defined in event contracts and consumed downstream.

### Required Change

Inject `DomainEventPublisher` and add event publication after `queryRunner.commitTransaction()` (after line 236):

```typescript
// 1. Add import
import { DomainEventPublisher } from '../../common/services/domain-event-publisher.service';

// 2. Inject in constructor
constructor(
  private readonly dataSource: DataSource,
  @InjectRepository(HarvestRecord)
  private readonly harvestRepository: Repository<HarvestRecord>,
  @InjectRepository(Batch)
  private readonly batchRepository: Repository<Batch>,
  @InjectRepository(TankOperation)
  private readonly operationRepository: Repository<TankOperation>,
  @InjectRepository(TankBatch)
  private readonly tankBatchRepository: Repository<TankBatch>,
  @InjectRepository(Tank)
  private readonly tankRepository: Repository<Tank>,
  private readonly eventPublisher: DomainEventPublisher,  // ADD
) {}

// 3. After commitTransaction() inside the execute() method:
await queryRunner.commitTransaction();

// Publish BatchHarvested event AFTER commit (matches BatchHarvestedEvent contract)
await this.eventPublisher.publish(
  {
    eventId: crypto.randomUUID(),
    eventType: 'BatchHarvested',
    timestamp: new Date(),
    tenantId,
    batchId: input.batchId,
    harvestedQuantity: input.quantityHarvested,
    harvestedAt: harvestDate,
    averageWeight: input.averageWeight,
    totalWeight: biomassKg,
    version: 1,
  },
  { handler: 'CreateHarvestRecordHandler', tenantId, aggregateId: input.batchId },
);

return harvestRecord;
```

### Cross-Domain Flag
Notify **platform-services** and **messaging-expert** that `BatchHarvestedEvent` will now begin flowing. Downstream consumers should be verified before deploying this change.

---

## REC-005: Fix cleanupOldExecutions Schema Name Construction in FeedingCronService

**Addresses:** HIGH-005
**File:** `apps/farm-service/src/feeding/services/feeding-cron.service.ts`
**Priority:** HIGH -- potential cross-tenant data deletion

### Root Cause
Schema name is constructed by string manipulation of `tenantId` values from a database query (line 731), then interpolated into a `SET search_path` SQL string. The correct approach is to enumerate schema names from `information_schema` via `listTenantSchemas()`, which already validates schema names against the database catalog.

### Required Change

Replace the per-tenant schema detection and cleanup loop (lines 700-781) with the `listTenantSchemas()` pattern already used by `generateDailyPlans()` and `checkFeedTransitions()`:

```typescript
async cleanupOldExecutions(): Promise<void> {
  // ... lock acquisition and date calculation unchanged ...

  // Use listTenantSchemas() for validated schema names (same as generateDailyPlans)
  const tenantSchemas = await listTenantSchemas(this.dataSource);

  if (tenantSchemas.length === 0) {
    this.logger.log('No tenant schemas found', { jobId: context.jobId });
    return;
  }

  let totalDeleted = 0;
  const deletedByTenant: Record<string, number> = {};

  for (const schema of tenantSchemas) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Schema name is from information_schema catalog -- trusted source
      await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

      let deleted = 0;
      let tenantDeleted = 0;
      let iterations = 0;
      const maxIterations = 100;

      do {
        // Batch delete -- no tenantId filter needed because search_path
        // scopes the query to this tenant's schema
        const result = await queryRunner.query(
          `DELETE FROM daily_feeding_executions
           WHERE id IN (
             SELECT id FROM daily_feeding_executions
             WHERE "executionDate" < $1
             AND status = ANY($2)
             LIMIT $3
           )`,
          [oneYearAgo, [ExecutionStatus.COMPLETED, ExecutionStatus.SKIPPED], CLEANUP_BATCH_SIZE],
        );

        deleted = result?.rowCount ?? 0;
        tenantDeleted += deleted;
        iterations++;

        if (deleted === CLEANUP_BATCH_SIZE) {
          await this.sleep(100);
        }

      } while (deleted === CLEANUP_BATCH_SIZE && iterations < maxIterations);

      if (tenantDeleted > 0) {
        deletedByTenant[schema] = tenantDeleted;
        totalDeleted += tenantDeleted;
      }

      if (iterations >= maxIterations) {
        this.logger.warn(
          `Cleanup for schema ${schema} reached max iterations`,
          { jobId: context.jobId, schema, deleted: tenantDeleted },
        );
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Cleanup failed for schema ${schema}: ${err.message}`,
        err.stack,
        { jobId: context.jobId },
      );
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }

  // ... rest of the method (logging, metrics emission) unchanged ...
}
```

### Key Security Properties of This Fix
1. Schema names come from `information_schema.schemata` via `listTenantSchemas()`, which is read-only catalog data that cannot be tampered with by application-layer inputs.
2. The `DELETE` query operates within the scoped `search_path`, removing the need to pass `tenantId` as a parameter to the delete -- eliminating the cross-tenant parameter risk.
3. The string manipulation of `tenantId` (line 731, current code) is removed entirely.
