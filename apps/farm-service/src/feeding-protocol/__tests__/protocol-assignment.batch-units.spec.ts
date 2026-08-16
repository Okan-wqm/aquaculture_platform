/**
 * AssignProtocolToBatchUnitsHandler (plan §1.2 — FARM-MEDIUM-229) pinleri:
 *  - Batch'in GÜNCEL üniteleri (primary VEYA batchDetails payı) unitId-artan
 *    sırayla, tekil atama yolunun AYNI çekirdeğinden geçer; ünite başına
 *    FeedingProtocolAssigned durable event'i üretilir.
 *  - Batch hiçbir ünitede değilse BadRequest (sessiz no-op yok).
 *  - ACTIVE olmayan protokole toplu atama da reddedilir (tekil yolla aynı kapı).
 */
import { BadRequestException } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { createMockRepository } from '@aquaculture/testing';
import { DataSource, EntityManager } from 'typeorm';

import { AssignProtocolToBatchUnitsHandler } from '../handlers/protocol-assignment.handlers';
import { FeedingMutationTransactionAuthority } from '../feeding-mutation-transaction.authority';
import { AssignProtocolToBatchUnitsCommand } from '../commands/feeding-protocol-v2.commands';
import { FeedingProtocolStatus, FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch, BatchType } from '../../batch/entities/batch.entity';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { RecordingFeedingAggregateMutationPort } from '../../__tests__/support/durable-mutation-test-authority';

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
const MUTATION_INSTANT = '2026-08-08T12:30:00.000Z';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  protocolStatus?: FeedingProtocolStatus;
  unitRows?: Array<{ unitId: string }>;
  existingLive?: ProtocolAssignment;
}

function makeHarness(opts: HarnessOpts = {}) {
  const protocol = mock<FeedingProtocolV2>({
    id: PROTOCOL,
    tenantId: TENANT,
    name: 'Std Protocol',
    status: opts.protocolStatus ?? FeedingProtocolStatus.ACTIVE,
    speciesId: 'species-1',
    isDeleted: false,
    bands: [],
  });
  const batch = mock<Batch>({
    id: BATCH,
    tenantId: TENANT,
    batchType: BatchType.PRODUCTION,
    speciesId: 'species-1',
  });

  const enqueued: Array<{ eventType: string; unitId?: string }> = [];
  const savedAssignments: ProtocolAssignment[] = [];

  const protocolRepo = createMockRepository<FeedingProtocolV2>();
  protocolRepo.findOne.mockResolvedValue(protocol);
  const assignmentRepo = createMockRepository<ProtocolAssignment>();
  assignmentRepo.findOne.mockResolvedValue(opts.existingLive ?? null);
  assignmentRepo.create.mockImplementation((row) => Object.assign(new ProtocolAssignment(), row));
  assignmentRepo.save.mockImplementation(async (row) => {
    if (Array.isArray(row)) throw new Error('batch repository save is outside this test contract');
    const saved = Object.assign(new ProtocolAssignment(), row, { id: `as-${row.unitId}` });
    savedAssignments.push(saved);
    return saved;
  });

  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === Batch) return batch;
    if (entity === TankBatch) return null; // boş ünite — tür kontrolü atlanır
    if (entity === EquipmentType) return mock<EquipmentType>({ category: EquipmentCategory.TANK });
    return null;
  });
  const query = jest.fn();
  query.mockImplementation(
    async () => opts.unitRows ?? [{ unitId: 'unit-a' }, { unitId: 'unit-b' }],
  );
  const getRepository = jest.fn().mockReturnValueOnce(protocolRepo).mockReturnValue(assignmentRepo);
  const mockManager = mock<EntityManager>({ findOne, query, getRepository });
  const mockDataSource = new DataSource({
    type: 'postgres',
    database: 'protocol-assignment-unit-test',
    entities: [],
  });
  const mockQueryRunner = mockDataSource.createQueryRunner();
  Object.assign(mockQueryRunner.manager, mockManager);
  jest.spyOn(mockQueryRunner, 'connect').mockResolvedValue(undefined);
  jest.spyOn(mockQueryRunner, 'startTransaction').mockResolvedValue(undefined);
  jest.spyOn(mockQueryRunner, 'commitTransaction').mockResolvedValue(undefined);
  jest.spyOn(mockQueryRunner, 'rollbackTransaction').mockResolvedValue(undefined);
  jest.spyOn(mockQueryRunner, 'release').mockResolvedValue(undefined);
  jest
    .spyOn(mockQueryRunner, 'query')
    .mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('transaction_timestamp()') ? [{ mutationInstant: MUTATION_INSTANT }] : [],
      ),
    );
  jest.spyOn(mockDataSource, 'createQueryRunner').mockReturnValue(mockQueryRunner);
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string; unitId?: string }) => {
      enqueued.push(event);
    }),
  });

  const feedingMutations = new RecordingFeedingAggregateMutationPort();
  feedingMutations.commitProtocolAssignmentTransition.mockImplementation(
    async (_session, input) => {
      const saved = Object.assign(input.aggregate, { id: `as-${input.aggregate.unitId}` });
      savedAssignments.push(saved);
      return saved;
    },
  );
  const handler = new AssignProtocolToBatchUnitsHandler(
    new FeedingMutationTransactionAuthority(mockDataSource),
    feedingMutations,
    outbox,
  );
  return { handler, enqueued, savedAssignments, findOne, query };
}

const command = new AssignProtocolToBatchUnitsCommand(BATCH, PROTOCOL, TENANT, 'user-1');

describe('AssignProtocolToBatchUnitsHandler', () => {
  it('batch üyeliği taşıyan TÜM ünitelere tek transaction içinde atama + event üretir', async () => {
    const harness = makeHarness();
    const result = await harness.handler.execute(command);

    expect(result.map((assignment) => assignment.unitId)).toEqual(['unit-a', 'unit-b']);
    expect(result.every((assignment) => assignment.protocolId === PROTOCOL)).toBe(true);
    expect(result.map((assignment) => assignment.effectiveFrom.toISOString())).toEqual([
      MUTATION_INSTANT,
      MUTATION_INSTANT,
    ]);
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

  it('replaces a live assignment at the same database transaction instant', async () => {
    const existingLive = mock<ProtocolAssignment>({
      id: 'old-assignment',
      tenantId: TENANT,
      unitId: 'unit-a',
      status: ProtocolAssignmentStatus.ACTIVE,
    });
    const harness = makeHarness({ existingLive, unitRows: [{ unitId: 'unit-a' }] });

    await harness.handler.execute(command);

    expect(existingLive.status).toBe(ProtocolAssignmentStatus.ENDED);
    if (!existingLive.endedAt) {
      throw new Error('replacement must persist an end instant');
    }
    expect(existingLive.endedAt.toISOString()).toBe(MUTATION_INSTANT);
  });

  it('ACTIVE olmayan protokole toplu atama reddedilir (tekil yolla aynı kapı)', async () => {
    const harness = makeHarness({ protocolStatus: FeedingProtocolStatus.DRAFT });
    await expect(harness.handler.execute(command)).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.savedAssignments).toHaveLength(0);
  });
});
