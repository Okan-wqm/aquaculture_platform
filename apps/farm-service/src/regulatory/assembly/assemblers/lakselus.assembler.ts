/**
 * Lakselus (sea lice) weekly report assembler.
 *
 * sjøtemperatur → WaterTemperatureService.getSiteCurrentTemperature — the ONE
 * temperature path (sensor projection vs manual measurement, newest wins),
 * with SENSOR/RECORDS provenance carrying sensor id + measurement time so
 * the operator can judge freshness before submitting to the regulator.
 *
 * lusetelling (adult female / mobile / attached averages) has no operational
 * entity until Phase 2 (`lice_counts`) — the counts are the legal core of
 * this report, so they are flagged blocking MANUAL_REQUIRED, never guessed.
 * Treatments likewise arrive in Phase 2 (`treatment_applications`).
 */
import { Injectable } from '@nestjs/common';

import { LusetellingPayload } from '../../mattilsynet-api.service';
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import {
  AssembledDraft,
  ReportFieldMeta,
  fromRecords,
  fromSensor,
  manualRequired,
} from '../provenance.types';

/** Data portion of the lakselus wire payload (identity is a form concern). */
export interface LakselusPrefillPayload {
  rapporteringsår: number;
  rapporteringsuke: number;
  sjøtemperatur: number | null;
  lusetelling: LusetellingPayload;
}

@Injectable()
export class LakselusReportAssembler {
  constructor(private readonly waterTemperature: WaterTemperatureService) {}

  async assemble(
    tenantId: string,
    siteId: string,
    year: number,
    week: number,
  ): Promise<AssembledDraft<LakselusPrefillPayload>> {
    const reading = await this.waterTemperature.getSiteCurrentTemperature(tenantId, siteId);

    const fields: ReportFieldMeta[] = [];
    if (reading && reading.source === 'sensor' && reading.sensorId) {
      fields.push(fromSensor('/sjøtemperatur', reading.sensorId, reading.measuredAt));
    } else if (reading) {
      fields.push({
        ...fromRecords('/sjøtemperatur', 'WaterTemperatureService.manual', 1),
        measuredAt: reading.measuredAt,
      });
    } else {
      fields.push(
        manualRequired(
          '/sjøtemperatur',
          'No water temperature on record for the site — link a temperature sensor or record a manual measurement (3 m depth, at least weekly per lakselusforskriften).',
          true,
        ),
      );
    }

    // The counting stages are the legal core of the report; the platform has
    // no lice-count records until Phase 2 — blocking, never guessed.
    fields.push(
      manualRequired(
        '/lusetelling',
        `Enter the week ${week}/${year} lice counts (adult females / mobiles / attached, average per fish) — lice counting records land in Phase 2.`,
        true,
      ),
    );

    return {
      draftPayload: {
        rapporteringsår: year,
        rapporteringsuke: week,
        sjøtemperatur: reading ? reading.celsius : null,
        lusetelling: { voksneHunnlus: 0, bevegeligeLus: 0, fastsittendeLus: 0 },
      },
      fields,
    };
  }
}
