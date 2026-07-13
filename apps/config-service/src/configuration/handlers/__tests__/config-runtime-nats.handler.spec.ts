import { AuditLogService } from '@aquaculture/backend-common/audit';
import { generateServiceIdentityHeadersV2 } from '@aquaculture/backend-common/utils';
import { ConfigService } from '@nestjs/config';
import {
  CONFIG_RUNTIME_SUBJECTS,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  canonicalConfigRuntimeBody,
  type ConfigRuntimeGetRequest,
} from '@platform/event-contracts';

import { ConfigurationService } from '../../services/configuration.service';
import { ConfigRuntimeNatsHandler } from '../config-runtime-nats.handler';

/**
 * ConfigRuntimeNatsHandler — the trusted secret read surface. Verifies the five
 * defense-in-depth layers this handler owns (the NATS cert-CN layer is enforced
 * by the broker, not here): HMAC verify, nonce-replay, per-caller key allowlist,
 * mandatory audit on allow AND deny, and value-never-in-audit-metadata.
 */

const DEV_SECRET = 'unit-test-signing-secret';
const CALLER = 'billing-service';
const SECRET_KEY = 'platform/billing.stripe_secret_key';

type FetchResult = { value: string; isSecret: boolean } | null;

interface Mocks {
  handler: ConfigRuntimeNatsHandler;
  fetch: jest.Mock;
  audit: jest.Mock;
}

function build(fetchImpl?: () => Promise<FetchResult>): Mocks {
  const fetch = jest.fn();
  fetch.mockImplementation(fetchImpl ?? (async () => ({ value: 'sk_live_super', isSecret: true })));
  const audit = jest.fn();
  audit.mockResolvedValue(undefined);
  // Repo cast-free mock idiom: a Pick-typed partial + single `as` at the seam.
  const configurationService: Pick<ConfigurationService, 'getEffectiveWithMeta'> = {
    getEffectiveWithMeta: fetch,
  };
  const auditLogService: Pick<AuditLogService, 'recordAwait'> = { recordAwait: audit };
  const configService: Pick<ConfigService, 'get'> = {
    get: (key: string): string | undefined =>
      key === 'SERVICE_IDENTITY_SIGNING_SECRET' ? DEV_SECRET : undefined,
  };
  const handler = new ConfigRuntimeNatsHandler(
    configurationService as ConfigurationService,
    auditLogService as AuditLogService,
    configService as ConfigService,
  );
  return { handler, fetch, audit };
}

function signedRequest(
  subject: string,
  service: string,
  key: string,
  overrides: { secret?: string; caller?: string; nonce?: string } = {},
): ConfigRuntimeGetRequest {
  // Spread into a plain Record<string,string> (the wire shape carried in the
  // NATS payload) — ServiceIdentityHeadersV2 has no index signature.
  const identity: Record<string, string> = {
    ...generateServiceIdentityHeadersV2({
      serviceName: overrides.caller ?? CALLER,
      secret: overrides.secret ?? DEV_SECRET,
      tenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      method: 'POST',
      path: subject,
      body: canonicalConfigRuntimeBody(service, key),
      keyId: 'test-kid',
      audience: 'config',
      nonce: overrides.nonce,
    }),
  };
  return { service, key, identity };
}

describe('ConfigRuntimeNatsHandler — GET_SECRET trusted path', () => {
  it('allowed caller + allowed key + valid HMAC → returns the decrypted value and audits ALLOW', async () => {
    const { handler, audit } = build(async () => ({ value: 'sk_live_super', isSecret: true }));
    const req = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      'platform',
      'billing.stripe_secret_key',
    );

    const result = await handler.getSecret(req);

    expect(result).toEqual({ found: true, value: 'sk_live_super' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'config.secret.fetched',
        resourceId: SECRET_KEY,
        tenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      }),
    );
    // VALUE NEVER in audit metadata.
    const metadataStr = JSON.stringify(audit.mock.calls.map((c) => c[0].metadata));
    expect(metadataStr).not.toContain('sk_live_super');
  });

  it('caller not on the key allowlist → deny + audit, no value leaked', async () => {
    const { handler, audit, fetch } = build();
    const req = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      'platform',
      'billing.some_other_secret',
    );

    const result = await handler.getSecret(req);

    expect(result).toEqual({ found: false, value: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'config.secret.denied' }));
  });

  it('tampered signature → deny (invalid HMAC), no fetch', async () => {
    const { handler, audit, fetch } = build();
    const req = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      'platform',
      'billing.stripe_secret_key',
    );
    req.identity['X-Service-Signature'] = 'deadbeef'.repeat(8);

    const result = await handler.getSecret(req);

    expect(result).toEqual({ found: false, value: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'config.secret.denied' }));
  });

  it('wrong signing secret → deny (HMAC mismatch)', async () => {
    const { handler } = build();
    const req = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      'platform',
      'billing.stripe_secret_key',
      { secret: 'attacker-secret' },
    );
    expect(await handler.getSecret(req)).toEqual({ found: false, value: null });
  });

  it('replayed nonce → first ALLOW, second DENY (replay)', async () => {
    const { handler, audit } = build(async () => ({ value: 'sk_live_super', isSecret: true }));
    const req = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      'platform',
      'billing.stripe_secret_key',
      { nonce: 'fixed-nonce-123' },
    );

    const first = await handler.getSecret(req);
    const second = await handler.getSecret(req);

    expect(first).toEqual({ found: true, value: 'sk_live_super' });
    expect(second).toEqual({ found: false, value: null });
    const denyCall = audit.mock.calls.find((c) => c[0].action === 'config.secret.denied');
    expect(denyCall?.[0].metadata).toMatchObject({ reason: 'nonce-replay' });
  });

  it('absent secret row → found:false (not an error)', async () => {
    const { handler } = build(async () => null);
    const req = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      'platform',
      'billing.stripe_secret_key',
    );
    expect(await handler.getSecret(req)).toEqual({ found: false, value: null });
  });

  it('SEC-MEDIUM-002: secret-path audit write failure → secret is NOT returned (fail-closed)', async () => {
    const { handler, audit } = build(async () => ({ value: 'sk_live_super', isSecret: true }));
    // The allow-audit recordAwait throws (DB down).
    audit.mockRejectedValue(new Error('audit db unavailable'));
    const req = signedRequest(
      CONFIG_RUNTIME_SUBJECTS.GET_SECRET,
      'platform',
      'billing.stripe_secret_key',
    );
    expect(await handler.getSecret(req)).toEqual({ found: false, value: null });
  });
});

describe('ConfigRuntimeNatsHandler — GET non-secret path cannot leak a secret key', () => {
  it('GET for the secret key is DENIED (not on the non-secret allowlist)', async () => {
    const { handler, fetch } = build();
    const req = signedRequest(CONFIG_RUNTIME_SUBJECTS.GET, 'platform', 'billing.stripe_secret_key');
    expect(await handler.getValue(req)).toEqual({ found: false, value: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('GET for an allowlisted non-secret key → returns the value', async () => {
    const { handler } = build(async () => ({ value: 'true', isSecret: false }));
    const req = signedRequest(CONFIG_RUNTIME_SUBJECTS.GET, 'platform', 'billing.stripe_enabled');
    expect(await handler.getValue(req)).toEqual({ found: true, value: 'true' });
  });

  it('SEC-MEDIUM-001: GET for an allowlisted key whose row IS a secret → refused (structural guard)', async () => {
    // Misconfiguration: an allowlisted non-secret key resolves to a secret row.
    // GET must refuse regardless of the allowlist.
    const { handler, audit } = build(async () => ({ value: 'leaked', isSecret: true }));
    const req = signedRequest(CONFIG_RUNTIME_SUBJECTS.GET, 'platform', 'billing.stripe_public_key');
    expect(await handler.getValue(req)).toEqual({ found: false, value: null });
    const denyCall = audit.mock.calls.find((c) => c[0].action === 'config.value.denied');
    expect(denyCall?.[0].metadata).toMatchObject({ reason: 'is-secret-on-nonsecret-path' });
  });
});
