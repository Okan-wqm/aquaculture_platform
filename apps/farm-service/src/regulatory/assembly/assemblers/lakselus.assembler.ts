/**
 * Lakselus (sea lice) weekly report assembler.
 *
 * sjøtemperatur → WaterTemperatureService.getPeriodTemperature over the REPORT
 * week — the ONE temperature path (sensor daily rollup preferred, manual
 * measurements as fallback), aggregated to the report period so the value is
 * the week's temperature rather than wall-clock "now" at assembly time.
 *
 * lusetelling → lice_counts rows for the ISO week: per-stage averages
 * weighted by fishSampled across the site's pens (the regulator wants the
 * site-level average per fish; weighting by sample size is the correct
 * pooled mean). Blocking MANUAL_REQUIRED only when the week has no counts —
 * the counts are the legal core of this report, never guessed.
 *
 * behandlinger → treatment_applications rows applied in the week, emitted
 * verbatim in the official method/virkestoff vocabulary (validated at write
 * time). Backfilled legacy rows whose virkestoff could not be classified are
 * flagged blocking MANUAL_REQUIRED naming the record to fix — fail-closed.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  IKKE_MEDIKAMENTELL_TYPES,
  IkkeMedikamentellBehandlingPayload,
  IkkeMedikamentellTypePayload,
  LusetellingPayload,
  MEDIKAMENTELL_TYPES,
  MENGDE_ENHETER,
  MedikamentellBehandlingPayload,
  MedikamentellTypePayload,
  MengdeEnhetPayload,
  STYRKE_ENHETER,
  StyrkeEnhetPayload,
  VIRKESTOFF_TYPES,
  VirkestoffPayload,
  VirkestoffTypePayload,
} from '../../mattilsynet-api.service';
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { AssembledDraft, ReportFieldMeta, fromRecords, manualRequired } from '../provenance.types';
import { isoWeekRange, round2 } from '../period.util';

/** Data portion of the lakselus wire payload (identity is a form concern). */
export interface LakselusPrefillPayload {
  rapporteringsår: number;
  rapporteringsuke: number;
  sjøtemperatur: number | null;
  lusetelling: LusetellingPayload;
  ikkeMedikamentelleBehandlinger: IkkeMedikamentellBehandlingPayload[];
  medikamentelleBehandlinger: MedikamentellBehandlingPayload[];
}

interface LiceCountRow {
  adultFemaleLice: string;
  mobileLice: string;
  attachedLice: string;
  fishSampled: string;
  countDate: string;
}

interface TreatmentRow {
  id: string;
  category: 'medicinal' | 'non_medicinal';
  method: string;
  virkestoffType: string | null;
  styrkeVerdi: string | null;
  styrkeEnhet: string | null;
  mengdeVerdi: string | null;
  mengdeEnhet: string | null;
  wholeSite: boolean;
  pensCount: number | null;
  appliedAt: Date;
  beskrivelse: string | null;
}

/** Narrowing guards against the official value lists (the wire-type SSoT). */
function isIkkeMedikamentellType(value: string): value is IkkeMedikamentellTypePayload {
  return (IKKE_MEDIKAMENTELL_TYPES as readonly string[]).includes(value);
}
function isMedikamentellType(value: string): value is MedikamentellTypePayload {
  return (MEDIKAMENTELL_TYPES as readonly string[]).includes(value);
}
function isVirkestoffType(value: string): value is VirkestoffTypePayload {
  return (VIRKESTOFF_TYPES as readonly string[]).includes(value);
}
function isStyrkeEnhet(value: string): value is StyrkeEnhetPayload {
  return (STYRKE_ENHETER as readonly string[]).includes(value);
}
function isMengdeEnhet(value: string): value is MengdeEnhetPayload {
  return (MENGDE_ENHETER as readonly string[]).includes(value);
}

@Injectable()
export class LakselusReportAssembler {
  constructor(
    private readonly waterTemperature: WaterTemperatureService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async assemble(
    tenantId: string,
    siteId: string,
    year: number,
    week: number,
  ): Promise<AssembledDraft<LakselusPrefillPayload>> {
    const { fromDate, toDate } = isoWeekRange(year, week);
    const [temperature, counts, treatments] = await Promise.all([
      // Period temperature over the REPORT week — not wall-clock "now" — so a
      // draft assembled after the week (scheduler rollover / backfill) carries
      // the week's temperature. Aggregated from the sensor daily rollup or the
      // week's manual measurements.
      this.waterTemperature.getPeriodTemperature(tenantId, siteId, fromDate, toDate),
      this.queryLiceCounts(tenantId, siteId, year, week),
      this.queryTreatments(tenantId, siteId, fromDate, toDate),
    ]);

    const fields: ReportFieldMeta[] = [];
    if (temperature) {
      fields.push(
        fromRecords(
          '/sjøtemperatur',
          `WaterTemperatureService.period(${temperature.source})`,
          temperature.coverageDays,
        ),
      );
    } else {
      fields.push(
        manualRequired(
          '/sjøtemperatur',
          `No water temperature on record for the site in ISO week ${week}/${year} — link a temperature sensor or record a manual measurement (3 m depth, at least weekly per lakselusforskriften).`,
          true,
        ),
      );
    }

    const lusetelling = this.aggregateCounts(counts);
    if (counts.length > 0) {
      fields.push(
        fromRecords('/lusetelling', 'lice_counts weekly fishSampled-weighted mean', counts.length),
      );
    } else {
      // The counting stages are the legal core of the report — blocking,
      // never guessed. Actionable: the operator records counts, the draft
      // re-assembles.
      fields.push(
        manualRequired(
          '/lusetelling',
          `No lice counts recorded for ISO week ${week}/${year} — record the pen counts (adult females / mobiles / attached, average per fish) via lice-count capture.`,
          true,
        ),
      );
    }

    const { ikkeMedikamentelle, medikamentelle } = this.mapTreatments(
      treatments,
      this.latestCountDate(counts),
      fields,
    );
    fields.push(
      fromRecords(
        '/ikkeMedikamentelleBehandlinger',
        'treatment_applications (non-medicinal, week window)',
        ikkeMedikamentelle.length,
      ),
    );
    fields.push(
      fromRecords(
        '/medikamentelleBehandlinger',
        'treatment_applications (medicinal, week window)',
        medikamentelle.length,
      ),
    );

    return {
      draftPayload: {
        rapporteringsår: year,
        rapporteringsuke: week,
        sjøtemperatur: temperature ? temperature.celsius : null,
        lusetelling,
        ikkeMedikamentelleBehandlinger: ikkeMedikamentelle,
        medikamentelleBehandlinger: medikamentelle,
      },
      fields,
    };
  }

  /** Pooled per-fish mean across pens: Σ(avg×sampled) / Σ(sampled). */
  private aggregateCounts(rows: LiceCountRow[]): LusetellingPayload {
    const totalSampled = rows.reduce((sum, row) => sum + Number(row.fishSampled), 0);
    if (totalSampled === 0) {
      return { voksneHunnlus: 0, bevegeligeLus: 0, fastsittendeLus: 0 };
    }
    const weighted = (pick: (row: LiceCountRow) => string): number =>
      round2(
        rows.reduce((sum, row) => sum + Number(pick(row)) * Number(row.fishSampled), 0) /
          totalSampled,
      );
    return {
      voksneHunnlus: weighted((row) => row.adultFemaleLice),
      bevegeligeLus: weighted((row) => row.mobileLice),
      fastsittendeLus: weighted((row) => row.attachedLice),
    };
  }

  private latestCountDate(rows: LiceCountRow[]): string | null {
    return rows.reduce<string | null>(
      (latest, row) => (latest === null || row.countDate > latest ? row.countDate : latest),
      null,
    );
  }

  /**
   * Emit treatment rows in the official vocabulary. Rows written through
   * TreatmentApplicationService are valid by construction; backfilled legacy
   * rows may miss a classifiable virkestoff — those become blocking
   * MANUAL_REQUIRED naming the record (fail-closed, no silent coercion).
   */
  private mapTreatments(
    rows: TreatmentRow[],
    latestCountDate: string | null,
    fields: ReportFieldMeta[],
  ): {
    ikkeMedikamentelle: IkkeMedikamentellBehandlingPayload[];
    medikamentelle: MedikamentellBehandlingPayload[];
  } {
    const ikkeMedikamentelle: IkkeMedikamentellBehandlingPayload[] = [];
    const medikamentelle: MedikamentellBehandlingPayload[] = [];

    for (const row of rows) {
      // Records-derived, not guessed: the treatment was carried out before
      // counting exactly when it predates the week's latest count date.
      const appliedDate = new Date(row.appliedAt).toISOString().slice(0, 10);
      const gjennomførtFørTelling = latestCountDate !== null && appliedDate <= latestCountDate;
      const common = {
        gjennomførtFørTelling,
        heleLokaliteten: row.wholeSite,
        antallMerder: row.pensCount ?? undefined,
      };

      if (row.category === 'non_medicinal') {
        if (!isIkkeMedikamentellType(row.method)) {
          fields.push(
            manualRequired(
              '/ikkeMedikamentelleBehandlinger',
              `Treatment record ${row.id} carries method '${row.method}', which is not an official non-medicinal value — correct the treatment record.`,
              true,
            ),
          );
          continue;
        }
        ikkeMedikamentelle.push({
          type: row.method,
          ...common,
          beskrivelse:
            row.method === 'ANNEN_BEHANDLING' ? (row.beskrivelse ?? undefined) : undefined,
        });
        continue;
      }

      if (!isMedikamentellType(row.method)) {
        fields.push(
          manualRequired(
            '/medikamentelleBehandlinger',
            `Treatment record ${row.id} carries method '${row.method}', which is not an official medicinal value — correct the treatment record.`,
            true,
          ),
        );
        continue;
      }
      const virkestoff = this.mapVirkestoff(row);
      if (!virkestoff) {
        fields.push(
          manualRequired(
            '/medikamentelleBehandlinger',
            `Treatment record ${row.id} has no classifiable virkestoff (legacy backfill) — set the official virkestoff on the treatment record.`,
            true,
          ),
        );
        continue;
      }
      medikamentelle.push({
        type: row.method,
        ...common,
        virkestoff,
        beskrivelse: row.method === 'ANNEN_BEHANDLING' ? (row.beskrivelse ?? undefined) : undefined,
      });
    }

    return { ikkeMedikamentelle, medikamentelle };
  }

  private mapVirkestoff(row: TreatmentRow): VirkestoffPayload | null {
    if (!row.virkestoffType || !isVirkestoffType(row.virkestoffType)) {
      return null;
    }
    const type = row.virkestoffType;
    if (type === 'ANNET_VIRKESTOFF' && !row.beskrivelse) {
      return null;
    }
    return {
      type,
      styrke:
        row.styrkeVerdi !== null && row.styrkeEnhet !== null && isStyrkeEnhet(row.styrkeEnhet)
          ? { verdi: Number(row.styrkeVerdi), enhet: row.styrkeEnhet }
          : undefined,
      mengde:
        row.mengdeVerdi !== null && row.mengdeEnhet !== null && isMengdeEnhet(row.mengdeEnhet)
          ? { verdi: Number(row.mengdeVerdi), enhet: row.mengdeEnhet }
          : undefined,
      annetVirkestoff: type === 'ANNET_VIRKESTOFF' ? (row.beskrivelse ?? undefined) : undefined,
    };
  }

  private async queryLiceCounts(
    tenantId: string,
    siteId: string,
    year: number,
    week: number,
  ): Promise<LiceCountRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `SELECT "adultFemaleLice", "mobileLice", "attachedLice", "fishSampled", "countDate"::text AS "countDate"
           FROM lice_counts
          WHERE "tenantId" = $1
            AND "siteId" = $2
            AND "reportingYear" = $3
            AND "reportingWeek" = $4`,
        [tenantId, siteId, year, week],
      );
    });
  }

  private async queryTreatments(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<TreatmentRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `SELECT id, category, method, "virkestoffType",
                "styrkeVerdi", "styrkeEnhet", "mengdeVerdi", "mengdeEnhet",
                "wholeSite", "pensCount", "appliedAt", beskrivelse
           FROM treatment_applications
          WHERE "tenantId" = $1
            AND "siteId" = $2
            AND "appliedAt"::date BETWEEN $3 AND $4
          ORDER BY "appliedAt"`,
        [tenantId, siteId, fromDate, toDate],
      );
    });
  }
}
