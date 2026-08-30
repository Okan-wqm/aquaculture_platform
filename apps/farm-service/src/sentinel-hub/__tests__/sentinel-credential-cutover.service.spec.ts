import { MarineProviderCredentialClient } from '@aquaculture/backend-common/config-client';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { MarineProviderCredentialMutationOutcome } from '@platform/event-contracts';
import type { QueryRunner } from 'typeorm';

import { SentinelHubSettings } from '../entities/sentinel-hub-settings.entity';
import { SentinelCredentialCutoverService } from '../sentinel-credential-cutover.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCHEMA_NAME = 'tenant_aaaaaaaaaaaa4aaa';
const ROW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CANONICAL_IDENTITY = { schemaName: SCHEMA_NAME, tenantId: TENANT_ID } as const;

function legacyRow(
  overrides: Partial<{
    tenantId: string;
    isConfigured: boolean;
    configCutoverAt: Date | null;
    configCutoverBundleDigest: string | null;
    configCutoverErasedAt: Date | null;
  }> = {},
): {
  id: string;
  tenantId: string;
  isConfigured: boolean;
  configCutoverAt: Date | null;
  configCutoverBundleDigest: string | null;
  configCutoverErasedAt: Date | null;
} {
  return {
    id: ROW_ID,
    tenantId: overrides.tenantId ?? TENANT_ID,
    isConfigured: overrides.isConfigured ?? true,
    configCutoverAt: overrides.configCutoverAt ?? null,
    configCutoverBundleDigest: overrides.configCutoverBundleDigest ?? null,
    configCutoverErasedAt: overrides.configCutoverErasedAt ?? null,
  };
}

function legacySettings(): SentinelHubSettings {
  return Object.assign(new SentinelHubSettings(), {
    id: ROW_ID,
    tenantId: TENANT_ID,
    clientId: 'legacy-client',
    clientSecret: 'legacy-secret',
    instanceId: 'legacy-instance',
    isConfigured: true,
    usageCount: 0,
    configCutoverAt: null,
    configCutoverBundleDigest: null,
    configCutoverVersion: null,
    configCutoverSourceTenantId: null,
    configCutoverErasedAt: null,
  });
}

function credentialClient(): {
  client: MarineProviderCredentialClient;
  upsert: jest.SpyInstance;
} {
  const client = Object.create(
    MarineProviderCredentialClient.prototype,
  ) as MarineProviderCredentialClient;
  return { client, upsert: jest.spyOn(client, 'upsert') };
}

function bypassService(): BypassRlsService {
  const bypass = Object.create(BypassRlsService.prototype) as BypassRlsService;
  jest
    .spyOn(bypass, 'withBypass')
    .mockImplementation(async (_operation, callback) => await callback());
  return bypass;
}

describe('SentinelCredentialCutoverService', () => {
  it('prepares a frozen digest and finalizes only the same decrypted bundle', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const repository = createMockRepository<SentinelHubSettings>();
    const settings = legacySettings();
    mockManager.getRepository.mockReturnValue(repository);
    repository.findOne.mockResolvedValue(settings);

    let persistedDigest: string | null = null;
    mockQueryRunner.query.mockImplementation(
      async (sql: string, parameters?: unknown[]): Promise<unknown> => {
        if (sql.includes('SELECT "id", "tenantId"')) {
          return [legacyRow({ configCutoverBundleDigest: persistedDigest })];
        }
        if (sql.includes('SET "config_cutover_bundle_digest"')) {
          persistedDigest = String(parameters?.[0]);
          return [{ id: ROW_ID }];
        }
        if (sql.includes('SET "config_cutover_at"')) {
          return [{ id: ROW_ID }];
        }
        return [];
      },
    );

    const { client } = credentialClient();
    const service = new SentinelCredentialCutoverService(mockDataSource, bypassService(), client);
    const candidate = await service.prepareCurrentTenantSchema(mockQueryRunner, CANONICAL_IDENTITY);

    expect(candidate).toEqual(
      expect.objectContaining({
        rowId: ROW_ID,
        tenantId: TENANT_ID,
        schemaName: SCHEMA_NAME,
        bundle: {
          clientId: 'legacy-client',
          clientSecret: 'legacy-secret',
          instanceId: 'legacy-instance',
        },
        bundleDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(persistedDigest).toBe(candidate?.bundleDigest);

    if (!candidate) {
      throw new Error('Expected a prepared candidate');
    }
    await service.finalizeCurrentTenantSchema(mockQueryRunner, CANONICAL_IDENTITY, candidate, {
      sourceTenantId: TENANT_ID,
      configVersion: 12,
    });

    expect(mockQueryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('SET "config_cutover_at" = now()'),
      [12, TENANT_ID, ROW_ID, candidate.bundleDigest],
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('transfers outside the tenant transaction, then opens a fresh finalization transaction', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const repository = createMockRepository<SentinelHubSettings>();
    mockManager.getRepository.mockReturnValue(repository);
    repository.findOne.mockResolvedValue(legacySettings());
    mockDataSource.query.mockResolvedValue([
      {
        schema_name: SCHEMA_NAME,
        tenant_id: TENANT_ID,
        schema_exists: true,
        committed_proof: true,
      },
    ]);

    let persistedDigest: string | null = null;
    mockQueryRunner.query.mockImplementation(
      async (sql: string, parameters?: unknown[]): Promise<unknown> => {
        if (sql.includes('SELECT "id", "tenantId"')) {
          return [legacyRow({ configCutoverBundleDigest: persistedDigest })];
        }
        if (sql.includes('SET "config_cutover_bundle_digest"')) {
          persistedDigest = String(parameters?.[0]);
          return [{ id: ROW_ID }];
        }
        if (sql.includes('SET "config_cutover_at"')) {
          return [{ id: ROW_ID }];
        }
        return [];
      },
    );
    const { client, upsert } = credentialClient();
    upsert.mockResolvedValue({
      outcome: MarineProviderCredentialMutationOutcome.APPLIED,
      success: true,
      sourceTenantId: TENANT_ID,
      configVersion: 12,
    });
    const service = new SentinelCredentialCutoverService(mockDataSource, bypassService(), client);

    await service.onApplicationBootstrap();

    expect(mockQueryRunner.startTransaction).toHaveBeenCalledTimes(2);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(2);
    const firstCommitOrder = mockQueryRunner.commitTransaction.mock.invocationCallOrder[0];
    const upsertOrder = upsert.mock.invocationCallOrder[0];
    const secondStartOrder = mockQueryRunner.startTransaction.mock.invocationCallOrder[1];
    expect(firstCommitOrder).toBeLessThan(upsertOrder ?? 0);
    expect(upsertOrder).toBeLessThan(secondStartOrder ?? 0);
  });

  it('scrubs a prepared legacy bundle when config-service proves the tenant was erased', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const repository = createMockRepository<SentinelHubSettings>();
    mockManager.getRepository.mockReturnValue(repository);
    repository.findOne.mockResolvedValue(legacySettings());
    mockDataSource.query.mockResolvedValue([
      {
        schema_name: SCHEMA_NAME,
        tenant_id: TENANT_ID,
        schema_exists: true,
        committed_proof: true,
      },
    ]);

    let persistedDigest: string | null = null;
    mockQueryRunner.query.mockImplementation(
      async (sql: string, parameters?: unknown[]): Promise<unknown> => {
        if (sql.includes('SELECT "id", "tenantId"')) {
          return [legacyRow({ configCutoverBundleDigest: persistedDigest })];
        }
        if (sql.includes('SET "config_cutover_bundle_digest"')) {
          persistedDigest = String(parameters?.[0]);
          return [{ id: ROW_ID }];
        }
        if (sql.includes('SET "config_cutover_erased_at"')) {
          return [{ id: ROW_ID }];
        }
        return [];
      },
    );
    const { client, upsert } = credentialClient();
    upsert.mockResolvedValue({
      outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    });
    const service = new SentinelCredentialCutoverService(mockDataSource, bypassService(), client);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(mockQueryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('SET "config_cutover_erased_at" = now()'),
      [ROW_ID, TENANT_ID, expect.stringMatching(/^[a-f0-9]{64}$/u)],
    );
    expect(mockQueryRunner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('SET "config_cutover_at" = now()'),
      expect.anything(),
    );
  });

  it('refuses to prepare an incomplete legacy bundle', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const repository = createMockRepository<SentinelHubSettings>();
    const settings = legacySettings();
    settings.clientSecret = null;
    mockQueryRunner.query.mockResolvedValue([legacyRow()]);
    mockManager.getRepository.mockReturnValue(repository);
    repository.findOne.mockResolvedValue(settings);
    const { client, upsert } = credentialClient();
    const service = new SentinelCredentialCutoverService(mockDataSource, bypassService(), client);

    await expect(
      service.prepareCurrentTenantSchema(mockQueryRunner, CANONICAL_IDENTITY),
    ).rejects.toThrow('incomplete credential bundle');
    expect(upsert).not.toHaveBeenCalled();
    expect(mockQueryRunner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('SET "config_cutover_bundle_digest"'),
      expect.anything(),
    );
  });

  it('rejects a row tenant mismatch before decrypt, transfer, or scrub', async () => {
    const mismatchedTenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    mockQueryRunner.query.mockResolvedValue([legacyRow({ tenantId: mismatchedTenantId })]);
    const { client, upsert } = credentialClient();
    const service = new SentinelCredentialCutoverService(mockDataSource, bypassService(), client);

    await expect(
      service.prepareCurrentTenantSchema(mockQueryRunner, CANONICAL_IDENTITY),
    ).rejects.toThrow(/does not match its canonical schema/u);
    expect(mockManager.getRepository).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('fails closed when a prepared digest no longer matches the decrypted row', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const repository = createMockRepository<SentinelHubSettings>();
    mockManager.getRepository.mockReturnValue(repository);
    repository.findOne.mockResolvedValue(legacySettings());
    mockQueryRunner.query.mockResolvedValue([
      legacyRow({ configCutoverBundleDigest: 'a'.repeat(64) }),
    ]);
    const { client } = credentialClient();
    const service = new SentinelCredentialCutoverService(mockDataSource, bypassService(), client);

    await expect(
      service.prepareCurrentTenantSchema(mockQueryRunner, CANONICAL_IDENTITY),
    ).rejects.toThrow(/digest does not match/u);
  });

  it('keeps startup fail-closed when config-service rejects a prepared tenant bundle', async () => {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const repository = createMockRepository<SentinelHubSettings>();
    mockManager.getRepository.mockReturnValue(repository);
    repository.findOne.mockResolvedValue(legacySettings());
    mockDataSource.query.mockResolvedValue([
      {
        schema_name: SCHEMA_NAME,
        tenant_id: TENANT_ID,
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    mockQueryRunner.query.mockImplementation(
      async (sql: string, parameters?: unknown[]): Promise<unknown> => {
        if (sql.includes('SELECT "id", "tenantId"')) {
          return [legacyRow()];
        }
        if (sql.includes('SET "config_cutover_bundle_digest"')) {
          return parameters?.[0] ? [{ id: ROW_ID }] : [];
        }
        return [];
      },
    );
    const { client, upsert } = credentialClient();
    upsert.mockResolvedValue({
      outcome: MarineProviderCredentialMutationOutcome.RETRYABLE_FAILURE,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    });
    const service = new SentinelCredentialCutoverService(mockDataSource, bypassService(), client);

    await expect(service.onApplicationBootstrap()).rejects.toThrow('farm-service startup refused');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.query).not.toHaveBeenCalledWith(
      expect.stringContaining('SET "config_cutover_at" = now()'),
      expect.anything(),
    );
  });
});
