import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRequestContext } from '@aquaculture/backend-common/logging';

import { VfdChangeSetSchedulerService } from '../vfd-change-set-scheduler.service';
import { VfdChangeSet } from '../../entities/vfd-change-set.entity';
import { VfdChangeSetStatus } from '../../../vfd/entities/vfd.enums';
import { VfdParameterWriterService } from '../vfd-parameter-writer.service';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_SCHEMA = 'tenant_aaaaaaaaaaaaaaaa';

/**
 * Build a mock query-runner that satisfies forEachTenantSchema's lifecycle
 * (connect/startTransaction/SET.../commit/release) and returns the supplied
 * due-change-set rows for the vfd_change_sets discovery query.
 */
function buildQueryRunner(dueRows: { id: string; tenant_id: string }[]) {
  let txActive = false;
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockImplementation(() => {
      txActive = true;
      return Promise.resolve();
    }),
    commitTransaction: jest.fn().mockImplementation(() => {
      txActive = false;
      return Promise.resolve();
    }),
    rollbackTransaction: jest.fn().mockImplementation(() => {
      txActive = false;
      return Promise.resolve();
    }),
    get isTransactionActive(): boolean {
      return txActive;
    },
    query: jest.fn().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM vfd_change_sets')) {
        return Promise.resolve(dueRows);
      }
      return Promise.resolve([]);
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function buildDataSource(dueRows: { id: string; tenant_id: string }[], schemas = [TENANT_SCHEMA]) {
  const queryRunner = buildQueryRunner(dueRows);
  return {
    queryRunner,
    dataSource: {
      // listTenantSchemas() runs this information_schema query.
      query: jest.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('information_schema.schemata')) {
          return Promise.resolve(schemas.map((schema_name) => ({ schema_name })));
        }
        return Promise.resolve([]);
      }),
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    },
  };
}

function makeChangeSet(overrides: Partial<VfdChangeSet> = {}): VfdChangeSet {
  const cs = new VfdChangeSet();
  cs.id = 'cs-1';
  cs.tenantId = TENANT_ID;
  cs.vfdDeviceId = 'device-1';
  cs.status = VfdChangeSetStatus.APPROVED;
  cs.items = [];
  Object.assign(cs, overrides);
  return cs;
}

async function buildService(opts: {
  dueRows?: { id: string; tenant_id: string }[];
  reloaded?: VfdChangeSet | null;
  applyImpl?: (cs: VfdChangeSet) => Promise<VfdChangeSet>;
}) {
  const dueRows = opts.dueRows ?? [{ id: 'cs-1', tenant_id: TENANT_ID }];
  const { dataSource, queryRunner } = buildDataSource(dueRows);

  const changeSetRepo = {
    findOne: jest.fn().mockResolvedValue(opts.reloaded ?? makeChangeSet()),
  };
  const parameterWriter = {
    applyChangeSet: jest.fn().mockImplementation(
      opts.applyImpl ?? (async (cs: VfdChangeSet) => ({ ...cs, status: VfdChangeSetStatus.APPLIED })),
    ),
  };
  const eventEmitter = { emit: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      VfdChangeSetSchedulerService,
      { provide: getRepositoryToken(VfdChangeSet), useValue: changeSetRepo },
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: VfdParameterWriterService, useValue: parameterWriter },
      { provide: EventEmitter2, useValue: eventEmitter },
    ],
  }).compile();

  return {
    service: module.get(VfdChangeSetSchedulerService),
    changeSetRepo,
    parameterWriter,
    eventEmitter,
    queryRunner,
  };
}

describe('VfdChangeSetSchedulerService', () => {
  afterEach(() => jest.clearAllMocks());

  it('applies a due change set inside its tenant context', async () => {
    let applyTenantId: string | undefined = 'NOT_IN_CONTEXT';
    const { service, changeSetRepo, parameterWriter } = await buildService({
      applyImpl: async (cs) => {
        applyTenantId = getRequestContext().tenantId;
        return { ...cs, status: VfdChangeSetStatus.APPLIED };
      },
    });

    await service.handleScheduledChangeSets();

    // Reload happens under the scoped context, keyed by the discovered id.
    expect(changeSetRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'cs-1' },
      relations: ['items'],
    });
    expect(parameterWriter.applyChangeSet).toHaveBeenCalledTimes(1);
    expect(applyTenantId).toBe(TENANT_ID);
  });

  it('does nothing when no change sets are due', async () => {
    const { service, parameterWriter, changeSetRepo } = await buildService({ dueRows: [] });

    await service.handleScheduledChangeSets();

    expect(changeSetRepo.findOne).not.toHaveBeenCalled();
    expect(parameterWriter.applyChangeSet).not.toHaveBeenCalled();
  });

  it('skips a change set that is no longer APPROVED at apply time', async () => {
    const { service, parameterWriter } = await buildService({
      reloaded: makeChangeSet({ status: VfdChangeSetStatus.CANCELLED }),
    });

    await service.handleScheduledChangeSets();

    expect(parameterWriter.applyChangeSet).not.toHaveBeenCalled();
  });

  it('emits a schedule-failed alert when apply throws, without breaking the cycle', async () => {
    const { service, parameterWriter, eventEmitter } = await buildService({
      applyImpl: async () => {
        throw new Error('drive comm failure');
      },
    });

    await service.handleScheduledChangeSets();

    expect(parameterWriter.applyChangeSet).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'vfd.changeset.schedule-failed',
      expect.objectContaining({ changeSetId: 'cs-1', tenantId: TENANT_ID }),
    );
  });

  it('skips overlapping cycles while one is still processing (reentrancy guard)', async () => {
    let releaseApply: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const { service, parameterWriter } = await buildService({
      applyImpl: async (cs) => {
        await gate;
        return { ...cs, status: VfdChangeSetStatus.APPLIED };
      },
    });

    const first = service.handleScheduledChangeSets();
    // Second cycle fires while the first is still applying — must be skipped.
    await service.handleScheduledChangeSets();
    releaseApply?.();
    await first;

    expect(parameterWriter.applyChangeSet).toHaveBeenCalledTimes(1);
  });
});
