/**
 * Disease-outbreak varsling assembler.
 *
 * INTERIM SOURCE (FARM-MEDIUM-152): unlike escape/welfare, disease has no
 * dedicated operational entity — the closest source is the generic health_events
 * ledger. This assembler surfaces the site's latest DISEASE_OUTBREAK health
 * event (scoped through tank → department → site, since health_events carry no
 * siteId) for what it can honestly provide as RECORDS: the disease name
 * (diagnosis/title), the affected percentage, and the pathogen category as
 * operator context. What health_events cannot express in the varsling wire
 * shape stays MANUAL_REQUIRED and blocking — the regulator's disease-LIST
 * category (A/C/F, orthogonal to the pathogen taxonomy), the suspected/confirmed
 * status, the affected fish count, and the veterinarian notification. A site
 * with no disease event blocks the whole draft (fail-closed).
 *
 * Per-tenant read (runInTenantRead sets search_path to tenant_<uuid>).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AssembledDraft, ReportFieldMeta, fromRecords, manualRequired } from '../provenance.types';
import { round2 } from '../period.util';

/** Data portion of the disease varsling payload (identity is a form concern). */
export interface DiseasePrefillPayload {
  healthEventId: string | null;
  eventDate: string | null;
  diseaseName: string;
  pathogenCategory: string | null;
  affectedPercentage: number | null;
  diseaseCategory: string;
  confirmation: string;
  affectedCount: number | null;
  clinicalSigns: string[];
  description: string | null;
  veterinarianNotified: boolean;
  veterinarianName: string;
}

interface DiseaseRow {
  id: string;
  eventDate: string;
  title: string;
  diagnosis: string | null;
  pathogenCategory: string | null;
  affectedPercent: string | null;
  description: string | null;
}

@Injectable()
export class DiseaseReportAssembler {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async assemble(
    tenantId: string,
    siteId: string,
  ): Promise<AssembledDraft<DiseasePrefillPayload>> {
    const row = await this.queryLatestOutbreak(tenantId, siteId);

    if (!row) {
      return {
        draftPayload: {
          healthEventId: null,
          eventDate: null,
          diseaseName: '',
          pathogenCategory: null,
          affectedPercentage: null,
          diseaseCategory: '',
          confirmation: '',
          affectedCount: null,
          clinicalSigns: [],
          description: null,
          veterinarianNotified: false,
          veterinarianName: '',
        },
        fields: [
          manualRequired(
            '/',
            'No disease-outbreak health event on record for this site — record it in Fish Health before filing the disease varsling.',
            true,
          ),
        ],
      };
    }

    const src = 'health_events (latest disease_outbreak event)';
    const diseaseName = row.diagnosis ?? row.title;
    const affectedPercentage = row.affectedPercent != null ? round2(Number(row.affectedPercent)) : null;

    const fields: ReportFieldMeta[] = [
      fromRecords('/diseaseName', src, 1),
      fromRecords('/eventDate', src, 1),
    ];

    // pathogen category (bacterial/viral/…) — RECORDS context that helps the
    // operator pick the regulator's A/C/F list, but is NOT that classification.
    if (row.pathogenCategory) {
      fields.push(fromRecords('/pathogenCategory', src, 1));
    }

    if (affectedPercentage != null) {
      fields.push(fromRecords('/affectedPercentage', src, 1));
    } else {
      fields.push(
        manualRequired('/affectedPercentage', 'Enter the affected percentage of the population.', true),
      );
    }

    // The disease-LIST category (A/C/F) is orthogonal to the pathogen taxonomy —
    // an operator classification the health event cannot make.
    fields.push(
      manualRequired(
        '/diseaseCategory',
        'Classify the disease into the regulator list (A / C / F) — distinct from the pathogen category shown for context.',
        true,
      ),
      manualRequired(
        '/confirmation',
        'State whether the disease is suspected or lab-confirmed.',
        true,
      ),
      manualRequired(
        '/affectedCount',
        'Enter the number of affected fish (health events record a percentage, not a count).',
        true,
      ),
      manualRequired(
        '/veterinarianNotified',
        'Confirm whether a veterinarian has been notified, and name them.',
        true,
      ),
      // Clinical signs are free text on the health event — surfaced as context,
      // but the structured sign list is the operator's to confirm.
      manualRequired(
        '/clinicalSigns',
        'List the clinical signs (the health-event description is shown for reference).',
        false,
      ),
    );

    return {
      draftPayload: {
        healthEventId: row.id,
        eventDate: row.eventDate,
        diseaseName,
        pathogenCategory: row.pathogenCategory,
        affectedPercentage,
        diseaseCategory: '',
        confirmation: '',
        affectedCount: null,
        clinicalSigns: [],
        description: row.description,
        veterinarianNotified: false,
        veterinarianName: '',
      },
      fields,
    };
  }

  private async queryLatestOutbreak(
    tenantId: string,
    siteId: string,
  ): Promise<DiseaseRow | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const rows: DiseaseRow[] = await queryRunner.query(
        `SELECT he.id,
                he."eventDate"::text AS "eventDate",
                he.title,
                he.diagnosis,
                he."diseaseCategory" AS "pathogenCategory",
                he."affectedPercent" AS "affectedPercent",
                he.description
           FROM health_events he
           JOIN tanks t ON t.id = he."tankId"
           JOIN departments d ON d.id = t."departmentId"
          WHERE he."tenantId" = $1
            AND d."siteId" = $2
            AND he."eventType" = 'disease_outbreak'
          ORDER BY he."eventDate" DESC
          LIMIT 1`,
        [tenantId, siteId],
      );
      return rows[0] ?? null;
    });
  }
}
