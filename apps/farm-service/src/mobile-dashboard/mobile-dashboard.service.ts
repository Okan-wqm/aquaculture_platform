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

  async getTodaysDailyOpsCounts(
    tenantId: string,
    clientDate?: string,
  ): Promise<TodaysDailyOpsCounts> {
    // FARM-MEDIUM-053: the day boundary is EXPLICIT and named rather than a
    // silent bare-UTC slice. FARM_DASHBOARD_TIME_ZONE (IANA name, default 'UTC')
    // is the configured farm-local calendar zone so "today" matches what an
    // operator sees on the floor.
    //
    // FARM-MEDIUM-056: the client may additionally pass its OWN device-local
    // calendar day (strict YYYY-MM-DD) so the dashboard counts and the device's
    // notion of "today" agree on ONE named day — eliminating the split where the
    // server computed a different calendar day than the phone showed. The day is
    // resolved ONCE here (today/todayStart/tomorrow all derive from it) so
    // mortality.recordDate, feeding.executionDate, and the WQ measuredAt window
    // consume the identical boundary. A malformed clientDate is rejected and the
    // server falls back to its own FARM_DASHBOARD_TIME_ZONE computation. The query
    // stays strictly tenant-scoped (tenantId filter unchanged), so an
    // attacker-influenceable clientDate only selects which UTC slice of the
    // caller's OWN tenant is counted — a read-only aggregate, no cross-tenant reach.
    const timeZone = process.env.FARM_DASHBOARD_TIME_ZONE ?? 'UTC';
    const today = this.resolveCalendarDay(clientDate, timeZone);
    const tomorrow = new Date(`${today}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const todayStart = new Date(`${today}T00:00:00.000Z`);

    const [mortalityRaw, cullRaw, wqReadingsCount, feedingRaw] = await Promise.all([
      this.mortalityRepo
        .createQueryBuilder('mortality')
        .select('COALESCE(SUM(mortality.count), 0)', 'mortalityCount')
        .where('mortality.tenantId = :tenantId', { tenantId })
        .andWhere('mortality.recordDate = :today', { today })
        .getRawOne<{ mortalityCount: string }>(),
      // FARM-MEDIUM-053: culls were previously invisible in the removal counts.
      // Sum today's CULL operations from tank_operations as a DISTINCT metric.
      this.tankOperationRepo
        .createQueryBuilder('operation')
        .select('COALESCE(SUM(operation.quantity), 0)', 'cullCount')
        .where('operation.tenantId = :tenantId', { tenantId })
        .andWhere('operation.operationType = :cull', { cull: OperationType.CULL })
        .andWhere('operation.isDeleted = false')
        .andWhere('operation.operationDate = :today', { today })
        .getRawOne<{ cullCount: string }>(),
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
      cullCount: Number(cullRaw?.cullCount ?? 0),
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

  /**
   * Calendar date (YYYY-MM-DD) for `date` in the given IANA timeZone.
   *
   * WHY: a bare `date.toISOString().slice(0,10)` always slices the UTC day, so
   * an operation logged at 23:30 farm-local in a +03 tenant would land on the
   * wrong calendar day. en-CA gives the ISO YYYY-MM-DD ordering directly.
   * 'UTC' reproduces the previous behaviour exactly when no zone is configured.
   */
  private localDateString(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  /**
   * Resolve the single authoritative calendar day (YYYY-MM-DD) for the counts.
   *
   * FARM-MEDIUM-056: when the client supplies its device-local day it becomes
   * the agreed boundary — but ONLY if it is a strict, well-formed YYYY-MM-DD
   * (regex + real-date round-trip). A malformed or nonsensical value (e.g.
   * '2026-13-40', SQL fragments, empty string) is rejected and the server falls
   * back to its own timeZone computation. This keeps the boundary
   * attacker-tolerant: the value can only ever name a real calendar day, and it
   * is consumed purely as a date filter on the already-tenant-scoped queries.
   */
  private resolveCalendarDay(clientDate: string | undefined, timeZone: string): string {
    if (clientDate && this.isStrictIsoDate(clientDate)) {
      return clientDate;
    }
    return this.localDateString(new Date(), timeZone);
  }

  /**
   * True only for a strict `YYYY-MM-DD` that names a REAL calendar day. The
   * round-trip guard rejects values that match the shape but are not valid dates
   * (e.g. '2026-02-30'): such an input would be normalized by Date and no longer
   * equal the source string.
   */
  private isStrictIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    return parsed.toISOString().slice(0, 10) === value;
  }
}
