import { ForbiddenException } from '@nestjs/common';

/**
 * Where the credential version inside a {@link CredentialProof} was observed.
 *
 * - `authenticated-principal`: the user row as it was read before the factor
 *   (password, passkey, step-up TOTP) was verified against it. Reading it
 *   AFTER the factor would let a credential change that committed during the
 *   verification (a password reset that also revoked the passkey) become the
 *   anchor the mint is fenced on.
 * - `credential-write`: the `RETURNING` of the committed UPDATE that changed a
 *   credential column (password reset, invitation acceptance, password
 *   change, legacy hash upgrade). The trigger has already advanced the
 *   version, so this is the only honest anchor for a mint that follows it.
 * - `locked-principal`: the row read under `FOR UPDATE` inside the very
 *   transaction that mints (refresh rotation).
 * - `signed-challenge`: the version the password step signed into the MFA
 *   challenge token, so the second factor completes against the credential
 *   the first factor proved.
 */
export type CredentialProofOrigin =
  | 'authenticated-principal'
  | 'credential-write'
  | 'locked-principal'
  | 'signed-challenge';

interface VersionedPrincipal {
  readonly id: string;
  readonly credentialVersion: number;
}

/**
 * The only authority `TokenService.generateTokens` accepts to mint a token.
 *
 * WHY (ORPHAN-HIGH-811): the issuance fence used to read `credentialVersion`
 * off whatever `User` entity the caller passed in. Password reset and
 * invitation acceptance change the password, the database trigger advances
 * the version, and the caller still held the entity it loaded before the
 * write — so every legitimate reset/invitation completion was refused with
 * "User credentials changed during token issuance" AFTER the one-time token
 * had been consumed. Any mutable entity can be stale, so the fence must not
 * take one.
 *
 * WHAT: an immutable `{ userId, credentialVersion }` pair that can only be
 * produced at one of the named origins above. The private member makes the
 * type nominal — an object literal or a `User` can never satisfy it — so a
 * caller cannot hand the fence a version it did not observe at a point that
 * proves the credential.
 */
export class CredentialProof {
  private readonly origin: CredentialProofOrigin;

  private constructor(
    readonly userId: string,
    readonly credentialVersion: number,
    origin: CredentialProofOrigin,
  ) {
    this.origin = origin;
  }

  /** The origin, for the refusal log line and audit correlation. */
  get provenance(): CredentialProofOrigin {
    return this.origin;
  }

  static ofAuthenticatedPrincipal(principal: VersionedPrincipal): CredentialProof {
    return CredentialProof.create(
      principal.id,
      principal.credentialVersion,
      'authenticated-principal',
    );
  }

  static ofLockedPrincipal(principal: VersionedPrincipal): CredentialProof {
    return CredentialProof.create(principal.id, principal.credentialVersion, 'locked-principal');
  }

  static ofCredentialWrite(row: VersionedPrincipal): CredentialProof {
    return CredentialProof.create(row.id, row.credentialVersion, 'credential-write');
  }

  /**
   * The challenge claim is untrusted-shaped data until checked here: a token
   * minted before the claim existed, or one whose claim is not a positive
   * integer, is refused rather than completed without a fence.
   */
  static ofSignedChallenge(userId: string, credentialVersion: unknown): CredentialProof {
    return CredentialProof.create(userId, credentialVersion, 'signed-challenge');
  }

  /**
   * Whether a value can anchor the fence: a positive safe integer, the only
   * shape the trigger ever writes. Signed-token consumers use it to tell a
   * token of an older shape ("sign in again") from a server fault before they
   * build a proof.
   */
  static isCredentialVersion(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
  }

  /**
   * A principal loaded with a partial select carries no version; minting from
   * it would disable the fence silently, so it is refused (ORPHAN-CRITICAL-808).
   */
  private static create(
    userId: string,
    credentialVersion: unknown,
    origin: CredentialProofOrigin,
  ): CredentialProof {
    if (!CredentialProof.isCredentialVersion(credentialVersion)) {
      throw new ForbiddenException('Cannot issue a token for an unfenced principal');
    }
    return new CredentialProof(userId, credentialVersion, origin);
  }
}
