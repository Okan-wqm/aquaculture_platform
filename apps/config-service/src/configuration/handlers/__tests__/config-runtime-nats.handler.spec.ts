import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationKeyId,
} from '@aquaculture/configuration-contracts';
import { AuditLogService } from '@aquaculture/backend-common/audit';
import { generateServiceIdentityHeadersV2 } from '@aquaculture/backend-common/utils';
import { ConfigService } from '@nestjs/config';
import {
  CONFIG_RUNTIME_SUBJECTS,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  canonicalConfigRuntimeBody,
  type ConfigRuntimeGetRequest,
  type ConfigRuntimeResult,
} from '@platform/event-contracts';

import { ConfigurationService } from '../../services/configuration.service';
import { ConfigRuntimeNatsHandler } from '../config-runtime-nats.handler';

const DEV_SECRET = 'unit-test-signing-secret';
const BILLING_CALLER = 'billing-service';
const BILLING_SECRET_RESOURCE = 'platform/billing.stripe_secret_key';

type FetchResult = {
  value: string;
  sourceTenantId: string;
  configVersion: number;
} | null;

interface Mocks {
  handler: ConfigRuntimeNatsHandler;
  fetch: jest.Mock;
  audit: jest.Mock;
}

function build(fetchImpl?: () => Promise<FetchResult>): Mocks {
  const fetch = jest.fn();
  fetch.mockImplementation(
    fetchImpl ??
      (async () => ({
        value: 'sk_live_super',
        sourceTenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
        configVersion: 1,
      })),
  );
  const audit = jest.fn().mockResolvedValue(undefined);
  const configurationService: Pick<ConfigurationService, 'getEffectiveWithMeta'> = {
    getEffectiveWithMeta: fetch,
  };
  const auditLogService: Pick<AuditLogService, 'recordAwait'> = { recordAwait: audit };
  const configService: Pick<ConfigService, 'get'> = {
    get: (key: string): string | undefined =>
      key === 'SERVICE_IDENTITY_SIGNING_SECRET' ? DEV_SECRET : undefined,
  };
  return {
    handler: new ConfigRuntimeNatsHandler(
      configurationService as ConfigurationService,
      auditLogService as AuditLogService,
      configService as ConfigService,
    ),
    fetch,
    audit,
  };
}

function signedRequest(
  subject: string,
  keyId: ConfigurationKeyId,
  overrides: {
    caller?: string;
    nonce?: string;
    secret?: string;
    catalogDigest?: string;
  } = {},
): ConfigRuntimeGetRequest {
  const catalogDigest = overrides.catalogDigest ?? CONFIGURATION_CATALOG_DIGEST;
  const identity: Record<string, string> = {
    ...generateServiceIdentityHeadersV2({
      serviceName: overrides.caller ?? BILLING_CALLER,
      secret: overrides.secret ?? DEV_SECRET,
      tenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      method: 'POST',
      path: subject,
      body: canonicalConfigRuntimeBody(catalogDigest, keyId),
      keyId: 'test-kid',
      audience: 'config',
      nonce: overrides.nonce,
    }),
  };
  return { catalogDigest, keyId, identity };
}

function runtimeResult(found: boolean, value: string | null): ConfigRuntimeResult {
  return { catalogDigest: CONFIGURATION_CATALOG_DIGEST, found, value };
}

describe('ConfigRuntimeNatsHandler catalog-pinned secret path', () => {
  it('returns and audits an exact catalog-registered billing secret', async () => {
    const { handler, audit } = build();
    const result = await handler.getSecret(
      signedRequest(
        CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
        ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
      ),
    );

    expect(result).toEqual(runtimeResult(true, 'sk_live_super'));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'config.secret.fetched',
        resourceId: BILLING_SECRET_RESOURCE,
        tenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      }),
    );
    expect(JSON.stringify(audit.mock.calls.map((call) => call[0].metadata))).not.toContain(
      'sk_live_super',
    );
  });

  it('serves the independently registered notification secret only to notification-service', async () => {
    const { handler } = build(async () => ({
      value: 'smtp-secret',
      sourceTenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      configVersion: 2,
    }));
    const result = await handler.getSecret(
      signedRequest(CONFIG_RUNTIME_SUBJECTS.GET_SECRET, ConfigurationKeyId.EMAIL_SMTP_PASSWORD, {
        caller: 'notification-service',
      }),
    );
    expect(result).toEqual(runtimeResult(true, 'smtp-secret'));
  });

  it('denies a registered caller when the requested key belongs to another consumer', async () => {
    const { handler, fetch, audit } = build();
    const result = await handler.getSecret(
      signedRequest(
        CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
        ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
        {
          caller: 'notification-service',
        },
      ),
    );
    expect(result).toEqual(runtimeResult(false, null));
    expect(fetch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'config.secret.denied' }));
  });

  it('rejects a stale catalog generation before reading configuration', async () => {
    const { handler, fetch, audit } = build();
    const result = await handler.getSecret(
      signedRequest(
        CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
        ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
        {
          catalogDigest: '0'.repeat(64),
        },
      ),
    );
    expect(result).toEqual(runtimeResult(false, null));
    expect(fetch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'catalog-digest-mismatch' }),
      }),
    );
  });

  it('rejects tampering and nonce replay without leaking a value', async () => {
    const { handler, fetch } = build();
    const tampered = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
    );
    tampered.identity['X-Service-Signature'] = 'deadbeef'.repeat(8);
    expect(await handler.getSecret(tampered)).toEqual(runtimeResult(false, null));
    expect(fetch).not.toHaveBeenCalled();

    const replay = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
      { nonce: 'fixed-nonce-123' },
    );
    expect(await handler.getSecret(replay)).toEqual(runtimeResult(true, 'sk_live_super'));
    expect(await handler.getSecret(replay)).toEqual(runtimeResult(false, null));
  });

  it('returns indistinguishable absence and fails closed when disclosure audit fails', async () => {
    const absent = build(async () => null);
    expect(
      await absent.handler.getSecret(
        signedRequest(
          CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
          ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
        ),
      ),
    ).toEqual(runtimeResult(false, null));

    const auditFailure = build();
    auditFailure.audit.mockRejectedValue(new Error('audit db unavailable'));
    expect(
      await auditFailure.handler.getSecret(
        signedRequest(
          CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
          ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
        ),
      ),
    ).toEqual(runtimeResult(false, null));
  });
});

describe('ConfigRuntimeNatsHandler non-secret path', () => {
  it('cannot serve a catalog-secret ID over GET', async () => {
    const { handler, fetch } = build();
    expect(
      await handler.getValue(
        signedRequest(CONFIG_RUNTIME_SUBJECTS.GET, ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY),
      ),
    ).toEqual(runtimeResult(false, null));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves a catalog-registered non-secret ID with catalog identity', async () => {
    const { handler } = build(async () => ({
      value: 'true',
      sourceTenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      configVersion: 1,
    }));
    expect(
      await handler.getValue(
        signedRequest(CONFIG_RUNTIME_SUBJECTS.GET, ConfigurationKeyId.BILLING_STRIPE_ENABLED),
      ),
    ).toEqual(runtimeResult(true, 'true'));
  });
});
