/**
 * Settefisk (smolt) monthly report assembler.
 *
 * One produksjonsenhet per stocked tank under the site:
 *   karId                     → tanks.regulatoryUnitId (official kar-/merd-id)
 *                               when set, else the internal code (RPT-016b)
 *   artskode                  → species catalog code (official FAO mapping
 *                               lands in Phase 2 — non-2-to-5-uppercase codes
 *                               are flagged blocking)
 *   snittvektGram / beholdning → tank_batches live composition
 *   antallSelvdød             → mortality_records period sum per tank
 *   antallAvlivet             → tank_operations CULL period sum per tank
 *   antallFlyttetEksternt     → cross-site TRANSFER_OUT period sum per tank
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProduksjonsenhetSettefiskPayload } from '../../mattilsynet-api.service';
import { AssembledDraft, fromRecords, manualRequired } from '../provenance.types';
import { monthRange, round2 } from '../period.util';
import { OFFICIAL_ARTSKODE_PATTERN } from '../../../species/data/official-species-codes';

/** Data portion of the settefisk wire payload (identity is a form concern). */
export interface SettefiskPrefillPayload {
  rapporteringsmåned: number;
  rapporteringsår: number;
  produksjonsenheter: ProduksjonsenhetSettefiskPayload[];
}

interface UnitRow {
  tankId: string;
  karId: string;
  artskode: string | null;
  beholdning: string;
  snittvektGram: string | null;
  selvdod: string | null;
  avlivet: string | null;
  flyttetEksternt: string | null;
}

const OFFICIAL_ARTSKODE = OFFICIAL_ARTSKODE_PATTERN;

@Injectable()
export class SettefiskReportAssembler {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async assemble(
    tenantId: string,
    siteId: string,
    reportYear: number,
    reportMonth: number,
  ): Promise<AssembledDraft<SettefiskPrefillPayload>> {
    const { fromDate, toDate } = monthRange(reportYear, reportMonth);
    const rows = await this.queryUnits(tenantId, siteId, fromDate, toDate);

    const produksjonsenheter: ProduksjonsenhetSettefiskPayload[] = rows.map((row) => ({
      karId: row.karId,
      artskode: row.artskode ?? '',
      snittvektGram: row.snittvektGram == null ? 0 : round2(Number(row.snittvektGram)),
      beholdningVedMånedsslutt: Number(row.beholdning),
      antallAvlivet: Number(row.avlivet ?? 0),
      antallSelvdød: Number(row.selvdod ?? 0),
      antallFlyttetEksternt: Number(row.flyttetEksternt ?? 0),
    }));

    const fields = [
      fromRecords('/produksjonsenheter', 'SettefiskReportAssembler.queryUnits', rows.length),
    ];
    if (rows.length === 0) {
      fields.push(
        manualRequired(
          '/produksjonsenheter',
          `No stocked tanks found under the site for ${fromDate}..${toDate} — the official schema requires at least one production unit.`,
          true,
        ),
      );
    }
    rows.forEach((row, index) => {
      if (!row.artskode || !OFFICIAL_ARTSKODE.test(row.artskode)) {
        fields.push(
          manualRequired(
            `/produksjonsenheter/${index}/artskode`,
            `Species of tank ${row.karId} has no official FAO code (found "${row.artskode ?? ''}") — set the official code in Setup → Species.`,
            true,
          ),
        );
      }
    });

    return {
      draftPayload: {
        rapporteringsmåned: reportMonth,
        rapporteringsår: reportYear,
        produksjonsenheter,
      },
      fields,
    };
  }

  private async queryUnits(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<UnitRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `WITH site_tanks AS (
           SELECT t.id, COALESCE(t."regulatoryUnitId", t.code) AS code
             FROM tanks t
             JOIN departments d ON d.id = t."departmentId"
            WHERE t."tenantId" = $1 AND d."siteId" = $2
         ),
         -- PERF-HIGH-002: each aggregation is scoped to the site's tanks via
         -- site_tanks so it uses the (tankId, recordDate/operationDate) index for a
         -- handful of tanks, instead of scanning the tenant's whole mortality /
         -- operations history once per site and discarding the non-site rows.
         mortality AS (
           SELECT mr."tankId" AS tank_id, SUM(mr.count)::bigint AS selvdod
             FROM mortality_records mr
             JOIN site_tanks st ON st.id = mr."tankId"
            WHERE mr."tenantId" = $1 AND mr."recordDate" BETWEEN $3 AND $4
            GROUP BY mr."tankId"
         ),
         culls AS (
           SELECT o."tankId" AS tank_id, SUM(o.quantity)::bigint AS avlivet
             FROM tank_operations o
             JOIN site_tanks st ON st.id = o."tankId"
            WHERE o."tenantId" = $1
              AND o."operationType" = 'cull'
              AND o."operationDate"::date BETWEEN $3 AND $4
            GROUP BY o."tankId"
         ),
         external_out AS (
           SELECT o."tankId" AS tank_id, SUM(o.quantity)::bigint AS flyttet
             FROM tank_operations o
             JOIN site_tanks st ON st.id = o."tankId"
             LEFT JOIN tanks dt ON dt.id = o."destinationTankId"
             LEFT JOIN departments dd ON dd.id = dt."departmentId"
            WHERE o."tenantId" = $1
              AND o."operationType" = 'transfer_out'
              AND o."operationDate"::date BETWEEN $3 AND $4
              AND (dd."siteId" IS NULL OR dd."siteId" <> $2)
            GROUP BY o."tankId"
         )
         SELECT st.id AS "tankId",
                st.code AS "karId",
                COALESCE(s."officialCode", s.code) AS artskode,
                tb."totalQuantity"::bigint AS beholdning,
                CASE WHEN tb."totalQuantity" > 0
                     THEN tb."totalBiomassKg" * 1000.0 / tb."totalQuantity"
                END AS "snittvektGram",
                m.selvdod::text AS selvdod,
                c.avlivet::text AS avlivet,
                x.flyttet::text AS "flyttetEksternt"
           FROM site_tanks st
           JOIN tank_batches tb ON tb."tankId" = st.id AND tb."tenantId" = $1
           LEFT JOIN batches_v2 b ON b.id = tb."primaryBatchId"
           LEFT JOIN species s ON s.id = b."speciesId"
           LEFT JOIN mortality m ON m.tank_id = st.id
           LEFT JOIN culls c ON c.tank_id = st.id
           LEFT JOIN external_out x ON x.tank_id = st.id
          WHERE tb."totalQuantity" > 0
          ORDER BY st.code`,
        [tenantId, siteId, fromDate, toDate],
      );
    });
  }
}
