import * as crypto from 'crypto';

import { ConfigService } from '@nestjs/config';

import { JwksController } from '../jwks.controller';

/**
 * JWKS lifecycle + kid SSoT — SEC-HIGH-003 / SEC-HIGH-004 regression guards.
 *
 * WHY: tokens issued without a `kid` header could not be matched to a JWKS
 * entry during a rotation overlap (try-all fallback weakened rotation), and a
 * permanently-cached JWKS served the stale key set for the process lifetime
 * after a roll. These tests pin (a) the published kid equals the signer's
 * SSoT and (b) the cache expires on its TTL.
 */
describe('JwksController (SEC-HIGH-003 / SEC-HIGH-004)', () => {
  const keypair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Real ConfigService over an internal-config object — its get(key, default)
  // reads the same object reference live (cache defaults off), so a test can
  // mutate the map to simulate an operator key rotation. No cast.
  const configWith = (overrides: Record<string, unknown>): ConfigService =>
    new ConfigService(overrides);

  it('publishes the current key under the active signing kid (SSoT JWT_KEY_ID)', () => {
    const controller = new JwksController(
      configWith({ JWT_PUBLIC_KEY: keypair.publicKey, JWT_KEY_ID: 'key-2026-06' }),
    );

    const jwks = controller.getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe('key-2026-06');
    expect(jwks.keys[0]?.use).toBe('sig');
    expect(jwks.keys[0]?.alg).toBe('RS256');
  });

  it('defaults the kid to key-1 when JWT_KEY_ID is unset (matches signer default)', () => {
    const controller = new JwksController(configWith({ JWT_PUBLIC_KEY: keypair.publicKey }));
    expect(controller.getJwks().keys[0]?.kid).toBe('key-1');
  });

  it('serves both current and previous keys for rotation overlap', () => {
    const previous = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const controller = new JwksController(
      configWith({
        JWT_PUBLIC_KEY: keypair.publicKey,
        JWT_KEY_ID: 'key-new',
        JWT_PREVIOUS_PUBLIC_KEY: previous.publicKey,
        JWT_PREVIOUS_KEY_ID: 'key-old',
      }),
    );
    const kids = controller.getJwks().keys.map((k) => k.kid);
    expect(kids).toEqual(['key-new', 'key-old']);
  });

  it('expires the cache after the TTL so a rotated key set propagates', () => {
    jest.useFakeTimers();
    try {
      // First read caches under key-1.
      const overrides: Record<string, unknown> = {
        JWT_PUBLIC_KEY: keypair.publicKey,
        JWT_KEY_ID: 'key-1',
        JWKS_CACHE_TTL_MS: 5 * 60_000,
      };
      // Live-reading real ConfigService: mutating `overrides` below rotates
      // the reported kid, exactly as an operator env change would.
      const config = new ConfigService(overrides);
      const controller = new JwksController(config);

      expect(controller.getJwks().keys[0]?.kid).toBe('key-1');

      // Operator rotates: config now reports key-2. Within the TTL the cache
      // must still serve key-1 (stable), then refresh to key-2 after it.
      overrides['JWT_KEY_ID'] = 'key-2';
      jest.advanceTimersByTime(4 * 60_000);
      expect(controller.getJwks().keys[0]?.kid).toBe('key-1');

      jest.advanceTimersByTime(2 * 60_000); // now past the 5m TTL
      expect(controller.getJwks().keys[0]?.kid).toBe('key-2');
    } finally {
      jest.useRealTimers();
    }
  });
});
