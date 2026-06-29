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

import {
  BiomassReport,
  BiomassReportPayload,
  BiomassReportStatus,
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

    if (existing && existing.status === BiomassReportStatus.SUBMITTED) {
      throw new BadRequestException(
        `Biomass report for site ${input.siteId} / ${input.reportYear}-` +
          `${input.reportMonth.toString().padStart(2, '0')} is already ` +
          `SUBMITTED and cannot be edited. Start a correction flow if the ` +
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
