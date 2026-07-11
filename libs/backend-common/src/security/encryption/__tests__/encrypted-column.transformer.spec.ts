/**
 * createEncryptedColumnTransformer key-resolution gate (SEC-MEDIUM-003).
 *
 * The insecure dev-only fallback key ('dddd…') must be reachable ONLY from an
 * explicit development/test environment. In production, staging, an unset
 * NODE_ENV, or any typo'd value, an absent key must fail closed — otherwise
 * real Maskinporten secrets / PII get encrypted with a public key.
 *
 * resolveKey is module-private and caches per env-var NAME, so each test uses a
 * UNIQUE env-var name to avoid cross-test cache hits.
 */
import { createEncryptedColumnTransformer } from '../encrypted-column.transformer';

describe('createEncryptedColumnTransformer key gate (SEC-MEDIUM-003)', () => {
  const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
  let n = 0;
  const uniqueKeyName = (): string => `TEST_ENC_KEY_${n++}`;

  // Env-var names are dynamic (per-test unique), so a computed `delete` is
  // required — Reflect.deleteProperty keeps that off @typescript-eslint/no-dynamic-delete.
  const clearKey = (name: string): void => {
    Reflect.deleteProperty(process.env, name);
  };

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
    }
  });

  it("uses the dev fallback (round-trips) when NODE_ENV='test' and no key is set", () => {
    process.env['NODE_ENV'] = 'test';
    const name = uniqueKeyName();
    clearKey(name);
    const t = createEncryptedColumnTransformer(name);
    const enc = t.to('super-secret') as string;
    expect(typeof enc).toBe('string');
    expect(enc).not.toBe('super-secret');
    expect(t.from(enc)).toBe('super-secret');
  });

  it("uses the dev fallback when NODE_ENV='development'", () => {
    process.env['NODE_ENV'] = 'development';
    const name = uniqueKeyName();
    clearKey(name);
    const t = createEncryptedColumnTransformer(name);
    expect(() => {
      t.to('x');
    }).not.toThrow();
  });

  it('FAILS CLOSED in production when no key is set', () => {
    process.env['NODE_ENV'] = 'production';
    const name = uniqueKeyName();
    clearKey(name);
    const t = createEncryptedColumnTransformer(name);
    expect(() => {
      t.to('x');
    }).toThrow(/required unless NODE_ENV/i);
  });

  it("FAILS CLOSED in staging (not merely 'not production')", () => {
    process.env['NODE_ENV'] = 'staging';
    const name = uniqueKeyName();
    clearKey(name);
    const t = createEncryptedColumnTransformer(name);
    expect(() => {
      t.to('x');
    }).toThrow(/required unless NODE_ENV/i);
  });

  it('FAILS CLOSED when NODE_ENV is unset', () => {
    delete process.env['NODE_ENV'];
    const name = uniqueKeyName();
    clearKey(name);
    const t = createEncryptedColumnTransformer(name);
    expect(() => {
      t.to('x');
    }).toThrow(/unset/i);
  });

  it('uses an explicit key regardless of NODE_ENV (production, key present)', () => {
    process.env['NODE_ENV'] = 'production';
    const name = uniqueKeyName();
    process.env[name] = 'a'.repeat(64); // 64 hex chars = 32-byte key
    const t = createEncryptedColumnTransformer(name);
    const enc = t.to('secret') as string;
    expect(t.from(enc)).toBe('secret');
    clearKey(name);
  });
});
