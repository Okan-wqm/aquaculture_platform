import {
  redactProtocolSecrets,
  isSecretConfigKey,
  REDACTED_PLACEHOLDER,
} from '../redact-protocol-secrets';

describe('redactProtocolSecrets (SENSOR-HIGH-081)', () => {
  it('masks every credential-bearing field', () => {
    const config = {
      host: '10.0.0.5',
      port: 502,
      username: 'operator',
      password: 'hunter2',
      bearerToken: 'eyJhbGciOi...',
      apiKey: 'sk-live-abc',
      oauth2ClientSecret: 'shhh',
      clientPrivateKey: '-----BEGIN KEY-----',
      psk: 'preshared',
    };

    const result = redactProtocolSecrets(config);

    expect(result.host).toBe('10.0.0.5');
    expect(result.port).toBe(502);
    expect(result.username).toBe('operator');
    expect(result.password).toBe(REDACTED_PLACEHOLDER);
    expect(result.bearerToken).toBe(REDACTED_PLACEHOLDER);
    expect(result.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(result.oauth2ClientSecret).toBe(REDACTED_PLACEHOLDER);
    expect(result.clientPrivateKey).toBe(REDACTED_PLACEHOLDER);
    expect(result.psk).toBe(REDACTED_PLACEHOLDER);
  });

  it('preserves a null/undefined secret rather than fabricating one', () => {
    const result = redactProtocolSecrets({ password: null, bearerToken: undefined, host: 'x' });
    expect(result.password).toBeNull();
    expect(result.bearerToken).toBeUndefined();
    expect(result.host).toBe('x');
  });

  it('recurses into nested credential blocks', () => {
    const result = redactProtocolSecrets({
      oauth2: { clientId: 'public-id', clientSecret: 'nested-secret' },
    });
    const oauth2 = result.oauth2 as Record<string, unknown>;
    expect(oauth2.clientId).toBe('public-id');
    expect(oauth2.clientSecret).toBe(REDACTED_PLACEHOLDER);
  });

  it('returns an empty object for null/undefined config', () => {
    expect(redactProtocolSecrets(null)).toEqual({});
    expect(redactProtocolSecrets(undefined)).toEqual({});
  });

  it('does not mutate the input config', () => {
    const config = { password: 'secret', host: 'x' };
    redactProtocolSecrets(config);
    expect(config.password).toBe('secret');
  });

  it('classifies secret vs non-secret field names', () => {
    expect(isSecretConfigKey('password')).toBe(true);
    expect(isSecretConfigKey('clientSecret')).toBe(true);
    expect(isSecretConfigKey('bearerToken')).toBe(true);
    expect(isSecretConfigKey('host')).toBe(false);
    expect(isSecretConfigKey('port')).toBe(false);
    expect(isSecretConfigKey('keepAlive')).toBe(false);
  });
});
