/**
 * Lice Count Service — writes the operational lice-count records the weekly
 * lakselus report assembles from.
 *
 * Upsert semantics: one row per (tenantId, tankId, countDate) — re-recording
 * the same pen/date corrects the earlier row instead of duplicating it, which
 * is both the natural idempotency key for offline/mobile retries and the
 * regulator's model (one count per pen per counting day).
 *
 * ISO reporting year/week are derived HERE at write time (period.util is the
 * one ISO-week implementation) so the assembler's weekly aggregation is a
 * plain indexed equality query, immune to week-53/year-boundary drift.
 *
 * @module FishHealth
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { isoWeekOf } from '../../regulatory/assembly/period.util';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { LiceCount } from '../entities/lice-count.entity';
import { RecordLiceCountInput } from '../dto/field-capture.inputs';

@Injectable()
export class LiceCountService {
  private readonly logger = new Logger(LiceCountService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly waterTemperature: WaterTemperatureService,
  ) {}

  async record(tenantId: string, input: RecordLiceCountInput, userId: string): Promise<LiceCount> {
    const countDate = input.countDate.slice(0, 10);
    const { isoYear, isoWeek } = isoWeekOf(new Date(`${countDate}T00:00:00Z`));

    // Temperature: an operator-supplied value is MANUAL truth; otherwise the
    // one site-temperature path (sensor projection vs manual measurement,
    // newest wins) fills it with its own source label. Resolved before the
    // transaction — it is a read against other tables.
    let seaTemperatureC = input.seaTemperatureC;
    let temperatureSource: string | undefined =
      input.seaTemperatureC !== undefined ? 'manual' : undefined;
    if (seaTemperatureC === undefined) {
      const reading = await this.waterTemperature.getSiteCurrentTemperature(tenantId, input.siteId);
      if (reading) {
        seaTemperatureC = reading.celsius;
        temperatureSource = reading.source;
      }
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, LiceCount, tenantId);

      const existing = await repo.findOne({
        where: { tenantId, tankId: input.tankId, countDate },
      });

      const values = {
        siteId: input.siteId,
        batchId: input.batchId,
        reportingYear: isoYear,
        reportingWeek: isoWeek,
        adultFemaleLice: input.adultFemaleLice,
        mobileLice: input.mobileLice,
        attachedLice: input.attachedLice,
        fishSampled: input.fishSampled,
        seaTemperatureC,
        temperatureSource,
        countedBy: userId,
        notes: input.notes,
      };

      if (existing) {
        Object.assign(existing, values);
        const updated = await repo.save(existing);
        this.logger.log(`Corrected lice count ${updated.id} (tank ${input.tankId}, ${countDate})`);
        return updated;
      }

      const saved = await repo.save(
        repo.create({ ...values, tenantId, tankId: input.tankId, countDate }),
      );
      this.logger.log(
        `Recorded lice count ${saved.id} (tank ${input.tankId}, ${countDate}, ISO ${isoYear}/W${isoWeek})`,
      );
      return saved;
    });
  }
}
