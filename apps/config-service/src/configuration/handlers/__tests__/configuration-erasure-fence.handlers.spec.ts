import { TenantErasureTombstoneError } from '@aquaculture/backend-common/compliance';
import { createMockDataSource } from '@aquaculture/testing';
import { InternalServerErrorException } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';

import { CreateConfigurationCommand } from '../../commands/create-configuration.command';
import { DeleteConfigurationCommand } from '../../commands/delete-configuration.command';
import { UpdateConfigurationCommand } from '../../commands/update-configuration.command';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../../entities/configuration.entity';
import { CreateConfigurationHandler } from '../create-configuration.handler';
import { DeleteConfigurationHandler } from '../delete-configuration.handler';
import { UpdateConfigurationHandler } from '../update-configuration.handler';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIGURATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface HandlerHarness {
  readonly queryRunner: jest.Mocked<QueryRunner>;
  readonly execute: () => Promise<unknown>;
  readonly callCounts: {
    readonly repositoryLookup: () => number;
    readonly commit: () => number;
    readonly rollback: () => number;
    readonly release: () => number;
  };
}

function tombstonedQueryRunner(): ReturnType<typeof createMockDataSource> {
  const mocks = createMockDataSource();
  mocks.mockQueryRunner.query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT EXISTS') ? [{ erased: true }] : [],
  );
  return mocks;
}

function createHarness(kind: 'create' | 'update' | 'delete'): HandlerHarness {
  const { mockDataSource, mockQueryRunner } = tombstonedQueryRunner();
  const configurationService = { invalidateCache: jest.fn() };
  const validationService = { validateValue: jest.fn() };
  const encryptionService = { isAvailable: jest.fn().mockReturnValue(true) };
  const outboxPublisher = { enqueue: jest.fn() };
  const repositoryLookup = jest.spyOn(mockQueryRunner.manager, 'getRepository');
  const commit = jest.spyOn(mockQueryRunner, 'commitTransaction');
  const rollback = jest.spyOn(mockQueryRunner, 'rollbackTransaction');
  const release = jest.spyOn(mockQueryRunner, 'release');
  const callCounts = {
    repositoryLookup: () => repositoryLookup.mock.calls.length,
    commit: () => commit.mock.calls.length,
    rollback: () => rollback.mock.calls.length,
    release: () => release.mock.calls.length,
  };

  if (kind === 'create') {
    const handler = new CreateConfigurationHandler(
      mockDataSource,
      configurationService as never,
      validationService,
      encryptionService as never,
      outboxPublisher as never,
    );
    return {
      queryRunner: mockQueryRunner,
      callCounts,
      execute: () =>
        handler.execute(
          new CreateConfigurationCommand(
            TENANT_ID,
            {
              service: 'farm-service',
              key: 'monitoring.enabled',
              value: 'true',
              valueType: ConfigValueType.BOOLEAN,
              environment: ConfigEnvironment.ALL,
              isSecret: false,
            },
            'user-1',
          ),
        ),
    };
  }

  if (kind === 'update') {
    const handler = new UpdateConfigurationHandler(
      mockDataSource,
      configurationService as never,
      validationService,
      encryptionService as never,
      outboxPublisher as never,
    );
    return {
      queryRunner: mockQueryRunner,
      callCounts,
      execute: () =>
        handler.execute(
          new UpdateConfigurationCommand(
            TENANT_ID,
            { id: CONFIGURATION_ID, description: 'must not be written' },
            'user-1',
          ),
        ),
    };
  }

  const handler = new DeleteConfigurationHandler(
    mockDataSource,
    configurationService as never,
    outboxPublisher as never,
  );
  return {
    queryRunner: mockQueryRunner,
    callCounts,
    execute: () =>
      handler.execute(new DeleteConfigurationCommand(TENANT_ID, CONFIGURATION_ID, 'user-1')),
  };
}

describe.each(['create', 'update', 'delete'] as const)('%s configuration erasure fence', (kind) => {
  it('pins RLS, acquires the tenant fence, and propagates the permanent tombstone', async () => {
    const harness = createHarness(kind);

    await expect(harness.execute()).rejects.toBeInstanceOf(TenantErasureTombstoneError);

    const statements = harness.queryRunner.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('set_config');
    expect(statements[1]).toContain('pg_advisory_xact_lock');
    expect(statements[2]).toContain('SELECT EXISTS');
    expect(harness.callCounts.repositoryLookup()).toBe(0);
    expect(harness.callCounts.commit()).toBe(0);
    expect(harness.callCounts.rollback()).toBe(1);
    expect(harness.callCounts.release()).toBe(1);
  });
});

describe('secret configuration writes', () => {
  it('never persists a create secret as plaintext when encryption is unavailable', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    mockQueryRunner.query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT EXISTS') ? [{ erased: false }] : [],
    );
    const repository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
    };
    mockManager.getRepository.mockReturnValue(repository as never);
    const handler = new CreateConfigurationHandler(
      mockDataSource,
      { invalidateCache: jest.fn() } as never,
      { validateValue: jest.fn() },
      { isAvailable: jest.fn().mockReturnValue(false), encrypt: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
    );

    await expect(
      handler.execute(
        new CreateConfigurationCommand(
          TENANT_ID,
          {
            service: 'farm-service',
            key: 'provider.secret',
            value: 'plaintext-must-not-persist',
            valueType: ConfigValueType.SECRET,
            environment: ConfigEnvironment.ALL,
            isSecret: true,
          },
          'user-1',
        ),
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('never persists an updated secret as plaintext when encryption is unavailable', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    mockQueryRunner.query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT EXISTS') ? [{ erased: false }] : [],
    );
    const configuration = Object.assign(new Configuration(), {
      id: CONFIGURATION_ID,
      tenantId: TENANT_ID,
      service: 'farm-service',
      key: 'provider.secret',
      value: 'prior-plaintext',
      valueType: ConfigValueType.STRING,
      environment: ConfigEnvironment.ALL,
      isSecret: false,
      isActive: true,
    });
    const configurationRepository = {
      findOne: jest.fn().mockResolvedValue(configuration),
      save: jest.fn(),
    };
    const historyRepository = { create: jest.fn(), save: jest.fn() };
    mockManager.getRepository
      .mockReturnValueOnce(configurationRepository as never)
      .mockReturnValueOnce(historyRepository as never);
    const handler = new UpdateConfigurationHandler(
      mockDataSource,
      { invalidateCache: jest.fn() } as never,
      { validateValue: jest.fn() },
      { isAvailable: jest.fn().mockReturnValue(false), encrypt: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
    );

    await expect(
      handler.execute(
        new UpdateConfigurationCommand(
          TENANT_ID,
          {
            id: CONFIGURATION_ID,
            value: 'plaintext-must-not-persist',
            valueType: ConfigValueType.SECRET,
          },
          'user-1',
        ),
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(configurationRepository.save).not.toHaveBeenCalled();
    expect(historyRepository.save).not.toHaveBeenCalled();
  });
});
