import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { MortalityRecord } from '../batch/entities/mortality-record.entity';
import { TankOperation, OperationType } from '../batch/entities/tank-operation.entity';
import { DailyFeedingExecution, ExecutionStatus } from '../feeding/entities/daily-feeding-execution.entity';
import { WaterQualityMeasurement } from '../water-quality/entities/water-quality-measurement.entity';
import { MobileStockEvent, StockEventsSummary, TodaysDailyOpsCounts } from './dto/mobile-dashboard.dto';

const STOCK_EVENT_OPERATION_TYPES = [
  OperationType.MORTALITY,
  OperationType.CULL,
  OperationType.TRANSFER_OUT,
  OperationType.HARVEST,
];

@Injectable()
export class MobileDashboardService {
  constructor(
    @InjectRepository(MortalityRecord)
    private readonly mortalityRepo: Repository<MortalityRecord>,
    @InjectRepository(WaterQualityMeasurement)
    private readonly waterQualityRepo: Repository<WaterQualityMeasurement>,
    @InjectRepository(DailyFeedingExecution)
    private readonly feedingExecutionRepo: Repository<DailyFeedingExecution>,
    @InjectRepository(TankOperation)
    private readonly tankOperationRepo: Repository<TankOperation>,
  ) {}

  async getTodaysDailyOpsCounts(tenantId: string): Promise<TodaysDailyOpsCounts> {
    const today = this.utcDateString(new Date());
    const tomorrow = new Date(`${today}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const todayStart = new Date(`${today}T00:00:00.000Z`);

    const [mortalityRaw, wqReadingsCount, feedingRaw] = await Promise.all([
      this.mortalityRepo
        .createQueryBuilder('mortality')
        .select('COALESCE(SUM(mortality.count), 0)', 'mortalityCount')
        .where('mortality.tenantId = :tenantId', { tenantId })
        .andWhere('mortality.recordDate = :today', { today })
        .getRawOne<{ mortalityCount: string }>(),
      this.waterQualityRepo
        .createQueryBuilder('measurement')
        .where('measurement.tenantId = :tenantId', { tenantId })
        .andWhere('measurement.measuredAt >= :todayStart', { todayStart })
        .andWhere('measurement.measuredAt < :tomorrow', { tomorrow })
        .getCount(),
      this.feedingExecutionRepo
        .createQueryBuilder('execution')
        .select('COUNT(*)', 'feedingTotalCount')
        .addSelect(
          'COUNT(*) FILTER (WHERE execution.status = :completed)',
          'feedingCompletedCount',
        )
        .where('execution.tenantId = :tenantId', { tenantId })
        .andWhere('execution.executionDate = :today', { today })
        .setParameter('completed', ExecutionStatus.COMPLETED)
        .getRawOne<{ feedingTotalCount: string; feedingCompletedCount: string }>(),
    ]);

    return {
      mortalityCount: Number(mortalityRaw?.mortalityCount ?? 0),
      wqReadingsCount,
      feedingCompletedCount: Number(feedingRaw?.feedingCompletedCount ?? 0),
      feedingTotalCount: Number(feedingRaw?.feedingTotalCount ?? 0),
    };
  }

  async getStockEventsSummary(tenantId: string, daysBack = 7): Promise<StockEventsSummary> {
    const boundedDaysBack = Math.min(Math.max(daysBack, 1), 90);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - boundedDaysBack);

    const where = {
      tenantId,
      operationType: In(STOCK_EVENT_OPERATION_TYPES),
      isDeleted: false,
      createdAt: MoreThanOrEqual(since),
    };

    const [thisWeekEventsCount, recentOperations] = await Promise.all([
      this.tankOperationRepo.count({ where }),
      this.tankOperationRepo.find({
        where,
        order: { createdAt: 'DESC' },
        take: 10,
      }),
    ]);

    return {
      thisWeekEventsCount,
      pendingTransferCount: 0,
      recentEvents: recentOperations.map((operation) => this.toStockEvent(operation)),
    };
  }

  private toStockEvent(operation: TankOperation): MobileStockEvent {
    const type = this.toMobileEventType(operation.operationType);
    return {
      id: operation.id,
      type,
      tankName: operation.tankName ?? operation.tankCode ?? operation.tankId,
      quantity: Math.abs(Number(operation.quantity ?? 0)),
      createdAt: operation.createdAt,
      note: this.eventNote(operation),
    };
  }

  private toMobileEventType(operationType: OperationType): string {
    switch (operationType) {
      case OperationType.MORTALITY:
        return 'MORTALITY';
      case OperationType.CULL:
        return 'CULL';
      case OperationType.TRANSFER_OUT:
        return 'TRANSFER';
      case OperationType.HARVEST:
        return 'HARVEST';
      default:
        return operationType.toUpperCase();
    }
  }

  private eventNote(operation: TankOperation): string | undefined {
    if (operation.operationType === OperationType.TRANSFER_OUT && operation.destinationTankName) {
      return `To ${operation.destinationTankName}`;
    }

    return (
      operation.mortalityDetail ??
      operation.cullDetail ??
      operation.transferReason ??
      operation.notes ??
      undefined
    );
  }

  private utcDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
