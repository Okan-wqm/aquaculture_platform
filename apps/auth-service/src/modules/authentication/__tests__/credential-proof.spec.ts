import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { ForbiddenException } from '@nestjs/common';

import { CredentialProof } from '../services/credential-proof';

/**
 * ORPHAN-HIGH-811 — the proof is the only mint authority, so its
 * constructors are the whole trust boundary: every origin records where the
 * version came from, and nothing that is not a positive integer version can
 * become a proof.
 */
describe('CredentialProof', () => {
  const userId = '0f3d8a52-5b6f-4f5e-9a39-3c2b8b5f7a10';

  it.each([
    [
      'authenticated-principal',
      CredentialProof.ofAuthenticatedPrincipal({ id: userId, credentialVersion: 3 }),
    ],
    ['locked-principal', CredentialProof.ofLockedPrincipal({ id: userId, credentialVersion: 3 })],
    ['credential-write', CredentialProof.ofCredentialWrite({ id: userId, credentialVersion: 3 })],
    ['signed-challenge', CredentialProof.ofSignedChallenge(userId, 3)],
  ])('records the %s origin with the observed version', (origin, proof) => {
    expect(proof.userId).toBe(userId);
    expect(proof.credentialVersion).toBe(3);
    expect(proof.provenance).toBe(origin);
  });

  it.each([
    ['missing (partial select / pre-claim challenge)', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a numeric string from a forged claim', '3'],
    ['beyond safe-integer range', Number.MAX_SAFE_INTEGER + 1],
  ])('refuses a %s version — no unfenced mint can start', (_label, version) => {
    expect(() => CredentialProof.ofSignedChallenge(userId, version)).toThrow(ForbiddenException);
    expect(() => CredentialProof.ofSignedChallenge(userId, version)).toThrow(
      'Cannot issue a token for an unfenced principal',
    );
  });

  it('refuses an entity that carries no version, whatever its type claims', () => {
    // A `User` loaded with a partial select has `credentialVersion` undefined
    // at runtime even though the entity type declares it non-optional.
    const partial = JSON.parse(JSON.stringify({ id: userId })) as {
      id: string;
      credentialVersion: number;
    };
    expect(() => CredentialProof.ofAuthenticatedPrincipal(partial)).toThrow(
      'Cannot issue a token for an unfenced principal',
    );
  });
});

/**
 * ORPHAN-HIGH-811, detectable tier: where a proof may be minted.
 *
 * The factories are public — a nominal type cannot stop a caller from
 * wrapping a row it reloaded at mint time, which is exactly the "re-anchor"
 * the finding warns erases the original credential proof. So each origin is
 * pinned to the files whose flow gives it meaning; a new call site elsewhere
 * fails here and becomes a reviewed decision rather than a silent weakening.
 */
describe('CredentialProof call sites', () => {
  const SRC_ROOT = join(__dirname, '..', '..', '..');
  const ALLOWED: Record<string, readonly string[]> = {
    // The row read before the factor (password, passkey, step-up TOTP).
    ofAuthenticatedPrincipal: [
      'modules/authentication/services/authentication.service.ts',
      'modules/authentication/services/mfa.service.ts',
      'modules/authentication/services/webauthn.service.ts',
    ],
    // The row locked FOR UPDATE inside the refresh-rotation transaction.
    ofLockedPrincipal: ['modules/authentication/services/authentication.service.ts'],
    // The RETURNING of a credential write — only the store issues those.
    ofCredentialWrite: ['modules/authentication/services/user-account.store.ts'],
    // The version the password step signed into the MFA challenge.
    ofSignedChallenge: ['modules/authentication/services/mfa.service.ts'],
  };

  function productionSources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return entry === '__tests__' ? [] : productionSources(path);
      }
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }

  const callSites = productionSources(SRC_ROOT).flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(/CredentialProof\.(of\w+)\(/g)].map((match) => ({
      factory: match[1] ?? '',
      file: relative(SRC_ROOT, path),
    })),
  );

  it('finds the call sites it guards (a moved tree must not pass vacuously)', () => {
    expect(new Set(callSites.map(({ factory }) => factory))).toEqual(new Set(Object.keys(ALLOWED)));
  });

  it('mints each origin only where its flow gives it meaning', () => {
    const offenders = callSites
      .filter(({ factory, file }) => !(ALLOWED[factory] ?? []).includes(file))
      .map(({ factory, file }) => `${file}: CredentialProof.${factory}`);
    expect(offenders).toEqual([]);
  });
});
