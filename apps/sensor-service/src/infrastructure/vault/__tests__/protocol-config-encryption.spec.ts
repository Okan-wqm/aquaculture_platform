/**
 * At-rest protocol-credential encryption (SENSOR-MEDIUM-080).
 *
 * Pins that secret-named fields are encrypted with AES-256-GCM while non-secret
 * fields (host, port, topic — the topic index / MQTT hot path) stay plaintext,
 * and that the transformer refuses to persist plaintext secrets with no cipher.
 */
import {
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedValue,
  resolveEncryptionKey,
  KEY_LENGTH,
} from '../credential-crypto';
import {
  hasSecretField,
  mapProtocolSecretFields,
} from '../protocol-secret-fields';
import {
  SecretCipher,
  decryptProtocolConfig,
  encryptProtocolConfig,
} from '../protocol-config.transformer';

const KEY = Buffer.alloc(KEY_LENGTH, 7);

const cipher: SecretCipher = {
  encrypt: (p) => encryptSecretValue(p, KEY),
  decrypt: (v) => decryptSecretValue(v, KEY),
  isEncrypted: (v) => isEncryptedValue(v),
};

describe('credential-crypto (AES-256-GCM)', () => {
  it('round-trips encrypt → decrypt', () => {
    const enc = encryptSecretValue('s3cr3t-pass', KEY);
    expect(enc.startsWith('enc:')).toBe(true);
    expect(enc).not.toContain('s3cr3t-pass');
    expect(decryptSecretValue(enc, KEY)).toBe('s3cr3t-pass');
  });

  it('uses a fresh IV per call (ciphertexts differ for the same plaintext)', () => {
    expect(encryptSecretValue('x', KEY)).not.toBe(encryptSecretValue('x', KEY));
  });

  it('passes plaintext through decrypt (backward compat for pre-encryption rows)', () => {
    expect(decryptSecretValue('legacy-plaintext', KEY)).toBe('legacy-plaintext');
  });

  it('resolves hex, ascii, null, and rejects wrong length', () => {
    expect(resolveEncryptionKey('a'.repeat(64))).toHaveLength(32); // 64 hex → 32 bytes
    expect(resolveEncryptionKey('k'.repeat(32))).toHaveLength(32); // 32 ascii
    expect(resolveEncryptionKey(undefined)).toBeNull();
    expect(resolveEncryptionKey('')).toBeNull();
    expect(() => resolveEncryptionKey('too-short')).toThrow();
  });
});

describe('mapProtocolSecretFields', () => {
  it('transforms only secret-named string fields, recursing into nested objects', () => {
    const out = mapProtocolSecretFields(
      {
        host: '10.0.0.5',
        port: 502,
        topic: 'farm/1/temp',
        password: 'pw',
        oauth2: { clientId: 'cid', clientSecret: 'cs' },
        tags: ['a', 'b'],
        nothing: null,
      },
      (v) => `X(${v})`,
    );

    expect(out).toEqual({
      host: '10.0.0.5',
      port: 502,
      topic: 'farm/1/temp',
      password: 'X(pw)',
      oauth2: { clientId: 'cid', clientSecret: 'X(cs)' },
      tags: ['a', 'b'],
      nothing: null,
    });
  });

  it('hasSecretField detects nested secrets and their absence', () => {
    expect(hasSecretField({ host: 'h', port: 1 })).toBe(false);
    expect(hasSecretField({ host: 'h', apiKey: 'k' })).toBe(true);
    expect(hasSecretField({ auth: { token: 't' } })).toBe(true);
  });
});

describe('encryptProtocolConfig / decryptProtocolConfig (field level)', () => {
  const raw = {
    host: '10.0.0.5',
    port: 1883,
    topic: 'farm/1/temp',
    username: 'device',
    password: 'super-secret',
    oauth2: { clientId: 'cid', clientSecret: 'oauth-secret' },
  };

  it('encrypts secret fields at rest and leaves non-secret fields (incl. topic) plaintext', () => {
    const atRest = encryptProtocolConfig(raw, cipher) as Record<string, unknown>;

    expect(atRest.host).toBe('10.0.0.5');
    expect(atRest.port).toBe(1883);
    expect(atRest.topic).toBe('farm/1/temp'); // topic index / MQTT hot path preserved
    expect(atRest.username).toBe('device'); // not secret-named
    expect(String(atRest.password).startsWith('enc:')).toBe(true);
    expect(String(atRest.password)).not.toContain('super-secret');
    const oauth = atRest.oauth2 as Record<string, unknown>;
    expect(String(oauth.clientSecret).startsWith('enc:')).toBe(true);
    expect(oauth.clientId).toBe('cid');
  });

  it('round-trips back to the exact plaintext on read', () => {
    const atRest = encryptProtocolConfig(raw, cipher);
    expect(decryptProtocolConfig(atRest, cipher)).toEqual(raw);
  });

  it('is idempotent — encrypting an already-encrypted config does not double-encrypt', () => {
    const once = encryptProtocolConfig(raw, cipher) as Record<string, unknown>;
    const twice = encryptProtocolConfig(once, cipher) as Record<string, unknown>;
    expect(twice.password).toBe(once.password);
    expect(decryptProtocolConfig(twice, cipher)).toEqual(raw);
  });

  it('refuses to store plaintext secrets when no cipher is wired', () => {
    expect(() => encryptProtocolConfig(raw, null)).toThrow(/not initialized/i);
  });

  it('stores a secret-free config verbatim even with no cipher', () => {
    const safe = { host: 'h', port: 1, topic: 't' };
    expect(encryptProtocolConfig(safe, null)).toEqual(safe);
  });

  it('passes through null/undefined configs', () => {
    expect(encryptProtocolConfig(null, cipher)).toBeNull();
    expect(decryptProtocolConfig(undefined, cipher)).toBeUndefined();
  });

  it('decrypts a legacy plaintext-secret config unchanged (backward compat)', () => {
    // A row written before encryption: secret is plaintext, no enc: prefix.
    expect(decryptProtocolConfig(raw, cipher)).toEqual(raw);
  });
});
