/**
 * WaterQualityService Unit Tests — SINGLE-INGRESS (Tier-1)
 *
 * Proves the single-ingress invariant for parameter values:
 *   1. validate() runs UNCONDITIONALLY on every create (no legacy "only if
 *      dynamicParameters present" branch).
 *   2. A failed validation (strict-mode reject of empty-with-keys / no-config)
 *      throws BadRequestException and NOTHING is persisted.
 *   3. update() re-validates the MERGED dynamic parameters against the
 *      measurement's stored equipmentId before save.
 *   4. The legacy fixed `parameters` field is structurally gone from the
 *      create/update DTOs — there is no second parameter channel.
 *
 * London-school: every collaborator (evaluation, validation, datasource,
 * outbox, repositories) is provided as a NestJS `useValue` double — no casts.
 */
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { WaterQualityValidationService } from '../services/water-quality-validation.service';
import { WaterQualityEvaluationService } from '../services/water-quality-evaluation.service';
import {
  WaterQualityService,
  CreateWaterQualityData,
  WaterQualityCaller,
} from '../water-quality.service';
import {
  WaterQualityMeasurement,
  WaterQualityStatus,
  MeasurementSource,
} from '../entities/water-quality-measurement.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { CreateWaterQualityInput } from '../dto/create-water-quality.input';
import { UpdateWaterQualityInput } from '../dto/update-water-quality.input';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EQUIPMENT = '22222222-2222-4222-8222-222222222222';
const MEASUREMENT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

// SEC-HIGH-051: the caller threaded into WaterQualityService.create. A
// MODULE_MANAGER bypasses the object-level site check via the canonical role
// hierarchy, so these single-ingress validation tests keep their original
// behaviour — they assert validate()/persist invariants, not the site gate.
const WQ_CALLER: WaterQualityCaller = {
  sub: USER,
  roles: [Role.MODULE_MANAGER],
  assignedSiteIds: [],
};

interface ServiceHarness {
  service: WaterQualityService;
  validate: jest.Mock;
  evaluate: jest.Mock;
  repository: ReturnType<typeof createMockRepository<WaterQualityMeasurement>>;
  mockManager: ReturnType<typeof createMockDataSource>['mockManager'];
  enqueue: jest.Mock;
  recalcForUnitMock: jest.Mock;
}

async function buildService(): Promise<ServiceHarness> {
  const repository = createMockRepository<WaterQualityMeasurement>();
  const tankRepository = createMockRepository<Tank>();

  const evaluate = jest.fn().mockResolvedValue({
    overallStatus: WaterQualityStatus.OPTIMAL,
    criticalCount: 0,
    warningCount: 0,
    optimalCount: 1,
    evaluations: [{ parameter: 'temperature', value: 14, unit: 'C', status: 'optimal' }],
    recommendations: [],
  });
  const validate = jest.fn().mockResolvedValue({ valid: true, errors: [] });
  const recalcForUnitMock = jest.fn().mockResolvedValue(null);
  const enqueue = jest.fn().mockResolvedValue(undefined);

  const { mockDataSource, mockManager } = createMockDataSource();

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      WaterQualityService,
      { provide: getRepositoryToken(WaterQualityMeasurement), useValue: repository },
      { provide: getRepositoryToken(Tank), useValue: tankRepository },
      { provide: WaterQualityEvaluationService, useValue: { evaluate } },
      { provide: WaterQualityValidationService, useValue: { validate } },
      { provide: DataSource, useValue: mockDataSource },
      { provide: OutboxPublisher, useValue: { enqueue } },
      // SEC-HIGH-051: pure policy with no constructor deps — provided as the
      // real class so the object-level site check runs production logic. The
      // MODULE_MANAGER WQ_CALLER bypasses it, preserving each test's intent.
      SiteAuthorizationService,
      // P-31 recalc — mocked (day-plan-recalc.service.spec kapsıyor).
      { provide: DayPlanRecalcService, useValue: { recalcForUnit: recalcForUnitMock } },
    ],
  }).compile();

  const service = moduleRef.get(WaterQualityService);
  return { service, validate, evaluate, repository, mockManager, enqueue, recalcForUnitMock };
}

function createInput(overrides: Partial<CreateWaterQualityData> = {}): CreateWaterQualityData {
  return {
    equipmentId: EQUIPMENT,
    measuredAt: new Date('2026-06-14T08:00:00Z'),
    source: MeasurementSource.MANUAL,
    dynamicParameters: { temperature: 14 },
    ...overrides,
  };
}

describe('WaterQualityService — single-ingress validation', () => {
  describe('create()', () => {
    it('runs validate() UNCONDITIONALLY on every create with equipmentId + dynamicParameters', async () => {
      const { service, validate, mockManager } = await buildService();
      mockManager.save.mockImplementation((_entityClass: unknown, data: unknown) =>
        Promise.resolve({
          id: MEASUREMENT,
          measuredAt: new Date('2026-06-14T08:00:00Z'),
          parameters: { temperature: 14 },
          ...(data as object),
        }),
      );

      await service.create(TENANT, createInput(), WQ_CALLER);

      expect(validate).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledWith(TENANT, { temperature: 14 }, EQUIPMENT);
    });

    it('rejects when strict-mode validation fails (empty-with-keys / no-config) and persists nothing', async () => {
      const { service, validate, mockManager, enqueue } = await buildService();
      validate.mockResolvedValue({
        valid: false,
        errors: [
          {
            field: '__tenant__',
            code: 'NO_ACTIVE_PARAMETER_CONFIGS',
            message: 'Tenant has no active water-quality parameter configurations.',
          },
        ],
      });

      await expect(
        service.create(TENANT, createInput({ dynamicParameters: { foo: 1 } }), WQ_CALLER),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockManager.save).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns the idempotent existing measurement WITHOUT re-validating (replay safety)', async () => {
      const { service, validate, repository } = await buildService();
      const existing = { id: MEASUREMENT, tenantId: TENANT } as WaterQualityMeasurement;
      repository.findOne.mockResolvedValue(existing);

      const result = await service.create(
        TENANT,
        createInput({ idempotencyKey: '44444444-4444-4444-8444-444444444444' }),
        WQ_CALLER,
      );

      expect(result).toBe(existing);
      expect(validate).not.toHaveBeenCalled();
    });

    it('persists only the dynamicParameters JSONB (no static parameters merge)', async () => {
      const { service, mockManager } = await buildService();
      mockManager.save.mockImplementation((_e: unknown, entity: unknown) =>
        Promise.resolve({ id: MEASUREMENT, ...(entity as object) }),
      );

      await service.create(
        TENANT,
        createInput({ dynamicParameters: { temperature: 14, ph: 7.2 } }),
        WQ_CALLER,
      );

      // jest infers create()'s array overload for the recorded call, so the
      // 2nd arg is typed `unknown[] | undefined` — which does not overlap with
      // the entity-like shape for a direct cast. Widen to `unknown` first (an
      // implicit, lossless assignment), then a single cast probes the runtime
      // entity the handler built via manager.create(WaterQualityMeasurement, …).
      const createArg: unknown = mockManager.create.mock.calls[0]![1];
      const createdEntity = createArg as { parameters: Record<string, unknown> };
      expect(createdEntity.parameters).toEqual({ temperature: 14, ph: 7.2 });
    });
  });

  describe('update()', () => {
    it('re-validates the MERGED dynamic parameters against the stored equipmentId before save', async () => {
      const { service, validate, repository } = await buildService();
      const stored = {
        id: MEASUREMENT,
        tenantId: TENANT,
        equipmentId: EQUIPMENT,
        parameters: { temperature: 14 },
        overallStatus: WaterQualityStatus.OPTIMAL,
        hasAlarm: false,
      } as WaterQualityMeasurement;
      repository.findOne.mockResolvedValue(stored);
      repository.save.mockImplementation((m: unknown) =>
        Promise.resolve(m as WaterQualityMeasurement),
      );

      await service.update(TENANT, MEASUREMENT, { dynamicParameters: { ph: 7.5 } });

      expect(validate).toHaveBeenCalledWith(TENANT, { temperature: 14, ph: 7.5 }, EQUIPMENT);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('rejects an update whose merged parameters fail validation and does NOT save', async () => {
      const { service, validate, repository } = await buildService();
      repository.findOne.mockResolvedValue({
        id: MEASUREMENT,
        tenantId: TENANT,
        equipmentId: EQUIPMENT,
        parameters: { temperature: 14 },
      } as WaterQualityMeasurement);
      validate.mockResolvedValue({
        valid: false,
        errors: [{ field: 'bogus', code: 'UNKNOWN_PARAMETER', message: 'unknown' }],
      });

      await expect(
        service.update(TENANT, MEASUREMENT, { dynamicParameters: { bogus: 1 } }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.save).not.toHaveBeenCalled();
    });

    it('skips validation when only notes/weather change (no dynamicParameters)', async () => {
      const { service, validate, repository } = await buildService();
      repository.findOne.mockResolvedValue({
        id: MEASUREMENT,
        tenantId: TENANT,
        equipmentId: EQUIPMENT,
        parameters: { temperature: 14 },
        overallStatus: WaterQualityStatus.OPTIMAL,
      } as WaterQualityMeasurement);
      repository.save.mockImplementation((m: unknown) =>
        Promise.resolve(m as WaterQualityMeasurement),
      );

      await service.update(TENANT, MEASUREMENT, { notes: 'rechecked' });

      expect(validate).not.toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('DTO single-ingress shape (legacy parameters removed)', () => {
    // COMPILE-TIME proof (the definitive guarantee): this spec is type-checked
    // under the project's strict tsconfig. A complete CreateWaterQualityInput
    // can be satisfied WITHOUT a `parameters` field — if `parameters` were still
    // a (required) member, the `satisfies` check below would fail the build. The
    // `Extract<keyof T, 'parameters'>` type assertions resolve to `never`,
    // failing compilation if the key ever reappears on either DTO.
    it('CreateWaterQualityInput omits `parameters` and is satisfiable with dynamicParameters only', () => {
      const input = {
        equipmentId: EQUIPMENT,
        measuredAt: new Date('2026-06-14T08:00:00Z'),
        source: MeasurementSource.MANUAL,
        dynamicParameters: { temperature: 14 },
      } satisfies CreateWaterQualityInput;

      const noLegacyKey: Extract<keyof CreateWaterQualityInput, 'parameters'> extends never
        ? true
        : false = true;

      expect(noLegacyKey).toBe(true);
      expect(input.dynamicParameters).toEqual({ temperature: 14 });
      expect(input.equipmentId).toBe(EQUIPMENT);
    });

    it('UpdateWaterQualityInput omits `parameters` and exposes dynamicParameters', () => {
      const input = {
        id: MEASUREMENT,
        dynamicParameters: { ph: 7.1 },
      } satisfies UpdateWaterQualityInput;

      const noLegacyKey: Extract<keyof UpdateWaterQualityInput, 'parameters'> extends never
        ? true
        : false = true;

      expect(noLegacyKey).toBe(true);
      expect(input.dynamicParameters).toEqual({ ph: 7.1 });
    });
  });

  describe('recordManualTemperature', () => {
    it('persists a MANUAL temperature-only measurement and triggers same-tx recalc (P-31)', async () => {
      const { service, repository, mockManager, recalcForUnitMock } = await buildService();
      repository.create.mockImplementation((m: unknown) => m as WaterQualityMeasurement);

      const result = await service.recordManualTemperature(TENANT, 'tank-1', 12.5, 'user-1');

      expect(result).toBe(true);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          tankId: 'tank-1',
          equipmentId: 'tank-1',
          source: MeasurementSource.MANUAL,
          temperature: 12.5,
          parameters: { temperature: 12.5 },
          measuredBy: 'user-1',
        }),
      );
      // Persist artık transaction manager'ından geçer (kayıt + recalc atomik).
      expect(mockManager.save).toHaveBeenCalledTimes(1);
      expect(recalcForUnitMock).toHaveBeenCalledWith(expect.anything(), TENANT, 'tank-1', {
        reason: 'temperature',
        newTemperatureC: 12.5,
      });
    });

    it('rejects an out-of-range temperature without saving', async () => {
      const { service, repository } = await buildService();
      await expect(
        service.recordManualTemperature(TENANT, 'tank-1', 99, 'user-1'),
      ).rejects.toThrow();
      expect(repository.save).not.toHaveBeenCalled();
    });
  });
});
