/**
 * AssignProtocolToBatchUnitsHandler (plan §1.2 — FARM-MEDIUM-229) pinleri:
 *  - Batch'in GÜNCEL üniteleri (primary VEYA batchDetails payı) unitId-artan
 *    sırayla, tekil atama yolunun AYNI çekirdeğinden geçer; ünite başına
 *    FeedingProtocolAssigned durable event'i üretilir.
 *  - Batch hiçbir ünitede değilse BadRequest (sessiz no-op yok).
 *  - ACTIVE olmayan protokole toplu atama da reddedilir (tekil yolla aynı kapı).
 */
import { BadRequestException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { AssignProtocolToBatchUnitsHandler } from '../handlers/protocol-assignment.handlers';
import { AssignProtocolToBatchUnitsCommand } from '../commands/feeding-protocol-v2.commands';
import { FeedingProtocolStatus, FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch, BatchType } from '../../batch/entities/batch.entity';
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
const BATCH = '22222222-2222-4222-8222-222222222222';
const PROTOCOL = '33333333-3333-4333-8333-333333333333';

interface HarnessOpts {
  protocolStatus?: FeedingProtocolStatus;
  unitRows?: Array<{ unitId: string }>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const protocol = stub<FeedingProtocolV2>({
    id: PROTOCOL,
    tenantId: TENANT,
    name: 'Std Protocol',
    status: opts.protocolStatus ?? FeedingProtocolStatus.ACTIVE,
    speciesId: 'species-1',
    isDeleted: false,
    bands: [],
  });
  const batch = stub<Batch>({
    id: BATCH,
    tenantId: TENANT,
    batchType: BatchType.PRODUCTION,
    speciesId: 'species-1',
  });

  const enqueued: Array<{ eventType: string; unitId?: string }> = [];
  const savedAssignments: ProtocolAssignment[] = [];

  const protocolRepo = stub<Repository<FeedingProtocolV2>>({
    findOne: jest.fn(async () => protocol),
  });
  const assignmentRepo = stub<Repository<ProtocolAssignment>>({
    findOne: jest.fn(async () => null),
    // Ünitedeki TÜM canlı atamalar (active + paused) sonlandırılır —
    // yalnız ACTIVE'i sonlandırmak paused birikimine yol açıyordu
    // (FARM-MEDIUM-255/261). Burada canlı atama yok.
    find: jest.fn(async () => []),
    // `create` and `save` are OVERLOAD SETS on Repository (array and
    // single-entity forms, with and without SaveOptions), which no
    // single-signature jest.fn can satisfy — see stubMember's docblock. The
    // member type is still named here, so a rename or removal on Repository
    // breaks this file, and every other member of the double stays checked.
    create: stubMember<Repository<ProtocolAssignment>['create']>(
      jest.fn((row: Partial<ProtocolAssignment>) => row),
    ),
    save: stubMember<Repository<ProtocolAssignment>['save']>(
      jest.fn(async (row: Partial<ProtocolAssignment>) => {
        const saved = { ...row, id: `as-${row.unitId}` } as ProtocolAssignment;
        savedAssignments.push(saved);
        return saved;
      }),
    ),
  });

  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === Batch) return batch;
    if (entity === TankBatch) return null; // boş ünite — tür kontrolü atlanır
    if (entity === EquipmentType) return stub<EquipmentType>({ category: EquipmentCategory.TANK });
    return null;
  });
  const query = jest.fn();
  query.mockImplementation(
    async () => opts.unitRows ?? [{ unitId: 'unit-a' }, { unitId: 'unit-b' }],
  );
  const getRepository = jest.fn((entity: unknown) => {
    if (entity === FeedingProtocolV2) return protocolRepo;
    if (entity === ProtocolAssignment) return assignmentRepo;
    throw new Error('unexpected repository request');
  });
  const manager = stub<EntityManager>({
    findOne,
    query,
    getRepository: stubMember<EntityManager['getRepository']>(getRepository),
  });

  const dataSource = stub<DataSource>({
    transaction: (async (cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager)) as DataSource['transaction'],
  });
  const outbox = stub<OutboxPublisher>({
    // OutboxPublisher.enqueue returns Promise<void>; an async fn that returns
    // nothing already IS that shape, so the cast was never load-bearing.
    enqueue: jest.fn(async (event: { eventType: string; unitId?: string }) => {
      enqueued.push(event);
    }),
  });

  const handler = new AssignProtocolToBatchUnitsHandler(dataSource, outbox);
  return { handler, enqueued, savedAssignments, findOne, query };
}

const command = new AssignProtocolToBatchUnitsCommand(BATCH, PROTOCOL, TENANT, 'user-1');

describe('AssignProtocolToBatchUnitsHandler', () => {
  it('batch üyeliği taşıyan TÜM ünitelere tek transaction içinde atama + event üretir', async () => {
    const harness = makeHarness();
    const result = await harness.handler.execute(command);

    expect(result.map((assignment) => assignment.unitId)).toEqual(['unit-a', 'unit-b']);
    expect(result.every((assignment) => assignment.protocolId === PROTOCOL)).toBe(true);
    expect(
      harness.enqueued.filter((event) => event.eventType === 'FeedingProtocolAssigned'),
    ).toHaveLength(2);
    // Üyelik sorgusu primary VEYA batchDetails payını kapsar (C-4 tanımı).
    const membershipSql = String(harness.query.mock.calls[0][0]);
    expect(membershipSql).toContain('"primaryBatchId" = $2');
    expect(membershipSql).toContain('jsonb_array_elements');
    expect(membershipSql).toContain('ORDER BY tb."tankId" ASC');
  });

  it('batch hiçbir ünitede değilse BadRequest (sessiz no-op yok)', async () => {
    const harness = makeHarness({ unitRows: [] });
    await expect(harness.handler.execute(command)).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.enqueued).toHaveLength(0);
  });

  it('ACTIVE olmayan protokole toplu atama reddedilir (tekil yolla aynı kapı)', async () => {
    const harness = makeHarness({ protocolStatus: FeedingProtocolStatus.DRAFT });
    await expect(harness.handler.execute(command)).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.savedAssignments).toHaveLength(0);
  });
});
