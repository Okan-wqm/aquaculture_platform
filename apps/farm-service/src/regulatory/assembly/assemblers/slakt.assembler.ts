/**
 * Slakt (slaughter) weekly report assemblers — planned + executed.
 *
 * Executed: harvest_records for the ISO week, kg per species split across the
 * Norwegian kvalitetsklasse (superior/ordinær/produksjonsfisk/utkast) from the
 * stored harvest_records.qualityClass (RPT-007) — RECORDS, no guessing.
 *
 * Planned: harvest_plans whose plannedDate falls in the target week, kg into
 * the weekday bucket per species (statuses that still represent an intent:
 * planned/approved/scheduled/in_progress).
 *
 * godkjenningsnummer comes from the slaughter-facility catalog's default
 * facility (SSoT), falling back to the legacy regulatory_settings field
 * until Phase 4 drops it; absent in both → blocking MANUAL_REQUIRED.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { KvalitetsklasserPerArtPayload, UkeplanPerArtPayload } from '../../mattilsynet-api.service';
import { SlaughterFacilityService } from '../../services/slaughter-facility.service';
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
  qualityClass: string;
  totalKg: string;
  recordCount: string;
}

/** Fold an official quality-class value into its wire bucket (kg). */
function addQualityKg(
  bucket: KvalitetsklasserPerArtPayload,
  qualityClass: string,
  kg: number,
): void {
  switch (qualityClass) {
    case 'superior':
      bucket.superiorKg = round2(bucket.superiorKg + kg);
      break;
    case 'ordinaer':
      bucket.ordinærKg = round2(bucket.ordinærKg + kg);
      break;
    case 'produksjonsfisk':
      bucket.produksjonsfiskKg = round2(bucket.produksjonsfiskKg + kg);
      break;
    case 'utkast':
      bucket.utkastKg = round2(bucket.utkastKg + kg);
      break;
  }
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
    private readonly facilityService: SlaughterFacilityService,
  ) {}

  async assembleExecuted(
    tenantId: string,
    siteId: string,
    year: number,
    week: number,
  ): Promise<AssembledDraft<SlaktUtfortPrefillPayload>> {
    const { fromDate, toDate } = isoWeekRange(year, week);
    const [rows, approval, fields] = await Promise.all([
      this.queryExecuted(tenantId, siteId, fromDate, toDate),
      this.resolveApprovalNumber(tenantId),
      Promise.resolve([] as ReportFieldMeta[]),
    ]);

    const recordCount = rows.reduce((sum, row) => sum + Number(row.recordCount), 0);
    fields.push(fromRecords('/totalKgPerArt', 'SlaktReportAssembler.queryExecuted', recordCount));
    this.pushApprovalProvenance(fields, approval);

    // One bucket per species, kg folded into the official quality classes from
    // harvest_records.qualityClass (stored regulatory truth, RPT-007). The
    // class split is RECORDS now — no MANUAL_REQUIRED distribution.
    const bySpecies = new Map<string, KvalitetsklasserPerArtPayload>();
    for (const row of rows) {
      const bucket =
        bySpecies.get(row.artskode) ??
        ({
          art: row.artskode,
          superiorKg: 0,
          ordinærKg: 0,
          produksjonsfiskKg: 0,
          utkastKg: 0,
        } as KvalitetsklasserPerArtPayload);
      addQualityKg(bucket, row.qualityClass, Number(row.totalKg));
      bySpecies.set(row.artskode, bucket);
    }
    const arter = Array.from(bySpecies.values());
    if (arter.length > 0) {
      fields.push(
        fromRecords(
          '/arter',
          'SlaktReportAssembler.queryExecuted (per quality class)',
          recordCount,
        ),
      );
    } else {
      fields.push(
        manualRequired(
          '/arter',
          `No harvest records found for ISO week ${week}/${year} (${fromDate}..${toDate}).`,
          true,
        ),
      );
    }

    const totalKgPerArt = new Map<string, number>();
    for (const row of rows) {
      totalKgPerArt.set(
        row.artskode,
        round2((totalKgPerArt.get(row.artskode) ?? 0) + Number(row.totalKg)),
      );
    }

    return {
      draftPayload: {
        slakteuke: week,
        slakteår: year,
        godkjenningsnummer: approval.value ?? '',
        arter,
        totalKgPerArt: Array.from(totalKgPerArt.entries()).map(([artskode, totalKg]) => ({
          artskode,
          totalKg,
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
    const [rows, approval] = await Promise.all([
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
    this.pushApprovalProvenance(fields, approval);
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
        godkjenningsnummer: approval.value ?? '',
        ukeplanPerArt: Array.from(bySpecies.values()),
      },
      fields,
    };
  }

  private pushApprovalProvenance(
    fields: ReportFieldMeta[],
    approval: { value?: string; source: string },
  ): void {
    if (approval.value) {
      fields.push(fromRecords('/godkjenningsnummer', approval.source, 1));
    } else {
      fields.push(
        manualRequired(
          '/godkjenningsnummer',
          'No slaughter facility configured — add one (with its godkjenningsnummer) in Setup → Slaughter facilities.',
          true,
        ),
      );
    }
  }

  /**
   * The slaughter-facility catalog's default facility is the sole SSoT for the
   * godkjenningsnummer (RPT-007). The legacy regulatory_settings field was the
   * transition fallback and is now dropped (Phase 4 dedup) — no default facility
   * means the field is blocking MANUAL_REQUIRED, resolved in Setup → Facilities.
   */
  private async resolveApprovalNumber(
    tenantId: string,
  ): Promise<{ value?: string; source: string }> {
    const facility = await this.facilityService.getDefaultFacility(tenantId);
    return {
      value: facility?.godkjenningsnummer || undefined,
      source: 'SlaughterFacilityService.defaultFacility',
    };
  }

  private async queryExecuted(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<ExecutedRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `SELECT COALESCE(s."officialCode", s.code) AS artskode,
                hr."qualityClass" AS "qualityClass",
                SUM(hr."totalBiomass")::numeric AS "totalKg",
                COUNT(*)::bigint AS "recordCount"
           FROM harvest_records hr
           JOIN tanks t ON t.id = hr."tankId" AND t."tenantId" = hr."tenantId"
           JOIN departments d ON d.id = t."departmentId" AND d."siteId" = $2
           JOIN batches_v2 b ON b.id = hr."batchId" AND b."tenantId" = hr."tenantId"
           JOIN species s ON s.id = b."speciesId"
          WHERE hr."tenantId" = $1
            AND hr."harvestDate"::date BETWEEN $3 AND $4
          GROUP BY COALESCE(s."officialCode", s.code), hr."qualityClass"
          ORDER BY COALESCE(s."officialCode", s.code), hr."qualityClass"`,
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
        `SELECT COALESCE(s."officialCode", s.code) AS artskode,
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
