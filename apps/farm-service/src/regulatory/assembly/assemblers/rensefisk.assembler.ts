/**
 * Rensefisk (cleaner fish) monthly report assembler.
 *
 * Per merd (tank carrying cleaner fish) and per cleaner species:
 *   beholdningVedForrigeMånedsslutt → reconstructed from the current
 *     tank_batches cleaner composition minus this month's ledger deltas
 *   utsett.antallNy / antallFlyttetInn → CLEANER_DEPLOYMENT / _TRANSFER_IN
 *   uttak.antallSelvdød / antallFlyttetUt → CLEANER_MORTALITY / _TRANSFER_OUT
 *   the six avlivet buckets + kanIkkeGjøresRedeFor → 0 with a MANUAL note
 *     carrying the CLEANER_REMOVAL total: the ledger records THAT removals
 *     happened but not the regulator's cause split (Phase 2 adds the split
 *     at capture time — no guessing here)
 *   artskode → must be one of the official USB/BER/GRO/BNB; anything else
 *     is flagged blocking (fixed in Setup → Species)
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryBus } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  ProduksjonsenhetRensefiskPayload,
  RensefiskUttakPayload,
} from '../../mattilsynet-api.service';
import {
  GetSiteFeedConsumptionQuery,
  SiteFeedConsumptionResult,
} from '../../../feeding/queries/get-site-feed-consumption.query';
import { AssembledDraft, fromRecords, manualRequired } from '../provenance.types';
import { monthRange } from '../period.util';

/** Data portion of the rensefisk wire payload (identity is a form concern). */
export interface RensefiskPrefillPayload {
  rapporteringsmåned: number;
  rapporteringsår: number;
  tørrforKg?: number;
  våtforKg?: number;
  produksjonsenheter: ProduksjonsenhetRensefiskPayload[];
}

interface CompositionRow {
  tankId: string;
  merdId: string;
  speciesId: string;
  artskode: string | null;
  sourceType: string | null;
  quantity: string;
}

interface LedgerRow {
  tankId: string;
  speciesId: string;
  operationType: string;
  total: string;
}

const OFFICIAL_CLEANER_CODES = new Set(['USB', 'BER', 'GRO', 'BNB']);

const EMPTY_UTTAK: RensefiskUttakPayload = {
  antallAvlivetSykdom: 0,
  antallAvlivetSkader: 0,
  antallAvlivetAvmagret: 0,
  antallAvlivetForeståendeHåndteringAvLaksen: 0,
  antallAvlivetForeståendeUgunstigLevemiljø: 0,
  antallAvlivetSkalIkkeBrukes: 0,
  antallSelvdød: 0,
  antallFlyttetUt: 0,
  antallKanIkkeGjøresRedeFor: 0,
};

@Injectable()
export class RensefiskReportAssembler {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBus: QueryBus,
  ) {}

  async assemble(
    tenantId: string,
    siteId: string,
    reportYear: number,
    reportMonth: number,
  ): Promise<AssembledDraft<RensefiskPrefillPayload>> {
    const { fromDate, toDate } = monthRange(reportYear, reportMonth);

    const [composition, ledger, feed] = await Promise.all([
      this.queryComposition(tenantId, siteId),
      this.queryLedger(tenantId, siteId, fromDate, toDate),
      this.queryBus.execute<GetSiteFeedConsumptionQuery, SiteFeedConsumptionResult>(
        new GetSiteFeedConsumptionQuery(tenantId, siteId, fromDate, toDate),
      ),
    ]);

    // Ledger deltas keyed by tank+species.
    const deltas = new Map<string, Record<string, number>>();
    for (const row of ledger) {
      const key = `${row.tankId}:${row.speciesId}`;
      const entry = deltas.get(key) ?? {};
      entry[row.operationType] = Number(row.total);
      deltas.set(key, entry);
    }

    const byTank = new Map<
      string,
      { merdId: string; arter: ProduksjonsenhetRensefiskPayload['arter'] }
    >();
    const fields = [
      fromRecords(
        '/produksjonsenheter',
        'RensefiskReportAssembler.queryComposition',
        composition.length,
      ),
    ];
    let unitIndex = 0;

    for (const row of composition) {
      const delta = deltas.get(`${row.tankId}:${row.speciesId}`) ?? {};
      const ny = delta['cleaner_deployment'] ?? 0;
      const flyttetInn = delta['cleaner_transfer_in'] ?? 0;
      const selvdod = delta['cleaner_mortality'] ?? 0;
      const flyttetUt = delta['cleaner_transfer_out'] ?? 0;
      const removals = delta['cleaner_removal'] ?? 0;

      // Closing stock (now) minus in-month inflows plus in-month outflows.
      const beholdningPrev = Math.max(
        0,
        Number(row.quantity) - ny - flyttetInn + selvdod + flyttetUt + removals,
      );

      const tank = byTank.get(row.tankId) ?? { merdId: row.merdId, arter: [] };
      const artskode = row.artskode ?? '';
      tank.arter.push({
        artskode: artskode as 'USB' | 'BER' | 'GRO' | 'BNB',
        opprinnelse:
          row.sourceType === 'wild_caught'
            ? 'VILLFANGET'
            : row.sourceType === 'farmed'
              ? 'OPPDRETTET'
              : 'UKJENT',
        beholdningVedForrigeMånedsslutt: beholdningPrev,
        utsett: { antallFlyttetInn: flyttetInn, antallNy: ny },
        uttak: { ...EMPTY_UTTAK, antallSelvdød: selvdod, antallFlyttetUt: flyttetUt },
      });
      byTank.set(row.tankId, tank);

      if (!OFFICIAL_CLEANER_CODES.has(artskode)) {
        fields.push(
          manualRequired(
            `/produksjonsenheter/${unitIndex}/arter`,
            `Cleaner species in ${row.merdId} has code "${artskode}" — the official schema accepts only USB/BER/GRO/BNB. Set the official code in Setup → Species.`,
            true,
          ),
        );
      }
      if (removals > 0) {
        fields.push(
          manualRequired(
            `/produksjonsenheter/${unitIndex}/arter`,
            `${removals} cleaner fish were removed from ${row.merdId} this month — distribute them across the official uttak causes (the ledger records removals without the regulator's cause split until Phase 2).`,
            false,
          ),
        );
      }
      unitIndex += 1;
    }

    const produksjonsenheter = Array.from(byTank.values()).map((tank) => ({
      merdId: tank.merdId,
      arter: tank.arter,
    }));
    if (produksjonsenheter.length === 0) {
      fields.push(
        manualRequired(
          '/produksjonsenheter',
          'No cleaner-fish stock found under the site — the official schema requires at least one production unit.',
          true,
        ),
      );
    }
    // The feeding ledger does not distinguish cleaner dry/wet feed; surface
    // the site total as context and leave the split to the operator.
    fields.push(
      manualRequired(
        '/tørrforKg',
        `Cleaner-fish dry/wet feed split is manual (site feed ledger total for the period: ${feed.totalKg} kg).`,
        false,
      ),
    );

    return {
      draftPayload: {
        rapporteringsmåned: reportMonth,
        rapporteringsår: reportYear,
        produksjonsenheter,
      },
      fields,
    };
  }

  private async queryComposition(tenantId: string, siteId: string): Promise<CompositionRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `SELECT t.id AS "tankId",
                t.code AS "merdId",
                cfd->>'speciesId' AS "speciesId",
                COALESCE(s."officialCode", s.code) AS artskode,
                cfd->>'sourceType' AS "sourceType",
                COALESCE(cfd->>'quantity', '0') AS quantity
           FROM tanks t
           JOIN departments d ON d.id = t."departmentId" AND d."siteId" = $2
           JOIN tank_batches tb ON tb."tankId" = t.id AND tb."tenantId" = $1,
           jsonb_array_elements(COALESCE(tb."cleanerFishDetails", '[]'::jsonb)) AS cfd
           LEFT JOIN species s ON s.id = (cfd->>'speciesId')::uuid
          WHERE t."tenantId" = $1
          ORDER BY t.code`,
        [tenantId, siteId],
      );
    });
  }

  private async queryLedger(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<LedgerRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `SELECT o."tankId" AS "tankId",
                b."speciesId" AS "speciesId",
                o."operationType" AS "operationType",
                SUM(o.quantity)::bigint AS total
           FROM tank_operations o
           JOIN tanks t ON t.id = o."tankId" AND t."tenantId" = o."tenantId"
           JOIN departments d ON d.id = t."departmentId" AND d."siteId" = $2
           JOIN batches_v2 b ON b.id = o."batchId" AND b."tenantId" = o."tenantId"
          WHERE o."tenantId" = $1
            AND o."operationType" IN (
              'cleaner_deployment', 'cleaner_mortality', 'cleaner_removal',
              'cleaner_transfer_in', 'cleaner_transfer_out'
            )
            AND o."operationDate"::date BETWEEN $3 AND $4
          GROUP BY o."tankId", b."speciesId", o."operationType"`,
        [tenantId, siteId, fromDate, toDate],
      );
    });
  }
}
