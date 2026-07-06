/**
 * EscapeIncidentService — the row and the EscapeIncidentRecordedEvent outbox
 * entry are written through the SAME transaction manager (atomic), and close
 * ends the recapture lifecycle.
 */
import { NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

const runInTenantTransaction = jest.fn();
const tenantManagerRepo = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
  tenantManagerRepo: (manager: unknown, entity: unknown, tenantId: string) =>
    tenantManagerRepo(manager, entity, tenantId),
}));

import { EscapeIncidentService } from '../services/escape-incident.service';
import { EscapeIncidentCause, EscapeIncidentStatus } from '../entities/escape-incident.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER = 'uuuuuuuu-1111-4222-8333-444444444444';

interface FakeRepo {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function setup(existing: object | null = null): {
  service: EscapeIncidentService;
  repo: FakeRepo;
  enqueue: jest.Mock;
  txManager: Partial<EntityManager>;
} {
  const txManager: Partial<EntityManager> = {};
  runInTenantTransaction.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ manager: txManager }),
  );
  const repo: FakeRepo = {
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((values: object) => values),
    save: jest.fn(async (values: object) => ({ id: 'incident-1', ...values })),
  };
  tenantManagerRepo.mockReturnValue(repo);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const service = new EscapeIncidentService(
    {} as Partial<DataSource> as DataSource,
    { enqueue } as Partial<OutboxPublisher> as OutboxPublisher,
  );
  return { service, repo, enqueue, txManager };
}

describe('EscapeIncidentService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records the incident and enqueues EscapeIncidentRecorded through the SAME txn manager', async () => {
    const { service, enqueue, txManager } = setup();

    const saved = await service.record(
      TENANT,
      {
        siteId: 'site-1',
        detectedAt: '2026-07-05T09:30:00Z',
        speciesId: 'species-1',
        estimatedCount: 1200,
        cause: EscapeIncidentCause.HOLE_IN_NET,
      },
      USER,
    );

    expect(saved).toMatchObject({
      id: 'incident-1',
      status: EscapeIncidentStatus.OPEN,
      createdBy: USER,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [event, manager, options] = enqueue.mock.calls[0];
    expect(manager).toBe(txManager);
    expect(options).toEqual({
      idempotencyKey: 'escape-incident:incident-1',
      aggregateId: 'site-1',
    });
    expect(event).toMatchObject({
      eventType: 'EscapeIncidentRecorded',
      tenantId: TENANT,
      incidentId: 'incident-1',
      siteId: 'site-1',
      speciesId: 'species-1',
      estimatedCount: 1200,
      cause: EscapeIncidentCause.HOLE_IN_NET,
      detectedAt: '2026-07-05T09:30:00.000Z',
      recordedBy: USER,
    });
  });

  it('defaults an unspecified cause to UNKNOWN (never guessed)', async () => {
    const { service, enqueue } = setup();

    await service.record(
      TENANT,
      { siteId: 'site-1', detectedAt: '2026-07-05T09:30:00Z', speciesId: 's', estimatedCount: 5 },
      USER,
    );

    expect(enqueue.mock.calls[0][0]).toMatchObject({ cause: EscapeIncidentCause.UNKNOWN });
  });

  it('close: sets CLOSED + recovered count and ends recovery', async () => {
    const { service, repo } = setup({
      id: 'incident-1',
      tenantId: TENANT,
      status: EscapeIncidentStatus.OPEN,
      recoveryOngoing: true,
    });

    const closed = await service.close(TENANT, { id: 'incident-1', recoveredCount: 340 }, USER);

    expect(closed).toMatchObject({
      status: EscapeIncidentStatus.CLOSED,
      recoveredCount: 340,
      recoveryOngoing: false,
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('close: unknown incident is a NotFoundException', async () => {
    const { service } = setup(null);

    await expect(service.close(TENANT, { id: 'missing' }, USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
