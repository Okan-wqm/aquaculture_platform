import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { UpsertConfigurationCommand } from './commands/upsert-configuration.command';
import { SYSTEM_TENANT_ID } from './configuration.constants';
import { ConfigurationResolver } from './configuration.resolver';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from './entities/configuration.entity';
import { GetConfigurationsByServiceQuery } from './queries/get-configurations.query';

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

function configurationRow(): Configuration {
  return Object.assign(new Configuration(), {
    id: 'config-id',
    tenantId: SYSTEM_TENANT_ID,
    service: 'platform',
    key: 'platform.name',
    value: 'Aquaculture Platform',
    valueType: ConfigValueType.STRING,
    environment: ConfigEnvironment.ALL,
    isSecret: false,
    isActive: true,
    version: 1,
  });
}

function providerCredentialRow(): Configuration {
  return Object.assign(new Configuration(), {
    id: 'provider-credential-id',
    tenantId: SYSTEM_TENANT_ID,
    service: 'farm-service',
    key: 'marine.cdse.credentials',
    value: 'encrypted-provider-credential',
    valueType: ConfigValueType.SECRET,
    environment: ConfigEnvironment.ALL,
    isSecret: true,
    isActive: true,
    version: 7,
  });
}

function farmRuntimeConfigurationRow(): Configuration {
  return Object.assign(new Configuration(), {
    id: 'farm-runtime-config-id',
    tenantId: SYSTEM_TENANT_ID,
    service: 'farm-service',
    key: 'environment.sync_enabled',
    value: 'true',
    valueType: ConfigValueType.BOOLEAN,
    environment: ConfigEnvironment.ALL,
    isSecret: false,
    isActive: true,
    version: 2,
  });
}

interface ResolverContext {
  req: { user?: { sub: string; tenantId?: string | null; roles?: string[] } };
}

function makeHarness() {
  const executeCommand = jest.fn();
  const commandBus: Pick<CommandBus, 'execute'> = { execute: executeCommand };
  const executeQuery = jest.fn();
  const queryBus: Pick<QueryBus, 'execute'> = { execute: executeQuery };

  const resolver = new ConfigurationResolver(commandBus as CommandBus, queryBus as QueryBus);
  return { resolver, executeCommand, executeQuery };
}

function context(user?: ResolverContext['req']['user']): ResolverContext {
  return { req: { user } };
}

describe('ConfigurationResolver tenant scoping', () => {
  it('scopes a tenant user to its verified JWT tenant claim', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue([configurationRow()]);

    await resolver.getEffectiveConfigurationsByService(
      'platform',
      ConfigEnvironment.ALL,
      context({ sub: 'user-1', tenantId: TENANT_ID, roles: ['TENANT_ADMIN'] }),
    );

    const dispatched = executeQuery.mock.calls[0]?.[0] as GetConfigurationsByServiceQuery;
    expect(dispatched.tenantId).toBe(TENANT_ID);
    expect(dispatched.service).toBe('platform');
  });

  it('resolves a tenantless SUPER_ADMIN to the SYSTEM scope', async () => {
    // SUPER_ADMIN is the platform's only tenantless principal; platform-scope
    // configuration lives under SYSTEM_TENANT_ID.
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue([configurationRow()]);

    await resolver.getEffectiveConfigurationsByService(
      'platform',
      ConfigEnvironment.ALL,
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    const dispatched = executeQuery.mock.calls[0]?.[0] as GetConfigurationsByServiceQuery;
    expect(dispatched.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('rejects a tenantless non-admin fail-closed', async () => {
    const { resolver, executeQuery } = makeHarness();

    await expect(
      resolver.getEffectiveConfigurationsByService(
        'platform',
        ConfigEnvironment.ALL,
        context({ sub: 'user-2', tenantId: null, roles: ['WORKER'] }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const { resolver } = makeHarness();

    await expect(
      resolver.getEffectiveConfigurationsByService(
        'platform',
        ConfigEnvironment.ALL,
        context(undefined),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a tenant read of provider credential metadata before dispatch', async () => {
    const { resolver, executeQuery } = makeHarness();

    await expect(
      resolver.getEffectiveConfiguration(
        'farm-service',
        'marine.cdse.credentials',
        ConfigEnvironment.ALL,
        context({ sub: 'user-1', tenantId: TENANT_ID, roles: ['TENANT_ADMIN'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('filters provider credential metadata from tenant service listings', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue([farmRuntimeConfigurationRow(), providerCredentialRow()]);

    const result = await resolver.getEffectiveConfigurationsByService(
      'farm-service',
      ConfigEnvironment.ALL,
      context({ sub: 'user-1', tenantId: TENANT_ID, roles: ['TENANT_ADMIN'] }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('environment.sync_enabled');
  });

  it('does not treat a tenant-scoped SUPER_ADMIN claim as operations scope', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue([providerCredentialRow()]);

    await expect(
      resolver.getEffectiveConfiguration(
        'farm-service',
        'marine.cdse.credentials',
        ConfigEnvironment.ALL,
        context({ sub: 'admin-1', tenantId: TENANT_ID, roles: ['SUPER_ADMIN'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const bulkResult = await resolver.getEffectiveConfigurationsByService(
      'farm-service',
      ConfigEnvironment.ALL,
      context({ sub: 'admin-1', tenantId: TENANT_ID, roles: ['SUPER_ADMIN'] }),
    );
    expect(bulkResult).toEqual([]);
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it('preserves provider credential metadata access for tenantless SUPER_ADMIN operations', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue(providerCredentialRow());

    const result = await resolver.getEffectiveConfiguration(
      'farm-service',
      'marine.cdse.credentials',
      ConfigEnvironment.ALL,
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    expect(result).toMatchObject({
      tenantId: SYSTEM_TENANT_ID,
      key: 'marine.cdse.credentials',
      value: '[ENCRYPTED]',
      secretMode: 'redacted',
    });
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it('writes platform settings under the SYSTEM scope for a tenantless SUPER_ADMIN', async () => {
    const { resolver, executeCommand } = makeHarness();
    executeCommand.mockResolvedValue(configurationRow());

    await resolver.setConfiguration(
      'platform',
      'maintenance.mode_enabled',
      'true',
      ConfigEnvironment.ALL,
      false,
      'admin-panel save',
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    const dispatched = executeCommand.mock.calls[0]?.[0] as UpsertConfigurationCommand;
    expect(dispatched.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(dispatched.key).toBe('maintenance.mode_enabled');
    expect(dispatched.value).toBe('true');
  });

  it.each([
    ['tenant admin', ['TENANT_ADMIN']],
    ['tenant-scoped SUPER_ADMIN', ['SUPER_ADMIN']],
  ] as const)('denies restricted provider credential writes from a %s', async (_name, roles) => {
    const { resolver, executeCommand } = makeHarness();

    await expect(
      resolver.setConfiguration(
        'farm-service',
        'marine.cdse.credentials',
        '{"clientId":"client","clientSecret":"secret"}',
        ConfigEnvironment.ALL,
        true,
        'must be denied',
        context({ sub: 'tenant-admin', tenantId: TENANT_ID, roles: [...roles] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('allows only tenantless SUPER_ADMIN to write the system provider bundle and forces secret mode', async () => {
    const { resolver, executeCommand } = makeHarness();
    executeCommand.mockResolvedValue(providerCredentialRow());

    const result = await resolver.setConfiguration(
      'farm-service',
      'marine.cdse.credentials',
      '{"clientId":"client","clientSecret":"secret"}',
      ConfigEnvironment.ALL,
      false,
      'company provider rotation',
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    const dispatched = executeCommand.mock.calls[0]?.[0] as UpsertConfigurationCommand;
    expect(dispatched.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(dispatched.isSecret).toBe(true);
    expect(result).toMatchObject({
      tenantId: SYSTEM_TENANT_ID,
      key: 'marine.cdse.credentials',
      value: '[ENCRYPTED]',
      secretMode: 'redacted',
    });
  });

  it('denies setConfiguration to non-admin roles', async () => {
    const { resolver, executeCommand } = makeHarness();

    await expect(
      resolver.setConfiguration(
        'platform',
        'maintenance.mode_enabled',
        'true',
        ConfigEnvironment.ALL,
        false,
        undefined,
        context({ sub: 'user-1', tenantId: TENANT_ID, roles: ['WORKER'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
