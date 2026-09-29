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
