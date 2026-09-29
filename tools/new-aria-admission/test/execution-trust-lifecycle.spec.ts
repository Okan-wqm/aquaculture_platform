import { generateKeyPairSync } from 'node:crypto';

import {
  abortExecutionSigningReservation,
  commitExecutionSigningReservation,
  reserveExecutionSigningCapability,
  verifyExecutionSigningCapability,
} from '../src/kernel/execution-signing-capability';
import { loadExecutionSigningCapability } from '../src/runtime/execution-signer';

import { trustRootBytes } from './attestation-fixture';
import {
  attackerExecutionSigner,
  authorizedExecutionAuthority,
  evidenceRootUsingExecutionKey,
  executionPrivateKeyBytes,
  executionTrustRootBytes,
  trustedExecutionSigner,
} from './execution-receipt-fixture';
import { digest, trustedOperatorSigner } from './operator-authority-fixture';

describe('execution signing key lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('proves private-key possession before a repository session can open', () => {
    const authority = authorizedExecutionAuthority();
    const root = executionTrustRootBytes();
    const capability = loadExecutionSigningCapability({
      authority,
      trust_root_bytes: root,
      evidence_trust_root_bytes: trustRootBytes(),
      private_key_pkcs8_der: executionPrivateKeyBytes(),
    });

    expect(() => verifyExecutionSigningCapability(capability, authority, root)).not.toThrow();
    expect(() => verifyExecutionSigningCapability({ ...capability }, authority, root)).toThrow(
      /issued|runtime|capability/i,
    );
    expect(() =>
      verifyExecutionSigningCapability(
        { ...capability, authority_envelope_sha256: '0'.repeat(64) },
        authority,
        root,
      ),
    ).toThrow(/proof|authority|capability/i);
  });

  it('reserves transactionally and consumes one authority capability exactly once', () => {
    const root = executionTrustRootBytes(
      trustedExecutionSigner,
      'ATTEST_EXECUTION',
      {},
      { execution_session_id: 'execution-session-one-shot' },
    );
    const pinnedAuthority = authorizedExecutionAuthority({
      execution_session_id: 'execution-session-one-shot',
      execution_trust_root_sha256: digest(root),
    });
    const capability = loadExecutionSigningCapability({
      authority: pinnedAuthority,
      trust_root_bytes: root,
      evidence_trust_root_bytes: trustRootBytes(),
      private_key_pkcs8_der: executionPrivateKeyBytes(),
    });

    const abandoned = reserveExecutionSigningCapability(capability, pinnedAuthority, root);
    expect(() => reserveExecutionSigningCapability(capability, pinnedAuthority, root)).toThrow(
      /reserved|consumed|lifecycle/i,
    );
    abortExecutionSigningReservation(abandoned);
    const committed = reserveExecutionSigningCapability(capability, pinnedAuthority, root);
    commitExecutionSigningReservation(committed);
    expect(() => reserveExecutionSigningCapability(capability, pinnedAuthority, root)).toThrow(
      /reserved|consumed|lifecycle/i,
    );
  });

  it('rejects duplicate issuance for the same branded authority object', () => {
    const authority = authorizedExecutionAuthority();
    const input = {
      authority,
      trust_root_bytes: executionTrustRootBytes(),
      evidence_trust_root_bytes: trustRootBytes(),
      private_key_pkcs8_der: executionPrivateKeyBytes(),
    };

    loadExecutionSigningCapability(input);
    expect(() => loadExecutionSigningCapability(input)).toThrow(/already issued|authority/i);
  });

  it('rejects mismatched private material and an unpinned execution root', () => {
    const authority = authorizedExecutionAuthority();
    expect(() =>
      loadExecutionSigningCapability({
        authority,
        trust_root_bytes: executionTrustRootBytes(),
        evidence_trust_root_bytes: trustRootBytes(),
        private_key_pkcs8_der: executionPrivateKeyBytes(attackerExecutionSigner),
      }),
    ).toThrow(/private|public|key/i);
    expect(() =>
      loadExecutionSigningCapability({
        authority,
        trust_root_bytes: executionTrustRootBytes(attackerExecutionSigner),
        evidence_trust_root_bytes: trustRootBytes(),
        private_key_pkcs8_der: executionPrivateKeyBytes(attackerExecutionSigner),
      }),
    ).toThrow(/trust root digest/i);
  });

  it.each([
    ['revoked key', { status: 'REVOKED' }],
    ['wrong session', { execution_session_id: 'execution-session-other' }],
    ['future key', { valid_from: '2026-09-02T12:31:00.000Z' }],
    ['shorter key window', { valid_until: '2026-09-02T13:59:59.999Z' }],
    ['rolled-back epoch', { revocation_epoch: 0 }],
  ])('rejects an execution trust root with %s', (_name, keyExtra) => {
    const root = executionTrustRootBytes(trustedExecutionSigner, 'ATTEST_EXECUTION', {}, keyExtra);
    const authority = authorizedExecutionAuthority({ execution_trust_root_sha256: digest(root) });
    expect(() =>
      loadExecutionSigningCapability({
        authority,
        trust_root_bytes: root,
        evidence_trust_root_bytes: trustRootBytes(),
        private_key_pkcs8_der: executionPrivateKeyBytes(),
      }),
    ).toThrow(/status|session|window|valid|epoch|schema/i);
  });

  it('rejects execution keys reused by operator or evidence identities', () => {
    const operatorCollision = {
      principalId: 'execution-attestor-1',
      publicKey: trustedOperatorSigner.publicKey,
      privateKey: trustedOperatorSigner.privateKey,
    };
    const executionRoot = executionTrustRootBytes(operatorCollision);
    const authority = authorizedExecutionAuthority({
      execution_trust_root_sha256: digest(executionRoot),
    });
    expect(() =>
      loadExecutionSigningCapability({
        authority,
        trust_root_bytes: executionRoot,
        evidence_trust_root_bytes: trustRootBytes(),
        private_key_pkcs8_der: executionPrivateKeyBytes(operatorCollision),
      }),
    ).toThrow(/separate|operator/i);

    const evidenceRoot = evidenceRootUsingExecutionKey();
    const evidenceAuthority = authorizedExecutionAuthority({
      evidence_trust_root_sha256: digest(evidenceRoot),
    });
    expect(() =>
      loadExecutionSigningCapability({
        authority: evidenceAuthority,
        trust_root_bytes: executionTrustRootBytes(),
        evidence_trust_root_bytes: evidenceRoot,
        private_key_pkcs8_der: executionPrivateKeyBytes(),
      }),
    ).toThrow(/separate|evidence/i);
  });

  it('rejects non-Ed25519 key material and an open trust-root document', () => {
    const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsa = { principalId: 'execution-rsa-1', ...rsaKeys };
    const rsaRoot = executionTrustRootBytes(rsa);
    const rsaAuthority = authorizedExecutionAuthority({
      execution_trust_root_sha256: digest(rsaRoot),
    });
    expect(() =>
      loadExecutionSigningCapability({
        authority: rsaAuthority,
        trust_root_bytes: rsaRoot,
        evidence_trust_root_bytes: trustRootBytes(),
        private_key_pkcs8_der: executionPrivateKeyBytes(rsa),
      }),
    ).toThrow(/Ed25519/i);

    const openRoot = executionTrustRootBytes(trustedExecutionSigner, 'ATTEST_EXECUTION', {
      extra: true,
    });
    const openAuthority = authorizedExecutionAuthority({
      execution_trust_root_sha256: digest(openRoot),
    });
    expect(() =>
      loadExecutionSigningCapability({
        authority: openAuthority,
        trust_root_bytes: openRoot,
        evidence_trust_root_bytes: trustRootBytes(),
        private_key_pkcs8_der: executionPrivateKeyBytes(),
      }),
    ).toThrow(/schema/i);
  });
});
