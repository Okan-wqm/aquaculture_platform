import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkpointTransitionClaimName,
  claimCheckpointTransition,
} from '../src/adapters/file-checkpoint-transition-claim';
import { FileEvidenceCheckpointStore } from '../src/adapters/file-evidence-checkpoint-store';
import {
  commitEvidenceCheckpoint,
  evidenceCheckpointScopeSha256,
  type EvidenceCheckpointCommit,
  type EvidenceCheckpointRequest,
} from '../src/application/evidence-checkpoint';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';

import {
  checkpointProjectionCommitFields,
  checkpointProjectionTipFields,
} from './checkpoint-projection-fixture';
import { completionFixture, evidenceManifestContract } from './progress-fixture';

function commitFixture(): EvidenceCheckpointCommit {
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

function requestFor(commit: EvidenceCheckpointCommit): EvidenceCheckpointRequest {
  const { manifest } = commit;
  return {
    repository_id: manifest.target.repository_id,
    workspace_id: manifest.target.workspace_id,
    program_id: manifest.claim.program_id,
    sprint_id: manifest.claim.sprint_id,
    authority_sha256: manifest.authority_sha256,
    evidence_id: manifest.evidence_id,
    valid_from: commit.valid_from,
    valid_until: commit.valid_until,
    expected: null,
    next: {
      authority_sha256: manifest.authority_sha256,
      evidence_id: manifest.evidence_id,
      version: manifest.version,
      manifest_sha256: commit.manifest_sha256,
      history_sha256: commit.history_sha256,
      ...checkpointProjectionTipFields(),
    },
  };
}

describe('checkpoint crash recovery', () => {
  it('ignores an obsolete lock directory on exact durable replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-recovery-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const commit = commitFixture();
      await expect(commitEvidenceCheckpoint(commit, store)).resolves.toBe('COMMITTED');
      const record = readdirSync(root).find((name) => /^\w{64}-.*\.json$/u.test(name));
      if (record === undefined) throw new TypeError('checkpoint record is missing');
      mkdirSync(join(root, `${record.slice(0, 64)}.lock`), { mode: 0o700 });

      await expect(commitEvidenceCheckpoint(commit, store)).resolves.toBe('ALREADY_COMMITTED');
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers only the exact canonical orphan transition claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-claim-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const commit = commitFixture();
      const request = requestFor(commit);
      const scope = evidenceCheckpointScopeSha256(request);
      const claimName = checkpointTransitionClaimName(scope);
      expect(claimCheckpointTransition(root, scope, request)).toBe('CLAIMED');
      expect(readdirSync(root).filter((name) => name.endsWith('.claim'))).toEqual([claimName]);
      expect(
        claimCheckpointTransition(root, scope, {
          ...request,
          next: { ...request.next, manifest_sha256: '8'.repeat(64) },
        }),
      ).toBe('CONFLICT');

      await expect(commitEvidenceCheckpoint(commit, store)).resolves.toBe('COMMITTED');
      expect(readdirSync(root).filter((name) => name.endsWith('.claim'))).toEqual([claimName]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes an exact hard-link temp left after durable final publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-hardlink-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const commit = commitFixture();
      const request = requestFor(commit);
      const scope = evidenceCheckpointScopeSha256(request);
      const version = request.next.version.toString().padStart(10, '0');
      const finalName = `${scope}-${version}-${request.next.manifest_sha256}.json`;
      const tempName = `.${finalName}.1.00000000-0000-4000-8000-000000000001.tmp`;
      expect(claimCheckpointTransition(root, scope, request)).toBe('CLAIMED');
      writeFileSync(join(root, tempName), canonicalJsonBytes(request.next), { mode: 0o600 });
      linkSync(join(root, tempName), join(root, finalName));

      await expect(commitEvidenceCheckpoint(commit, store)).resolves.toBe('ALREADY_COMMITTED');
      expect(readdirSync(root)).toContain(finalName);
      expect(readdirSync(root)).not.toContain(tempName);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not recover a hard-link temp whose bytes differ from its claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-hardlink-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const commit = commitFixture();
      const request = requestFor(commit);
      const scope = evidenceCheckpointScopeSha256(request);
      const version = request.next.version.toString().padStart(10, '0');
      const finalName = `${scope}-${version}-${request.next.manifest_sha256}.json`;
      const tempName = `.${finalName}.1.00000000-0000-4000-8000-000000000002.tmp`;
      expect(claimCheckpointTransition(root, scope, request)).toBe('CLAIMED');
      writeFileSync(join(root, tempName), canonicalJsonBytes({ attacker: true }), { mode: 0o600 });
      linkSync(join(root, tempName), join(root, finalName));

      await expect(commitEvidenceCheckpoint(commit, store)).rejects.toThrow(/temp.*claim/i);
      expect(readdirSync(root)).toEqual(expect.arrayContaining([finalName, tempName]));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
