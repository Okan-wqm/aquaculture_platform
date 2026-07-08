/**
 * LiceCountService — upsert-by-(tank, date) natural idempotency, ISO
 * reporting year/week derived at write time (week-53 edge included), and the
 * one-temperature-path fallback when the operator supplies no reading.
 */
import { DataSource, EntityManager } from 'typeorm';

const runInTenantTransaction = jest.fn();
const tenantManagerRepo = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
  tenantManagerRepo: (manager: unknown, entity: unknown, tenantId: string) =>
    tenantManagerRepo(manager, entity, tenantId),
}));

import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { LiceCountService } from '../services/lice-count.service';
import { RecordLiceCountInput } from '../dto/field-capture.inputs';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER = 'uuuuuuuu-1111-4222-8333-444444444444';

interface FakeRepo {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function makeRepo(existing: object | null): FakeRepo {
  return {
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((values: object) => values),
    save: jest.fn(async (values: object) => ({ id: 'lc-1', ...values })),
  };
}

function makeService(
  repo: FakeRepo,
  reading: Awaited<ReturnType<WaterTemperatureService['getSiteCurrentTemperature']>> = null,
): { service: LiceCountService; waterTemperature: jest.Mock } {
  runInTenantTransaction.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ manager: {} as Partial<EntityManager> }),
  );
  tenantManagerRepo.mockReturnValue(repo);
  const getSiteCurrentTemperature = jest.fn().mockResolvedValue(reading);
  const service = new LiceCountService(
    {} as Partial<DataSource> as DataSource,
    { getSiteCurrentTemperature } as Partial<WaterTemperatureService> as WaterTemperatureService,
  );
  return { service, waterTemperature: getSiteCurrentTemperature };
}

function input(overrides: Partial<RecordLiceCountInput> = {}): RecordLiceCountInput {
  return {
    siteId: 'site-1',
    tankId: 'tank-1',
    countDate: '2026-07-01',
    adultFemaleLice: 0.4,
    mobileLice: 1.2,
    attachedLice: 0.3,
    fishSampled: 20,
    ...overrides,
  };
}

describe('LiceCountService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a row with ISO year/week derived from the count date', async () => {
    const repo = makeRepo(null);
    const { service } = makeService(repo);

    const saved = await service.record(TENANT, input(), USER);

    expect(saved).toMatchObject({
      tenantId: TENANT,
      tankId: 'tank-1',
      countDate: '2026-07-01',
      reportingYear: 2026,
      reportingWeek: 27,
      countedBy: USER,
    });
  });

  it('assigns the year-boundary date to ISO week 53 of the PREVIOUS year', async () => {
    const repo = makeRepo(null);
    const { service } = makeService(repo);

    // 2027-01-01 is a Friday — ISO-8601 places it in week 53 of 2026.
    const saved = await service.record(TENANT, input({ countDate: '2027-01-01' }), USER);

    expect(saved).toMatchObject({ reportingYear: 2026, reportingWeek: 53 });
  });

  it('upserts: re-recording the same tank+date corrects the existing row', async () => {
    const existing = {
      id: 'lc-existing',
      tenantId: TENANT,
      tankId: 'tank-1',
      countDate: '2026-07-01',
      adultFemaleLice: 9.9,
    };
    const repo = makeRepo(existing);
    const { service } = makeService(repo);

    const saved = await service.record(TENANT, input({ adultFemaleLice: 0.7 }), USER);

    expect(repo.create).not.toHaveBeenCalled();
    expect(saved).toMatchObject({ id: 'lc-existing', adultFemaleLice: 0.7 });
  });

  it('labels an operator-supplied temperature as manual without touching the sensor path', async () => {
    const repo = makeRepo(null);
    const { service, waterTemperature } = makeService(repo);

    const saved = await service.record(TENANT, input({ seaTemperatureC: 13.5 }), USER);

    expect(saved).toMatchObject({ seaTemperatureC: 13.5, temperatureSource: 'manual' });
    expect(waterTemperature).not.toHaveBeenCalled();
  });

  it('falls back to the one site-temperature path with its own source label', async () => {
    const repo = makeRepo(null);
    const { service, waterTemperature } = makeService(repo, {
      celsius: 12.1,
      source: 'sensor',
      measuredAt: new Date('2026-07-01T06:00:00Z'),
      sensorId: 'sensor-3',
    });

    const saved = await service.record(TENANT, input(), USER);

    expect(waterTemperature).toHaveBeenCalledWith(TENANT, 'site-1');
    expect(saved).toMatchObject({ seaTemperatureC: 12.1, temperatureSource: 'sensor' });
  });
});
