import { fstatSync } from 'node:fs';

import { canonicalJsonBytes } from '../kernel/canonical-json';
import type { VerifiedCurrentEpochSnapshot } from '../kernel/current-epoch-provider';
import { hasExactKeys, isJsonRecord } from '../kernel/evidence-object';
import { parseStrictJson } from '../kernel/strict-json';

import type { BoundCurrentEpochDirectory } from './file-current-epoch-binding';
import {
  readCheckpointFile,
  recoverCheckpointFilePublication,
  writeNewCheckpointFile,
} from './file-checkpoint-directory-io';
import { boundedDirectoryEntryNames } from './bounded-directory-entries';

const stateName = /^\.new-aria-current-epoch-([a-f0-9]{64})-([0-9]{10})\.json$/u;
const stateKeys = [
  'schema_version',
  'contract_id',
  'provider_identity_sha256',
  'revision',
  'snapshot_sha256',
];
const maxStateRecords = 4_096;

interface StoredEpochState {
  readonly revision: number;
  readonly snapshotSha256: string;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const { code } = error as { readonly code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function stateBytes(
  providerIdentitySha256: string,
  snapshot: VerifiedCurrentEpochSnapshot,
): Buffer {
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-current-epoch-state-v1',
    provider_identity_sha256: providerIdentitySha256,
    revision: snapshot.revision,
    snapshot_sha256: snapshot.sha256,
  });
}

function stateRecordBytes(directory: BoundCurrentEpochDirectory, name: string): Buffer {
  try {
    return readCheckpointFile(directory, name, 4_096);
  } catch (error) {
    let linked: Buffer;
    try {
      linked = readCheckpointFile(directory, name, 4_096, 2);
    } catch {
      throw error;
    }
    recoverCheckpointFilePublication(directory, name, linked, false);
    return readCheckpointFile(directory, name, 4_096);
  }
}

function loadState(
  directory: BoundCurrentEpochDirectory,
  name: string,
  identity: string,
  revision: number,
): StoredEpochState {
  const bytes = stateRecordBytes(directory, name);
  const value = parseStrictJson(bytes);
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, stateKeys) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-current-epoch-state-v1' ||
    value.provider_identity_sha256 !== identity ||
    value.revision !== revision ||
    typeof value.snapshot_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.snapshot_sha256) ||
    !canonicalJsonBytes(value).equals(bytes)
  ) {
    throw new TypeError('current epoch durable state is invalid');
  }
  return { revision, snapshotSha256: value.snapshot_sha256 };
}

function latestState(
  directory: BoundCurrentEpochDirectory,
  identity: string,
): StoredEpochState | null {
  const names = boundedDirectoryEntryNames(
    directory.descriptor_path,
    maxStateRecords,
    'current epoch durable state directory',
  ).filter((name) => stateName.test(name));
  const states = names
    .map((name) => ({ match: stateName.exec(name), name }))
    .filter(({ match }) => match?.[1] === identity)
    .map(({ match, name }) => {
      const revisionText = match?.[2];
      const revision = revisionText === undefined ? Number.NaN : Number(revisionText);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new TypeError('current epoch durable state revision is invalid');
      }
      return loadState(directory, name, identity, revision);
    })
    .sort((left, right) => left.revision - right.revision);
  return states.at(-1) ?? null;
}

function assertRoot(directory: BoundCurrentEpochDirectory): void {
  const stats = fstatSync(directory.descriptor);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o022) !== 0) {
    throw new TypeError('current epoch state directory ownership or mode is unsafe');
  }
}

export function commitCurrentEpochState(
  directory: BoundCurrentEpochDirectory,
  providerIdentitySha256: string,
  snapshot: VerifiedCurrentEpochSnapshot,
): void {
  assertRoot(directory);
  const current = latestState(directory, providerIdentitySha256);
  if (
    current !== null &&
    (snapshot.revision < current.revision ||
      (snapshot.revision === current.revision && snapshot.sha256 !== current.snapshotSha256))
  ) {
    throw new TypeError('current epoch durable state rejects rollback or equivocation');
  }
  if (current?.revision === snapshot.revision) return;
  const revision = snapshot.revision.toString().padStart(10, '0');
  const name = `.new-aria-current-epoch-${providerIdentitySha256}-${revision}.json`;
  const expected = stateBytes(providerIdentitySha256, snapshot);
  try {
    writeNewCheckpointFile(directory, name, expected);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    if (!stateRecordBytes(directory, name).equals(expected)) {
      throw new TypeError('current epoch durable state revision forked');
    }
  }
  const committed = latestState(directory, providerIdentitySha256);
  if (committed?.revision !== snapshot.revision || committed.snapshotSha256 !== snapshot.sha256) {
    throw new TypeError('current epoch durable state advanced concurrently');
  }
}
