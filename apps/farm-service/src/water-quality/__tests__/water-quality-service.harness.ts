/**
 * Shared London-school harness for WaterQualityService specs.
 *
 * Every collaborator (evaluation, validation, datasource, outbox, repositories,
 * the auth membership client) is a NestJS `useValue` double — no casts. The
 * unit directory is modelled as a map `unitId → siteId | null` behind the
 * transaction manager's `findOne`, so the REAL site derivation
 * (`resolveMeasuredUnitSite`) and the REAL site policy
 * (`SiteAuthorizationService`) run against it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type FindOneOptions } from 'typeorm';
import { of, throwError } from 'rxjs';
import { OutboxPublisher } from '@platform/outbox';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import type { ValidateTenantMembershipResult } from '@platform/event-contracts';

import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { Tank } from '../../tank/entities/tank.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Department } from '../../department/entities/department.entity';
import { WaterQualityValidationService } from '../services/water-quality-validation.service';
import { WaterQualityEvaluationService } from '../services/water-quality-evaluation.service';
import {
  FARM_AUTH_NATS_CLIENT,
  MeasurementActorService,
} from '../services/measurement-actor.service';
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

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const EQUIPMENT = '22222222-2222-4222-8222-222222222222';
export const MEASUREMENT = '33333333-3333-4333-8333-333333333333';
export const USER = '44444444-4444-4444-8444-444444444444';
export const SITE_A = '55555555-5555-4555-8555-555555555555';
export const SITE_B = '66666666-6666-4666-8666-666666666666';

// SEC-HIGH-051: a MODULE_MANAGER bypasses the object-level site check via the
// canonical role hierarchy, so validation tests assert validate()/persist
// invariants, not the site gate.
export const WQ_CALLER: WaterQualityCaller = {
  sub: USER,
  roles: [Role.MODULE_MANAGER],
  assignedSiteIds: [],
};

export interface ServiceHarness {
  service: WaterQualityService;
  validate: jest.Mock;
  evaluate: jest.Mock;
  repository: ReturnType<typeof createMockRepository<WaterQualityMeasurement>>;
  mockManager: ReturnType<typeof createMockDataSource>['mockManager'];
  enqueue: jest.Mock;
  recalcForUnitMock: jest.Mock;
  /** The auth membership query double (`ClientProxy.send`). */
  membershipSend: jest.Mock;
}

export interface HarnessOptions {
  /** unitId → the site of its department (null = site-less department). */
  units?: Record<string, string | null>;
}

/** A membership answer: every asked id is an active member. */
export function activeMembers(userIds: string[]): ValidateTenantMembershipResult {
  return {
    success: true,
    allValid: true,
    validUserIds: userIds,
    invalidUserIds: [],
    inactiveUserIds: [],
  };
}

export { of, throwError };

export async function buildService(options: HarnessOptions = {}): Promise<ServiceHarness> {
  const units = options.units ?? { [EQUIPMENT]: SITE_A };
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
  const membershipSend = jest.fn().mockReturnValue(of(activeMembers([])));

  const { mockDataSource, mockManager } = createMockDataSource();
  // Unit directory: equipment → department `dep-{unit}` → the unit's site.
  mockManager.findOne.mockImplementation((entity: unknown, findOptions: FindOneOptions) => {
    const where = findOptions.where;
    const id = where !== undefined && !Array.isArray(where) ? where['id'] : undefined;
    if (typeof id !== 'string') return Promise.resolve(null);
    if (entity === Equipment && id in units) {
      return Promise.resolve({ id, departmentId: `dep-${id}` });
    }
    if (entity === Department && id.startsWith('dep-')) {
      const unitId = id.slice('dep-'.length);
      return Promise.resolve({ id, siteId: units[unitId] ?? null });
    }
    return Promise.resolve(null);
  });
  mockManager.save.mockImplementation((_entityClass: unknown, data: unknown) =>
    Promise.resolve({
      id: MEASUREMENT,
      measuredAt: new Date('2026-06-14T08:00:00Z'),
      parameters: {},
      ...(data as object),
    }),
  );

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      WaterQualityService,
      MeasurementActorService,
      { provide: FARM_AUTH_NATS_CLIENT, useValue: { send: membershipSend } },
      { provide: getRepositoryToken(WaterQualityMeasurement), useValue: repository },
      { provide: getRepositoryToken(Tank), useValue: tankRepository },
      { provide: WaterQualityEvaluationService, useValue: { evaluate } },
      { provide: WaterQualityValidationService, useValue: { validate } },
      { provide: DataSource, useValue: mockDataSource },
      { provide: OutboxPublisher, useValue: { enqueue } },
      // SEC-HIGH-051: pure policy — the real class runs production logic.
      SiteAuthorizationService,
      // P-31 recalc — mocked (day-plan-recalc.service.spec covers it).
      { provide: DayPlanRecalcService, useValue: { recalcForUnit: recalcForUnitMock } },
    ],
  }).compile();

  const service = moduleRef.get(WaterQualityService);
  return {
    service,
    validate,
    evaluate,
    repository,
    mockManager,
    enqueue,
    recalcForUnitMock,
    membershipSend,
  };
}

export function createInput(
  overrides: Partial<CreateWaterQualityData> = {},
): CreateWaterQualityData {
  return {
    equipmentId: EQUIPMENT,
    measuredAt: new Date('2026-06-14T08:00:00Z'),
    source: MeasurementSource.MANUAL,
    dynamicParameters: { temperature: 14 },
    ...overrides,
  };
}
