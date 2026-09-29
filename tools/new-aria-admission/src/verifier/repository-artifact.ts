import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { validateRepositoryExecutionSnapshot } from '../application/repository-execution-snapshot';
import type { RepositoryExecutionSnapshot } from '../application/repository-execution-snapshot';
import { canonicalJsonBytes, compareCodePoints } from '../kernel/canonical-json';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from '../kernel/evidence-object';
import type { JsonValue } from '../kernel/strict-json';

import { decodeDossierBytes } from './dossier-bytes';

const artifactKeys = ['bytes_base64', 'path', 'sha256', 'uri'] as const;
const safeSegment = /^[A-Za-z0-9._-]+$/u;
const MAX_ARTIFACTS = 128;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export interface RepositoryArtifactSource {
  readonly contract_id: 'new-aria-repository-artifact-source-v1';
}

const artifactSources = new WeakMap<object, (path: string) => Buffer>();

function relativePath(value: JsonValue | undefined): string {
  const path = requiredText(value, 'dossier repository artifact path');
  const segments = path.split('/');
  if (
    isAbsolute(path) ||
    segments.length === 0 ||
    segments.some((segment) => !safeSegment.test(segment) || segment === '.' || segment === '..')
  )
    throw new TypeError('dossier repository artifact path is unsafe');
  return path;
}

function readRepositoryFile(root: string, path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAX_ARTIFACT_BYTES) {
      throw new TypeError('dossier repository artifact is invalid or oversized');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new TypeError('dossier repository artifact changed while reading');
    }
    return bytes;
  } catch {
    throw new TypeError('dossier repository artifact is unavailable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function directoryRepositoryArtifactSource(root: string): RepositoryArtifactSource {
  const source: RepositoryArtifactSource = Object.freeze({
    contract_id: 'new-aria-repository-artifact-source-v1',
  });
  artifactSources.set(source, (path) => readRepositoryFile(root, path));
  return source;
}

export function snapshotRepositoryArtifactSource(
  value: RepositoryExecutionSnapshot,
): RepositoryArtifactSource {
  const snapshot = validateRepositoryExecutionSnapshot(value, value.head_sha);
  const files = new Map(snapshot.files.map((file) => [file.path, Buffer.from(file.bytes)]));
  const source: RepositoryArtifactSource = Object.freeze({
    contract_id: 'new-aria-repository-artifact-source-v1',
  });
  artifactSources.set(source, (path) => {
    const bytes = files.get(path);
    if (bytes === undefined) throw new TypeError('dossier repository artifact is unavailable');
    return Buffer.from(bytes);
  });
  return source;
}

function readRepositoryArtifact(source: RepositoryArtifactSource, path: string): Buffer {
  const reader = artifactSources.get(source);
  if (reader === undefined) throw new TypeError('repository artifact source was not issued');
  return reader(path);
}

export function verifyRepositoryArtifactClosure(
  value: JsonValue | undefined,
  source: RepositoryArtifactSource,
): string {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARTIFACTS) {
    throw new TypeError('dossier repository artifact closure is empty or oversized');
  }
  const references: { readonly path: string; readonly sha256: string; readonly uri: string }[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isJsonRecord(entry) || !hasExactKeys(entry, artifactKeys)) {
      throw new TypeError('dossier repository artifact entry is invalid');
    }
    const bytesBase64 = requiredText(
      entry.bytes_base64,
      `dossier repository artifact ${index + 1} bytes`,
    );
    const sha256 = requiredSha256(entry.sha256, 'dossier repository artifact digest');
    const decoded = decodeDossierBytes(
      { bytes_base64: bytesBase64, sha256 },
      `dossier repository artifact ${index + 1}`,
    );
    const path = relativePath(entry.path);
    const uri = requiredText(entry.uri, 'dossier repository artifact URI');
    const actual = readRepositoryArtifact(source, path);
    if (
      uri !== `aria-evidence://sha256/${sha256}` ||
      digestBytes(actual) !== sha256 ||
      !actual.equals(decoded.bytes)
    )
      throw new TypeError('dossier repository artifact does not match the reviewed snapshot');
    references.push({ path, sha256, uri });
  }
  const canonical = [...references].sort((left, right) => compareCodePoints(left.path, right.path));
  if (
    new Set(references.map(({ path }) => path)).size !== references.length ||
    references.some(({ path }, index) => path !== canonical[index]?.path)
  )
    throw new TypeError('dossier repository artifacts are duplicated or unordered');
  return digestBytes(canonicalJsonBytes(references));
}
