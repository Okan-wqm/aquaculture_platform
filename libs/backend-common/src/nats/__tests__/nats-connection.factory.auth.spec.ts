/**
 * ADR-015: under mTLS the NATS identity is the certificate CN and nothing else.
 * `NATS_AUTH_USER` / `NATS_AUTH_PASS` / `NATS_AUTH_TOKEN` may still be populated in the
 * environment (a leftover from a dev or CI profile); they must never reach the CONNECT frame
 * options, and the mode must stay `mtls-cert`. The invariant lives in one place only, the
 * branch structure of `buildNatsConnectionOptions`, and no other spec feeds a populated
 * environment under mTLS (inbox.spec deletes the three variables in its mTLS case).
 *
 * DET-crossfile2 (Z33). This spec passes on the factory as it is: it is the pin that goes red
 * on a factory that sets a credential outside its auth-mode branch.
 *
 * The credential decision is made before any key material is read, so the mTLS cases use the
 * explicit local-dev TLS escape hatch (no CA, nothing to read) instead of a certificate fixture.
 */
import { buildNatsConnectionOptions } from '../nats-connection.factory';

const MTLS_ENV = {
  NATS_URL: 'tls://nats:4222',
  NATS_TLS_ENABLED: 'true',
  NATS_TLS_INSECURE_ALLOW: 'true',
  NATS_TLS_CERT: '/run/nats/client-cert.pem',
  NATS_TLS_KEY: '/run/nats/client-key.pem',
} as const;
const PLAIN_ENV = { NATS_URL: 'nats://localhost:4222', NATS_TLS_ENABLED: 'false' } as const;
const USER_PASS = { NATS_AUTH_USER: 'legacy-user', NATS_AUTH_PASS: 'legacy-pass' } as const;
const TOKEN = { NATS_AUTH_TOKEN: 'legacy-token' } as const;

const ENV_KEYS = [
  ...Object.keys(MTLS_ENV),
  ...Object.keys(USER_PASS),
  ...Object.keys(TOKEN),
  'NATS_TLS_CA',
  'NODE_ENV',
];

describe('buildNatsConnectionOptions — CONNECT identity (ADR-015)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it.each([
    ['user and password', USER_PASS],
    ['token', TOKEN],
    ['user, password and token', { ...USER_PASS, ...TOKEN }],
  ])('under mTLS a populated %s never reaches the CONNECT options', (_name, credentials) => {
    Object.assign(process.env, MTLS_ENV, credentials);

    const options = buildNatsConnectionOptions('gateway-api');

    expect(options.authMode).toBe('mtls-cert');
    for (const field of ['user', 'pass', 'token']) expect(options).not.toHaveProperty(field);
  });

  // Near-miss: the guard is the mode, not "credentials are never set". Without a client
  // certificate the same environment keeps selecting the dev / CI fallbacks.
  it('without a client certificate the same credentials still select their own mode', () => {
    Object.assign(process.env, PLAIN_ENV, USER_PASS);
    expect(buildNatsConnectionOptions('gateway-api')).toMatchObject({
      authMode: 'user-pass',
      user: 'legacy-user',
      pass: 'legacy-pass',
    });

    Object.assign(process.env, TOKEN);
    const tokenOptions = buildNatsConnectionOptions('gateway-api');
    expect(tokenOptions).toMatchObject({ authMode: 'token', token: 'legacy-token' });
    expect(tokenOptions).not.toHaveProperty('user');
  });
});
