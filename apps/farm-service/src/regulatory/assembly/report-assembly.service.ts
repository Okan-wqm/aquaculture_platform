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
import { DiseaseReportAssembler } from './assemblers/disease.assembler';
import { EscapeReportAssembler } from './assemblers/escape.assembler';
import { LakselusReportAssembler } from './assemblers/lakselus.assembler';
import { RensefiskReportAssembler } from './assemblers/rensefisk.assembler';
import { SettefiskReportAssembler } from './assemblers/settefisk.assembler';
import { SlaktReportAssembler } from './assemblers/slakt.assembler';
import { WelfareReportAssembler } from './assemblers/welfare.assembler';
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
  /**
   * The assembled wire-body as a plain JSON record — the single widening from
   * the per-assembler's concrete payload type to the jsonb shape the draft
   * table + `reportPrefill` GraphQL JSON scalar carry, so every downstream
   * consumer reads a keyed record without a cast.
   */
  draftPayload: Record<string, unknown>;
  fields: ReportFieldMeta[];
  /** True when zero blocking fields remain (submission-ready draft). */
  schemaValid: boolean;
  assembledAt: Date;
}

/** Widen a concrete assembler payload to the jsonb record shape (cast-free). */
function toJsonRecord(payload: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload));
}

@Injectable()
export class ReportAssemblyService {
  constructor(
    private readonly biomassAssembler: BiomassReportAssembler,
    private readonly lakselusAssembler: LakselusReportAssembler,
    private readonly settefiskAssembler: SettefiskReportAssembler,
    private readonly rensefiskAssembler: RensefiskReportAssembler,
    private readonly slaktAssembler: SlaktReportAssembler,
    private readonly escapeAssembler: EscapeReportAssembler,
    private readonly welfareAssembler: WelfareReportAssembler,
    private readonly diseaseAssembler: DiseaseReportAssembler,
  ) {}

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
      draftPayload: toJsonRecord(draft.draftPayload),
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
      case ReportPrefillType.BIOMASS:
        return this.biomassAssembler.assemble(
          tenantId,
          siteId,
          period.year,
          this.requireMonth(reportType, period),
        );
      case ReportPrefillType.SMOLT:
        return this.settefiskAssembler.assemble(
          tenantId,
          siteId,
          period.year,
          this.requireMonth(reportType, period),
        );
      case ReportPrefillType.CLEANER_FISH:
        return this.rensefiskAssembler.assemble(
          tenantId,
          siteId,
          period.year,
          this.requireMonth(reportType, period),
        );
      case ReportPrefillType.SEA_LICE:
        return this.lakselusAssembler.assemble(
          tenantId,
          siteId,
          period.year,
          this.requireWeek(reportType, period),
        );
      case ReportPrefillType.SLAUGHTER_EXECUTED:
        return this.slaktAssembler.assembleExecuted(
          tenantId,
          siteId,
          period.year,
          this.requireWeek(reportType, period),
        );
      case ReportPrefillType.SLAUGHTER_PLANNED:
        return this.slaktAssembler.assemblePlanned(
          tenantId,
          siteId,
          period.year,
          this.requireWeek(reportType, period),
        );
      case ReportPrefillType.ESCAPE:
        // Incident-triggered, not period-based: assembles the latest open,
        // unreported escape_incident for the site (period is nominal).
        return this.escapeAssembler.assemble(tenantId, siteId);
      case ReportPrefillType.WELFARE_EVENT:
        // Event-triggered: assembles the site's latest welfare_assessment
        // (period is nominal).
        return this.welfareAssembler.assemble(tenantId, siteId);
      case ReportPrefillType.DISEASE_OUTBREAK:
        // Event-triggered: assembles the site's latest disease_outbreak health
        // event (interim source — FARM-MEDIUM-152; period is nominal).
        return this.diseaseAssembler.assemble(tenantId, siteId);
      default:
        throw new BadRequestException(
          `Server-side assembly for ${reportType} has not landed yet — tracked in ` +
            'docs/plans/2026-07-06-mattilsynet-automated-reporting/PLAN.md (Phase 2: the varsling ' +
            'types assemble from the escape/welfare/disease operational entities once they exist). ' +
            'Use the manual form for this report type until its assembler ships.',
        );
    }
  }

  private requireMonth(reportType: ReportPrefillType, period: ReportPrefillPeriod): number {
    if (!period.month) {
      throw new BadRequestException(`${reportType} prefill requires periodMonth (1-12).`);
    }
    return period.month;
  }

  private requireWeek(reportType: ReportPrefillType, period: ReportPrefillPeriod): number {
    if (!period.week) {
      throw new BadRequestException(`${reportType} prefill requires periodWeek (ISO 1-53).`);
    }
    return period.week;
  }
}
