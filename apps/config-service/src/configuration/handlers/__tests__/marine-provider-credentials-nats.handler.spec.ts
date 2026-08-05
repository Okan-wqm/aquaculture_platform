import { AuditLogService } from '@aquaculture/backend-common/audit';
import { TenantErasureTombstoneError } from '@aquaculture/backend-common/compliance';
import { RedisService } from '@aquaculture/backend-common/redis';
import { generateServiceIdentityHeadersV2 } from '@aquaculture/backend-common/utils';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandBus } from '@nestjs/cqrs';
import {
  MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
  MARINE_PROVIDER_CREDENTIAL_SUBJECTS,
  MarineProviderCredentialMutationOutcome,
  MarineProviderCredentialResolveOutcome,
  canonicalMarineProviderCredentialBody,
  type MarineProviderCredentialOperation,
  type MarineProviderCredentialRequest,
  type MarineProviderCredentialResolveResult,
} from '@platform/event-contracts';

import { ConfigurationService } from '../../services/configuration.service';
import { MarineProviderCredentialsNatsHandler } from '../marine-provider-credentials-nats.handler';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_SECRET = 'marine-provider-test-signing-secret';

interface Harness {
  handler: MarineProviderCredentialsNatsHandler;
  getEffectiveFresh: jest.Mock;
  getEffectiveCached: jest.Mock;
  execute: jest.Mock;
  audit: jest.Mock;
  setNx: jest.Mock;
}

function signedRequest(
  subject: string,
  operation: MarineProviderCredentialOperation,
  key: string,
  bundleJson?: string,
  actorId = operation === 'resolve'
    ? MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID
    : MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
): MarineProviderCredentialRequest {
  const body = canonicalMarineProviderCredentialBody({
    operation,
    tenantId: TENANT_ID,
    service: MARINE_PROVIDER_CREDENTIAL_SERVICE,
    key,
    actorId,
    bundleJson,
  });
  return {
    tenantId: TENANT_ID,
    service: MARINE_PROVIDER_CREDENTIAL_SERVICE,
    key,
    actorId,
    bundleJson,
    identity: {
      ...generateServiceIdentityHeadersV2({
        serviceName: 'farm-service',
        secret: DEV_SECRET,
        tenantId: TENANT_ID,
        method: 'POST',
        path: subject,
        body,
        keyId: 'test-kid',
        audience: 'config',
      }),
    },
  };
}

function build(sharedNonces = new Set<string>()): Harness {
  const getEffectiveFresh = jest.fn();
  const getEffectiveCached = jest.fn();
  const execute = jest.fn();
  const audit = jest.fn().mockResolvedValue(undefined);
  const setNx = jest.fn(async (key: string): Promise<boolean> => {
    if (sharedNonces.has(key)) {
      return false;
    }
    sharedNonces.add(key);
    return true;
  });
  const configurationService: Pick<
    ConfigurationService,
    'getEffectiveWithMeta' | 'getEffectiveWithMetaFresh'
  > = {
    getEffectiveWithMeta: getEffectiveCached,
    getEffectiveWithMetaFresh: getEffectiveFresh,
  };
  const commandBus: Pick<CommandBus, 'execute'> = { execute };
  const auditLogService: Pick<AuditLogService, 'recordAwait'> = { recordAwait: audit };
  const configService: Pick<ConfigService, 'get'> = {
    get: (key: string): string | undefined =>
      key === 'SERVICE_IDENTITY_SIGNING_SECRET' ? DEV_SECRET : undefined,
  };
  return {
    handler: new MarineProviderCredentialsNatsHandler(
      configurationService as ConfigurationService,
      commandBus as CommandBus,
      auditLogService as AuditLogService,
      configService as ConfigService,
      { setNx } as Pick<RedisService, 'setNx'> as RedisService,
    ),
    getEffectiveFresh,
    getEffectiveCached,
    execute,
    audit,
    setNx,
  };
}

describe('MarineProviderCredentialsNatsHandler', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects malformed trust-boundary payloads without dereferencing attacker data', async () => {
    const harness = build();

    await expect(harness.handler.resolve(null)).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });
    expect(harness.getEffectiveFresh).not.toHaveBeenCalled();
    expect(harness.getEffectiveCached).not.toHaveBeenCalled();
    expect(harness.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'marine.provider-credential.denied',
        tenantId: '00000000-0000-0000-0000-000000000000',
        metadata: expect.objectContaining({ reason: 'invalid-request-shape' }),
      }),
    );
  });

  it.each([
    {
      name: 'preserved tenant override',
      sourceTenantId: TENANT_ID,
    },
    {
      name: 'company fallback',
      sourceTenantId: '00000000-0000-0000-0000-000000000000',
    },
  ])('resolves a valid $name with provenance', async ({ sourceTenantId }) => {
    const harness = build();
    harness.getEffectiveFresh.mockResolvedValue({
      value: '{"clientId":"effective-id","clientSecret":"effective-secret"}',
      isSecret: true,
      sourceTenantId,
      configVersion: 7,
    });
    const request = signedRequest(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
      'resolve',
      'marine.cdse.credentials',
    );

    const result: MarineProviderCredentialResolveResult = await harness.handler.resolve(request);

    expect(result).toEqual({
      outcome: MarineProviderCredentialResolveOutcome.RESOLVED,
      found: true,
      bundleJson: '{"clientId":"effective-id","clientSecret":"effective-secret"}',
      sourceTenantId,
      configVersion: 7,
    });
    expect(harness.getEffectiveFresh).toHaveBeenCalledTimes(1);
    expect(harness.getEffectiveCached).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain('effective-secret');
  });

  it('never falls back after an invalid tenant override fails bundle validation', async () => {
    const harness = build();
    harness.getEffectiveFresh.mockResolvedValue({
      value: '{"clientId":"tenant-id"}',
      isSecret: true,
      sourceTenantId: TENANT_ID,
      configVersion: 2,
    });
    const request = signedRequest(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
      'resolve',
      'marine.cdse.credentials',
    );

    await expect(harness.handler.resolve(request)).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
      found: false,
      bundleJson: null,
      sourceTenantId: TENANT_ID,
      configVersion: 2,
    });
    expect(harness.getEffectiveFresh).toHaveBeenCalledTimes(1);
    expect(harness.getEffectiveCached).not.toHaveBeenCalled();
  });

  it.each(['marine.cmems.credentials', 'marine.unapproved.credentials'])(
    'rejects signed non-allowlisted key %s before a database read',
    async (key) => {
      const harness = build();
      const request = signedRequest(MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE, 'resolve', key);

      await expect(harness.handler.resolve(request)).resolves.toEqual({
        outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
        found: false,
        bundleJson: null,
        sourceTenantId: null,
        configVersion: null,
      });
      expect(harness.getEffectiveFresh).not.toHaveBeenCalled();
      expect(harness.getEffectiveCached).not.toHaveBeenCalled();
    },
  );

  it('rejects a signed upsert from any actor other than the one-shot cutover', async () => {
    const harness = build();
    const request = signedRequest(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
      'upsert',
      'marine.cdse.credentials',
      '{"clientId":"id","clientSecret":"secret"}',
      MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
    );

    await expect(harness.handler.upsert(request)).resolves.toEqual({
      outcome: MarineProviderCredentialMutationOutcome.RETRYABLE_FAILURE,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('upserts the complete CDSE JSON bundle as one secret configuration command', async () => {
    const harness = build();
    harness.execute.mockResolvedValue({
      tenantId: TENANT_ID,
      version: 4,
    });
    const bundleJson = '{"clientId":"id","clientSecret":"secret","instanceId":"instance"}';
    const request = signedRequest(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
      'upsert',
      'marine.cdse.credentials',
      bundleJson,
    );

    await expect(harness.handler.upsert(request)).resolves.toEqual({
      outcome: MarineProviderCredentialMutationOutcome.APPLIED,
      success: true,
      sourceTenantId: TENANT_ID,
      configVersion: 4,
    });
    expect(harness.execute).toHaveBeenCalledTimes(1);
    const command = harness.execute.mock.calls[0]?.[0] as {
      value: string;
      isSecret: boolean;
      tenantId: string;
      key: string;
    };
    expect(command).toMatchObject({
      value: bundleJson,
      isSecret: true,
      tenantId: TENANT_ID,
      key: 'marine.cdse.credentials',
    });
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain('secret');
  });

  it('rejects replayed signed writes', async () => {
    const harness = build();
    harness.execute.mockResolvedValue({ tenantId: TENANT_ID, version: 1 });
    const request = signedRequest(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
      'upsert',
      'marine.cdse.credentials',
      '{"clientId":"id","clientSecret":"secret"}',
    );

    await expect(harness.handler.upsert(request)).resolves.toMatchObject({ success: true });
    await expect(harness.handler.upsert(request)).resolves.toEqual({
      outcome: MarineProviderCredentialMutationOutcome.RETRYABLE_FAILURE,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    });
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it('returns a terminal tenant-erased outcome without exposing persistence details', async () => {
    const harness = build();
    harness.execute.mockRejectedValue(new TenantErasureTombstoneError());
    const request = signedRequest(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
      'upsert',
      'marine.cdse.credentials',
      '{"clientId":"id","clientSecret":"secret"}',
    );

    await expect(harness.handler.upsert(request)).resolves.toEqual({
      outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    });
    expect(harness.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'marine.provider-credential.denied',
        metadata: expect.objectContaining({ reason: 'tenant-erased' }),
      }),
    );
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain('secret');
  });

  it('rejects a replay that lands on another config-service replica', async () => {
    const sharedNonces = new Set<string>();
    const firstReplica = build(sharedNonces);
    const secondReplica = build(sharedNonces);
    firstReplica.getEffectiveFresh.mockResolvedValue({
      value: '{"clientId":"effective-id","clientSecret":"effective-secret"}',
      isSecret: true,
      sourceTenantId: TENANT_ID,
      configVersion: 7,
    });
    secondReplica.getEffectiveFresh.mockResolvedValue({
      value: '{"clientId":"effective-id","clientSecret":"effective-secret"}',
      isSecret: true,
      sourceTenantId: TENANT_ID,
      configVersion: 7,
    });
    const request = signedRequest(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
      'resolve',
      'marine.cdse.credentials',
    );

    await expect(firstReplica.handler.resolve(request)).resolves.toMatchObject({ found: true });
    await expect(secondReplica.handler.resolve(request)).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });

    expect(firstReplica.getEffectiveFresh).toHaveBeenCalledTimes(1);
    expect(secondReplica.getEffectiveFresh).not.toHaveBeenCalled();
  });

  it('returns a sanitized transient outcome when the replay ledger is unavailable', async () => {
    const harness = build();
    harness.setNx.mockRejectedValue(new Error('redis transport detail'));

    await expect(
      harness.handler.resolve(
        signedRequest(
          MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
          'resolve',
          'marine.cdse.credentials',
        ),
      ),
    ).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });

    expect(harness.getEffectiveFresh).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('returns a sanitized transient outcome when the effective credential database read fails', async () => {
    const harness = build();
    harness.getEffectiveFresh.mockRejectedValue(
      new Error('database detail with internal endpoint must not escape'),
    );

    await expect(
      harness.handler.resolve(
        signedRequest(
          MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
          'resolve',
          'marine.cdse.credentials',
        ),
      ),
    ).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });
    expect(harness.getEffectiveFresh).toHaveBeenCalledTimes(1);
  });

  it('returns NOT_FOUND only after a true absence is durably audited', async () => {
    const harness = build();
    harness.getEffectiveFresh.mockResolvedValue(null);

    await expect(
      harness.handler.resolve(
        signedRequest(
          MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
          'resolve',
          'marine.cdse.credentials',
        ),
      ),
    ).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });
    expect(harness.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'marine.provider-credential.resolved',
        metadata: expect.objectContaining({ found: false, outcome: 'allow' }),
      }),
    );
  });

  it('returns a sanitized transient outcome when absence audit persistence fails', async () => {
    const harness = build();
    harness.getEffectiveFresh.mockResolvedValue(null);
    harness.audit.mockRejectedValue(new Error('audit persistence detail must not escape'));

    await expect(
      harness.handler.resolve(
        signedRequest(
          MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
          'resolve',
          'marine.cdse.credentials',
        ),
      ),
    ).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });
  });

  it('returns a sanitized transient outcome when required disclosure audit persistence fails', async () => {
    const harness = build();
    harness.getEffectiveFresh.mockResolvedValue({
      value: '{"clientId":"effective-id","clientSecret":"effective-secret"}',
      isSecret: true,
      sourceTenantId: TENANT_ID,
      configVersion: 7,
    });
    harness.audit.mockRejectedValue(new Error('audit persistence detail must not escape'));

    await expect(
      harness.handler.resolve(
        signedRequest(
          MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
          'resolve',
          'marine.cdse.credentials',
        ),
      ),
    ).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });
  });

  it('never writes transport, persistence, or audit error details to logs', async () => {
    const leakSentinel = 'raw-error-secret-and-upstream-url';
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const upsertHarness = build();
    upsertHarness.execute.mockRejectedValue(new Error(leakSentinel));
    await upsertHarness.handler.upsert(
      signedRequest(
        MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
        'upsert',
        'marine.cdse.credentials',
        '{"clientId":"id","clientSecret":"secret"}',
      ),
    );

    const readHarness = build();
    readHarness.getEffectiveFresh.mockRejectedValue(new Error(leakSentinel));
    await readHarness.handler.resolve(
      signedRequest(
        MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
        'resolve',
        'marine.cdse.credentials',
      ),
    );

    const requiredAuditHarness = build();
    requiredAuditHarness.audit.mockRejectedValue(new Error(leakSentinel));
    await requiredAuditHarness.handler.upsert(
      signedRequest(
        MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
        'upsert',
        'marine.cdse.credentials',
        '{"clientId":"id","clientSecret":"secret"}',
      ),
    );

    const malformedAuditHarness = build();
    malformedAuditHarness.audit.mockRejectedValue(new Error(leakSentinel));
    await malformedAuditHarness.handler.resolve(null);

    const serializedLogs = JSON.stringify(loggerError.mock.calls);
    expect(serializedLogs).not.toContain(leakSentinel);
    expect(serializedLogs).not.toContain('clientSecret');
    expect(serializedLogs).toContain('marine.cdse.credentials');
  });
});
