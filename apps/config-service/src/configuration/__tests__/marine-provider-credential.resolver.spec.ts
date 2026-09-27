import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  MARINE_PROVIDER_CREDENTIAL_KEYS,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
  parseMarineProviderCdseCredentialBundle,
} from '@platform/event-contracts';

import { UpsertConfigurationCommand } from '../commands/upsert-configuration.command';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';
import { GraphQLPrincipalContext } from '../graphql-principal';
import { MarineProviderCredentialResolver } from '../marine-provider-credential.resolver';
import { GetConfigurationQuery } from '../queries/get-configuration.query';

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

function storedCredentialRow(overrides: Partial<Configuration> = {}): Configuration {
  return Object.assign(new Configuration(), {
    id: 'provider-credential-id',
    tenantId: SYSTEM_TENANT_ID,
    service: MARINE_PROVIDER_CREDENTIAL_SERVICE,
    key: MARINE_PROVIDER_CREDENTIAL_KEYS.CDSE,
    value: 'encrypted-provider-credential',
    valueType: ConfigValueType.SECRET,
    environment: ConfigEnvironment.ALL,
    isSecret: true,
    isActive: true,
    version: 7,
    updatedAt: new Date('2026-09-18T10:00:00.000Z'),
    ...overrides,
  });
}

function makeHarness() {
  const executeCommand = jest.fn();
  const commandBus: Pick<CommandBus, 'execute'> = { execute: executeCommand };
  const executeQuery = jest.fn();
  const queryBus: Pick<QueryBus, 'execute'> = { execute: executeQuery };
  const resolver = new MarineProviderCredentialResolver(
    commandBus as CommandBus,
    queryBus as QueryBus,
  );
  return { resolver, executeCommand, executeQuery };
}

function context(user?: GraphQLPrincipalContext['req']['user']): GraphQLPrincipalContext {
  return { req: { user } };
}

const superAdmin = context({ sub: 'operator-1', tenantId: null, roles: ['SUPER_ADMIN'] });

describe('MarineProviderCredentialResolver authorization', () => {
  it.each([
    ['anonymous', context(undefined)],
    ['tenant user', context({ sub: 'u', tenantId: TENANT_ID, roles: ['TENANT_ADMIN'] })],
    [
      'tenant-scoped SUPER_ADMIN',
      context({ sub: 'u', tenantId: TENANT_ID, roles: ['SUPER_ADMIN'] }),
    ],
    [
      'tenantless platform admin without SUPER_ADMIN',
      context({ sub: 'u', roles: ['platform_admin'] }),
    ],
  ])('refuses the status read to a %s without touching the bus', async (_label, ctx) => {
    const { resolver, executeQuery } = makeHarness();
    await expect(resolver.getMarineProviderCredentialStatus('CDSE', ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant user', context({ sub: 'u', tenantId: TENANT_ID, roles: ['TENANT_ADMIN'] })],
    [
      'tenant-scoped SUPER_ADMIN',
      context({ sub: 'u', tenantId: TENANT_ID, roles: ['SUPER_ADMIN'] }),
    ],
  ])('refuses the write to a %s without touching the bus', async (_label, ctx) => {
    const { resolver, executeCommand } = makeHarness();
    await expect(
      resolver.setMarineProviderCdseCredential({ clientId: 'id', clientSecret: 'secret' }, ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe('MarineProviderCredentialResolver status read', () => {
  it('reads the company row under the system tenant and reports it without the value', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue(storedCredentialRow());

    const status = await resolver.getMarineProviderCredentialStatus('CDSE', superAdmin);

    expect(executeQuery).toHaveBeenCalledWith(
      new GetConfigurationQuery(
        SYSTEM_TENANT_ID,
        MARINE_PROVIDER_CREDENTIAL_SERVICE,
        MARINE_PROVIDER_CREDENTIAL_KEYS.CDSE,
        ConfigEnvironment.ALL,
      ),
    );
    expect(status).toEqual({
      provider: 'CDSE',
      configured: true,
      version: 7,
      updatedAt: new Date('2026-09-18T10:00:00.000Z'),
    });
    expect(JSON.stringify(status)).not.toContain('encrypted-provider-credential');
  });

  it('reports "not configured" when no company row exists', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockRejectedValue(new NotFoundException('Configuration not found'));

    await expect(resolver.getMarineProviderCredentialStatus('CDSE', superAdmin)).resolves.toEqual({
      provider: 'CDSE',
      configured: false,
      version: null,
      updatedAt: null,
    });
  });

  it('reports a tombstoned company row as not configured', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue(storedCredentialRow({ isActive: false }));

    await expect(resolver.getMarineProviderCredentialStatus('CDSE', superAdmin)).resolves.toEqual({
      provider: 'CDSE',
      configured: false,
      version: null,
      updatedAt: null,
    });
  });

  it('lets any other read failure propagate', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockRejectedValue(new Error('database unavailable'));

    await expect(resolver.getMarineProviderCredentialStatus('CDSE', superAdmin)).rejects.toThrow(
      'database unavailable',
    );
  });
});

describe('MarineProviderCredentialResolver write', () => {
  it('writes the canonical secret bundle under the system tenant through the upsert command', async () => {
    const { resolver, executeCommand } = makeHarness();
    executeCommand.mockResolvedValue(storedCredentialRow({ version: 8 }));

    const status = await resolver.setMarineProviderCdseCredential(
      {
        clientId: 'cdse-client',
        clientSecret: 'cdse-secret',
        instanceId: 'inst-1',
        reason: 'rotation',
      },
      superAdmin,
    );

    expect(executeCommand).toHaveBeenCalledTimes(1);
    const command = executeCommand.mock.calls[0][0] as UpsertConfigurationCommand;
    expect(command).toBeInstanceOf(UpsertConfigurationCommand);
    expect(command.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(command.service).toBe(MARINE_PROVIDER_CREDENTIAL_SERVICE);
    expect(command.key).toBe(MARINE_PROVIDER_CREDENTIAL_KEYS.CDSE);
    expect(command.environment).toBe(ConfigEnvironment.ALL);
    expect(command.isSecret).toBe(true);
    expect(command.userId).toBe('operator-1');
    expect(command.reason).toBe('rotation');
    // The stored value is exactly what the farm runtime will parse.
    expect(parseMarineProviderCdseCredentialBundle(command.value)).toEqual({
      clientId: 'cdse-client',
      clientSecret: 'cdse-secret',
      instanceId: 'inst-1',
    });
    expect(status).toEqual({
      provider: 'CDSE',
      configured: true,
      version: 8,
      updatedAt: new Date('2026-09-18T10:00:00.000Z'),
    });
  });

  it('omits instanceId from the bundle when the input leaves it out', async () => {
    const { resolver, executeCommand } = makeHarness();
    executeCommand.mockResolvedValue(storedCredentialRow());

    await resolver.setMarineProviderCdseCredential(
      { clientId: 'cdse-client', clientSecret: 'cdse-secret' },
      superAdmin,
    );

    const command = executeCommand.mock.calls[0][0] as UpsertConfigurationCommand;
    expect(JSON.parse(command.value)).toEqual({
      clientId: 'cdse-client',
      clientSecret: 'cdse-secret',
    });
    expect(command.reason).toMatch(/platform admin surface/);
  });

  it('rejects fields the canonical bundle rules refuse before any write', async () => {
    const { resolver, executeCommand } = makeHarness();

    await expect(
      resolver.setMarineProviderCdseCredential(
        { clientId: '', clientSecret: 'secret' },
        superAdmin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
