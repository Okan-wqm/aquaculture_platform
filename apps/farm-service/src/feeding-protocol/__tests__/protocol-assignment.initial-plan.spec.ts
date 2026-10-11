/**
 * Atama-anı ilk gün planı üretimi — FARM-MEDIUM-257 (kök-neden çözüm).
 *
 * Gün planı eskiden yalnız 06:00 cron'unun üretimiyle oluşuyordu: protokol
 * atandıktan sonra operatör ilk planı ancak ERTESİ GÜN görüyordu
 * (`feedingDayPlans` boş dönüyor, E2E akışı düşüyordu). Bu spec atama
 * komutunun yeni sözleşmesini pinler:
 *  - balıklı ünite + ACTIVE protokol → atama ile İLK plan AYNI transaction'da
 *    üretilir (gerçek DayPlanAdminService.generateInitialDayPlan koşar —
 *    handler stub'ı değil);
 *  - sınıflandırılmış atlanmalar (boş ünite, gelecek effectiveFrom, bugünkü
 *    plan zaten var) atamayı BAŞARISIZ KILMAZ;
 *  - üretimden beklenmedik bir hata atama transaction'ını geri alır (atomik:
 *    ya atama+plan birlikte durur ya birlikte alınır).
 */
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { AssignProtocolToUnitHandler } from '../handlers/protocol-assignment.handlers';
import { AssignProtocolToUnitCommand } from '../commands/feeding-protocol-v2.commands';
import { DayPlanAdminService } from '../services/day-plan-admin.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { ProtocolResolutionService } from '../services/protocol-resolution.service';
import { ProtocolRateService } from '../services/protocol-rate.service';
import { FeedingClockService } from '../services/feeding-clock.service';
import { SiteTimeZoneService } from '../../localization/services/site-time-zone.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import {
  FeedingProtocolV2,
  FeedingProtocolStatus,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import { FeedingUnitType } from '../entities/protocol-assignment.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { stub, stubMember } from '@aquaculture/testing';

jest.mock('../../batch/utils/tank-lookup.util', () => ({
  findTankOrEquipmentWithManager: jest.fn(async (_manager: unknown, unitId: string) => ({
    equipment: {
      id: unitId,
      name: `Unit ${unitId}`,
      code: unitId.toUpperCase(),
      departmentId: 'dep-1',
      equipmentTypeId: 'eqt-1',
    },
    isFromTanksTable: false,
  })),
  resolveSiteIdFromDepartment: jest.fn(async () => 'site-1'),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROTOCOL = '33333333-3333-4333-8333-333333333333';
const UNIT = '77777777-7777-4777-8777-777777777777';
const USER = '44444444-4444-4444-8444-444444444444';

const PROTOCOL_FIXTURE = stub<FeedingProtocolV2>({
  id: PROTOCOL,
  tenantId: TENANT,
  name: 'Std Protocol',
  status: FeedingProtocolStatus.ACTIVE,
  speciesId: 'species-1',
  isDeleted: false,
  bands: [
    {
      minWeightG: 0,
      maxWeightG: 200,
      feedId: 'feed-s1',
      feedCode: 'S1',
      feedName: 'Starter',
      feedingRatePercent: 3,
      expectedFcr: 1.1,
    },
  ],
  settings: {
    autoTransition: true,
    transitionBufferG: 10,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
});

/** Balıklı ünite — primaryBatchId verilmedi: tür kontrolü atlanır (stub sadeliği). */
const STOCKED_TANK_BATCH = stub<TankBatch>({
  tankId: UNIT,
  totalQuantity: 1000,
  totalBiomassKg: 100,
  avgWeightG: 100,
  batchDetails: [],
});

interface HarnessOpts {
  tankBatch?: TankBatch | null;
  effectiveFrom?: Date;
  persistResult?: string | null;
  persistError?: Error;
}

function makeHarness(opts: HarnessOpts = {}) {
  const tankBatch = opts.tankBatch === undefined ? STOCKED_TANK_BATCH : opts.tankBatch;

  const protocolRepo = stub<Repository<FeedingProtocolV2>>({
    findOne: jest.fn(async () => PROTOCOL_FIXTURE),
  });
  const savedAssignments: ProtocolAssignment[] = [];
  const assignmentRepo = stub<Repository<ProtocolAssignment>>({
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    // `create`/`save` overload setleri — stubMember belgeli tek imza çözümü.
    create: stubMember<Repository<ProtocolAssignment>['create']>(
      jest.fn((row: Partial<ProtocolAssignment>) => row),
    ),
    save: stubMember<Repository<ProtocolAssignment>['save']>(
      jest.fn(async (row: Partial<ProtocolAssignment>) => {
        const saved = { ...row, id: 'as-new-1' } as ProtocolAssignment;
        savedAssignments.push(saved);
        return saved;
      }),
    ),
  });

  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === FeedingProtocolV2) return PROTOCOL_FIXTURE;
    if (entity === TankBatch) return tankBatch;
    if (entity === EquipmentType) return stub<EquipmentType>({ category: EquipmentCategory.TANK });
    return null;
  });
  const managerFind = jest.fn(async () => []);
  const manager = stub<EntityManager>({
    findOne,
    find: managerFind,
    getRepository: stubMember<EntityManager['getRepository']>(
      jest.fn((entity: unknown) => {
        if (entity === FeedingProtocolV2) return protocolRepo;
        if (entity === ProtocolAssignment) return assignmentRepo;
        throw new Error('unexpected repository request');
      }),
    ),
  });

  const transaction = stubMember<DataSource['transaction']>(
    jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager)),
  );
  const dataSource = stub<DataSource>({ transaction });

  const enqueued: Array<{ eventType: string }> = [];
  const outbox = stub<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string }) => {
      enqueued.push(event);
    }),
  });

  // GERÇEK DayPlanAdminService — yalnız collaborating servisler stub'lı
  // (day-plan-admin.service.spec emsali); böylece test atama→üretim zincirinin
  // kendisini koşturur, handler'ın kedi kendisi değil.
  const computeDayPlan = jest.fn();
  computeDayPlan.mockReturnValue({
    snapshot: {},
    resolution: {},
    plannedTotalKg: 2,
    status: 'planned',
    meals: [],
  });
  const persistDayPlan = jest.fn();
  if (opts.persistError) persistDayPlan.mockRejectedValue(opts.persistError);
  else
    persistDayPlan.mockResolvedValue(
      opts.persistResult === undefined ? 'dp-init-1' : opts.persistResult,
    );

  const getEffectiveTemperature = jest.fn();
  getEffectiveTemperature.mockResolvedValue({ celsius: null, source: 'none' });

  const dayPlans = new DayPlanAdminService(
    stub<DataSource>({}),
    stub<MealPlanGeneratorService>({ computeDayPlan, persistDayPlan }),
    stub<DayPlanRecalcService>({ recalcForUnit: jest.fn() }),
    stub<WaterTemperatureService>({ getEffectiveTemperature }),
    stub<OutboxPublisher>({}),
    new ProtocolResolutionService(new ProtocolRateService()),
    stub<FeedingClockService>({
      resolve: jest.fn().mockResolvedValue(FeedingClockService.clockIn('UTC')),
    }),
    stub<SiteTimeZoneService>({
      siteZones: jest.fn().mockResolvedValue({ tenantZone: 'UTC', zoneOf: () => 'UTC' }),
    }),
  );

  const handler = new AssignProtocolToUnitHandler(dataSource, outbox, dayPlans);
  const command = new AssignProtocolToUnitCommand(
    {
      unitId: UNIT,
      unitType: FeedingUnitType.TANK,
      protocolId: PROTOCOL,
      effectiveFrom: opts.effectiveFrom,
    },
    TENANT,
    USER,
  );
  return { handler, command, persistDayPlan, computeDayPlan, enqueued, savedAssignments, manager };
}

describe('AssignProtocolToUnitHandler — atama-anı ilk plan üretimi (FARM-MEDIUM-257)', () => {
  it('balıklı üniteye atama, ilk gün planını AYNI transaction içinde üretir', async () => {
    const harness = makeHarness();

    const assignment = await harness.handler.execute(harness.command);

    expect(assignment.status).toBe('active');
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]!.eventType).toBe('FeedingProtocolAssigned');
    // Üretim KAYDEDİLEN atamayla ve aynı manager (transaction) ile koştu.
    expect(harness.computeDayPlan).toHaveBeenCalledTimes(1);
    expect(harness.persistDayPlan).toHaveBeenCalledTimes(1);
    expect(harness.persistDayPlan.mock.calls[0]![0]).toBe(harness.manager);
    const context = harness.persistDayPlan.mock.calls[0]![1] as Record<string, unknown>;
    expect(context['assignmentId']).toBe('as-new-1');
    expect(context['unitId']).toBe(UNIT);
    expect(context['protocolId']).toBe(PROTOCOL);
  });

  it('boş ünite: atama BAŞARILI kalır, plan üretilmez (sessiz değil — sınıflandırılmış skip)', async () => {
    const harness = makeHarness({ tankBatch: null });

    const assignment = await harness.handler.execute(harness.command);

    expect(assignment.status).toBe('active');
    expect(harness.persistDayPlan).not.toHaveBeenCalled();
  });

  it('gelecek effectiveFrom: atama yapılır, bugünün planı henüz üretilmez', async () => {
    const harness = makeHarness({
      effectiveFrom: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const assignment = await harness.handler.execute(harness.command);

    expect(assignment.status).toBe('active');
    expect(harness.persistDayPlan).not.toHaveBeenCalled();
  });

  it('bugünün planı zaten varsa (persist çakışması) atama yine başarılı — already_exists', async () => {
    const harness = makeHarness({ persistResult: null });

    const assignment = await harness.handler.execute(harness.command);

    expect(assignment.status).toBe('active');
    expect(harness.persistDayPlan).toHaveBeenCalledTimes(1);
  });

  it('üretimden beklenmedik hata atama transaction’ını geri alır (atomiklik)', async () => {
    const harness = makeHarness({
      persistError: new Error('persist exploded'),
    });

    await expect(harness.handler.execute(harness.command)).rejects.toThrow('persist exploded');
  });
});
