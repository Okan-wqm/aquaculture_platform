/**
 * SetUnitFeedersHandler pinleri.
 *
 * NOT: bu spec servis katmanının SÖZLEŞMESİNİ kanıtlar (hangi girdi reddedilir,
 * hangi satır tarihçeye iner). Payların 100'e toplandığı garantisinin KENDİSİ
 * burada kanıtlanmaz — o garanti veritabanındadır ve
 * `__tests__/e2e/feeder-assignment-share-sum.postgres.spec.ts` içinde gerçek bir
 * Postgres'e servis katmanını atlayan ham SQL yazılarak kanıtlanır. Mock'lanmış
 * bir veritabanına karşı "toplam 100" testi, tam olarak doğrulamak istediği şeyi
 * mock'layan test olurdu.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { SetUnitFeedersCommand } from '../commands/feeder-assignment.commands';
import { SetUnitFeedersHandler } from '../handlers/feeder-assignment.handlers';
import { FeederAssignment, FeederAssignmentStatus } from '../entities/feeder-assignment.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';

jest.mock('../../batch/utils/tank-lookup.util', () => ({
  findTankOrEquipmentWithManager: jest.fn(async (_manager: unknown, unitId: string) => ({
    equipment: {
      id: unitId,
      name: `Unit ${unitId}`,
      code: 'TANK-01',
      departmentId: 'dep-1',
      equipmentTypeId: 'eqt-tank',
    },
    isFromTanksTable: false,
  })),
  resolveSiteIdFromDepartment: jest.fn(async () => 'site-1'),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = '22222222-2222-4222-8222-222222222222';
const FEEDER_A = '33333333-3333-4333-8333-333333333333';
const FEEDER_B = '44444444-4444-4444-8444-444444444444';
const PUMP = '55555555-5555-4555-8555-555555555555';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  existingActive?: Array<Partial<FeederAssignment>>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const rows: FeederAssignment[] = (opts.existingActive ?? []).map(
    (row, index) =>
      ({
        id: `existing-${index}`,
        tenantId: TENANT,
        unitId: UNIT,
        status: FeederAssignmentStatus.ACTIVE,
        ...row,
      }) as FeederAssignment,
  );

  const saved: FeederAssignment[] = [];
  let sequence = 0;

  const assignmentRepo = {
    find: jest.fn(async (options: { where: { status?: FeederAssignmentStatus } }) =>
      options.where.status === FeederAssignmentStatus.ACTIVE
        ? rows.filter((row) => row.status === FeederAssignmentStatus.ACTIVE)
        : rows,
    ),
    create: jest.fn((row: Partial<FeederAssignment>) => row),
    save: jest.fn(async (row: FeederAssignment) => {
      if (!row.id) {
        sequence += 1;
        row.id = `new-${sequence}`;
        rows.push(row);
      }
      saved.push(row);
      return row;
    }),
  };

  const equipmentRepo = {
    findOne: jest.fn(async (options: { where: { id: string } }) => {
      const id = options.where.id;
      if (id === FEEDER_A || id === FEEDER_B) {
        return mock<Equipment>({
          id,
          name: `Feeder ${id.slice(0, 4)}`,
          code: id === FEEDER_A ? 'FEED-A' : 'FEED-B',
          isActive: true,
          isDeleted: false,
          equipmentTypeId: 'eqt-feeder',
        });
      }
      if (id === PUMP) {
        return mock<Equipment>({
          id,
          name: 'Main pump',
          code: 'PUMP-01',
          isActive: true,
          isDeleted: false,
          equipmentTypeId: 'eqt-pump',
        });
      }
      return null;
    }),
  };

  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown, options: { where: { id: string } }) => {
    if (entity !== EquipmentType) return null;
    switch (options.where.id) {
      case 'eqt-feeder':
        return mock<EquipmentType>({ category: EquipmentCategory.FEEDING });
      case 'eqt-pump':
        return mock<EquipmentType>({ category: EquipmentCategory.PUMP });
      default:
        return mock<EquipmentType>({ category: EquipmentCategory.TANK });
    }
  });

  const getRepository = jest.fn((entity: unknown) => {
    if (entity === FeederAssignment) return assignmentRepo;
    if (entity === Equipment) return equipmentRepo;
    throw new Error('unexpected repository request');
  });

  const manager = mock<EntityManager>({ findOne, getRepository: getRepository as never });
  const dataSource = mock<DataSource>({
    transaction: (async (cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager)) as DataSource['transaction'],
  });

  const enqueued: Array<{ eventType: string; endedAssignmentIds?: string[] }> = [];
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string; endedAssignmentIds?: string[] }) => {
      enqueued.push(event);
      return undefined as never;
    }),
  });

  return {
    handler: new SetUnitFeedersHandler(dataSource, outbox),
    rows,
    saved,
    enqueued,
  };
}

describe('SetUnitFeedersHandler', () => {
  it('binds two feeders to one unit, splitting the dose between them', async () => {
    const harness = makeHarness();

    const result = await harness.handler.execute(
      new SetUnitFeedersCommand(
        {
          unitId: UNIT,
          feeders: [
            { feederEquipmentId: FEEDER_A, doseSharePercent: 60 },
            { feederEquipmentId: FEEDER_B, doseSharePercent: 40 },
          ],
        },
        TENANT,
        'user-1',
      ),
    );

    expect(result).toHaveLength(2);
    expect(result.reduce((sum, assignment) => sum + assignment.doseSharePercent, 0)).toBe(100);
    expect(result.map((assignment) => assignment.feederEquipmentId).sort()).toEqual(
      [FEEDER_A, FEEDER_B].sort(),
    );
    expect(harness.enqueued.map((event) => event.eventType)).toEqual([
      'UnitFeederAssignmentsChanged',
    ]);
  });

  it('rejects a feeder set whose shares do not sum to 100', async () => {
    const harness = makeHarness();

    await expect(
      harness.handler.execute(
        new SetUnitFeedersCommand(
          {
            unitId: UNIT,
            feeders: [
              { feederEquipmentId: FEEDER_A, doseSharePercent: 60 },
              { feederEquipmentId: FEEDER_B, doseSharePercent: 30 },
            ],
          },
          TENANT,
          'user-1',
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.saved).toHaveLength(0);
  });

  it('rejects the same feeder listed twice for one unit', async () => {
    const harness = makeHarness();

    await expect(
      harness.handler.execute(
        new SetUnitFeedersCommand(
          {
            unitId: UNIT,
            feeders: [
              { feederEquipmentId: FEEDER_A, doseSharePercent: 50 },
              { feederEquipmentId: FEEDER_A, doseSharePercent: 50 },
            ],
          },
          TENANT,
          'user-1',
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses equipment that is not a feeder — the identity decision holds here too', async () => {
    const harness = makeHarness();

    await expect(
      harness.handler.execute(
        new SetUnitFeedersCommand(
          { unitId: UNIT, feeders: [{ feederEquipmentId: PUMP, doseSharePercent: 100 }] },
          TENANT,
          'user-1',
        ),
      ),
    ).rejects.toThrow(/not a feeder|yemleyici değil/i);
  });

  it('refuses a feeder id that resolves to no equipment row', async () => {
    const harness = makeHarness();

    await expect(
      harness.handler.execute(
        new SetUnitFeedersCommand(
          {
            unitId: UNIT,
            feeders: [
              { feederEquipmentId: '66666666-6666-4666-8666-666666666666', doseSharePercent: 100 },
            ],
          },
          TENANT,
          'user-1',
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ends the replaced row instead of deleting it, so history survives', async () => {
    const harness = makeHarness({
      existingActive: [
        {
          id: 'old-a',
          feederEquipmentId: FEEDER_A,
          feederCode: 'FEED-A',
          doseSharePercent: 100,
        },
      ],
    });

    const result = await harness.handler.execute(
      new SetUnitFeedersCommand(
        { unitId: UNIT, feeders: [{ feederEquipmentId: FEEDER_B, doseSharePercent: 100 }] },
        TENANT,
        'user-1',
      ),
    );

    const oldRow = harness.rows.find((row) => row.id === 'old-a');
    expect(oldRow?.status).toBe(FeederAssignmentStatus.ENDED);
    expect(oldRow?.endedAt).toBeInstanceOf(Date);
    expect(oldRow?.doseSharePercent).toBe(100); // frozen at the share it held
    expect(result.map((assignment) => assignment.feederEquipmentId)).toEqual([FEEDER_B]);
    expect(harness.enqueued[0]?.endedAssignmentIds).toEqual(['old-a']);
  });

  it('leaves an unchanged feeder row alone (no churn, no new generation)', async () => {
    const harness = makeHarness({
      existingActive: [
        {
          id: 'old-a',
          feederEquipmentId: FEEDER_A,
          feederCode: 'FEED-A',
          doseSharePercent: 100,
        },
      ],
    });

    await harness.handler.execute(
      new SetUnitFeedersCommand(
        { unitId: UNIT, feeders: [{ feederEquipmentId: FEEDER_A, doseSharePercent: 100 }] },
        TENANT,
        'user-1',
      ),
    );

    expect(harness.saved).toHaveLength(0);
    expect(harness.rows.find((row) => row.id === 'old-a')?.status).toBe(
      FeederAssignmentStatus.ACTIVE,
    );
  });

  it('accepts an empty set — the unit becomes hand-fed and every row is ended', async () => {
    const harness = makeHarness({
      existingActive: [
        { id: 'old-a', feederEquipmentId: FEEDER_A, feederCode: 'FEED-A', doseSharePercent: 100 },
      ],
    });

    const result = await harness.handler.execute(
      new SetUnitFeedersCommand({ unitId: UNIT, feeders: [] }, TENANT, 'user-1'),
    );

    expect(result).toEqual([]);
    expect(harness.rows.find((row) => row.id === 'old-a')?.status).toBe(
      FeederAssignmentStatus.ENDED,
    );
  });
});
