import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { isJsonRecord, requiredText } from '../src/kernel/evidence-object';
import type { JsonRecord } from '../src/kernel/evidence-object';
import { assertExactEvidenceObjectClosure } from '../src/kernel/evidence-object-closure';
import { parseStrictJson } from '../src/kernel/strict-json';

import { evidenceBundle, evidenceManifestContract, sha256 } from './progress-fixture';

function objectDocument(bytes: Uint8Array | undefined): JsonRecord {
  if (bytes === undefined) throw new TypeError('fixture object is missing');
  const document = parseStrictJson(bytes);
  if (!isJsonRecord(document)) throw new TypeError('fixture object is not a document');
  return document;
}

function storedReference(
  objects: Map<string, Uint8Array>,
  document: JsonRecord,
): { readonly uri: string; readonly sha256: string } {
  const bytes = canonicalJsonBytes(document);
  const digest = sha256(bytes);
  const reference = { uri: `aria-evidence://sha256/${digest}`, sha256: digest };
  objects.set(reference.uri, bytes);
  return reference;
}

describe('evidence object closure', () => {
  it('accepts only the exact reachable CAS graph and rejects hidden extra objects', () => {
    const fixture = evidenceBundle('d'.repeat(64));
    expect(() =>
      assertExactEvidenceObjectClosure(
        [evidenceManifestContract(fixture.manifest)],
        fixture.objects,
      ),
    ).not.toThrow();

    const hidden = Buffer.from('hidden-secret-material');
    const digest = sha256(hidden);
    fixture.objects.set(`aria-evidence://sha256/${digest}`, hidden);
    expect(() =>
      assertExactEvidenceObjectClosure(
        [evidenceManifestContract(fixture.manifest)],
        fixture.objects,
      ),
    ).toThrow(/unreferenced|closure|extra/i);
  });

  it('rejects a missing object from the reachable graph', () => {
    const fixture = evidenceBundle('d'.repeat(64));
    fixture.objects.delete(fixture.manifest.review.conflict_evidence.uri);

    expect(() =>
      assertExactEvidenceObjectClosure(
        [evidenceManifestContract(fixture.manifest)],
        fixture.objects,
      ),
    ).toThrow(/unavailable|changed|incomplete/i);
  });

  it('rejects reusing one signed receipt across two execution roles', () => {
    const fixture = evidenceBundle('d'.repeat(64));
    const control = fixture.manifest.oracle.negative_controls[0];
    if (control === undefined) throw new TypeError('fixture control is missing');
    const result = objectDocument(fixture.objects.get(control.result.uri));
    if (!isJsonRecord(result.execution) || !isJsonRecord(result.execution.execution_receipt)) {
      throw new TypeError('fixture execution receipt is missing');
    }
    const original = fixture.manifest.execution.execution_receipt;
    fixture.manifest.execution.execution_receipt = {
      uri: requiredText(result.execution.execution_receipt.uri, 'fixture receipt URI'),
      sha256: requiredText(result.execution.execution_receipt.sha256, 'fixture receipt digest'),
    };
    fixture.objects.delete(original.uri);

    expect(() =>
      assertExactEvidenceObjectClosure(
        [evidenceManifestContract(fixture.manifest)],
        fixture.objects,
      ),
    ).toThrow(/receipt.*reused|execution roles/i);
  });

  it('rejects a reachable result whose raw mutant role names another digest', () => {
    const fixture = evidenceBundle('d'.repeat(64));
    const control = fixture.manifest.oracle.negative_controls[0];
    if (control === undefined) throw new TypeError('fixture control is missing');
    const oldResult = control.result;
    const result = objectDocument(fixture.objects.get(oldResult.uri));
    result.mutant_document_sha256 = 'f'.repeat(64);
    control.result = storedReference(fixture.objects, result);
    fixture.objects.delete(oldResult.uri);

    expect(() =>
      assertExactEvidenceObjectClosure(
        [evidenceManifestContract(fixture.manifest)],
        fixture.objects,
      ),
    ).toThrow(/mutant.*role|mutant.*digest/i);
  });
});
