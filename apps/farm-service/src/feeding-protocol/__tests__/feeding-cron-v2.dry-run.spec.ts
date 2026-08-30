/**
 * K-3 dry-run: PAUSED atamalar için plan HESABI — persist YOK.
 *
 * Pinlenen sözleşme:
 *  - Migration'dan paused gelen atamanın aktive edildiğinde üreteceği plan
 *    GERÇEK üretici (MealPlanGeneratorService) ile hesaplanır; persistDayPlan
 *    HİÇ çağrılmaz, outbox'a hiçbir şey yazılmaz.
 *  - Üretim engelleri sınıflandırılır (draft_protocol / empty_unit /
 *    missing_protocol) — Faz 6 K-14 kapısının girdisi, sessiz atlama yok.
 */
const managerQuery = jest.fn();
const managerFind = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (
    ds: unknown,
    schema: string,
    tenantId: string,
    cb: (qr: {
      manager: { query: typeof managerQuery; find: typeof managerFind };
    }) => Promise<void>,
  ) => cb({ manager: { query: managerQuery, find: managerFind } }),
}));

import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';
import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { ProtocolRateService } from '../services/protocol-rate.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import {
  FeedingProtocolV2,
  FeedingProtocolStatus,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
  FeedingUnitType,
} from '../entities/protocol-assignment.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '88888888-8888-4888-8888-888888888888';
const UNIT = '77777777-7777-4777-8777-777777777777';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const PROTOCOL = mock<FeedingProtocolV2>({
  id: 'proto-1',
  tenantId: TENANT,
  status: FeedingProtocolStatus.ACTIVE,
  bands: [
    {
      minWeightG: 0,
      maxWeightG: 1000000,
      feedId: 'feed-1',
      feedCode: 'G4',
      feedName: 'Grower 4mm',
      feedingRatePercent: 2,
      expectedFcr: 1.2,
    },
  ],
  defaultMealSchedule: {
    mealsPerDay: 2,
    entries: [
      { time: '08:00', percentOfDaily: 50 },
      { time: '16:00', percentOfDaily: 50 },
    ],
  },
  settings: {
    autoTransition: true,
    transitionBufferG: 10,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
});

function makeAssignment(over: Partial<ProtocolAssignment> = {}): ProtocolAssignment {
  return mock<ProtocolAssignment>({
    id: 'assign-1',
    tenantId: TENANT,
    unitId: UNIT,
    unitType: FeedingUnitType.TANK,
    unitName: 'Tank 1',
    unitCode: 'T-1',
    siteId: SITE,
    protocolId: 'proto-1',
    status: ProtocolAssignmentStatus.PAUSED,
    overrides: {},
    suspensions: [],
    ...over,
  });
}

const TANK_BATCH = mock<TankBatch>({
  tankId: UNIT,
  tenantId: TENANT,
  totalQuantity: 1000,
  totalBiomassKg: 100,
  avgWeightG: 100,
});

interface DryRunFixture {
  assignments: ProtocolAssignment[];
  protocols: FeedingProtocolV2[];
  tankBatches: TankBatch[];
}

function makeService(fixture: DryRunFixture): {
  service: FeedingCronV2Service;
  persistDayPlan: jest.SpyInstance;
  enqueue: jest.Mock;
} {
  managerQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
    if (String(sql).includes('"sites"')) return [{ id: SITE, timezone: 'UTC' }];
    return [];
  });
  managerFind.mockImplementation(
    async (entity: unknown, opts?: { skip?: number }): Promise<unknown[]> => {
      if (entity === ProtocolAssignment) {
        return (opts?.skip ?? 0) === 0 ? fixture.assignments : [];
      }
      if (entity === FeedingProtocolV2) return fixture.protocols;
      if (entity === TankBatch) return fixture.tankBatches;
      return [];
    },
  );

  const generator = new MealPlanGeneratorService(new ProtocolRateService());
  const persistDayPlan = jest.spyOn(generator, 'persistDayPlan');
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const getEffectiveTemperaturesForUnits = jest.fn();
  getEffectiveTemperaturesForUnits.mockResolvedValue(
    new Map([[UNIT, { celsius: null, source: 'none' }]]),
  );

  const service = new FeedingCronV2Service(
    mock<DataSource>({}),
    generator,
    mock<BiomassGrowthApplierService>({}),
    mock<WaterTemperatureService>({ getEffectiveTemperaturesForUnits }),
    mock<FCRCalculationService>({}),
    mock<OutboxPublisher>({ enqueue }),
    mock<ProtocolFeedForecastService>({}),
  );
  return { service, persistDayPlan, enqueue };
}

describe('FeedingCronV2Service.dryRunForTenant (K-3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('paused atama için GERÇEK plan hesabı döner — persist ve event YOK', async () => {
    const { service, persistDayPlan, enqueue } = makeService({
      assignments: [makeAssignment()],
      protocols: [PROTOCOL],
      tankBatches: [TANK_BATCH],
    });

    const results = await service.dryRunForTenant(TENANT);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      assignmentId: 'assign-1',
      unitId: UNIT,
      outcome: 'computed',
    });
    // 100kg × %2 = 2kg/gün, 2 öğüne bölünür.
    expect(results[0]!.computed?.plannedTotalKg).toBe(2);
    expect(results[0]!.computed?.meals).toHaveLength(2);
    expect(persistDayPlan).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('aktivasyon engellerini sınıflandırır: draft_protocol / empty_unit / missing_protocol', async () => {
    const draftProtocol = mock<FeedingProtocolV2>({
      ...PROTOCOL,
      id: 'proto-draft',
      status: FeedingProtocolStatus.DRAFT,
    });
    const { service } = makeService({
      assignments: [
        makeAssignment({ id: 'a-draft', protocolId: 'proto-draft' }),
        makeAssignment({ id: 'a-empty', unitId: 'unit-empty', unitCode: 'T-9' }),
        makeAssignment({ id: 'a-missing', protocolId: 'proto-yok' }),
      ],
      protocols: [PROTOCOL, draftProtocol],
      tankBatches: [TANK_BATCH],
    });

    const results = await service.dryRunForTenant(TENANT);

    const byId = new Map(results.map((r) => [r.assignmentId, r.outcome]));
    expect(byId.get('a-draft')).toBe('draft_protocol');
    expect(byId.get('a-empty')).toBe('empty_unit');
    expect(byId.get('a-missing')).toBe('missing_protocol');
  });
});
