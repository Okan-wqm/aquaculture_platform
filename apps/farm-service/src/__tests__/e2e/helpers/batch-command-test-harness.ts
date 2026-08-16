import {
  MobileCommandReceiptService,
  type MobileCommandReceiptState,
} from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { OutboxPublisher } from '@platform/outbox';
import type { DataSource, EntityManager } from 'typeorm';

import { AuditLog } from '../../../database/entities/audit-log.entity';
import { AuditLogService } from '../../../database/services/audit-log.service';
import { CodeGeneratorService } from '../../../database/services/code-generator.service';
import { CodeSequence } from '../../../database/entities/code-sequence.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import { BatchDocument } from '../../../batch/entities/batch-document.entity';
import { TankAllocation } from '../../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../../batch/entities/tank-operation.entity';
import { CreateBatchHandler } from '../../../batch/handlers/create-batch.handler';
import { AllocateToTankHandler } from '../../../batch/handlers/allocate-to-tank.handler';
import { TransferBatchHandler } from '../../../batch/handlers/transfer-batch.handler';
import { BatchAggregateMutationPort } from '../../../batch/batch-aggregate-mutation.port';
import { BatchService } from '../../../batch/services/batch.service';
import { RemovalQuantityPolicyService } from '../../../batch/services/removal-quantity-policy.service';
import { TankBatchService } from '../../../batch/services/tank-batch.service';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { FinanceSettingsService } from '../../../finance/services/finance-settings.service';
import { FeedingAggregateMutationPort } from '../../../feeding-protocol/feeding-aggregate-mutation.writer';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { ProtocolRateService } from '../../../feeding-protocol/services/protocol-rate.service';
import { ProtocolResolutionAuthority } from '../../../feeding-protocol/services/protocol-resolution.authority';
import { Species } from '../../../species/entities/species.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { TankCapacityService } from '../../../tank/services/tank-capacity.service';

class TenantIsolationProjectionAuthority extends FarmStockProjectionService {
  override refreshContainers(
    ..._args: Parameters<FarmStockProjectionService['refreshContainers']>
  ): Promise<void> {
    return Promise.resolve();
  }
}

class TenantIsolationReceiptAuthority extends MobileCommandReceiptService {
  override begin(
    ..._args: Parameters<MobileCommandReceiptService['begin']>
  ): Promise<MobileCommandReceiptState> {
    return Promise.resolve({ mode: 'started', receiptId: 'tenant-isolation-receipt' });
  }

  override complete(..._args: Parameters<MobileCommandReceiptService['complete']>): Promise<void> {
    return Promise.resolve();
  }
}

class TenantIsolationDayPlanRecalcAuthority extends DayPlanRecalcService {
  constructor(feedingMutations: FeedingAggregateMutationPort, outboxPublisher: OutboxPublisher) {
    super(
      feedingMutations,
      new ProtocolResolutionAuthority(new ProtocolRateService()),
      outboxPublisher,
    );
  }

  override recalcForUnit(
    ..._args: Parameters<DayPlanRecalcService['recalcForUnit']>
  ): Promise<null> {
    return Promise.resolve(null);
  }
}

export interface BatchCommandTestHarness {
  readonly createBatch: CreateBatchHandler;
  readonly allocateToTank: AllocateToTankHandler;
  readonly transferBatch: TransferBatchHandler;
  readonly readModel: BatchService;
}

/**
 * E2E composition root for the current CQRS batch write architecture.
 * Constructor order lives here once, while each spec supplies only its real
 * database and the two closed durable-mutation authorities.
 */
export function createBatchCommandTestHarness(input: {
  readonly dataSource: DataSource;
  readonly batchMutations: BatchAggregateMutationPort;
  readonly feedingMutations: FeedingAggregateMutationPort;
  readonly outboxPublisher: OutboxPublisher;
}): BatchCommandTestHarness {
  const batchRepository = input.dataSource.getRepository(Batch);
  const allocationRepository = input.dataSource.getRepository(TankAllocation);
  const tankBatchRepository = input.dataSource.getRepository(TankBatch);
  const operationRepository = input.dataSource.getRepository(TankOperation);
  const tankRepository = input.dataSource.getRepository(Tank);
  const equipmentRepository = input.dataSource.getRepository(Equipment);
  const equipmentTypeRepository = input.dataSource.getRepository(EquipmentType);
  const tankBatchService = new TankBatchService(input.batchMutations);
  const tankCapacityService = new TankCapacityService();
  const siteAuthorization = new SiteAuthorizationService();
  const farmStockProjection = new TenantIsolationProjectionAuthority();
  const mobileCommandReceipts = new TenantIsolationReceiptAuthority();
  const dayPlanRecalc = new TenantIsolationDayPlanRecalcAuthority(
    input.feedingMutations,
    input.outboxPublisher,
  );

  return Object.freeze({
    createBatch: new CreateBatchHandler(
      input.batchMutations,
      input.dataSource,
      batchRepository,
      input.dataSource.getRepository(BatchDocument),
      input.dataSource.getRepository(Species),
      tankBatchRepository,
      equipmentRepository,
      new CodeGeneratorService(input.dataSource.getRepository(CodeSequence), input.dataSource),
      input.outboxPublisher,
      tankCapacityService,
      new FinanceSettingsService(input.dataSource),
    ),
    allocateToTank: new AllocateToTankHandler(
      input.batchMutations,
      batchRepository,
      allocationRepository,
      tankBatchRepository,
      equipmentRepository,
      input.dataSource,
      input.outboxPublisher,
      tankCapacityService,
      new AuditLogService(input.dataSource.getRepository(AuditLog)),
      siteAuthorization,
      tankBatchService,
      farmStockProjection,
      mobileCommandReceipts,
    ),
    transferBatch: new TransferBatchHandler(
      input.batchMutations,
      input.dataSource,
      batchRepository,
      allocationRepository,
      operationRepository,
      tankBatchRepository,
      equipmentRepository,
      tankRepository,
      equipmentTypeRepository,
      input.outboxPublisher,
      dayPlanRecalc,
      new RemovalQuantityPolicyService(),
      tankCapacityService,
      siteAuthorization,
      tankBatchService,
      farmStockProjection,
      mobileCommandReceipts,
    ),
    readModel: new BatchService(allocationRepository, tankBatchRepository, operationRepository),
  });
}

export function noOpFarmStockProjectionTestAuthority(): FarmStockProjectionService {
  return new TenantIsolationProjectionAuthority();
}

export function startedMobileCommandReceiptTestAuthority(): MobileCommandReceiptService {
  return new TenantIsolationReceiptAuthority();
}

export function noOpDayPlanRecalcTestAuthority(
  feedingMutations: FeedingAggregateMutationPort,
  outboxPublisher: OutboxPublisher,
): DayPlanRecalcService {
  return new TenantIsolationDayPlanRecalcAuthority(feedingMutations, outboxPublisher);
}
