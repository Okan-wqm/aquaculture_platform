/**
 * Welfare-event varsling assembler.
 *
 * The welfare varsling is event-triggered, not period-based. The platform's
 * welfare_assessments score the regulator-relevant indicators (gill / fin /
 * wound / deformity, 0..3 over a fish sample). This assembler surfaces the
 * site's most recent assessment as RECORDS provenance and DERIVES the varsling
 * severity from the worst indicator score (3 → critical, 2 → high). What the
 * scores cannot classify — the regulatory welfareEventType and, for a
 * mortality-threshold event, the mortality rate — stays MANUAL_REQUIRED; the
 * report never invents a welfare classification. A site with no assessment, or
 * an assessment that indicates no welfare concern (worst score ≤ 1), blocks so
 * the operator records/justifies before filing.
 *
 * Per-tenant read (runInTenantRead sets search_path to tenant_<uuid>).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AssembledDraft, ReportFieldMeta, fromRecords, manualRequired } from '../provenance.types';

/** Data portion of the welfare varsling payload (identity is a form concern). */
export interface WelfarePrefillPayload {
  assessmentId: string | null;
  assessedAt: string | null;
  fishSampled: number;
  gillScore: number | null;
  finScore: number | null;
  woundScore: number | null;
  deformityScore: number | null;
  worstScore: number | null;
  severity: string;
  welfareEventType: string;
  mortalityRate: number | null;
  affectedUnits: string[];
}

interface WelfareRow {
  id: string;
  assessedAt: string;
  fishSampled: number;
  gillScore: number;
  finScore: number;
  woundScore: number;
  deformityScore: number;
  tankCode: string | null;
}

/** WelfareSeverityInput values the varsling accepts (high | critical). */
function severityFromScore(worstScore: number): string {
  return worstScore >= 3 ? 'critical' : 'high';
}

@Injectable()
export class WelfareReportAssembler {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async assemble(tenantId: string, siteId: string): Promise<AssembledDraft<WelfarePrefillPayload>> {
    const row = await this.queryLatestAssessment(tenantId, siteId);

    if (!row) {
      return {
        draftPayload: {
          assessmentId: null,
          assessedAt: null,
          fishSampled: 0,
          gillScore: null,
          finScore: null,
          woundScore: null,
          deformityScore: null,
          worstScore: null,
          severity: '',
          welfareEventType: '',
          mortalityRate: null,
          affectedUnits: [],
        },
        fields: [
          manualRequired(
            '/',
            'No welfare assessment on record for this site — record one in Fish Health (or the mobile app) before filing the welfare varsling.',
            true,
          ),
        ],
      };
    }

    const src = 'welfare_assessments (latest assessment)';
    const worstScore = Math.max(row.gillScore, row.finScore, row.woundScore, row.deformityScore);
    const affectedUnits = row.tankCode ? [row.tankCode] : [];

    const fields: ReportFieldMeta[] = [
      fromRecords('/assessedAt', src, 1),
      fromRecords('/fishSampled', src, 1),
      fromRecords('/gillScore', src, 1),
      fromRecords('/finScore', src, 1),
      fromRecords('/woundScore', src, 1),
      fromRecords('/deformityScore', src, 1),
      // derived from the four RECORDS indicator scores — attributed so every
      // payload leaf traces to a field meta.
      fromRecords('/worstScore', `${src} (worst of the four indicator scores)`, 1),
    ];

    // severity — derivable only when the assessment actually indicates a welfare
    // concern; a healthy assessment (worst ≤ 1) is not varsling-worthy, so the
    // operator must justify the severity.
    let severity = '';
    if (worstScore >= 2) {
      severity = severityFromScore(worstScore);
      fields.push(fromRecords('/severity', `${src} (derived from worst indicator score)`, 1));
    } else {
      fields.push(
        manualRequired(
          '/severity',
          'The latest welfare assessment shows no significant impairment (worst score ≤ 1) — confirm the severity, or record a fresh assessment.',
          true,
        ),
      );
    }

    // welfareEventType — the regulatory classification (mortality-threshold /
    // equipment-failure / welfare-impact) is an operator judgment the indicator
    // scores cannot make.
    fields.push(
      manualRequired(
        '/welfareEventType',
        'Classify the welfare event (mortality threshold, equipment failure, or welfare impact) — the assessment scores do not determine the regulatory event type.',
        true,
      ),
    );

    // mortality rate — only required for a mortality-threshold event; the
    // assessment does not carry it.
    fields.push(
      manualRequired(
        '/mortalityRate',
        'For a mortality-threshold event, enter the mortality rate (%) and period.',
        false,
      ),
    );

    if (row.tankCode) {
      fields.push(fromRecords('/affectedUnits', src, 1));
    } else {
      fields.push(
        manualRequired(
          '/affectedUnits',
          'The assessment was not tank-scoped — name the affected unit(s).',
          false,
        ),
      );
    }

    return {
      draftPayload: {
        assessmentId: row.id,
        assessedAt: row.assessedAt,
        fishSampled: row.fishSampled,
        gillScore: row.gillScore,
        finScore: row.finScore,
        woundScore: row.woundScore,
        deformityScore: row.deformityScore,
        worstScore,
        severity,
        welfareEventType: '',
        mortalityRate: null,
        affectedUnits,
      },
      fields,
    };
  }

  private async queryLatestAssessment(
    tenantId: string,
    siteId: string,
  ): Promise<WelfareRow | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const rows: WelfareRow[] = await queryRunner.query(
        `SELECT wa.id,
                wa."assessedAt"::text AS "assessedAt",
                wa."fishSampled" AS "fishSampled",
                wa."gillScore" AS "gillScore",
                wa."finScore" AS "finScore",
                wa."woundScore" AS "woundScore",
                wa."deformityScore" AS "deformityScore",
                t.code AS "tankCode"
           FROM welfare_assessments wa
           LEFT JOIN tanks t ON t.id = wa."tankId"
          WHERE wa."tenantId" = $1
            AND wa."siteId" = $2
          ORDER BY wa."assessedAt" DESC, wa."createdAt" DESC
          LIMIT 1`,
        [tenantId, siteId],
      );
      return rows[0] ?? null;
    });
  }
}
