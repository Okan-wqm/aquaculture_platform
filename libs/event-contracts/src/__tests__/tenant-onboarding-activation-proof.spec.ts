import {
  decodeTenantOnboardingActivationProof,
  TENANT_ONBOARDING_ACTIVATION_PROOF_SCHEMA_VERSION,
} from '../tenant-commands';

describe('TenantOnboardingActivationProofV1', () => {
  const proof = Object.freeze({
    schemaVersion: TENANT_ONBOARDING_ACTIVATION_PROOF_SCHEMA_VERSION,
    generation: 3,
    sealToken: '44444444-4444-4444-8444-444444444444',
    evidenceRoot: 'a'.repeat(64),
    publicationDigest: 'b'.repeat(64),
  });

  it('decodes and freezes the exact versioned proof', () => {
    const decoded = decodeTenantOnboardingActivationProof(proof);

    expect(decoded).toEqual(proof);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it.each([
    [{ ...proof, schemaVersion: 'tenant-onboarding-activation-proof.v2' }, 'schema version'],
    [{ ...proof, generation: 0 }, 'positive integer'],
    [{ ...proof, generation: 1.5 }, 'positive integer'],
    [{ ...proof, sealToken: 'not-a-uuid' }, 'UUID'],
    [{ ...proof, evidenceRoot: 'A'.repeat(64) }, 'SHA-256'],
    [{ ...proof, publicationDigest: 'short' }, 'SHA-256'],
    [{ ...proof, extra: true }, 'unknown or missing fields'],
  ])('rejects malformed or authority-expanding proof %j', (candidate, message) => {
    expect(() => decodeTenantOnboardingActivationProof(candidate)).toThrow(message);
  });

  it('rejects a proof with a missing field', () => {
    const { publicationDigest: _publicationDigest, ...incomplete } = proof;

    expect(() => decodeTenantOnboardingActivationProof(incomplete)).toThrow(
      'unknown or missing fields',
    );
  });
});
