import { canonicalJsonBytes } from '../kernel/canonical-json';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonValue } from '../kernel/strict-json';

export interface CompletionBundleArtifactDescriptor {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

export interface CompletionBundleObjectDescriptor extends CompletionBundleArtifactDescriptor {
  readonly uri: string;
}

export interface CompletionProofBundleFiles {
  readonly target_request: CompletionBundleArtifactDescriptor;
  readonly operator_envelope: CompletionBundleArtifactDescriptor;
  readonly operator_trust_root: CompletionBundleArtifactDescriptor;
  readonly evidence_trust_root: CompletionBundleArtifactDescriptor;
  readonly execution_trust_root: CompletionBundleArtifactDescriptor;
  readonly event_policy: CompletionBundleArtifactDescriptor;
  readonly freshness_policy: CompletionBundleArtifactDescriptor;
  readonly event_chain: CompletionBundleArtifactDescriptor;
  readonly manifests: readonly CompletionBundleArtifactDescriptor[];
  readonly objects: readonly CompletionBundleObjectDescriptor[];
  readonly evidence_attestation: CompletionBundleArtifactDescriptor;
  readonly projection_artifact: CompletionBundleArtifactDescriptor;
}

export interface CompletionProofBundleMarker {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-completion-proof-bundle-v1';
  readonly bundle_verdict: 'VALID_AT';
  readonly files: CompletionProofBundleFiles;
}

type JsonRecord = { [key: string]: JsonValue };
const sha64 = /^[a-f0-9]{64}$/u;
const evidenceUri = /^aria-evidence:\/\/sha256\/([a-f0-9]{64})$/u;
const markerKeys = ['bundle_verdict', 'contract_id', 'files', 'schema_version'] as const;
const filesKeys = [
  'event_chain',
  'event_policy',
  'evidence_attestation',
  'evidence_trust_root',
  'execution_trust_root',
  'freshness_policy',
  'manifests',
  'objects',
  'operator_envelope',
  'operator_trust_root',
  'projection_artifact',
  'target_request',
] as const;
const artifactKeys = ['byte_length', 'path', 'sha256'] as const;
const objectKeys = ['byte_length', 'path', 'sha256', 'uri'] as const;

function record(value: JsonValue | undefined, keys: readonly string[], label: string): JsonRecord {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new TypeError(`${label} schema is invalid`);
  return value;
}

function descriptor(
  value: JsonValue | undefined,
  expectedPath: string,
): CompletionBundleArtifactDescriptor {
  const item = record(value, artifactKeys, 'completion bundle artifact');
  return descriptorFields(item, expectedPath);
}

function descriptorFields(
  item: JsonRecord,
  expectedPath: string,
): CompletionBundleArtifactDescriptor {
  if (
    item.path !== expectedPath ||
    typeof item.byte_length !== 'number' ||
    !Number.isSafeInteger(item.byte_length) ||
    item.byte_length < 0 ||
    typeof item.sha256 !== 'string' ||
    !sha64.test(item.sha256)
  )
    throw new TypeError('completion bundle artifact identity is invalid');
  return Object.freeze({
    path: expectedPath,
    byte_length: item.byte_length,
    sha256: item.sha256,
  });
}

function manifests(value: JsonValue | undefined): readonly CompletionBundleArtifactDescriptor[] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError('completion bundle manifest roster is invalid');
  }
  return Object.freeze(
    value.map((item, index) =>
      descriptor(item, `payload/manifest-${index.toString().padStart(2, '0')}.json`),
    ),
  );
}

function objects(value: JsonValue | undefined): readonly CompletionBundleObjectDescriptor[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new TypeError('completion bundle object roster is invalid');
  }
  let previous = '';
  return Object.freeze(
    value.map((item) => {
      const entry = record(item, objectKeys, 'completion bundle object');
      if (typeof entry.uri !== 'string') {
        throw new TypeError('completion bundle object URI is invalid');
      }
      const match = evidenceUri.exec(entry.uri);
      const objectSha256 = match?.[1];
      if (objectSha256 === undefined || entry.uri <= previous) {
        throw new TypeError('completion bundle object roster is not canonical or unique');
      }
      previous = entry.uri;
      const artifact = descriptorFields(entry, `payload/object-${objectSha256}.bin`);
      if (artifact.sha256 !== objectSha256) {
        throw new TypeError('completion bundle object content address is invalid');
      }
      return Object.freeze({ ...artifact, uri: entry.uri });
    }),
  );
}

export function parseCompletionProofBundleMarker(bytes: Uint8Array): CompletionProofBundleMarker {
  const owned = Buffer.from(bytes);
  if (
    owned.byteLength < 2 ||
    owned.byteLength > 256 * 1024 ||
    owned.at(-1) !== 0x0a ||
    owned.at(-2) === 0x0a
  )
    throw new TypeError('completion bundle marker framing is invalid');
  const body = owned.subarray(0, -1);
  const value = record(parseStrictJson(body), markerKeys, 'completion bundle marker');
  if (
    !canonicalJsonBytes(value).equals(body) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-completion-proof-bundle-v1' ||
    value.bundle_verdict !== 'VALID_AT'
  )
    throw new TypeError('completion bundle marker identity is invalid');
  const files = record(value.files, filesKeys, 'completion bundle files');
  return Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-completion-proof-bundle-v1',
    bundle_verdict: 'VALID_AT',
    files: Object.freeze({
      target_request: descriptor(files.target_request, 'payload/target-request.json'),
      operator_envelope: descriptor(files.operator_envelope, 'payload/operator-envelope.json'),
      operator_trust_root: descriptor(
        files.operator_trust_root,
        'payload/operator-trust-root.json',
      ),
      evidence_trust_root: descriptor(
        files.evidence_trust_root,
        'payload/evidence-trust-root.json',
      ),
      execution_trust_root: descriptor(
        files.execution_trust_root,
        'payload/execution-trust-root.json',
      ),
      event_policy: descriptor(files.event_policy, 'payload/event-policy.json'),
      freshness_policy: descriptor(files.freshness_policy, 'payload/freshness-policy.json'),
      event_chain: descriptor(files.event_chain, 'payload/event-chain.jsonl'),
      manifests: manifests(files.manifests),
      objects: objects(files.objects),
      evidence_attestation: descriptor(
        files.evidence_attestation,
        'payload/evidence-attestation.json',
      ),
      projection_artifact: descriptor(
        files.projection_artifact,
        'payload/completion-projection.json',
      ),
    }),
  });
}
