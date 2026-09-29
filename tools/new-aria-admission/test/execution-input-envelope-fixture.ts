import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface ExecutionInputEnvelopeFixture {
  readonly bytes: Buffer;
  readonly input_reference_bundle_sha256: string;
  readonly input_envelope_sha256: string;
  readonly object_sha256s: readonly string[];
}

export function executionInputEnvelope(
  objects: readonly Uint8Array[] = [Buffer.from('verified-input-object\n')],
): ExecutionInputEnvelopeFixture {
  const entries = objects.map((value) => {
    const bytes = Buffer.from(value);
    const sha256 = digest(bytes);
    return {
      object_base64: bytes.toString('base64'),
      reference: { sha256, uri: `aria-evidence://sha256/${sha256}` },
    };
  });
  const bytes = canonicalJsonBytes(entries);
  return Object.freeze({
    bytes,
    input_reference_bundle_sha256: digest(
      canonicalJsonBytes(entries.map((entry) => entry.reference)),
    ),
    input_envelope_sha256: digest(bytes),
    object_sha256s: Object.freeze(entries.map((entry) => entry.reference.sha256)),
  });
}

export function authenticatedExecutionInputEnvelope(
  authenticationObjects: readonly Uint8Array[],
  primaryObject: Uint8Array = Buffer.from('verified-input-object\n'),
  additionalObjects: readonly Uint8Array[] = [],
): ExecutionInputEnvelopeFixture {
  if (authenticationObjects.length !== 3) {
    throw new TypeError('execution authentication fixture requires exactly three objects');
  }
  return executionInputEnvelope([primaryObject, ...authenticationObjects, ...additionalObjects]);
}
