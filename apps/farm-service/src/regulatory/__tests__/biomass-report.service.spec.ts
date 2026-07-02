/**
 * BiomassReportService Unit Tests
 *
 * Covers the create-or-update-if-draft lifecycle, the immutability of
 * SUBMITTED reports, and the denormalised totalBiomassKg derivation.
 * Uses a hand-rolled repository double that only surfaces the methods
 * the service consumes so no type widens to `any`.
 */
import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { BiomassReportService } from '../services/biomass-report.service';
import {
  BiomassReport,
  BiomassReportStatus,
} from '../entities/biomass-report.entity';
import { CreateBiomassReportInput } from '../dto/create-biomass-report.input';

/** Minimal shape the service actually uses — avoids `as any`. */
interface RepoDouble {
  findOne: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  find: jest.Mock;
}

function makeRepoDouble(): RepoDouble {
  return {
    findOne: jest.fn(),
    save: jest.fn(async (x: BiomassReport) => x),
    create: jest.fn((x: Partial<BiomassReport>) => x as BiomassReport),
    find: jest.fn(async () => []),
  };
}

function makeInput(
  overrides: Partial<CreateBiomassReportInput> = {},
): CreateBiomassReportInput {
  const base: CreateBiomassReportInput = {
    siteId: '00000000-0000-4000-8000-000000000001',
    reportMonth: 4,
    reportYear: 2026,
    submit: false,
    currentBiomass: {
      totalKg: 42000,
      bySpecies: [
        {
          speciesId: 'ATLANTIC_SALMON',
          speciesName: 'Atlantic Salmon',
          fishCount: 100_000,
          biomassKg: 42000,
          avgWeightG: 420,
        },
      ],
    },
    stockings: [],
    mortality: {
      totalCount: 0,
      byCause: [],
      details: [],
    },
    slaughter: {
      totalQuantity: 0,
      totalBiomassKg: 0,
      records: [],
    },
    transfers: [],
    feedConsumption: {
      totalKg: 0,
      byFeedType: [],
    },
  };
  return { ...base, ...overrides };
}

describe('BiomassReportService', () => {
  const tenantId = '99999999-9999-4999-8999-999999999999';
  const userId = 'user-1';

  describe('createOrUpdate', () => {
    it('creates a new DRAFT when no existing row is found', async () => {
      const repo = makeRepoDouble();
      repo.findOne.mockResolvedValue(null);
      const service = new BiomassReportService(
        repo as unknown as Repository<BiomassReport>,
      );

      const result = await service.createOrUpdate(tenantId, makeInput(), userId);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          siteId: '00000000-0000-4000-8000-000000000001',
          reportMonth: 4,
          reportYear: 2026,
          status: BiomassReportStatus.DRAFT,
          generatedBy: userId,
          submittedAt: undefined,
        }),
      );
      expect(result.status).toBe(BiomassReportStatus.DRAFT);
      expect(result.totalBiomassKg).toBe('42000.00');
    });

    it('creates SUBMITTED when submit=true', async () => {
      const repo = makeRepoDouble();
      repo.findOne.mockResolvedValue(null);
      const service = new BiomassReportService(
        repo as unknown as Repository<BiomassReport>,
      );

      const result = await service.createOrUpdate(
        tenantId,
        makeInput({ submit: true }),
        userId,
      );

      expect(result.status).toBe(BiomassReportStatus.SUBMITTED);
      expect(result.submittedBy).toBe(userId);
      expect(result.submittedAt).toBeInstanceOf(Date);
    });

    it('updates an existing DRAFT in place (idempotent per period)', async () => {
      const existingDraft: BiomassReport = {
        id: 'row-1',
        tenantId,
        siteId: '00000000-0000-4000-8000-000000000001',
        reportMonth: 4,
        reportYear: 2026,
        status: BiomassReportStatus.DRAFT,
        reportData: {} as BiomassReport['reportData'],
        totalBiomassKg: '0.00',
        generatedBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const repo = makeRepoDouble();
      repo.findOne.mockResolvedValue(existingDraft);
      const service = new BiomassReportService(
        repo as unknown as Repository<BiomassReport>,
      );

      const result = await service.createOrUpdate(tenantId, makeInput(), userId);

      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('row-1');
      expect(result.totalBiomassKg).toBe('42000.00');
    });

    it('rejects update of a SUBMITTED row', async () => {
      const submitted: BiomassReport = {
        id: 'row-1',
        tenantId,
        siteId: '00000000-0000-4000-8000-000000000001',
        reportMonth: 4,
        reportYear: 2026,
        status: BiomassReportStatus.SUBMITTED,
        reportData: {} as BiomassReport['reportData'],
        totalBiomassKg: '1.00',
        generatedBy: userId,
        submittedAt: new Date(),
        submittedBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const repo = makeRepoDouble();
      repo.findOne.mockResolvedValue(submitted);
      const service = new BiomassReportService(
        repo as unknown as Repository<BiomassReport>,
      );

      await expect(
        service.createOrUpdate(tenantId, makeInput(), userId),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('denormalises totalBiomassKg across all species entries', async () => {
      const repo = makeRepoDouble();
      repo.findOne.mockResolvedValue(null);
      const service = new BiomassReportService(
        repo as unknown as Repository<BiomassReport>,
      );

      const input = makeInput({
        currentBiomass: {
          totalKg: 99999,
          bySpecies: [
            {
              speciesId: 'A',
              speciesName: 'A',
              fishCount: 1,
              biomassKg: 1500.5,
              avgWeightG: 1,
            },
            {
              speciesId: 'B',
              speciesName: 'B',
              fishCount: 1,
              biomassKg: 2499.5,
              avgWeightG: 1,
            },
          ],
        },
      });

      const result = await service.createOrUpdate(tenantId, input, userId);

      // Derived from bySpecies, NOT from input.currentBiomass.totalKg.
      expect(result.totalBiomassKg).toBe('4000.00');
    });
  });

  // findByPeriod + listForSite were migrated out of BiomassReportService to the
  // fail-closed read handlers (FARM-HIGH-060, #741). Their coverage — tenant
  // scoping, the composite-key lookup, and the [1,120] limit clamp — now lives
  // in biomass-report-read-handlers.spec.ts. createOrUpdate (the write) stays here.
});
