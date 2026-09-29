/**
 * Production mortality write + alert read path on a real DataSource
 * (FARM-HIGH-334 / ALERT-MEDIUM-007 Postgres proof).
 *
 * Lives under `__tests__/e2e/helpers/` for the same reason as
 * `farm-tenant-fixture.ts`: the production handler, reader and listener take
 * `@InjectRepository`-shaped repositories with no tenant-scoped equivalent of
 * that constructor shape, so the raw repositories are built here, ONCE, and the
 * specs stay subject to the banned-construct rule. Every collaborator is the
 * REAL one — including the mobile-command receipt service, so a suite must send
 * the idempotency envelope production requires (a command without one is
 * refused, FARM-HIGH-052) and register `FarmMobileCommandReceipt`.
 */
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import type { IEventBus } from '@platform/event-bus';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Repository } from 'typeorm';

import { Batch } from '../../../batch/entities/batch.entity';
import { MortalityRecord } from '../../../batch/entities/mortality-record.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../../batch/entities/tank-operation.entity';
import { RecordMortalityHandler } from '../../../batch/handlers/record-mortality.handler';
import { MortalityCullPolicyService } from '../../../batch/services/mortality-cull-policy.service';
import { RemovalQuantityPolicyService } from '../../../batch/services/removal-quantity-policy.service';
import { TankBatchService } from '../../../batch/services/tank-batch.service';
import { BackdatePolicyService } from '../../../common/services/backdate-policy.service';
import { AuditLog } from '../../../database/entities/audit-log.entity';
import { AuditLogService } from '../../../database/services/audit-log.service';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
import { MortalityAlertContextReader } from '../../../events/listeners/mortality-alert-context.reader';
import { MortalityRecordedListener } from '../../../events/listeners/mortality-recorded.listener';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { ProtocolRateService } from '../../../feeding-protocol/services/protocol-rate.service';
import { ProtocolResolutionService } from '../../../feeding-protocol/services/protocol-resolution.service';
import { FarmOutbox } from '../../../outbox/farm-outbox.entity';
import { Tank } from '../../../tank/entities/tank.entity';

export interface MortalityAlertHarness {
  /** The production mortality writer (record + MortalityRecorded outbox row). */
  recordMortality: RecordMortalityHandler;
  /** The production alert-context reader (stored-day window + tank site). */
  reader: MortalityAlertContextReader;
  /** The production listener wired to `bus`. */
  listener(bus: IEventBus): MortalityRecordedListener;
  mortalityRecords: Repository<MortalityRecord>;
  outbox: Repository<FarmOutbox>;
}

export function createMortalityAlertHarness(dataSource: DataSource): MortalityAlertHarness {
  const outboxPublisher = new OutboxPublisher(FarmOutbox);
  const mortalityRecords = dataSource.getRepository(MortalityRecord);
  const batches = dataSource.getRepository(Batch);
  const tankBatches = dataSource.getRepository(TankBatch);

  const recordMortality = new RecordMortalityHandler(
    dataSource,
    batches,
    mortalityRecords,
    dataSource.getRepository(TankOperation),
    tankBatches,
    dataSource.getRepository(Equipment),
    dataSource.getRepository(Tank),
    dataSource.getRepository(EquipmentType),
    outboxPublisher,
    new DayPlanRecalcService(
      outboxPublisher,
      new ProtocolResolutionService(new ProtocolRateService()),
    ),
    new RemovalQuantityPolicyService(),
    new BackdatePolicyService(new ConfigService()),
    new AuditLogService(dataSource.getRepository(AuditLog)),
    new SiteAuthorizationService(),
    new TankBatchService(),
    new MortalityCullPolicyService(),
    new FarmStockProjectionService(),
    new MobileCommandReceiptService(),
  );
  const reader = new MortalityAlertContextReader(mortalityRecords, batches);

  return {
    recordMortality,
    reader,
    listener: (bus) =>
      new MortalityRecordedListener(batches, mortalityRecords, tankBatches, reader, bus),
    mortalityRecords,
    outbox: dataSource.getRepository(FarmOutbox),
  };
}
