import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import {
  AttestationVerificationInput,
  verifyEvidenceAttestation,
} from '../src/kernel/evidence-attestation';
import { isJsonRecord, JsonRecord } from '../src/kernel/evidence-object';
import { loadFreshnessPolicy } from '../src/kernel/freshness-policy';
import { parseStrictJson } from '../src/kernel/strict-json';

import { sourceEpochContext } from './attestation-fixture';
import { completionFixture, freshnessPolicyBytes, sha256 } from './progress-fixture';

type MutableExpectation = {
  -readonly [Key in keyof AttestationVerificationInput['expected']]: AttestationVerificationInput['expected'][Key];
};

type VerificationInput = Omit<
  AttestationVerificationInput,
  'envelope_bytes' | 'expected' | 'trust_root_bytes'
> & {
  envelope_bytes: Uint8Array;
  expected: MutableExpectation;
  trust_root_bytes: Uint8Array;
};

type AttestedDigestField = 'negative_controls_sha256' | 'oracle_report_sha256';

function parseRecord(bytes: Uint8Array): JsonRecord {
  const value = parseStrictJson(bytes);
  if (!isJsonRecord(value)) throw new Error('fixture document is not a record');
  return value;
}

function recordArray(record: JsonRecord, field: string): JsonRecord[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`fixture ${field} array is missing`);
  const records: JsonRecord[] = [];
  for (const entry of value) {
    if (!isJsonRecord(entry)) throw new Error(`fixture ${field} entry is not a record`);
    records.push(entry);
  }
  return records;
}

function requiredText(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`fixture ${field} text is missing`);
  return value;
}

function verificationInput(): VerificationInput {
  const fixture = completionFixture();
  const tail = fixture.events.at(-1);
  if (tail === undefined) throw new Error('fixture event tail is missing');
  return {
    envelope_bytes: fixture.attestation,
    trust_root_bytes: fixture.trustRoot,
    expected: {
      trust_root_sha256: sha256(fixture.trustRoot),
      manifest_sha256: fixture.manifestSha256,
      authority_sha256: fixture.authoritySha256,
      event_chain_sha256: sha256(fixture.eventBytes),
      tail_event_hash: tail.event_hash,
      target_head_sha: 'b'.repeat(40),
      oracle_report_sha256: fixture.manifest.oracle.report.sha256,
      negative_controls_sha256: sha256(
        canonicalJsonBytes(fixture.manifest.oracle.negative_controls),
      ),
      producer_principal_id: 'producer-1',
      reviewer_principal_id: 'reviewer-1',
      oracle_principal_id: 'oracle-1',
      appellate_principal_id: 'appellate-1',
    },
    freshness_context: {
      now: '2026-09-02T12:30:00.000Z',
      current_invalidation_epochs: sourceEpochContext(fixture.authoritySha256),
    },
    freshness_policy: loadFreshnessPolicy(freshnessPolicyBytes).document,
  };
}

describe('external evidence attestation', () => {
  it('accepts four distinct Ed25519 producer, reviewer, oracle, and appellate signatures', () => {
    expect(verifyEvidenceAttestation(verificationInput()).sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects SPKI encodings with ignored trailing bytes', () => {
    const input = verificationInput();
    const root = parseRecord(input.trust_root_bytes);
    recordArray(root, 'keys').forEach((key, index) => {
      const encodedKey = requiredText(key, 'public_key_spki_der_base64');
      key.public_key_spki_der_base64 = Buffer.concat([
        Buffer.from(encodedKey, 'base64'),
        Buffer.alloc(index + 1),
      ]).toString('base64');
    });
    input.trust_root_bytes = canonicalJsonBytes(root);
    input.expected.trust_root_sha256 = sha256(input.trust_root_bytes);
    expect(() => verifyEvidenceAttestation(input)).toThrow(/canonical Ed25519/);
  });

  it('rejects one Ed25519 key reused across two principal capabilities', () => {
    const input = verificationInput();
    const keys = recordArray(parseRecord(input.trust_root_bytes), 'keys');
    const producer = keys[2];
    const reviewer = keys[3];
    if (producer === undefined || reviewer === undefined)
      throw new Error('fixture keys are missing');
    producer.public_key_spki_der_base64 = requiredText(reviewer, 'public_key_spki_der_base64');
    input.trust_root_bytes = canonicalJsonBytes({
      ...parseRecord(input.trust_root_bytes),
      keys,
    });
    input.expected.trust_root_sha256 = sha256(input.trust_root_bytes);
    expect(() => verifyEvidenceAttestation(input)).toThrow(/unique keys/);
  });

  it('rejects an attestation without an independent producer signature', () => {
    const input = verificationInput();
    const envelope = parseRecord(input.envelope_bytes);
    const signatures = recordArray(envelope, 'signatures');
    envelope.signatures = signatures.filter(
      (signature) => requiredText(signature, 'capability') !== 'PRODUCE',
    );
    input.envelope_bytes = canonicalJsonBytes(envelope);
    expect(() => verifyEvidenceAttestation(input)).toThrow(/identity|producer/);
  });

  it('rejects a second canonical envelope alias with reordered signatures', () => {
    const input = verificationInput();
    const envelope = parseRecord(input.envelope_bytes);
    envelope.signatures = recordArray(envelope, 'signatures').reverse();
    input.envelope_bytes = canonicalJsonBytes(envelope);
    expect(() => verifyEvidenceAttestation(input)).toThrow(/sorted/);
  });

  const attestedDigestFields: readonly AttestedDigestField[] = [
    'oracle_report_sha256',
    'negative_controls_sha256',
  ];

  it.each(attestedDigestFields)(
    'rejects an attestation outside the expected %s binding',
    (field) => {
      const input = verificationInput();
      input.expected[field] = '9'.repeat(64);
      expect(() => verifyEvidenceAttestation(input)).toThrow(/payload/);
    },
  );
});
