import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

function checkpointCommit(): EvidenceCheckpointCommit & { readonly valid_from: string } {
  const fixture = completionFixture();
  return {
    manifest: evidenceManifestContract(fixture.manifest),
    manifest_sha256: fixture.manifestSha256,
    history_sha256: '6'.repeat(64),
    ...checkpointProjectionCommitFields(),
    valid_from: '2026-09-02T12:00:00.000Z',
    valid_until: '2026-09-02T14:00:00.000Z',
  };
}

describe('checkpoint trusted clock interval', () => {
  const roots: string[] = [];
  const stores: FileEvidenceCheckpointStore[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rejects a clock rollback before the proof lower bound without a durable side effect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-time-'));
    roots.push(directory);
    const store = new FileEvidenceCheckpointStore(
      directory,
      checkpointStoreIdentityBytes('s01-checkpoint-store', directory),
    );
    stores.push(store);
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse('2026-09-02T12:30:00.000Z'))
      .mockReturnValueOnce(Date.parse('2026-09-02T11:59:59.999Z'));

    await expect(commitEvidenceCheckpoint(checkpointCommit(), store)).rejects.toThrow(
      /checkpoint|replay|fork/i,
    );
    expect(readdirSync(directory)).toEqual([checkpointIdentityFileName]);
  });

  it('rejects CAS when the clock precedes the final external epoch read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-time-'));
    roots.push(directory);
    const store = new FileEvidenceCheckpointStore(
      directory,
      checkpointStoreIdentityBytes('s01-checkpoint-store', directory),
    );
    stores.push(store);
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-02T12:10:00.000Z'));
    const commit = {
      ...checkpointCommit(),
      valid_from: '2026-09-02T12:30:00.000Z',
    };

    await expect(commitEvidenceCheckpoint(commit, store)).rejects.toThrow(/checkpoint|fork/i);
    expect(readdirSync(directory)).toEqual([checkpointIdentityFileName]);
  });
});
