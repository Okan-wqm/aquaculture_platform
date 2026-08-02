import {
  MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX,
  MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_KEYS,
  MARINE_PROVIDER_CREDENTIAL_MAX_BUNDLE_BYTES,
  MarineProviderCredentialResolveOutcome,
  MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
  MARINE_PROVIDER_CREDENTIAL_SUBJECTS,
  MarineProviderCredentialMutationOutcome,
  canonicalMarineProviderCredentialBody,
  marineProviderCredentialKey,
  parseMarineProviderCdseCredentialBundle,
  parseMarineProviderCredentialResolveResult,
  parseMarineProviderCredentialMutationResult,
  serializeMarineProviderCdseCredentialBundle,
} from './config-runtime';

describe('marine provider credential runtime contract', () => {
  it('pins the single atomic CDSE secret bundle key', () => {
    expect(MARINE_PROVIDER_CREDENTIAL_SERVICE).toBe('farm-service');
    expect(MARINE_PROVIDER_CREDENTIAL_KEYS).toEqual({
      CDSE: 'marine.cdse.credentials',
    });
    expect(marineProviderCredentialKey('CDSE')).toBe('marine.cdse.credentials');
  });

  it('pins distinct runtime-read and one-shot-cutover actors', () => {
    expect(MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID).toBe('farm-service:runtime');
    expect(MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID).toBe(
      'farm-service:sentinel-credential-cutover',
    );
  });

  it('parses and serializes one strict canonical CDSE bundle shape', () => {
    const serialized = serializeMarineProviderCdseCredentialBundle({
      clientId: 'client',
      clientSecret: 'secret',
      instanceId: 'instance',
    });

    expect(serialized).toBe(
      '{"clientId":"client","clientSecret":"secret","instanceId":"instance"}',
    );
    expect(parseMarineProviderCdseCredentialBundle(serialized)).toEqual({
      clientId: 'client',
      clientSecret: 'secret',
      instanceId: 'instance',
    });
  });

  it.each([
    ['partial', '{"clientId":"client"}'],
    ['unknown field', '{"clientId":"client","clientSecret":"secret","extra":true}'],
    ['empty identifier', '{"clientId":"","clientSecret":"secret"}'],
    ['oversized field', JSON.stringify({ clientId: 'client', clientSecret: 'x'.repeat(4097) })],
    ['oversized UTF-8 JSON', `"${'ø'.repeat(MARINE_PROVIDER_CREDENTIAL_MAX_BUNDLE_BYTES)}"`],
  ])('rejects a %s bundle at the shared contract boundary', (_name, value) => {
    expect(parseMarineProviderCdseCredentialBundle(value)).toBeNull();
  });

  it('uses a dedicated reply-inbox token for every secret-bearing response', () => {
    expect(MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX).toBe('_INBOXFARMMARINECFG');
    expect(MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX.startsWith('_INBOX.')).toBe(false);
  });

  it('keeps only internal secret resolution and one-shot write on exact subjects', () => {
    expect(MARINE_PROVIDER_CREDENTIAL_SUBJECTS).toEqual({
      RESOLVE: 'config.marine_credentials.resolve',
      UPSERT: 'config.marine_credentials.upsert',
    });
  });

  it('defines a sanitized unavailable outcome distinct from credential absence', () => {
    expect(MarineProviderCredentialResolveOutcome).toEqual({
      RESOLVED: 'RESOLVED',
      NOT_FOUND: 'NOT_FOUND',
      UNAVAILABLE: 'UNAVAILABLE',
    });

    expect(
      parseMarineProviderCredentialResolveResult({
        outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
        found: false,
        bundleJson: null,
        sourceTenantId: null,
        configVersion: null,
      }),
    ).toEqual({
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });
    expect(
      parseMarineProviderCredentialResolveResult({
        outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
        found: false,
        bundleJson: null,
        sourceTenantId: null,
        configVersion: null,
        internalError: 'database host and secret must not cross the boundary',
      }),
    ).toBeNull();
  });

  it('parses only exact, internally consistent credential mutation outcomes', () => {
    expect(
      parseMarineProviderCredentialMutationResult({
        outcome: MarineProviderCredentialMutationOutcome.APPLIED,
        success: true,
        sourceTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        configVersion: 1,
      }),
    ).toEqual({
      outcome: MarineProviderCredentialMutationOutcome.APPLIED,
      success: true,
      sourceTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configVersion: 1,
    });
    expect(
      parseMarineProviderCredentialMutationResult({
        outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
        success: false,
        sourceTenantId: null,
        configVersion: null,
      }),
    ).toEqual({
      outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    });
  });

  it.each([
    {
      outcome: MarineProviderCredentialMutationOutcome.APPLIED,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    },
    {
      outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
      success: true,
      sourceTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configVersion: 1,
    },
    {
      outcome: MarineProviderCredentialMutationOutcome.RETRYABLE_FAILURE,
      success: false,
      sourceTenantId: null,
      configVersion: null,
      internalError: 'must stay private',
    },
  ])('rejects contradictory or expanded mutation result %#', (value) => {
    expect(parseMarineProviderCredentialMutationResult(value)).toBeNull();
  });

  it.each([
    {
      name: 'resolved',
      value: {
        outcome: MarineProviderCredentialResolveOutcome.RESOLVED,
        found: true,
        bundleJson: '{"clientId":"client","clientSecret":"secret"}',
        sourceTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        configVersion: 1,
      },
    },
    {
      name: 'not found',
      value: {
        outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
        found: false,
        bundleJson: null,
        sourceTenantId: null,
        configVersion: null,
      },
    },
  ])('rejects internal fields appended to a $name reply', ({ value }) => {
    expect(
      parseMarineProviderCredentialResolveResult({
        ...value,
        internalError: 'database endpoint and secret must stay internal',
      }),
    ).toBeNull();
  });

  it.each([
    [
      'resolved without a valid bundle',
      MarineProviderCredentialResolveOutcome.RESOLVED,
      true,
      null,
    ],
    ['not found with a bundle', MarineProviderCredentialResolveOutcome.NOT_FOUND, false, '{}'],
    [
      'unavailable with provenance',
      MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      false,
      null,
    ],
  ])('rejects contradictory %s reply fields', (_name, outcome, found, bundleJson) => {
    expect(
      parseMarineProviderCredentialResolveResult({
        outcome,
        found,
        bundleJson,
        sourceTenantId:
          outcome === MarineProviderCredentialResolveOutcome.UNAVAILABLE
            ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            : null,
        configVersion: outcome === MarineProviderCredentialResolveOutcome.UNAVAILABLE ? 1 : null,
      }),
    ).toBeNull();
  });

  it('signs tenant, exact key, actor, operation, and the complete atomic bundle', () => {
    const canonical = canonicalMarineProviderCredentialBody({
      operation: 'upsert',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      service: 'farm-service',
      key: 'marine.cdse.credentials',
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      bundleJson: '{"clientId":"id","clientSecret":"secret"}',
    });

    expect(canonical).toBe(
      [
        'upsert',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'farm-service',
        'marine.cdse.credentials',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '{"clientId":"id","clientSecret":"secret"}',
      ].join('\n'),
    );
  });
});
