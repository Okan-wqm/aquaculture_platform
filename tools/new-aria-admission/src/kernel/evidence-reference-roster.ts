import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from './evidence-object';
import { referenceKeys } from './evidence-manifest-schema';
import type { JsonValue } from './strict-json';

const MAX_ARTIFACT_REFERENCES = 128;

interface DeclaredReference {
  readonly uri: string;
  readonly sha256: string;
}

function declaredReference(value: JsonValue | undefined, label: string): DeclaredReference {
  if (!isJsonRecord(value) || !hasExactKeys(value, referenceKeys)) {
    throw new TypeError(`${label} reference schema is open or incomplete`);
  }
  const sha256 = requiredSha256(value.sha256, `${label} reference digest`);
  const uri = requiredText(value.uri, `${label} reference URI`);
  if (uri !== `aria-evidence://sha256/${sha256}`) {
    throw new TypeError(`${label} reference is not content-addressed`);
  }
  return { uri, sha256 };
}

export function validateEvidenceReferenceRoster(
  inputs: JsonValue | undefined,
  artifacts: JsonValue | undefined,
  report: JsonValue | undefined,
  objects: ReadonlyMap<string, Uint8Array>,
): void {
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new TypeError('evidence input roster must contain exactly one baseline');
  }
  if (
    !Array.isArray(artifacts) ||
    artifacts.length === 0 ||
    artifacts.length > MAX_ARTIFACT_REFERENCES
  ) {
    throw new TypeError('evidence artifact roster exceeds its bound or is empty');
  }
  const values = [...inputs, ...artifacts, report];
  if (values.length > objects.size) {
    throw new TypeError('evidence object closure is unavailable or smaller than its reference roster');
  }
  const references = values.map((value, index) =>
    declaredReference(value, `evidence role ${index + 1}`),
  );
  if (
    new Set(references.map(({ uri }) => uri)).size !== references.length ||
    new Set(references.map(({ sha256 }) => sha256)).size !== references.length
  ) {
    throw new TypeError('evidence objects cannot be reused across input, artifact, and report roles');
  }
  const digestCache = new Map<string, string>();
  for (const reference of references) {
    const bytes = objects.get(reference.uri);
    if (bytes === undefined) {
      throw new TypeError(`evidence object unavailable: ${reference.uri}`);
    }
    const actual = digestCache.get(reference.uri) ?? digestBytes(bytes);
    digestCache.set(reference.uri, actual);
    if (actual !== reference.sha256) {
      throw new TypeError(`evidence object digest mismatch: ${reference.uri}`);
    }
  }
}
