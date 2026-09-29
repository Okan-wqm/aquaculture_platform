import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { MortalityRecordedEvent } from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { MortalityRecord } from '../../batch/entities/mortality-record.entity';
import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';
import {
  MORTALITY_TREND_WINDOW_DAYS,
  shiftCalendarDay,
  summarizeMortalityWindow,
  type DailyMortalityRow,
} from './mortality-alert-window';

export interface DailyMortality {
  /** The calendar day (`YYYY-MM-DD`) the triggering record is stored under. */
  day: string;
  todayCount: number;
  todayRate: number;
  weeklyAverage: number;
  trend: 'increasing' | 'stable' | 'decreasing';
}

/**
 * The tenant reads behind a mortality alert decision (FARM-HIGH-334,
 * ALERT-MEDIUM-007). Runs inside the listener's tenant context: the injected
 * repositories route to `tenant_<uuid>` through the ALS-driven pool patch.
 */
@Injectable()
export class MortalityAlertContextReader {
  constructor(
    @InjectRepository(MortalityRecord)
    private readonly mortalityRecordRepository: Repository<MortalityRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  /**
   * The daily rate and weekly trend for the batch from its records.
   *
   * FARM-HIGH-334: the window is keyed to the calendar day the triggering
   * record is STORED under (`recordDate`), derived by the same driver
   * conversion the write path applies to `observedAt` — so the record that
   * raised the event is always inside its own day. It used to filter the
   * `date` column with `MoreThan(server midnight)`, which excluded every row of
   * the current day and kept the daily-rate alarm permanently silent. Days are
   * compared as dates, never against a timestamp.
   */
  async dailyMortality(event: MortalityRecordedEvent): Promise<DailyMortality> {
    const day = this.recordDayOf(new Date(event.mortalityDate));
    const from = shiftCalendarDay(day, -(MORTALITY_TREND_WINDOW_DAYS - 1));

    const raw: Array<{ day: string; count: string }> = await this.mortalityRecordRepository
      .createQueryBuilder('record')
      .select(`to_char(record."recordDate", 'YYYY-MM-DD')`, 'day')
      .addSelect('SUM(record.count)', 'count')
      .where('record."tenantId" = :tenantId', { tenantId: event.tenantId })
      .andWhere('record."batchId" = :batchId', { batchId: event.batchId })
      .andWhere('record."recordDate" BETWEEN CAST(:from AS date) AND CAST(:day AS date)', {
        from,
        day,
      })
      .groupBy('record."recordDate"')
      .getRawMany();
    const rows: DailyMortalityRow[] = raw.map((row) => ({
      day: row.day,
      count: Number(row.count),
    }));
    const { dayCount, weeklyAverage, trend } = summarizeMortalityWindow(rows, day);

    // The day's rate is measured against the population at the START of that
    // day: what is alive now plus every death recorded under the day (the
    // triggering record included).
    const batch = await this.batchRepository.findOne({
      where: { id: event.batchId, tenantId: event.tenantId },
    });
    const populationAtDayStart = (batch?.currentQuantity ?? 0) + dayCount;
    const todayRate = populationAtDayStart > 0 ? (dayCount / populationAtDayStart) * 100 : 0;

    return { day, todayCount: dayCount, todayRate, weeklyAverage, trend };
  }

  /**
   * The calendar day (`YYYY-MM-DD`) a mortality observed at `observedAt` is
   * stored under — derived through the driver's own persistence conversion of
   * the `recordDate` column, the path `recordDate: payload.observedAt` takes on
   * write, so reader and writer cannot disagree about a record's day. Making
   * that stored day site-local for instant inputs needs the write-side input
   * contract split tracked as FARM-MEDIUM-355.
   */
  recordDayOf(observedAt: Date): string {
    const column = this.mortalityRecordRepository.metadata.findColumnWithPropertyName('recordDate');
    if (!column) {
      throw new Error('MortalityRecord.recordDate column metadata is missing');
    }
    const stored: unknown =
      this.mortalityRecordRepository.manager.connection.driver.preparePersistentValue(
        observedAt,
        column,
      );
    if (typeof stored !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(stored)) {
      throw new Error(`recordDate conversion produced a non-date value: ${String(stored)}`);
    }
    return stored;
  }

  /** The tank's site (Department.siteId via the one tank resolver), or null. */
  async siteOf(event: MortalityRecordedEvent): Promise<string | null> {
    if (!event.tankId) return null;
    return resolveTankSiteId(this.mortalityRecordRepository.manager, event.tankId, event.tenantId);
  }
}
