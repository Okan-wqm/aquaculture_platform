import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileEvidenceCheckpointStore } from '../src/adapters/file-evidence-checkpoint-store';
import { commitEvidenceCheckpoint } from '../src/application/evidence-checkpoint';
import type { EvidenceCheckpointCommit } from '../src/application/evidence-checkpoint';
import type { EvidenceManifest } from '../src/domain/evidence-contracts';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';

import { checkpointProjectionCommitFields } from './checkpoint-projection-fixture';
import { completionFixture, evidenceManifestContract } from './progress-fixture';

function commit(manifest: EvidenceManifest, manifestSha256: string): EvidenceCheckpointCommit {
  return {
    manifest,
    manifest_sha256: manifestSha256,
    history_sha256: '6'.repeat(64),
    ...checkpointProjectionCommitFields(),
    valid_from: '2026-09-02T12:00:00.000Z',
    valid_until: '2099-01-01T00:00:00.000Z',
  };
}

describe('checkpoint stable work-unit scope', () => {
  it('rejects a second terminal tip under a renewed authority without supersession', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-authority-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const fixture = completionFixture();
      const first = evidenceManifestContract(fixture.manifest);
      const renewed = {
        ...first,
        authority_sha256: 'b'.repeat(64),
        evidence_id: 'S01-code-proof-renewed',
      } as EvidenceManifest;

      await expect(commitEvidenceCheckpoint(commit(first, '8'.repeat(64)), store)).resolves.toBe(
        'COMMITTED',
      );
      await expect(
        commitEvidenceCheckpoint(commit(renewed, '9'.repeat(64)), store),
      ).rejects.toThrow(/replay|fork|conflict/i);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
