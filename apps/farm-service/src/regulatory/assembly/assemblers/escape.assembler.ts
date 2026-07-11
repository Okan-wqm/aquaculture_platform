/**
 * Escape (rømming) varsling assembler.
 *
 * The rømming varsling is incident-triggered, not period-based: it reports a
 * single escape_incident recorded operationally (mobile / Fish Health). This
 * assembler surfaces the most recent OPEN incident for the site that has not yet
 * been reported (varslingReportId IS NULL) as RECORDS provenance, so the report
 * form never re-enters escape facts — corrections flow to the incident record.
 * A site with no open, unreported incident is a blocking MANUAL_REQUIRED naming
 * where to record one (fail-closed — never a silent empty varsling).
 *
 * Per-tenant read (runInTenantRead sets search_path to tenant_<uuid>).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AssembledDraft, ReportFieldMeta, fromRecords, manualRequired } from '../provenance.types';
import { round2 } from '../period.util';
import { OFFICIAL_ARTSKODE_PATTERN } from '../../../species/data/official-species-codes';

/** Official artskode shape — the single SSoT shared by every assembler. */
const OFFICIAL_ARTSKODE = OFFICIAL_ARTSKODE_PATTERN;

/** Data portion of the escape varsling payload (identity is a form concern). */
export interface EscapePrefillPayload {
  incidentId: string | null;
  detectedAt: string | null;
  estimatedCount: number;
  species: string;
  avgWeightG: number | null;
  totalBiomassKg: number | null;
  cause: string;
  causeDetails: string | null;
  affectedUnits: string[];
  recoveryOngoing: boolean;
}

interface EscapeRow {
  id: string;
  detectedAt: Date;
  estimatedCount: number;
  avgWeightG: string | null;
  cause: string;
  causeDetails: string | null;
  recoveryOngoing: boolean;
  tankCode: string | null;
  artskode: string | null;
}

@Injectable()
export class EscapeReportAssembler {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async assemble(tenantId: string, siteId: string): Promise<AssembledDraft<EscapePrefillPayload>> {
    const row = await this.queryLatestOpenIncident(tenantId, siteId);

    if (!row) {
      // Fail-closed: nothing to report from. The whole draft is blocking so the
      // operator records the incident first.
      return {
        draftPayload: {
          incidentId: null,
          detectedAt: null,
          estimatedCount: 0,
          species: '',
          avgWeightG: null,
          totalBiomassKg: null,
          cause: '',
          causeDetails: null,
          affectedUnits: [],
          recoveryOngoing: false,
        },
        fields: [
          manualRequired(
            '/',
            'No open, unreported escape incident for this site — record the rømming in Fish Health (or the mobile app) before filing the varsling.',
            true,
          ),
        ],
      };
    }

    const src = 'escape_incidents (latest open, unreported incident)';
    const avgWeightG = row.avgWeightG != null ? Number(row.avgWeightG) : null;
    const totalBiomassKg =
      avgWeightG != null ? round2((row.estimatedCount * avgWeightG) / 1000) : null;
    const affectedUnits = row.tankCode ? [row.tankCode] : [];

    const fields: ReportFieldMeta[] = [
      fromRecords('/detectedAt', src, 1),
      fromRecords('/estimatedCount', src, 1),
      fromRecords('/cause', src, 1),
      fromRecords('/recoveryOngoing', src, 1),
    ];

    // supplementary free-text cause detail — RECORDS context when the incident
    // carries it; trace its provenance so no payload leaf goes unattributed.
    if (row.causeDetails) {
      fields.push(fromRecords('/causeDetails', src, 1));
    }

    // species — an official FAO code is required to file; unmapped blocks.
    if (row.artskode && OFFICIAL_ARTSKODE.test(row.artskode)) {
      fields.push(fromRecords('/species', src, 1));
    } else {
      fields.push(
        manualRequired(
          '/species',
          `The escaped species has no official FAO code (found "${row.artskode ?? ''}") — set it in Setup → Species.`,
          true,
        ),
      );
    }

    // avgWeight / biomass — both are the regulator's mass figures, so a missing
    // weight on the incident blocks until it is recorded on the source.
    if (avgWeightG != null) {
      fields.push(fromRecords('/avgWeightG', src, 1), fromRecords('/totalBiomassKg', src, 1));
    } else {
      fields.push(
        manualRequired(
          '/avgWeightG',
          'The escape incident has no average weight — record it on the incident so the escaped biomass can be computed.',
          true,
        ),
        manualRequired('/totalBiomassKg', 'Depends on the average weight above.', true),
      );
    }

    // affected units — the pen/merd id. A whole-site escape without a tank is
    // legitimate, so this is non-blocking MANUAL when the incident is untanked.
    if (row.tankCode) {
      fields.push(fromRecords('/affectedUnits', src, 1));
    } else {
      fields.push(
        manualRequired(
          '/affectedUnits',
          'The incident was not tank-scoped — name the affected unit(s) if applicable.',
          false,
        ),
      );
    }

    return {
      draftPayload: {
        incidentId: row.id,
        detectedAt: row.detectedAt.toISOString(),
        estimatedCount: row.estimatedCount,
        species: row.artskode ?? '',
        avgWeightG,
        totalBiomassKg,
        cause: row.cause,
        causeDetails: row.causeDetails,
        affectedUnits,
        recoveryOngoing: row.recoveryOngoing,
      },
      fields,
    };
  }

  private async queryLatestOpenIncident(
    tenantId: string,
    siteId: string,
  ): Promise<EscapeRow | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const rows: EscapeRow[] = await queryRunner.query(
        `SELECT ei.id,
                ei."detectedAt" AS "detectedAt",
                ei."estimatedCount" AS "estimatedCount",
                ei."avgWeightG" AS "avgWeightG",
                ei.cause,
                ei."causeDetails" AS "causeDetails",
                ei."recoveryOngoing" AS "recoveryOngoing",
                t.code AS "tankCode",
                COALESCE(s."officialCode", s.code) AS artskode
           FROM escape_incidents ei
           LEFT JOIN species s ON s.id = ei."speciesId"
           LEFT JOIN tanks t ON t.id = ei."tankId"
          WHERE ei."tenantId" = $1
            AND ei."siteId" = $2
            AND ei.status = 'open'
            AND ei."varslingReportId" IS NULL
          ORDER BY ei."detectedAt" DESC, ei."createdAt" DESC
          LIMIT 1`,
        [tenantId, siteId],
      );
      return rows[0] ?? null;
    });
  }
}
