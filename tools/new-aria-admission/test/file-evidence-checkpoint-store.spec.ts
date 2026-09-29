import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkpointIdentityFileName,
  FileEvidenceCheckpointStore,
} from '../src/adapters/file-evidence-checkpoint-store';
import { commitEvidenceCheckpoint } from '../src/application/evidence-checkpoint';
import type { EvidenceCheckpointCommit } from '../src/application/evidence-checkpoint';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';

import { checkpointProjectionCommitFields } from './checkpoint-projection-fixture';
import { completionFixture, evidenceManifestContract } from './progress-fixture';

const stores: FileEvidenceCheckpointStore[] = [];

function store(directory: string): FileEvidenceCheckpointStore {
  const checkpoint = new FileEvidenceCheckpointStore(
    directory,
    checkpointStoreIdentityBytes('s01-checkpoint-store', directory),
  );
  stores.push(checkpoint);
  return checkpoint;
}

function checkpointCommit(): EvidenceCheckpointCommit {
  const fixture = completionFixture();
  return {
    manifest: evidenceManifestContract(fixture.manifest),
    manifest_sha256: fixture.manifestSha256,
    history_sha256: '6'.repeat(64),
    ...checkpointProjectionCommitFields(),
    valid_from: '2026-09-02T12:00:00.000Z',
    valid_until: '2099-01-01T00:00:00.000Z',
  };
}

describe('durable completion checkpoint', () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.useRealTimers();
    for (const checkpoint of stores.splice(0)) checkpoint.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('allows exact idempotent replay but denies a fork at the final tip', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);
    const checkpoint = store(directory);
    const commit = checkpointCommit();

    await expect(commitEvidenceCheckpoint(commit, checkpoint)).resolves.toBe('COMMITTED');
    await expect(commitEvidenceCheckpoint(commit, checkpoint)).resolves.toBe('ALREADY_COMMITTED');
    await expect(
      commitEvidenceCheckpoint({ ...commit, manifest_sha256: '8'.repeat(64) }, checkpoint),
    ).rejects.toThrow(/replay|fork|conflict/i);
  });

  it('serializes concurrent exact commits into one write and one idempotent replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);
    const checkpoint = store(directory);
    const commit = checkpointCommit();

    const results = await Promise.all([
      commitEvidenceCheckpoint(commit, checkpoint),
      commitEvidenceCheckpoint(commit, checkpoint),
    ]);
    expect(results.sort()).toEqual(['ALREADY_COMMITTED', 'COMMITTED']);
  });

  it('rechecks the authority deadline inside the durable write boundary', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T14:00:00.001Z'));
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);
    const fixture = completionFixture();

    await expect(
      commitEvidenceCheckpoint(
        {
          manifest: evidenceManifestContract(fixture.manifest),
          manifest_sha256: fixture.manifestSha256,
          history_sha256: '6'.repeat(64),
          ...checkpointProjectionCommitFields(),
          valid_from: '2026-09-02T12:00:00.000Z',
          valid_until: '2026-09-02T14:00:00.000Z',
        },
        store(directory),
      ),
    ).rejects.toThrow(/replay|fork|checkpoint/i);
    expect(readdirSync(directory)).toEqual([checkpointIdentityFileName]);
  });

  it('requires an explicit one-time genesis identity for an empty store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);

    expect(() => new FileEvidenceCheckpointStore(directory)).toThrow(/genesis identity/i);
    expect(() => store(directory)).not.toThrow();
    expect(() => store(directory)).not.toThrow();
  });

  it('closes its held identity descriptors and rejects post-close use', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);
    const checkpoint = store(directory);

    checkpoint.close();
    expect(() => checkpoint.close()).not.toThrow();
    await expect(commitEvidenceCheckpoint(checkpointCommit(), checkpoint)).rejects.toThrow(
      /closed|trusted checkpoint/i,
    );
  });

  it('does not leak a directory descriptor when constructor validation fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);
    const before = readdirSync('/proc/self/fd').length;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(() => new FileEvidenceCheckpointStore(directory, Buffer.from('{}'))).toThrow();
    }

    expect(readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before + 1);
  });

  it('rejects a world-writable checkpoint root', () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);
    chmodSync(directory, 0o777);

    expect(() => store(directory)).toThrow(/permission|mode|writable/i);
  });

  it('detects checkpoint root replacement after construction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    const displaced = `${directory}-displaced`;
    roots.push(directory, displaced);
    const checkpoint = store(directory);
    renameSync(directory, displaced);
    mkdirSync(directory, { mode: 0o700 });

    await expect(commitEvidenceCheckpoint(checkpointCommit(), checkpoint)).rejects.toThrow(
      /identity changed/i,
    );
  });

  it('detects deletion of the bound store identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    roots.push(directory);
    const checkpoint = store(directory);
    rmSync(join(directory, checkpointIdentityFileName));

    await expect(commitEvidenceCheckpoint(checkpointCommit(), checkpoint)).rejects.toThrow(
      /identity/i,
    );
  });

  it('rejects a hard-linked or copied genesis identity in another root', () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
    const other = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-other-'));
    roots.push(directory, other);
    const identity = checkpointStoreIdentityBytes('s01-checkpoint-store', directory);
    const source = join(other, 'identity-source');
    writeFileSync(source, identity, { mode: 0o400 });
    linkSync(source, join(directory, checkpointIdentityFileName));
    expect(() => new FileEvidenceCheckpointStore(directory)).toThrow(/hard link|identity/i);

    rmSync(join(directory, checkpointIdentityFileName));
    writeFileSync(join(directory, checkpointIdentityFileName), identity, { mode: 0o400 });
    expect(
      () =>
        new FileEvidenceCheckpointStore(
          other,
          checkpointStoreIdentityBytes('s01-checkpoint-store', directory),
        ),
    ).toThrow(/root|identity/i);
  });
});
