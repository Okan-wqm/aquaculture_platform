import { generateKeyPairSync } from 'node:crypto';

import { ProgressAuthorityDocument } from '../src/domain/progress-contracts';
import {
  authorizeS01ProgressAuthority,
  assertAuthorizedS01ProgressAuthority,
  OperatorProgressAuthorityInput,
} from '../src/kernel/operator-progress-authority';

import {
  attackerOperatorSigner,
  digest,
  duplicatePrincipalSigner,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01FindingIds,
  s01ProgressAuthorityBytes,
  signerPublicKeyDigest,
  trustedOperatorSigner,
} from './operator-authority-fixture';

function input(
  overrides: Partial<OperatorProgressAuthorityInput> = {},
): OperatorProgressAuthorityInput {
  const trustRootBytes = operatorTrustRootBytes();
  return {
    envelope_bytes: operatorEnvelopeBytes(),
    trust_root_bytes: trustRootBytes,
    expected_trust_root_sha256: digest(trustRootBytes),
    ...overrides,
  };
}

function inputWithRoot(trustRootBytes: Uint8Array): OperatorProgressAuthorityInput {
  return input({
    trust_root_bytes: trustRootBytes,
    expected_trust_root_sha256: digest(trustRootBytes),
  });
}

function findingAt(index: number): string {
  const finding = s01FindingIds[index];
  if (finding === undefined) throw new Error(`S01 finding ${index} is missing`);
  return finding;
}

describe('operator progress authority', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('authorizes the exact signed S01 authority under the externally pinned trust root', () => {
    const authorityBytes = s01ProgressAuthorityBytes();
    const result = authorizeS01ProgressAuthority(
      input({ envelope_bytes: operatorEnvelopeBytes({ authorityBytes }) }),
    );

    expect(result.authority.sha256).toBe(digest(authorityBytes));
    expect(result.authority.document.finding_ids).toEqual(s01FindingIds);
    expect(result.signer_principal_id).toBe('operator-progress-1');
    expect(result.signer_key_sha256).toBe(signerPublicKeyDigest(trustedOperatorSigner));
    expect(result.observed_at).toBe('2026-09-02T12:00:00.000Z');
    expect(result.valid_until).toBe('2026-09-02T13:00:00.000Z');
  });

  it('brands a verified result as an in-process admission capability', () => {
    const authorized = authorizeS01ProgressAuthority(input());
    expect(() => assertAuthorizedS01ProgressAuthority(authorized)).not.toThrow();
  });

  it('rejects a structurally identical authority object not issued by this module', () => {
    const authorized = authorizeS01ProgressAuthority(input());
    expect(() => assertAuthorizedS01ProgressAuthority({ ...authorized })).toThrow(/not issued/);
  });

  it('rejects an attacker root and signature against the external trusted-root pin', () => {
    const attackerRoot = operatorTrustRootBytes({ signers: [attackerOperatorSigner] });
    expect(() =>
      authorizeS01ProgressAuthority(
        input({
          envelope_bytes: operatorEnvelopeBytes({ signer: attackerOperatorSigner }),
          trust_root_bytes: attackerRoot,
        }),
      ),
    ).toThrow(/trust root digest mismatch/);
  });

  it('rejects a caller-selected pin that does not identify the supplied root', () => {
    expect(() =>
      authorizeS01ProgressAuthority(input({ expected_trust_root_sha256: 'f'.repeat(64) })),
    ).toThrow(/trust root digest mismatch/);
  });

  it.each([
    ['open root', () => inputWithRoot(operatorTrustRootBytes({ rootExtra: { extra: true } }))],
    ['open trust key', () => inputWithRoot(operatorTrustRootBytes({ keyExtra: { extra: true } }))],
    [
      'open envelope',
      () => input({ envelope_bytes: operatorEnvelopeBytes({ envelopeExtra: { extra: true } }) }),
    ],
    [
      'open payload',
      () => input({ envelope_bytes: operatorEnvelopeBytes({ payloadExtra: { extra: true } }) }),
    ],
    [
      'open signature',
      () => input({ envelope_bytes: operatorEnvelopeBytes({ signatureExtra: { extra: true } }) }),
    ],
  ])('rejects a non-closed canonical document: %s', (_name, makeInput) => {
    expect(() => authorizeS01ProgressAuthority(makeInput())).toThrow(/schema/);
  });

  it('rejects duplicate signer principals', () => {
    const duplicateRoot = operatorTrustRootBytes({
      signers: [trustedOperatorSigner, duplicatePrincipalSigner],
    });
    expect(() => authorizeS01ProgressAuthority(inputWithRoot(duplicateRoot))).toThrow(/unique/);
  });

  it('rejects a duplicated public key under a second principal', () => {
    const duplicateKeyRoot = operatorTrustRootBytes({
      signers: [
        trustedOperatorSigner,
        { ...trustedOperatorSigner, principalId: 'operator-progress-2' },
      ],
    });
    expect(() => authorizeS01ProgressAuthority(inputWithRoot(duplicateKeyRoot))).toThrow(/unique/);
  });

  it('rejects an unordered operator principal roster', () => {
    const unorderedRoot = operatorTrustRootBytes({
      signers: [trustedOperatorSigner, attackerOperatorSigner],
    });
    expect(() => authorizeS01ProgressAuthority(inputWithRoot(unorderedRoot))).toThrow(/sorted/);
  });

  it('rejects a trust key without the progress authorization capability', () => {
    const wrongCapabilityRoot = operatorTrustRootBytes({ capability: 'REVIEW' });
    expect(() => authorizeS01ProgressAuthority(inputWithRoot(wrongCapabilityRoot))).toThrow(
      /capability/,
    );
  });

  it.each([
    ['wrong capability', operatorEnvelopeBytes({ capability: 'REVIEW' })],
    ['unknown principal', operatorEnvelopeBytes({ signer: attackerOperatorSigner })],
    ['duplicate signature', operatorEnvelopeBytes({ duplicateSignature: true })],
    [
      'invalid signature',
      operatorEnvelopeBytes({ signatureBase64: Buffer.alloc(64).toString('base64') }),
    ],
  ])('rejects %s', (_name, envelopeBytes) => {
    expect(() => authorizeS01ProgressAuthority(input({ envelope_bytes: envelopeBytes }))).toThrow();
  });

  it('rejects signer metadata that differs between the signed payload and envelope', () => {
    const envelopeBytes = operatorEnvelopeBytes({
      payloadExtra: { signer_principal_id: 'operator-progress-2' },
    });
    expect(() => authorizeS01ProgressAuthority(input({ envelope_bytes: envelopeBytes }))).toThrow(
      /signer/,
    );
  });

  it('rejects a non-Ed25519 trust key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaRoot = operatorTrustRootBytes({
      signers: [
        {
          principalId: 'operator-rsa-1',
          publicKey: rsa.publicKey,
          privateKey: rsa.privateKey,
        },
      ],
    });
    expect(() => authorizeS01ProgressAuthority(inputWithRoot(rsaRoot))).toThrow(/Ed25519/);
  });

  it.each([
    ['non-canonical observation', { observedAt: '2026-09-02T12:00:00Z' }],
    ['future observation', { observedAt: '2026-09-02T12:31:00.000Z' }],
    ['expired authorization', { validUntil: '2026-09-02T12:29:59.999Z' }],
    ['empty validity interval', { validUntil: '2026-09-02T12:00:00.000Z' }],
  ])('rejects %s', (_name, options) => {
    expect(() =>
      authorizeS01ProgressAuthority(input({ envelope_bytes: operatorEnvelopeBytes(options) })),
    ).toThrow(/timestamp|future|stale|interval/);
  });

  it('fails closed when the trusted runtime clock is unavailable', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Number.NaN);
    expect(() => authorizeS01ProgressAuthority(input())).toThrow(/trusted clock/);
  });

  it('rejects an authority payload whose signed bytes and digest disagree', () => {
    expect(() =>
      authorizeS01ProgressAuthority(
        input({
          envelope_bytes: operatorEnvelopeBytes({ authoritySha256: 'f'.repeat(64) }),
        }),
      ),
    ).toThrow(/authority digest mismatch/);
  });

  const invalidScopes: readonly [string, Partial<ProgressAuthorityDocument>][] = [
    ['wrong program', { program_id: 'other-program' }],
    ['wrong sprint', { sprint_id: 'S02' }],
    ['missing acceptance', { acceptance_ids: ['ACC-EVD-001'] }],
    ['extra acceptance', { acceptance_ids: ['ACC-EVD-001', 'ACC-S01', 'ACC-S02'] }],
    ['reordered acceptance', { acceptance_ids: ['ACC-S01', 'ACC-EVD-001'] }],
    ['duplicate acceptance', { acceptance_ids: ['ACC-EVD-001', 'ACC-S01', 'ACC-S01'] }],
    ['missing finding', { finding_ids: s01FindingIds.slice(0, -1) }],
    [
      'extra finding',
      {
        finding_ids: [...s01FindingIds.slice(0, 10), 'ARIA-AUDIT-011', ...s01FindingIds.slice(10)],
      },
    ],
    ['reordered finding', { finding_ids: [findingAt(1), findingAt(0), ...s01FindingIds.slice(2)] }],
    ['duplicate finding', { finding_ids: [findingAt(0), ...s01FindingIds] }],
  ];

  it.each(invalidScopes)('rejects an authority with %s', (_name, authorityOverrides) => {
    const authorityBytes = s01ProgressAuthorityBytes(authorityOverrides);
    expect(() =>
      authorizeS01ProgressAuthority(
        input({ envelope_bytes: operatorEnvelopeBytes({ authorityBytes }) }),
      ),
    ).toThrow();
  });

  it.each([
    ['leading whitespace', Buffer.concat([Buffer.from(' '), operatorEnvelopeBytes()])],
    ['trailing newline', Buffer.concat([operatorEnvelopeBytes(), Buffer.from('\n')])],
  ])('rejects a non-canonical envelope alias: %s', (_name, envelopeBytes) => {
    expect(() => authorizeS01ProgressAuthority(input({ envelope_bytes: envelopeBytes }))).toThrow();
  });
});
