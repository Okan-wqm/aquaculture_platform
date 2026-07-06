/**
 * BiomassReportService
 *
 * Owns the create / update-if-draft / finalise lifecycle of
 * `farm.biomass_reports`. Phase 2.1 of the "kalan kör noktalar" plan.
 *
 * Behaviour rules:
 *
 *   - The period `(tenantId, siteId, reportMonth, reportYear)` is the
 *     natural key. Two calls for the same period do NOT produce two
 *     rows; the second one updates the existing DRAFT in place.
 *
 *   - A SUBMITTED report is immutable. Re-submitting the same period
 *     after finalising throws `BadRequestException` so accidental
 *     overwrites cannot happen. A caller that genuinely needs to
 *     revise a submitted period must re-submit through a separate
 *     correction workflow (out of scope for phase 2.1).
 *
 *   - `totalBiomassKg` is denormalised at write time — the list UI
 *     can sort/filter on it without scanning JSONB.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotFoundException } from '@nestjs/common';

import {
  BiomassReport,
  BiomassReportPayload,
  BiomassReportStatus,
  TERMINAL_BIOMASS_STATUSES,
} from '../entities/biomass-report.entity';
import { CreateBiomassReportInput } from '../dto/create-biomass-report.input';

@Injectable()
export class BiomassReportService {
  private readonly logger = new Logger(BiomassReportService.name);

  constructor(
    @InjectRepository(BiomassReport)
    private readonly repo: Repository<BiomassReport>,
  ) {}

  async createOrUpdate(
    tenantId: string,
    input: CreateBiomassReportInput,
    userId: string,
  ): Promise<BiomassReport> {
    const existing = await this.repo.findOne({
      where: {
        tenantId,
        siteId: input.siteId,
        reportMonth: input.reportMonth,
        reportYear: input.reportYear,
      },
    });

    if (existing && TERMINAL_BIOMASS_STATUSES.has(existing.status)) {
      throw new BadRequestException(
        `Biomass report for site ${input.siteId} / ${input.reportYear}-` +
          `${input.reportMonth.toString().padStart(2, '0')} is already ` +
          `${existing.status} and cannot be edited. Start a correction flow if the ` +
          `period needs revision.`,
      );
    }

    const payload = this.buildPayload(input);
    const totalBiomassKg = this.deriveTotalBiomass(payload);

    if (existing) {
      existing.reportData = payload;
      existing.totalBiomassKg = totalBiomassKg.toFixed(2);
      existing.generatedBy = userId;
      if (input.submit) {
        existing.status = BiomassReportStatus.SUBMITTED;
        existing.submittedAt = new Date();
        existing.submittedBy = userId;
      }
      const saved = await this.repo.save(existing);
      this.logger.log(
        `Updated biomass report ${saved.id} for site ${input.siteId} ` +
          `(${input.reportYear}-${input.reportMonth}) — status=${saved.status}`,
      );
      return saved;
    }

    const fresh = this.repo.create({
      tenantId,
      siteId: input.siteId,
      reportMonth: input.reportMonth,
      reportYear: input.reportYear,
      status: input.submit
        ? BiomassReportStatus.SUBMITTED
        : BiomassReportStatus.DRAFT,
      reportData: payload,
      totalBiomassKg: totalBiomassKg.toFixed(2),
      generatedBy: userId,
      submittedAt: input.submit ? new Date() : undefined,
      submittedBy: input.submit ? userId : undefined,
    });
    const saved = await this.repo.save(fresh);
    this.logger.log(
      `Created biomass report ${saved.id} for site ${input.siteId} ` +
        `(${input.reportYear}-${input.reportMonth}) — status=${saved.status}`,
    );
    return saved;
  }

  // ==========================================================================
  // Altinn manual-submission state machine (RPT-001)
  //
  //   DRAFT ──markReady──▶ READY ──confirmSubmitted──▶ CONFIRMED_SUBMITTED (terminal)
  //     ▲                    │
  //     └──revertToDraft─────┘
  //
  // The biomass report is submitted to Fiskeridirektoratet MANUALLY via Altinn,
  // so the platform never claims an electronic submission — CONFIRMED_SUBMITTED
  // is reached ONLY when the operator confirms the Altinn receipt.
  // ==========================================================================

  /** DRAFT → READY: the report is reviewed and ready for the Altinn export. */
  async markReady(tenantId: string, id: string, userId: string): Promise<BiomassReport> {
    const report = await this.getOrThrow(tenantId, id);
    if (report.status !== BiomassReportStatus.DRAFT) {
      throw new BadRequestException(
        `Biomass report ${id} is ${report.status}; only a DRAFT can be marked READY`,
      );
    }
    report.status = BiomassReportStatus.READY;
    report.readyAt = new Date();
    report.generatedBy = userId;
    return this.repo.save(report);
  }

  /** READY → DRAFT: reopen for editing / re-assembly before submission. */
  async revertToDraft(tenantId: string, id: string): Promise<BiomassReport> {
    const report = await this.getOrThrow(tenantId, id);
    if (report.status !== BiomassReportStatus.READY) {
      throw new BadRequestException(
        `Biomass report ${id} is ${report.status}; only a READY report can revert to DRAFT`,
      );
    }
    report.status = BiomassReportStatus.DRAFT;
    report.readyAt = undefined;
    return this.repo.save(report);
  }

  /**
   * READY → CONFIRMED_SUBMITTED (terminal): the operator submitted the FD-0001
   * form via Altinn and confirms it with the receipt reference. This is the ONLY
   * path to a terminal biomass state under the honest channel model.
   */
  async confirmSubmitted(
    tenantId: string,
    id: string,
    altinnReference: string,
    userId: string,
  ): Promise<BiomassReport> {
    const report = await this.getOrThrow(tenantId, id);
    if (report.status !== BiomassReportStatus.READY) {
      throw new BadRequestException(
        `Biomass report ${id} is ${report.status}; confirm the Altinn submission only from READY`,
      );
    }
    const reference = altinnReference.trim();
    if (!reference) {
      throw new BadRequestException('An Altinn reference is required to confirm the submission');
    }
    report.status = BiomassReportStatus.CONFIRMED_SUBMITTED;
    report.altinnReference = reference;
    report.confirmedBy = userId;
    report.submittedBy = userId;
    report.submittedAt = new Date();
    return this.repo.save(report);
  }

  private async getOrThrow(tenantId: string, id: string): Promise<BiomassReport> {
    const report = await this.repo.findOne({ where: { id, tenantId } });
    if (!report) {
      throw new NotFoundException(`Biomass report ${id} not found`);
    }
    return report;
  }

  /**
   * Shape-narrowing copy from the input DTO into the typed
   * BiomassReportPayload. Keeps the persistence layer free of the
   * InputType classes (class-validator decorators would otherwise end
   * up on the JSONB column).
   */
  private buildPayload(
    input: CreateBiomassReportInput,
  ): BiomassReportPayload {
    return {
      currentBiomass: {
        totalKg: input.currentBiomass.totalKg,
        bySpecies: input.currentBiomass.bySpecies.map((s) => ({
          speciesId: s.speciesId,
          speciesName: s.speciesName,
          fishCount: s.fishCount,
          biomassKg: s.biomassKg,
          avgWeightG: s.avgWeightG,
        })),
      },
      stockings: input.stockings.map((r) => ({
        date: r.date,
        speciesCode: r.speciesCode,
        supplier: r.supplier,
        fishCount: r.fishCount,
        avgWeightG: r.avgWeightG,
        biomassKg: r.biomassKg,
        notes: r.notes,
      })),
      mortality: {
        totalCount: input.mortality.totalCount,
        byCause: input.mortality.byCause.map((c) => ({
          cause: c.cause,
          count: c.count,
        })),
        details: input.mortality.details.map((d) => ({
          date: d.date,
          cause: d.cause,
          speciesCode: d.speciesCode,
          count: d.count,
          biomassLossKg: d.biomassLossKg,
          notes: d.notes,
        })),
      },
      slaughter: {
        totalQuantity: input.slaughter.totalQuantity,
        totalBiomassKg: input.slaughter.totalBiomassKg,
        records: input.slaughter.records.map((r) => ({
          date: r.date,
          speciesCode: r.speciesCode,
          quantity: r.quantity,
          biomassKg: r.biomassKg,
          buyer: r.buyer,
          notes: r.notes,
        })),
      },
      transfers: input.transfers.map((t) => ({
        date: t.date,
        direction: t.direction,
        speciesCode: t.speciesCode,
        fishCount: t.fishCount,
        biomassKg: t.biomassKg,
        counterparty: t.counterparty,
        notes: t.notes,
      })),
      feedConsumption: {
        totalKg: input.feedConsumption.totalKg,
        byFeedType: input.feedConsumption.byFeedType.map((f) => ({
          feedName: f.feedName,
          brandName: f.brandName,
          quantityKg: f.quantityKg,
        })),
      },
    };
  }

  private deriveTotalBiomass(payload: BiomassReportPayload): number {
    return payload.currentBiomass.bySpecies.reduce(
      (sum, species) => sum + Number(species.biomassKg || 0),
      0,
    );
  }
}
