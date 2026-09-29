import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as bindingApi from '../src/adapters/file-checkpoint-store-binding';
import { FileEvidenceCheckpointStore } from '../src/adapters/file-evidence-checkpoint-store';
import { commitEvidenceCheckpoint } from '../src/application/evidence-checkpoint';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';

import { checkpointProjectionCommitFields } from './checkpoint-projection-fixture';
import { completionFixture, evidenceManifestContract } from './progress-fixture';

describe('checkpoint held-directory IO', () => {
  it('publishes through the held directory descriptor across visible path swaps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-fd-'));
    const displaced = `${root}-held`;
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    const original = bindingApi.verifyBoundCheckpointDirectory;
    jest.spyOn(bindingApi, 'verifyBoundCheckpointDirectory').mockImplementation((binding) => {
      if (existsSync(displaced)) {
        rmSync(root, { recursive: true, force: true });
        renameSync(displaced, root);
      }
      original(binding);
      renameSync(root, displaced);
      mkdirSync(root, { mode: 0o700 });
    });
    try {
      const fixture = completionFixture();
      await expect(
        commitEvidenceCheckpoint(
          {
            manifest: evidenceManifestContract(fixture.manifest),
            manifest_sha256: fixture.manifestSha256,
            history_sha256: '6'.repeat(64),
            ...checkpointProjectionCommitFields(),
            valid_from: '2026-09-02T12:00:00.000Z',
            valid_until: '2099-01-01T00:00:00.000Z',
          },
          store,
        ),
      ).resolves.toBe('COMMITTED');
      expect(readdirSync(root).some((name) => name.endsWith('.json'))).toBe(false);
      expect(readdirSync(displaced).some((name) => name.endsWith('.json'))).toBe(true);
    } finally {
      jest.restoreAllMocks();
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(displaced, { recursive: true, force: true });
    }
  });
});
