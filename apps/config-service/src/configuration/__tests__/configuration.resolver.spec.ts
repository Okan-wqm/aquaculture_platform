import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { UpsertConfigurationCommand } from '../commands/upsert-configuration.command';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import { ConfigurationResolver } from '../configuration.resolver';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';
import { GetConfigurationsByServiceQuery } from '../queries/get-configurations.query';

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
      null,
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
      null,
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
        null,
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
        null,
        context(undefined),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
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
      null,
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    const dispatched = executeCommand.mock.calls[0]?.[0] as UpsertConfigurationCommand;
    expect(dispatched.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(dispatched.key).toBe('maintenance.mode_enabled');
    expect(dispatched.value).toBe('true');
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
        null,
        context({ sub: 'user-1', tenantId: TENANT_ID, roles: ['WORKER'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
