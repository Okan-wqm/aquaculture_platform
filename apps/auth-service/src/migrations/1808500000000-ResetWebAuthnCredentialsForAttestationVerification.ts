import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ResetWebAuthnCredentialsForAttestationVerification1808500000000
 * (SEC-CRITICAL-001 — 2026-08-23 security scan, finding №37)
 *
 * WHY: registration verification moved to `@simplewebauthn/server`, which
 * derives the COSE public key from the attestation object
 * (proof-of-possession). The previously stored credentials hold
 * client-supplied SPKI keys with no attestation evidence — they are
 * unverifiable under the new verifier and, by construction, untrusted:
 * any one of them could have been planted with nothing but a stolen
 * access token.
 *
 * All existing rows are therefore deleted; users re-enroll through the
 * step-up-gated registration flow (password re-authentication required).
 * This is single-step, blue-green safe (no schema change), and idempotent.
 */
export class ResetWebAuthnCredentialsForAttestationVerification1808500000000
  implements MigrationInterface
{
  name = 'ResetWebAuthnCredentialsForAttestationVerification1808500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "auth"."webauthn_credentials"`);
  }

  public async down(): Promise<void> {
    // Irreversible by design: deleted rows were untrusted SPKI keys with no
    // attestation evidence. Users re-enroll; there is nothing to restore.
  }
}
