import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { FreshnessProof } from '../src/kernel/freshness';

interface TrustRootDocument {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-evidence-trust-root-v1';
  readonly keys: readonly {
    readonly principal_id: string;
    readonly capability: 'APPELLATE' | 'ORACLE' | 'PRODUCE' | 'REVIEW';
    readonly public_key_spki_der_base64: string;
  }[];
}

const reviewerKeys = generateKeyPairSync('ed25519');
const appellateKeys = generateKeyPairSync('ed25519');
const oracleKeys = generateKeyPairSync('ed25519');
const producerKeys = generateKeyPairSync('ed25519');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const publicDer = (key: typeof reviewerKeys.publicKey): string =>
  key.export({ format: 'der', type: 'spki' }).toString('base64');

export const sourceFreshness = (
  authoritySha256: string,
  targetHeadSha = 'b'.repeat(40),
  overrides: Readonly<Record<string, string>> = {},
): FreshnessProof => ({
  type: 'SOURCE_CODE_ORACLE',
  observed_at: '2026-09-02T12:00:00.000Z',
  valid_until: '2026-09-02T13:00:00.000Z',
  invalidation_epochs: [
    { key: 'authority', epoch: `sha256:${authoritySha256}` },
    { key: 'dependency', epoch: `sha256:${'d'.repeat(64)}` },
    { key: 'policy', epoch: `sha256:${'e'.repeat(64)}` },
    { key: 'source_head', epoch: `git:${targetHeadSha}` },
    { key: 'toolchain', epoch: `sha256:${'f'.repeat(64)}` },
    { key: 'verifier', epoch: `sha256:${'1'.repeat(64)}` },
  ].map(({ key, epoch }) => ({ key, epoch: overrides[key] ?? epoch })),
});

export const sourceEpochContext = (
  authoritySha256: string,
  targetHeadSha = 'b'.repeat(40),
): Map<string, string> =>
  new Map(
    sourceFreshness(authoritySha256, targetHeadSha).invalidation_epochs.map(({ key, epoch }) => [
      key,
      epoch,
    ]),
  );

export const trustRootDocument = (): TrustRootDocument => ({
  schema_version: '1.0.0',
  contract_id: 'new-aria-evidence-trust-root-v1',
  keys: [
    {
      principal_id: 'appellate-1',
      capability: 'APPELLATE',
      public_key_spki_der_base64: publicDer(appellateKeys.publicKey),
    },
    {
      principal_id: 'oracle-1',
      capability: 'ORACLE',
      public_key_spki_der_base64: publicDer(oracleKeys.publicKey),
    },
    {
      principal_id: 'producer-1',
      capability: 'PRODUCE',
      public_key_spki_der_base64: publicDer(producerKeys.publicKey),
    },
    {
      principal_id: 'reviewer-1',
      capability: 'REVIEW',
      public_key_spki_der_base64: publicDer(reviewerKeys.publicKey),
    },
  ],
});

export const trustRootBytes = (): Buffer => canonicalJsonBytes(trustRootDocument());

export function attestationBytes(
  manifestBytes: Uint8Array,
  authoritySha256: string,
  eventChainBytes: Uint8Array,
  tailEventHash: string,
  targetHeadSha = 'b'.repeat(40),
  epochOverrides: Readonly<Record<string, string>> = {},
): Buffer {
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString().replace(/\n$/u, '')) as {
    oracle: {
      report: { sha256: string };
      negative_controls: readonly object[];
    };
  };
  const payload = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-evidence-attestation-payload-v1',
    manifest_sha256: sha256(manifestBytes),
    authority_sha256: authoritySha256,
    event_chain_sha256: sha256(eventChainBytes),
    tail_event_hash: tailEventHash,
    target_head_sha: targetHeadSha,
    oracle_report_sha256: manifest.oracle.report.sha256,
    negative_controls_sha256: sha256(canonicalJsonBytes(manifest.oracle.negative_controls)),
    producer_principal_id: 'producer-1',
    reviewer_principal_id: 'reviewer-1',
    oracle_principal_id: 'oracle-1',
    appellate_principal_id: 'appellate-1',
    verdict: 'ACCEPTED',
    freshness: {
      ...sourceFreshness(authoritySha256, targetHeadSha, epochOverrides),
      observed_at: '2026-09-02T12:05:00.000Z',
    },
  };
  const signed = canonicalJsonBytes(payload);
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-evidence-attestation-envelope-v1',
    payload,
    signatures: [
      {
        principal_id: 'appellate-1',
        capability: 'APPELLATE',
        signature_base64: sign(null, signed, appellateKeys.privateKey).toString('base64'),
      },
      {
        principal_id: 'oracle-1',
        capability: 'ORACLE',
        signature_base64: sign(null, signed, oracleKeys.privateKey).toString('base64'),
      },
      {
        principal_id: 'producer-1',
        capability: 'PRODUCE',
        signature_base64: sign(null, signed, producerKeys.privateKey).toString('base64'),
      },
      {
        principal_id: 'reviewer-1',
        capability: 'REVIEW',
        signature_base64: sign(null, signed, reviewerKeys.privateKey).toString('base64'),
      },
    ],
  });
}
