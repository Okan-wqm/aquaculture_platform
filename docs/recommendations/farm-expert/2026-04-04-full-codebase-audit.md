# Development Recommendations -- Farm Expert
**Date:** 2026-04-04
**Related Review:** `docs/reviews/farm-expert/2026-04-04-full-codebase-audit.md`

## Recommendations

---

### REC-001: Fix Tenant Isolation in FeedingSchedulerService (addresses CRITICAL-001)
**Priority:** CRITICAL
**Estimated Effort:** S
**Files to Modify:**
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` -- add tenantId parameter to 3 methods and include in WHERE clauses

**Recommended Implementation:**

For `executeFeedingSchedule`:
```typescript
async executeFeedingSchedule(
  tenantId: string,  // ADD THIS PARAMETER
  scheduleId: string,
  executedBy: string = 'system',
  actualAmount?: number,
  notes?: string,
): Promise<FeedingExecutionResult> {
  const feedingTable = await this.feedingTableRepository.findOne({
    where: { id: scheduleId, tenantId },  // ADD tenantId
    relations: ['batch', 'feed'],
  });
  // ...
}
```

For `updateFeedingStatus`:
```typescript
async updateFeedingStatus(
  tenantId: string,  // ADD THIS PARAMETER
  id: string,
  status: FeedingStatus,
  reason?: string,
  updatedBy?: string,
): Promise<FeedingRecord> {
  const feedingRecord = await this.feedingRecordRepository.findOne({
    where: { id, tenantId },  // ADD tenantId
  });
  // ...
}
```

For `calculateFeedAmount`:
```typescript
async calculateFeedAmount(
  tenantId: string,  // ADD THIS PARAMETER
  batchId: string,
  waterTemperature?: number,
): Promise<FeedAmountCalculation> {
  const batch = await this.batchRepository.findOne({
    where: { id: batchId, tenantId },  // ADD tenantId
  });
  // ...
}
```

**Acceptance Criteria:**
- [ ] All three methods require `tenantId` as a parameter
- [ ] All database queries include `tenantId` in the WHERE clause
- [ ] All callers of these methods are updated to pass `tenantId`
- [ ] Unit tests verify that queries without matching tenantId return NotFoundException

---

### REC-002: Fix TOCTOU Race Condition in RecordCullHandler (addresses CRITICAL-002)
**Priority:** CRITICAL
**Estimated Effort:** M
**Files to Modify:**
- `apps/farm-service/src/batch/handlers/record-cull.handler.ts` -- move reads inside transaction, add pessimistic locks, add Math.max guards
- `apps/farm-service/src/batch/__tests__/handlers/record-cull.handler.spec.ts` -- create test file

**Recommended Implementation:**

Follow the pattern established in `RecordMortalityHandler` (which was already fixed):
```typescript
async execute(command: RecordCullCommand): Promise<Batch> {
  const { tenantId, batchId, payload, recordedBy } = command;

  const queryRunner = this.dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  let batch: Batch;

  try {
    // ALL reads inside transaction with pessimistic locks
    const foundBatch = await queryRunner.manager.findOne(Batch, {
      where: { id: batchId, tenantId, isActive: true },
      lock: { mode: 'pessimistic_write' },
    });

    if (!foundBatch) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }
    batch = foundBatch;

    // Tank lookup via manager (transaction-safe)
    const tankLookup = await findTankOrEquipmentWithManager(
      queryRunner.manager, payload.tankId, tenantId,
    );
    if (!tankLookup) {
      throw new NotFoundException(`Tank ${payload.tankId} not found`);
    }
    const tank = tankLookup.equipment;

    // Validation
    if (payload.quantity > batch.currentQuantity) {
      throw new BadRequestException(
        `Cull count (${payload.quantity}) exceeds current quantity (${batch.currentQuantity})`
      );
    }

    const avgWeightG = payload.avgWeightG || batch.getCurrentAvgWeight();
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    const tankBatch = await queryRunner.manager.findOne(TankBatch, {
      where: { tenantId, tankId: payload.tankId },
      lock: { mode: 'pessimistic_write' },
    });

    // ... create TankOperation ...

    // Update batch with Math.max guards
    batch.cullCount += payload.quantity;
    batch.currentQuantity = Math.max(0, batch.currentQuantity - payload.quantity);
    batch.retentionRate = batch.getRetentionRate();
    batch.updatedBy = recordedBy;
    await queryRunner.manager.save(Batch, batch);

    // Update TankBatch with Math.max guards
    if (tankBatch) {
      tankBatch.totalQuantity = Math.max(0, Number(tankBatch.totalQuantity) - payload.quantity);
      tankBatch.totalBiomassKg = Math.max(0, Number(tankBatch.totalBiomassKg) - biomassKg);
      // ... recalculate density ...
      await queryRunner.manager.save(TankBatch, tankBatch);
    }

    // Update tank biomass with Math.max guards
    const newBiomass = Math.max(0, Number(tank.currentBiomass || 0) - biomassKg);
    const newCount = Math.max(0, (tank.currentCount || 0) - payload.quantity);
    // ... update via correct table ...

    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }

  return batch;
}
```

**Acceptance Criteria:**
- [ ] All reads are inside the transaction
- [ ] `pessimistic_write` locks are used on Batch, TankBatch, and Equipment
- [ ] `Math.max(0, ...)` is applied to all quantity/biomass decrements
- [ ] Concurrent cull test exists verifying no negative quantities
- [ ] Handler uses `findTankOrEquipmentWithManager` (like mortality handler) to handle both Equipment and Tank tables

---

### REC-003: Enforce Tank Capacity Checks (addresses CRITICAL-003)
**Priority:** CRITICAL
**Estimated Effort:** M
**Files to Modify:**
- `web/modules/farm-module/src/pages/production/components/TransferModal.tsx:150` -- remove hardcoded `skipCapacityCheck: true`
- `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts:94-104` -- enforce capacity limit with configurable override
- `apps/farm-service/src/batch/resolvers/batch.resolver.ts:338-340` -- restrict `skipCapacityCheck` to admin roles

**Recommended Implementation:**

Frontend -- remove hardcoded bypass:
```typescript
// TransferModal.tsx line 150
skipCapacityCheck: false, // Let the server enforce capacity limits
```

Backend -- enforce capacity with configurable threshold and audit trail:
```typescript
// allocate-to-tank.handler.ts
const CAPACITY_HARD_LIMIT_PERCENT = 120; // Allow up to 120%, block beyond

if (biomassKg > availableCapacity) {
  const overCapacityPercent = ((currentBiomass + biomassKg) / maxBiomass) * 100;
  
  if (overCapacityPercent > CAPACITY_HARD_LIMIT_PERCENT) {
    throw new BadRequestException(
      `Equipment ${equipment.code} would exceed ${CAPACITY_HARD_LIMIT_PERCENT}% capacity. ` +
      `Cannot allocate ${biomassKg.toFixed(2)} kg.`
    );
  }
  
  this.logger.warn(
    `Equipment ${equipment.code} over capacity at ${overCapacityPercent.toFixed(1)}%. ` +
    `Allocation allowed but flagged.`,
  );
}
```

Resolver -- restrict skipCapacityCheck to admins:
```typescript
// batch.resolver.ts - transferBatch mutation
if (input.skipCapacityCheck && !user.roles.includes(Role.TENANT_ADMIN)) {
  throw new ForbiddenException('Only administrators can skip capacity checks');
}
```

**Acceptance Criteria:**
- [ ] Frontend does not hardcode `skipCapacityCheck: true`
- [ ] `AllocateToTankHandler` enforces a hard capacity limit (configurable threshold)
- [ ] `skipCapacityCheck` is restricted to `TENANT_ADMIN` role
- [ ] Over-capacity allocations are logged with full context (tenantId, equipmentId, biomass values)

---

### REC-004: Add Transaction and Event Publishing to CloseBatchHandler (addresses HIGH-001)
**Priority:** HIGH
**Estimated Effort:** M
**Files to Modify:**
- `apps/farm-service/src/batch/handlers/close-batch.handler.ts` -- add transaction, Logger, and BatchClosed event

**Recommended Implementation:**
```typescript
@Injectable()
@CommandHandler(CloseBatchCommand)
export class CloseBatchHandler implements ICommandHandler<CloseBatchCommand, Batch> {
  private readonly logger = new Logger(CloseBatchHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: CloseBatchCommand): Promise<Batch> {
    // ... validation same as current ...
    
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    
    let savedBatch: Batch;
    try {
      // ... apply changes to batch ...
      savedBatch = await queryRunner.manager.save(Batch, batch);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
    
    // Publish BatchClosed event AFTER transaction commit
    if (this.eventBus) {
      try {
        await this.eventBus.publish({
          eventId: randomUUID(),
          eventType: 'BatchClosed',
          timestamp: new Date(),
          tenantId,
          batchId: savedBatch.id,
          closeReason: reason,
          finalQuantity: finalMetrics.finalQuantity,
          finalBiomassKg: finalMetrics.finalBiomass,
          finalFCR: finalMetrics.fcr,
          mortalityRate: finalMetrics.mortalityRate,
          daysInProduction: finalMetrics.daysInProduction,
          version: 1,
        });
      } catch (eventError) {
        this.logger.error(`Failed to publish BatchClosed event: ${(eventError as Error).message}`, {
          batchId: savedBatch.id, tenantId,
        });
      }
    }
    
    return savedBatch;
  }
}
```

**Acceptance Criteria:**
- [ ] Handler uses QueryRunner transaction
- [ ] `BatchClosed` event is published after commit
- [ ] Event publish errors are logged (not silently swallowed)
- [ ] `Logger` is initialized and used for operational logging

---

### REC-005: Add BatchTransferred Event Publishing to TransferBatchHandler (addresses HIGH-002)
**Priority:** HIGH
**Estimated Effort:** S
**Files to Modify:**
- `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts` -- add event publish after commit

**Recommended Implementation:**
Add after line 314 (after `queryRunner.commitTransaction()`):
```typescript
// Publish domain event AFTER transaction commit
if (this.eventBus) {
  try {
    await this.eventBus.publish({
      eventId: randomUUID(),
      eventType: 'BatchTransferred',
      timestamp: new Date(),
      tenantId,
      batchId,
      sourceTankId: payload.sourceTankId,
      destinationTankId: payload.destinationTankId,
      quantity: payload.quantity,
      biomassKg,
      transferReason: payload.transferReason,
      version: 1,
    });
  } catch (eventError) {
    this.logger.error(
      `Failed to publish BatchTransferred event: ${(eventError as Error).message}`,
      { batchId, tenantId, sourceTankId: payload.sourceTankId },
    );
  }
}
```

Note: A Logger instance needs to be added to the handler constructor.

**Acceptance Criteria:**
- [ ] `BatchTransferred` event is published after transaction commit
- [ ] Event includes sourceTankId, destinationTankId, quantity, biomassKg
- [ ] Event publish errors are logged with context
- [ ] Logger instance is added to the handler

---

### REC-006: Add BatchAllocatedToTank Event Publishing to AllocateToTankHandler (addresses HIGH-003)
**Priority:** HIGH
**Estimated Effort:** S
**Files to Modify:**
- `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts` -- add EVENT_BUS injection and event publish after commit

**Recommended Implementation:**
Add to constructor:
```typescript
@Optional() @Inject('EVENT_BUS')
private readonly eventBus?: NatsEventBus,
```

Add after line 221 (after `queryRunner.commitTransaction()`):
```typescript
if (this.eventBus) {
  try {
    await this.eventBus.publish({
      eventId: randomUUID(),
      eventType: 'BatchAllocatedToTank',
      timestamp: new Date(),
      tenantId,
      batchId,
      tankId: payload.tankId,
      quantity: payload.quantity,
      biomassKg,
      allocationType: payload.allocationType,
      version: 1,
    });
  } catch (eventError) {
    this.logger.error(
      `Failed to publish BatchAllocatedToTank event: ${(eventError as Error).message}`,
      { batchId, tenantId, tankId: payload.tankId },
    );
  }
}
```

**Acceptance Criteria:**
- [ ] `EVENT_BUS` is injected with `@Optional() @Inject('EVENT_BUS')`
- [ ] `BatchAllocatedToTank` event is published after transaction commit
- [ ] Event publish errors are logged with context

---

### REC-007: Fix Silent Error Swallowing in Event Publish Catch Blocks (addresses HIGH-004, HIGH-005)
**Priority:** HIGH
**Estimated Effort:** S
**Files to Modify:**
- `apps/farm-service/src/batch/handlers/update-batch-status.handler.ts:94-96`
- `apps/farm-service/src/batch/handlers/record-mortality.handler.ts:223-225`

**Recommended Implementation:**
Replace the empty catch blocks:
```typescript
// BEFORE (both files):
} catch (eventError) {
  // Log but don't fail for event publishing errors
}

// AFTER:
} catch (eventError) {
  this.logger.error(
    `Failed to publish ${eventType} event for batch ${batchId}: ${(eventError as Error).message}`,
    { tenantId, batchId },
  );
}
```

For `update-batch-status.handler.ts`, also add a Logger instance since it already has one declared but the event error logging is missing.

**Acceptance Criteria:**
- [ ] All event publish catch blocks contain `this.logger.error()` calls
- [ ] Error messages include event type, batchId, and tenantId for correlation
- [ ] No empty catch blocks remain in batch handlers

---

### REC-008: Implement DataLoader for BatchResolver Document Fields (addresses HIGH-006)
**Priority:** HIGH
**Estimated Effort:** M
**Files to Modify:**
- `apps/farm-service/src/batch/resolvers/batch.resolver.ts:918-951` -- replace direct queries with DataLoader
- `apps/farm-service/src/batch/dataloaders/batch-document.dataloader.ts` -- create new file

**Recommended Implementation:**
```typescript
// batch-document.dataloader.ts (new file)
import DataLoader from 'dataloader';
import { Injectable, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { BatchDocument, BatchDocumentType } from '../entities/batch-document.entity';

@Injectable({ scope: Scope.REQUEST })
export class BatchDocumentDataLoader {
  private readonly loader: DataLoader<string, BatchDocument[]>;

  constructor(
    @InjectRepository(BatchDocument)
    private readonly documentRepository: Repository<BatchDocument>,
  ) {
    this.loader = new DataLoader(async (batchIds: readonly string[]) => {
      const documents = await this.documentRepository.find({
        where: { batchId: In([...batchIds]), isActive: true },
        order: { createdAt: 'DESC' },
      });

      // Group by batchId
      const groupedByBatch = new Map<string, BatchDocument[]>();
      for (const doc of documents) {
        const existing = groupedByBatch.get(doc.batchId) || [];
        existing.push(doc);
        groupedByBatch.set(doc.batchId, existing);
      }

      return batchIds.map(id => groupedByBatch.get(id) || []);
    });
  }

  async loadByBatchId(batchId: string): Promise<BatchDocument[]> {
    return this.loader.load(batchId);
  }
}
```

Then in the resolver:
```typescript
@ResolveField(() => [BatchDocumentResponse], { name: 'documents' })
async getDocuments(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
  return this.batchDocumentDataLoader.loadByBatchId(batch.id);
}
```

**Acceptance Criteria:**
- [ ] DataLoader batches document queries across all batches in a single list response
- [ ] For a list of 20 batches, only 1 additional query is executed for documents (not 60)
- [ ] DataLoader is request-scoped to prevent cross-request data leakage
- [ ] Health certificates and import documents are filtered from the loaded result, not separate queries
