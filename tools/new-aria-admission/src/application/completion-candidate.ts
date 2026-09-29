import { ImmutableByteMap } from './immutable-byte-map';

export interface CompletionCandidate {
  readonly event_bytes: Uint8Array;
  readonly manifest_bytes: readonly Uint8Array[];
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly evidence_attestation_bytes: Uint8Array;
}

const MAX_EVENT_CHAIN_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_COUNT = 64;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_OBJECT_COUNT = 256;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const evidenceUri = /^aria-evidence:\/\/sha256\/[a-f0-9]{64}$/u;

function ownedBytes(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} cannot use shared mutable memory`);
  }
  return Buffer.from(value);
}

function boundedBytes(value: Uint8Array, maximum: number, label: string): number {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} cannot use shared mutable memory`);
  }
  if (value.byteLength > maximum) throw new TypeError(`${label} byte limit exceeded`);
  return value.byteLength;
}

function nativeMapEntries(
  value: ReadonlyMap<string, Uint8Array>,
): readonly (readonly [string, Uint8Array])[] {
  if (
    !(value instanceof Map) ||
    Object.getPrototypeOf(value) !== Map.prototype ||
    Object.prototype.hasOwnProperty.call(value, Symbol.iterator)
  )
    throw new TypeError('evidence objects must use a canonical native Map');
  const size: number = Reflect.get(Map.prototype, 'size', value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_OBJECT_COUNT) {
    throw new TypeError('evidence object count limit exceeded');
  }
  const entries = Array.from(Map.prototype.entries.call(value));
  if (entries.length !== size) throw new TypeError('evidence object Map changed during snapshot');
  return entries;
}

function assertManifestBytes(value: unknown): asserts value is readonly Uint8Array[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => !(entry instanceof Uint8Array))) {
    throw new TypeError('evidence manifest collection must be an array of bytes');
  }
}

export function snapshotCompletionCandidate(input: CompletionCandidate): CompletionCandidate {
  const manifestValues: unknown = input.manifest_bytes;
  assertManifestBytes(manifestValues);
  if (manifestValues.length === 0 || manifestValues.length > MAX_MANIFEST_COUNT) {
    throw new TypeError('evidence manifest count limit exceeded');
  }
  let totalBytes = boundedBytes(input.event_bytes, MAX_EVENT_CHAIN_BYTES, 'event chain');
  const manifests = manifestValues.map((bytes, index) => {
    totalBytes += boundedBytes(bytes, MAX_MANIFEST_BYTES, `evidence manifest ${index}`);
    return bytes;
  });
  const entries = nativeMapEntries(input.objects);
  for (const [uri, bytes] of entries) {
    if (!evidenceUri.test(uri)) throw new TypeError('evidence object URI is not canonical');
    totalBytes += boundedBytes(bytes, MAX_OBJECT_BYTES, `evidence object ${uri}`);
  }
  totalBytes += boundedBytes(
    input.evidence_attestation_bytes,
    MAX_ATTESTATION_BYTES,
    'evidence attestation',
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CANDIDATE_BYTES) {
    throw new TypeError('completion candidate aggregate byte limit exceeded');
  }
  const manifestBytes = manifests.map((bytes, index) =>
    ownedBytes(bytes, `evidence manifest ${index}`),
  );
  const objects = new ImmutableByteMap(entries);
  return Object.freeze({
    event_bytes: ownedBytes(input.event_bytes, 'event chain'),
    manifest_bytes: Object.freeze(manifestBytes),
    objects,
    evidence_attestation_bytes: ownedBytes(
      input.evidence_attestation_bytes,
      'evidence attestation',
    ),
  });
}
