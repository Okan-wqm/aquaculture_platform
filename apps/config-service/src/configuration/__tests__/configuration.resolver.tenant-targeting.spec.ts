import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { TENANT_SETTINGS_SERVICE } from '@platform/tenant-settings';

import { UpsertConfigurationCommand } from '../commands/upsert-configuration.command';
import { ConfigurationResolver } from '../configuration.resolver';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';
import { GetConfigurationsByServiceQuery } from '../queries/get-configurations.query';

const TARGET_TENANT_ID = '9f1d4c2a-5b3e-4d7a-8c6f-1e2b3a4d5c6e';
const CALLER_TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

interface ResolverContext {
  req: { user?: { sub: string; tenantId?: string | null; roles?: string[] } };
}

function context(user?: ResolverContext['req']['user']): ResolverContext {
  return { req: { user } };
}

function configurationRow(tenantId: string): Configuration {
  return Object.assign(new Configuration(), {
    id: 'config-id',
    tenantId,
    service: TENANT_SETTINGS_SERVICE,
    key: 'security.mfa_required',
    value: 'true',
    valueType: ConfigValueType.BOOLEAN,
    environment: ConfigEnvironment.ALL,
    isSecret: false,
    isActive: true,
    version: 1,
  });
}

function harness(): {
  resolver: ConfigurationResolver;
  executeCommand: jest.Mock;
  executeQuery: jest.Mock;
} {
  const executeCommand = jest.fn();
  const executeQuery = jest.fn();
  const commandBus = Object.assign(Object.create(CommandBus.prototype) as CommandBus, {
    execute: executeCommand,
  });
  const queryBus = Object.assign(Object.create(QueryBus.prototype) as QueryBus, {
    execute: executeQuery,
  });
  return {
    resolver: new ConfigurationResolver(commandBus, queryBus),
    executeCommand,
    executeQuery,
  };
}

describe('ConfigurationResolver tenant targeting authority', () => {
  const superAdmin = context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] });

  it('targets the exact tenant for reads and writes by tenantless SUPER_ADMIN', async () => {
    const { resolver, executeCommand, executeQuery } = harness();
    executeQuery.mockResolvedValue([configurationRow(TARGET_TENANT_ID)]);
    executeCommand.mockResolvedValue(configurationRow(TARGET_TENANT_ID));

    await resolver.getEffectiveConfigurationsByService(
      TENANT_SETTINGS_SERVICE,
      ConfigEnvironment.ALL,
      superAdmin,
      TARGET_TENANT_ID,
    );
    await resolver.setConfiguration(
      TENANT_SETTINGS_SERVICE,
      'security.mfa_required',
      'true',
      ConfigEnvironment.ALL,
      false,
      'operator decision',
      superAdmin,
      TARGET_TENANT_ID,
    );

    const query = executeQuery.mock.calls[0]?.[0] as GetConfigurationsByServiceQuery;
    const command = executeCommand.mock.calls[0]?.[0] as UpsertConfigurationCommand;
    expect(query.tenantId).toBe(TARGET_TENANT_ID);
    expect(command.tenantId).toBe(TARGET_TENANT_ID);
    expect(command.service).toBe(TENANT_SETTINGS_SERVICE);
  });

  it('rejects explicit scope from tenant principals, including their own tenant', async () => {
    const { resolver, executeQuery } = harness();
    const tenantAdmin = context({
      sub: 'tenant-admin',
      tenantId: CALLER_TENANT_ID,
      roles: ['TENANT_ADMIN'],
    });
    await expect(
      resolver.getEffectiveConfigurationsByService(
        TENANT_SETTINGS_SERVICE,
        ConfigEnvironment.ALL,
        tenantAdmin,
        CALLER_TENANT_ID,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated and malformed target coordinates before dispatch', async () => {
    const { resolver, executeQuery } = harness();
    await expect(
      resolver.getEffectiveConfigurationsByService(
        TENANT_SETTINGS_SERVICE,
        ConfigEnvironment.ALL,
        context(),
        TARGET_TENANT_ID,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      resolver.getEffectiveConfigurationsByService(
        TENANT_SETTINGS_SERVICE,
        ConfigEnvironment.ALL,
        superAdmin,
        'not-a-tenant',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('preserves JWT-derived scope when no explicit target exists', async () => {
    const { resolver, executeQuery } = harness();
    executeQuery.mockResolvedValue([configurationRow(CALLER_TENANT_ID)]);
    await resolver.getEffectiveConfigurationsByService(
      TENANT_SETTINGS_SERVICE,
      ConfigEnvironment.ALL,
      context({ sub: 'tenant-admin', tenantId: CALLER_TENANT_ID, roles: ['TENANT_ADMIN'] }),
    );
    const query = executeQuery.mock.calls[0]?.[0] as GetConfigurationsByServiceQuery;
    expect(query.tenantId).toBe(CALLER_TENANT_ID);
  });
});
