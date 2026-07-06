/**
 * ReportAssemblyService — one entry point for server-assembled regulatory
 * report drafts (`reportPrefill`).
 *
 * Dispatches to the per-type assembler and computes the blocking verdict.
 * Assembler rollout is phased in the automated-reporting plan
 * (docs/plans/2026-07-06-mattilsynet-automated-reporting/PLAN.md):
 * BIOMASS lands in Phase 1; the five Mattilsynet REST types + the three
 * varsling types follow as their operational source entities land
 * (Phases 1b/2). Requesting a type whose assembler has not landed is a
 * client error naming the plan phase — never a silent empty draft.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { BiomassReportAssembler } from './biomass.assembler';
import { AssembledDraft, ReportFieldMeta } from './provenance.types';

/**
 * Report types that can be server-assembled. Superset of
 * RegulatoryReportType: BIOMASS has its own entity/lifecycle (Altinn
 * channel, not Mattilsynet REST) but shares the prefill pipeline.
 */
export enum ReportPrefillType {
  BIOMASS = 'BIOMASS',
  SEA_LICE = 'SEA_LICE',
  CLEANER_FISH = 'CLEANER_FISH',
  SMOLT = 'SMOLT',
  SLAUGHTER_PLANNED = 'SLAUGHTER_PLANNED',
  SLAUGHTER_EXECUTED = 'SLAUGHTER_EXECUTED',
  WELFARE_EVENT = 'WELFARE_EVENT',
  ESCAPE = 'ESCAPE',
  DISEASE_OUTBREAK = 'DISEASE_OUTBREAK',
}

export interface ReportPrefillPeriod {
  year: number;
  week?: number;
  month?: number;
}

export interface AssembledReport {
  reportType: ReportPrefillType;
  siteId: string;
  periodYear: number;
  periodWeek?: number;
  periodMonth?: number;
  draftPayload: object;
  fields: ReportFieldMeta[];
  /** True when zero blocking fields remain (submission-ready draft). */
  schemaValid: boolean;
  assembledAt: Date;
}

@Injectable()
export class ReportAssemblyService {
  constructor(private readonly biomassAssembler: BiomassReportAssembler) {}

  async assemble(
    tenantId: string,
    reportType: ReportPrefillType,
    siteId: string,
    period: ReportPrefillPeriod,
  ): Promise<AssembledReport> {
    const draft = await this.assembleDraft(tenantId, reportType, siteId, period);
    return {
      reportType,
      siteId,
      periodYear: period.year,
      periodWeek: period.week,
      periodMonth: period.month,
      draftPayload: draft.draftPayload,
      fields: draft.fields,
      schemaValid: !draft.fields.some((field) => field.blocking),
      assembledAt: new Date(),
    };
  }

  private async assembleDraft(
    tenantId: string,
    reportType: ReportPrefillType,
    siteId: string,
    period: ReportPrefillPeriod,
  ): Promise<AssembledDraft<object>> {
    switch (reportType) {
      case ReportPrefillType.BIOMASS: {
        if (!period.month) {
          throw new BadRequestException('BIOMASS prefill requires periodMonth (1-12).');
        }
        return this.biomassAssembler.assemble(tenantId, siteId, period.year, period.month);
      }
      default:
        throw new BadRequestException(
          `Server-side assembly for ${reportType} has not landed yet — tracked in ` +
            'docs/plans/2026-07-06-mattilsynet-automated-reporting/PLAN.md (Phases 1b/2). ' +
            'Use the manual form for this report type until its assembler ships.',
        );
    }
  }
}
