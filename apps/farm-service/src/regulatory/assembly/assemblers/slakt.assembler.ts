/**
 * Slakt (slaughter) weekly report assemblers — planned + executed.
 *
 * Executed: harvest_records for the ISO week, kg per species. The Norwegian
 * kvalitetsklasse split (superior/ordinær/produksjonsfisk/utkast) does not
 * exist on harvest records until Phase 2 — the per-species totals are
 * assembled and the split is flagged blocking MANUAL_REQUIRED (no guessing).
 *
 * Planned: harvest_plans whose plannedDate falls in the target week, kg into
 * the weekday bucket per species (statuses that still represent an intent:
 * planned/approved/scheduled/in_progress).
 *
 * godkjenningsnummer (slaughter-facility approval) comes from
 * regulatory_settings; absent → blocking MANUAL_REQUIRED (the facility
 * catalog lands in Phase 2).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { KvalitetsklasserPerArtPayload, UkeplanPerArtPayload } from '../../mattilsynet-api.service';
import { RegulatorySettingsService } from '../../regulatory-settings.service';
import { AssembledDraft, ReportFieldMeta, fromRecords, manualRequired } from '../provenance.types';
import { isoWeekRange, round2 } from '../period.util';

/** Data portions of the slakt wire payloads (identity is a form concern). */
export interface SlaktUtfortPrefillPayload {
  slakteuke: number;
  slakteår: number;
  godkjenningsnummer: string;
  arter: KvalitetsklasserPerArtPayload[];
  /** Assembled context: total gutted-weight kg per species for the week. */
  totalKgPerArt: Array<{ artskode: string; totalKg: number }>;
}

export interface SlaktPlanlagtPrefillPayload {
  uke: number;
  år: number;
  godkjenningsnummer: string;
  ukeplanPerArt: UkeplanPerArtPayload[];
}

interface ExecutedRow {
  artskode: string;
  totalKg: string;
  recordCount: string;
}

interface PlannedRow {
  artskode: string;
  weekday: string; // 1 (Mon) .. 7 (Sun), ISO
  totalKg: string;
}

function setWeekdayKg(plan: UkeplanPerArtPayload, isoWeekday: number, kg: number): void {
  switch (isoWeekday) {
    case 1:
      plan.mandagKg = kg;
      break;
    case 2:
      plan.tirsdagKg = kg;
      break;
    case 3:
      plan.onsdagKg = kg;
      break;
    case 4:
      plan.torsdagKg = kg;
      break;
    case 5:
      plan.fredagKg = kg;
      break;
    case 6:
      plan.lørdagKg = kg;
      break;
    case 7:
      plan.søndagKg = kg;
      break;
  }
}

function getWeekdayKg(plan: UkeplanPerArtPayload, isoWeekday: number): number {
  switch (isoWeekday) {
    case 1:
      return plan.mandagKg ?? 0;
    case 2:
      return plan.tirsdagKg ?? 0;
    case 3:
      return plan.onsdagKg ?? 0;
    case 4:
      return plan.torsdagKg ?? 0;
    case 5:
      return plan.fredagKg ?? 0;
    case 6:
      return plan.lørdagKg ?? 0;
    case 7:
      return plan.søndagKg ?? 0;
    default:
      return 0;
  }
}

@Injectable()
export class SlaktReportAssembler {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly settingsService: RegulatorySettingsService,
  ) {}

  async assembleExecuted(
    tenantId: string,
    siteId: string,
    year: number,
    week: number,
  ): Promise<AssembledDraft<SlaktUtfortPrefillPayload>> {
    const { fromDate, toDate } = isoWeekRange(year, week);
    const [rows, godkjenningsnummer, fields] = await Promise.all([
      this.queryExecuted(tenantId, siteId, fromDate, toDate),
      this.resolveApprovalNumber(tenantId),
      Promise.resolve([] as ReportFieldMeta[]),
    ]);

    const recordCount = rows.reduce((sum, row) => sum + Number(row.recordCount), 0);
    fields.push(fromRecords('/totalKgPerArt', 'SlaktReportAssembler.queryExecuted', recordCount));
    this.pushApprovalProvenance(fields, godkjenningsnummer);

    const arter: KvalitetsklasserPerArtPayload[] = rows.map((row) => ({
      art: row.artskode,
      superiorKg: 0,
      ordinærKg: 0,
      produksjonsfiskKg: 0,
      utkastKg: 0,
    }));
    rows.forEach((row, index) => {
      fields.push(
        manualRequired(
          `/arter/${index}`,
          `Distribute ${round2(Number(row.totalKg))} kg of ${row.artskode} across the official quality classes (superior/ordinær/produksjonsfisk/utkast) — the harvest records carry the total but not the regulator's class split until Phase 2.`,
          true,
        ),
      );
    });
    if (rows.length === 0) {
      fields.push(
        manualRequired(
          '/arter',
          `No harvest records found for ISO week ${week}/${year} (${fromDate}..${toDate}).`,
          true,
        ),
      );
    }

    return {
      draftPayload: {
        slakteuke: week,
        slakteår: year,
        godkjenningsnummer: godkjenningsnummer ?? '',
        arter,
        totalKgPerArt: rows.map((row) => ({
          artskode: row.artskode,
          totalKg: round2(Number(row.totalKg)),
        })),
      },
      fields,
    };
  }

  async assemblePlanned(
    tenantId: string,
    siteId: string,
    year: number,
    week: number,
  ): Promise<AssembledDraft<SlaktPlanlagtPrefillPayload>> {
    const { fromDate, toDate } = isoWeekRange(year, week);
    const [rows, godkjenningsnummer] = await Promise.all([
      this.queryPlanned(tenantId, siteId, fromDate, toDate),
      this.resolveApprovalNumber(tenantId),
    ]);

    const bySpecies = new Map<string, UkeplanPerArtPayload>();
    for (const row of rows) {
      const plan = bySpecies.get(row.artskode) ?? { artskode: row.artskode };
      const isoWeekday = Number(row.weekday);
      setWeekdayKg(plan, isoWeekday, round2(getWeekdayKg(plan, isoWeekday) + Number(row.totalKg)));
      bySpecies.set(row.artskode, plan);
    }

    const fields = [
      fromRecords('/ukeplanPerArt', 'SlaktReportAssembler.queryPlanned', rows.length),
    ];
    this.pushApprovalProvenance(fields, godkjenningsnummer);
    if (bySpecies.size === 0) {
      fields.push(
        manualRequired(
          '/ukeplanPerArt',
          `No active harvest plans fall in ISO week ${week}/${year} (${fromDate}..${toDate}).`,
          true,
        ),
      );
    }

    return {
      draftPayload: {
        uke: week,
        år: year,
        godkjenningsnummer: godkjenningsnummer ?? '',
        ukeplanPerArt: Array.from(bySpecies.values()),
      },
      fields,
    };
  }

  private pushApprovalProvenance(
    fields: ReportFieldMeta[],
    godkjenningsnummer: string | undefined,
  ): void {
    if (godkjenningsnummer) {
      fields.push(fromRecords('/godkjenningsnummer', 'RegulatorySettingsService', 1));
    } else {
      fields.push(
        manualRequired(
          '/godkjenningsnummer',
          'No slaughter-facility approval number configured — set it in Report Settings.',
          true,
        ),
      );
    }
  }

  private async resolveApprovalNumber(tenantId: string): Promise<string | undefined> {
    const settings = await this.settingsService.getSettings(tenantId);
    return settings?.slaughterApprovalNumber || undefined;
  }

  private async queryExecuted(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<ExecutedRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `SELECT s.code AS artskode,
                SUM(hr."totalBiomass")::numeric AS "totalKg",
                COUNT(*)::bigint AS "recordCount"
           FROM harvest_records hr
           JOIN tanks t ON t.id = hr."tankId" AND t."tenantId" = hr."tenantId"
           JOIN departments d ON d.id = t."departmentId" AND d."siteId" = $2
           JOIN batches_v2 b ON b.id = hr."batchId" AND b."tenantId" = hr."tenantId"
           JOIN species s ON s.id = b."speciesId"
          WHERE hr."tenantId" = $1
            AND hr."harvestDate"::date BETWEEN $3 AND $4
          GROUP BY s.code
          ORDER BY s.code`,
        [tenantId, siteId, fromDate, toDate],
      );
    });
  }

  private async queryPlanned(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<PlannedRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Site scope resolves through the plan's batch → current tank
      // allocation (harvest plans carry no tank/site column).
      return queryRunner.query(
        `SELECT s.code AS artskode,
                EXTRACT(ISODOW FROM hp."plannedDate")::int::text AS weekday,
                SUM(hp."estimatedBiomass")::numeric AS "totalKg"
           FROM harvest_plans hp
           JOIN batches_v2 b ON b.id = hp."batchId" AND b."tenantId" = hp."tenantId"
           JOIN species s ON s.id = b."speciesId"
          WHERE hp."tenantId" = $1
            AND hp."plannedDate" BETWEEN $3 AND $4
            AND hp.status IN ('planned', 'approved', 'scheduled', 'in_progress')
            AND EXISTS (
              SELECT 1
                FROM tank_batches tb
                JOIN tanks t ON t.id = tb."tankId"
                JOIN departments d ON d.id = t."departmentId"
               WHERE tb."tenantId" = hp."tenantId"
                 AND tb."primaryBatchId" = hp."batchId"
                 AND d."siteId" = $2
            )
          GROUP BY s.code, weekday
          ORDER BY s.code, weekday`,
        [tenantId, siteId, fromDate, toDate],
      );
    });
  }
}
