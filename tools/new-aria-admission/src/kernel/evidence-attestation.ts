import { createHash, verify } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import {
  decodeCanonicalBase64,
  evidenceCapability,
  EvidenceCapability,
  loadEvidenceTrustKeys,
} from './evidence-trust-root';
import {
  assertFreshnessProofShape,
  evaluateFreshness,
  FreshnessContext,
  FreshnessPolicy,
  FreshnessProof,
} from './freshness';
import { JsonValue, parseStrictJson } from './strict-json';

type JsonRecord = { [key: string]: JsonValue };

export interface AttestationExpectation {
  readonly trust_root_sha256: string;
  readonly manifest_sha256: string;
  readonly authority_sha256: string;
  readonly event_chain_sha256: string;
  readonly tail_event_hash: string;
  readonly target_head_sha: string;
  readonly oracle_report_sha256: string;
  readonly negative_controls_sha256: string;
  readonly producer_principal_id: string;
  readonly reviewer_principal_id: string;
  readonly oracle_principal_id: string;
  readonly appellate_principal_id: string;
}

interface AttestationVerificationScope {
  readonly envelope_bytes: Uint8Array;
  readonly trust_root_bytes: Uint8Array;
  readonly expected: AttestationExpectation;
  readonly freshness_policy: FreshnessPolicy;
}

export interface AttestationVerificationInput extends AttestationVerificationScope {
  readonly freshness_context: FreshnessContext;
}

export interface HistoricalAttestationVerificationInput extends AttestationVerificationScope {
  readonly current_invalidation_epochs: ReadonlyMap<string, string>;
}

export interface VerifiedEvidenceAttestation {
  readonly sha256: string;
  readonly observed_at: string;
  readonly valid_until: string;
}

const envelopeKeys = ['schema_version', 'contract_id', 'payload', 'signatures'];
const payloadKeys = [
  'schema_version',
  'contract_id',
  'manifest_sha256',
  'authority_sha256',
  'event_chain_sha256',
  'tail_event_hash',
  'target_head_sha',
  'oracle_report_sha256',
  'negative_controls_sha256',
  'producer_principal_id',
  'reviewer_principal_id',
  'oracle_principal_id',
  'appellate_principal_id',
  'verdict',
  'freshness',
];
const signatureKeys = ['principal_id', 'capability', 'signature_base64'];
const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;

const isRecord = (value: JsonValue | undefined): value is JsonRecord =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: JsonRecord, expected: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function validatePayload(payload: JsonRecord, expected: AttestationExpectation): FreshnessProof {
  if (!exactKeys(payload, payloadKeys))
    throw new TypeError('evidence attestation payload schema is invalid');
  if (
    payload.schema_version !== '1.0.0' ||
    payload.contract_id !== 'new-aria-evidence-attestation-payload-v1' ||
    payload.verdict !== 'ACCEPTED' ||
    payload.manifest_sha256 !== expected.manifest_sha256 ||
    payload.authority_sha256 !== expected.authority_sha256 ||
    payload.event_chain_sha256 !== expected.event_chain_sha256 ||
    payload.tail_event_hash !== expected.tail_event_hash ||
    payload.target_head_sha !== expected.target_head_sha ||
    payload.oracle_report_sha256 !== expected.oracle_report_sha256 ||
    payload.negative_controls_sha256 !== expected.negative_controls_sha256 ||
    payload.producer_principal_id !== expected.producer_principal_id ||
    payload.reviewer_principal_id !== expected.reviewer_principal_id ||
    payload.oracle_principal_id !== expected.oracle_principal_id ||
    payload.appellate_principal_id !== expected.appellate_principal_id ||
    !sha64.test(text(payload.manifest_sha256, 'attested manifest digest')) ||
    !sha64.test(text(payload.authority_sha256, 'attested authority digest')) ||
    !sha64.test(text(payload.event_chain_sha256, 'attested event chain digest')) ||
    !sha64.test(text(payload.tail_event_hash, 'attested event tail hash')) ||
    !sha64.test(text(payload.oracle_report_sha256, 'attested oracle report digest')) ||
    !sha64.test(text(payload.negative_controls_sha256, 'attested negative controls digest')) ||
    !sha40.test(text(payload.target_head_sha, 'attested target SHA'))
  ) {
    throw new TypeError('evidence attestation payload does not match expected authority');
  }
  assertFreshnessProofShape(payload.freshness);
  return payload.freshness;
}

function verifyAttestation(
  input: AttestationVerificationScope,
  contextFor: (freshness: FreshnessProof) => FreshnessContext,
): VerifiedEvidenceAttestation {
  const keys = loadEvidenceTrustKeys(input.trust_root_bytes, input.expected.trust_root_sha256);
  const envelope = parseStrictJson(input.envelope_bytes);
  if (!isRecord(envelope) || !exactKeys(envelope, envelopeKeys)) {
    throw new TypeError('evidence attestation envelope schema is invalid');
  }
  if (!canonicalJsonBytes(envelope).equals(Buffer.from(input.envelope_bytes))) {
    throw new TypeError('evidence attestation envelope must use canonical JSON');
  }
  if (
    envelope.schema_version !== '1.0.0' ||
    envelope.contract_id !== 'new-aria-evidence-attestation-envelope-v1' ||
    !isRecord(envelope.payload) ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 4
  ) {
    throw new TypeError('evidence attestation envelope identity is invalid');
  }
  const freshness = validatePayload(envelope.payload, input.expected);
  if (evaluateFreshness(freshness, contextFor(freshness), input.freshness_policy) !== 'CURRENT') {
    throw new TypeError('evidence attestation is stale');
  }
  const signedBytes = canonicalJsonBytes(envelope.payload);
  const capabilities = new Set<EvidenceCapability>();
  let previousPrincipal: string | undefined;
  for (const item of envelope.signatures) {
    if (!isRecord(item) || !exactKeys(item, signatureKeys))
      throw new TypeError('evidence signature schema is invalid');
    const signerCapability = evidenceCapability(item.capability);
    const principalId = text(item.principal_id, 'evidence signer principal');
    if (previousPrincipal !== undefined && principalId <= previousPrincipal) {
      throw new TypeError('evidence signatures must be sorted by principal');
    }
    previousPrincipal = principalId;
    const expectedPrincipal =
      signerCapability === 'PRODUCE'
        ? input.expected.producer_principal_id
        : signerCapability === 'REVIEW'
          ? input.expected.reviewer_principal_id
          : signerCapability === 'ORACLE'
            ? input.expected.oracle_principal_id
            : input.expected.appellate_principal_id;
    const trustKey = keys.find(
      (key) => key.principalId === principalId && key.capability === signerCapability,
    );
    if (
      principalId !== expectedPrincipal ||
      trustKey === undefined ||
      capabilities.has(signerCapability)
    ) {
      throw new TypeError('evidence signer identity or capability mismatch');
    }
    const signature = decodeCanonicalBase64(item.signature_base64, 'evidence signature');
    if (signature.length !== 64 || !verify(null, signedBytes, trustKey.publicKey, signature)) {
      throw new TypeError('evidence signature verification failed');
    }
    capabilities.add(signerCapability);
  }
  if (capabilities.size !== 4) {
    throw new TypeError('producer, review, oracle, and appellate signatures are required');
  }
  return Object.freeze({
    sha256: createHash('sha256').update(input.envelope_bytes).digest('hex'),
    observed_at: freshness.observed_at,
    valid_until: freshness.valid_until,
  });
}

export function verifyEvidenceAttestation(
  input: AttestationVerificationInput,
): VerifiedEvidenceAttestation {
  return verifyAttestation(input, () => input.freshness_context);
}

export function verifyHistoricalEvidenceAttestation(
  input: HistoricalAttestationVerificationInput,
): VerifiedEvidenceAttestation {
  return verifyAttestation(input, (freshness) => ({
    now: freshness.observed_at,
    current_invalidation_epochs: input.current_invalidation_epochs,
  }));
}
