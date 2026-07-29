/**
 * Explicit tenant targeting on the configuration resolver.
 *
 * # The capability this covers
 *
 * Before the `tenantId` argument existed, every operation derived its scope
 * from the caller's own JWT claim. SUPER_ADMIN is the platform's only tenantless
 * principal, so it always resolved to SYSTEM and could not address tenant X at
 * all. That single missing argument is why config-service could not own tenant
 * configuration, and therefore why `admin.tenant_configurations` was dropped on
 * a promise nothing could keep — admin-api's read paths went on synthesizing
 * identical defaults for every tenant and its write paths went on returning 410.
 *
 * # The security property
 *
 * The argument is gated, never trusted. A platform admin may name a target; any
 * other caller naming one is REFUSED rather than quietly scoped back to its own
 * tenant, because a silent narrowing would let a caller believe it had written
 * another tenant's row.
 */
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
import { TENANT_SETTINGS_SERVICE } from '../tenant-settings/tenant-settings.vocabulary';

const TARGET_TENANT_ID = '9f1d4c2a-5b3e-4d7a-8c6f-1e2b3a4d5c6e';
const CALLER_TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

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

interface ResolverContext {
  req: { user?: { sub: string; tenantId?: string | null; roles?: string[] } };
}

function makeHarness(): {
  resolver: ConfigurationResolver;
  executeCommand: jest.Mock;
  executeQuery: jest.Mock;
} {
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

describe('ConfigurationResolver explicit tenant targeting', () => {
  it('reads the NAMED tenant when a platform admin targets one', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue([configurationRow(TARGET_TENANT_ID)]);

    await resolver.getEffectiveConfigurationsByService(
      TENANT_SETTINGS_SERVICE,
      ConfigEnvironment.ALL,
      TARGET_TENANT_ID,
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    const dispatched = executeQuery.mock.calls[0]?.[0] as GetConfigurationsByServiceQuery;
    // Without the argument this same call resolves to SYSTEM — the exact
    // behaviour that made per-tenant administration impossible.
    expect(dispatched.tenantId).toBe(TARGET_TENANT_ID);
    expect(dispatched.tenantId).not.toBe(SYSTEM_TENANT_ID);
  });

  it('writes to the NAMED tenant when a platform admin targets one', async () => {
    const { resolver, executeCommand } = makeHarness();
    executeCommand.mockResolvedValue(configurationRow(TARGET_TENANT_ID));

    await resolver.setConfiguration(
      TENANT_SETTINGS_SERVICE,
      'security.mfa_required',
      'true',
      ConfigEnvironment.ALL,
      false,
      'admin-panel tenant settings save',
      TARGET_TENANT_ID,
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    const dispatched = executeCommand.mock.calls[0]?.[0] as UpsertConfigurationCommand;
    expect(dispatched.tenantId).toBe(TARGET_TENANT_ID);
    expect(dispatched.service).toBe(TENANT_SETTINGS_SERVICE);
    expect(dispatched.key).toBe('security.mfa_required');
  });

  it('refuses a tenant-scoped caller that names a foreign tenant', async () => {
    const { resolver, executeQuery } = makeHarness();

    await expect(
      resolver.getEffectiveConfigurationsByService(
        TENANT_SETTINGS_SERVICE,
        ConfigEnvironment.ALL,
        TARGET_TENANT_ID,
        context({ sub: 'user-1', tenantId: CALLER_TENANT_ID, roles: ['TENANT_ADMIN'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Refused, NOT silently narrowed to the caller's own tenant: a caller that
    // believed it had read tenant X while it read itself is worse than an error.
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('refuses a tenant-scoped caller that names its OWN tenant', async () => {
    // Same rule, no special case. Allowing the self-target would put a second
    // path into scope resolution, and the two would drift.
    const { resolver, executeCommand } = makeHarness();

    await expect(
      resolver.setConfiguration(
        TENANT_SETTINGS_SERVICE,
        'security.mfa_required',
        'true',
        ConfigEnvironment.ALL,
        false,
        undefined,
        CALLER_TENANT_ID,
        context({ sub: 'user-1', tenantId: CALLER_TENANT_ID, roles: ['TENANT_ADMIN'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller that names a tenant', async () => {
    const { resolver, executeQuery } = makeHarness();

    await expect(
      resolver.getEffectiveConfigurationsByService(
        TENANT_SETTINGS_SERVICE,
        ConfigEnvironment.ALL,
        TARGET_TENANT_ID,
        context(undefined),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('keeps the untargeted behaviour unchanged for a tenant caller', async () => {
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue([configurationRow(CALLER_TENANT_ID)]);

    await resolver.getEffectiveConfigurationsByService(
      TENANT_SETTINGS_SERVICE,
      ConfigEnvironment.ALL,
      null,
      context({ sub: 'user-1', tenantId: CALLER_TENANT_ID, roles: ['TENANT_ADMIN'] }),
    );

    const dispatched = executeQuery.mock.calls[0]?.[0] as GetConfigurationsByServiceQuery;
    expect(dispatched.tenantId).toBe(CALLER_TENANT_ID);
  });

  it('treats an empty-string target as no target rather than as a tenant id', async () => {
    // A page that renders before its route param resolves sends ''. Reading it
    // as a tenant id would query a partition that cannot exist and return an
    // empty settings page that looks like a tenant with nothing configured.
    const { resolver, executeQuery } = makeHarness();
    executeQuery.mockResolvedValue([configurationRow(SYSTEM_TENANT_ID)]);

    await resolver.getEffectiveConfigurationsByService(
      TENANT_SETTINGS_SERVICE,
      ConfigEnvironment.ALL,
      '',
      context({ sub: 'admin-1', tenantId: null, roles: ['SUPER_ADMIN'] }),
    );

    const dispatched = executeQuery.mock.calls[0]?.[0] as GetConfigurationsByServiceQuery;
    expect(dispatched.tenantId).toBe(SYSTEM_TENANT_ID);
  });
});
