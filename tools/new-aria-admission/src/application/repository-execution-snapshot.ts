import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { compareCodePoints } from '../kernel/canonical-json';

const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;
export const REPOSITORY_SNAPSHOT_POLICY = Object.freeze({
  max_files: 20_000,
  max_file_bytes: 64 * 1024 * 1024,
  max_total_bytes: 256 * 1024 * 1024,
});

export interface RepositorySnapshotFile {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly blob_sha: string;
  readonly content_sha256: string;
  readonly bytes: Uint8Array;
}

export interface RepositoryExecutionSnapshot {
  readonly head_sha: string;
  readonly tree_sha: string;
  readonly files: readonly RepositorySnapshotFile[];
}

const digest = (algorithm: 'sha1' | 'sha256', bytes: Uint8Array): string =>
  createHash(algorithm).update(bytes).digest('hex');

const gitBlobDigest = (bytes: Uint8Array): string => {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return createHash('sha1').update(header).update(bytes).digest('hex');
};

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4_096 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    posix.normalize(path) === path &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    Array.from(path).every((character) => {
      const point = character.codePointAt(0);
      return (
        point !== undefined &&
        point >= 0x20 &&
        point !== 0x7f &&
        (point < 0x202a || point > 0x202e) &&
        (point < 0x2066 || point > 0x2069)
      );
    })
  );
}

function copyFile(file: RepositorySnapshotFile): RepositorySnapshotFile {
  if (!safeRelativePath(file.path)) {
    throw new TypeError('repository snapshot contains an unsafe path');
  }
  if (file.mode !== '100644' && file.mode !== '100755') {
    throw new TypeError('repository snapshot contains a symlink or special mode');
  }
  if (
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength > REPOSITORY_SNAPSHOT_POLICY.max_file_bytes
  ) {
    throw new TypeError('repository snapshot file bytes are invalid or unbounded');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && file.bytes.buffer instanceof SharedArrayBuffer) {
    throw new TypeError('repository snapshot cannot use shared mutable memory');
  }
  const bytes = Buffer.from(file.bytes);
  if (
    !sha40.test(file.blob_sha) ||
    !sha64.test(file.content_sha256) ||
    gitBlobDigest(bytes) !== file.blob_sha ||
    digest('sha256', bytes) !== file.content_sha256
  ) {
    throw new TypeError('repository snapshot file digest mismatch');
  }
  return Object.freeze({ ...file, bytes });
}

export function validateRepositoryExecutionSnapshot(
  snapshot: RepositoryExecutionSnapshot,
  expectedHeadSha: string,
): RepositoryExecutionSnapshot {
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    snapshot.head_sha !== expectedHeadSha ||
    !sha40.test(snapshot.head_sha) ||
    !sha40.test(snapshot.tree_sha) ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length > REPOSITORY_SNAPSHOT_POLICY.max_files
  ) {
    throw new TypeError('repository execution snapshot identity is invalid');
  }
  const files = snapshot.files.map(copyFile);
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  const paths = files.map((file) => file.path);
  const sorted = [...paths].sort(compareCodePoints);
  if (
    totalBytes > REPOSITORY_SNAPSHOT_POLICY.max_total_bytes ||
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => path !== sorted[index])
  ) {
    throw new TypeError('repository execution snapshot is oversized, duplicated, or unordered');
  }
  return Object.freeze({
    head_sha: snapshot.head_sha,
    tree_sha: snapshot.tree_sha,
    files: Object.freeze(files),
  });
}
