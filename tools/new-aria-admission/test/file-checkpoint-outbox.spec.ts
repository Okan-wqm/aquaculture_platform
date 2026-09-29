import { linkSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkpointTransitionClaimName,
  claimCheckpointTransition,
} from '../src/adapters/file-checkpoint-transition-claim';
import {
  FileEvidenceCheckpointStore,
  recoverCommittedCheckpointProjection,
} from '../src/adapters/file-evidence-checkpoint-store';
import {
  evidenceCheckpointScopeSha256,
  type EvidenceCheckpointRequest,
} from '../src/application/evidence-checkpoint';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';

import {
  checkpointProjectionCommitFields,
  checkpointProjectionTipFields,
} from './checkpoint-projection-fixture';

function request(): EvidenceCheckpointRequest {
  return {
    repository_id: 'repo-outbox',
    workspace_id: 'workspace-outbox',
    program_id: 'program-outbox',
    sprint_id: 'S01',
    authority_sha256: 'a'.repeat(64),
    evidence_id: 'evidence-outbox',
    valid_from: '2026-09-02T12:00:00.000Z',
    valid_until: '2026-09-02T13:00:00.000Z',
    expected: null,
    next: {
      authority_sha256: 'a'.repeat(64),
      evidence_id: 'evidence-outbox',
      version: 1,
      manifest_sha256: 'b'.repeat(64),
      history_sha256: 'c'.repeat(64),
      ...checkpointProjectionTipFields(),
    },
  };
}

describe('checkpoint projection outbox', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('recovers only exact immutable framed bytes after admission validity expires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-outbox-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const value = request();
      await expect(store.compareAndSet(value)).resolves.toBe('COMMITTED');
      jest.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
      const query = {
        repository_id: value.repository_id,
        workspace_id: value.workspace_id,
        program_id: value.program_id,
        sprint_id: value.sprint_id,
        authority_sha256: value.authority_sha256,
        evidence_id: value.evidence_id,
        version: value.next.version,
      };
      const recovered = recoverCommittedCheckpointProjection(store, query);
      expect(recovered?.bytes).toEqual(
        checkpointProjectionCommitFields().projection_artifact_bytes,
      );
      expect(recovered?.sha256).toBe(value.next.projection_sha256);
      if (recovered === null) throw new TypeError('checkpoint outbox fixture is missing');
      recovered.bytes.fill(0);
      expect(recoverCommittedCheckpointProjection(store, query)?.bytes).toEqual(
        checkpointProjectionCommitFields().projection_artifact_bytes,
      );
      expect(() =>
        recoverCommittedCheckpointProjection(store, {
          ...query,
          authority_sha256: 'e'.repeat(64),
        }),
      ).toThrow(/immutable final tip/i);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans an exact claim-bound final hardlink before historical recovery', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-outbox-linked-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const value = request();
      const scope = evidenceCheckpointScopeSha256(value);
      expect(claimCheckpointTransition(root, scope, value)).toBe('CLAIMED');
      const version = value.next.version.toString().padStart(10, '0');
      const finalName = `${scope}-${version}-${value.next.manifest_sha256}.json`;
      const tempName = `.${finalName}.100.00000000-0000-4000-8000-000000000003.tmp`;
      writeFileSync(join(root, tempName), canonicalJsonBytes(value.next), { mode: 0o600 });
      linkSync(join(root, tempName), join(root, finalName));

      const recovered = recoverCommittedCheckpointProjection(store, {
        repository_id: value.repository_id,
        workspace_id: value.workspace_id,
        program_id: value.program_id,
        sprint_id: value.sprint_id,
        authority_sha256: value.authority_sha256,
        evidence_id: value.evidence_id,
        version: value.next.version,
      });
      expect(recovered?.manifest_sha256).toBe(value.next.manifest_sha256);
      expect(readdirSync(root)).not.toContain(tempName);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans an exact linked claim temp when the checkpoint final is already unique', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-outbox-claim-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const value = request();
      await expect(store.compareAndSet(value)).resolves.toBe('COMMITTED');
      const scope = evidenceCheckpointScopeSha256(value);
      const claimName = checkpointTransitionClaimName(scope);
      const claimTemp = `.${claimName}.101.00000000-0000-4000-8000-000000000003.tmp`;
      linkSync(join(root, claimName), join(root, claimTemp));
      jest.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));

      expect(() =>
        recoverCommittedCheckpointProjection(store, {
          repository_id: value.repository_id,
          workspace_id: value.workspace_id,
          program_id: value.program_id,
          sprint_id: value.sprint_id,
          authority_sha256: 'e'.repeat(64),
          evidence_id: value.evidence_id,
          version: value.next.version,
        }),
      ).toThrow(/immutable final tip/i);
      expect(readdirSync(root)).toContain(claimTemp);

      expect(
        recoverCommittedCheckpointProjection(store, {
          repository_id: value.repository_id,
          workspace_id: value.workspace_id,
          program_id: value.program_id,
          sprint_id: value.sprint_id,
          authority_sha256: value.authority_sha256,
          evidence_id: value.evidence_id,
          version: value.next.version,
        })?.manifest_sha256,
      ).toBe(value.next.manifest_sha256);
      expect(readdirSync(root)).not.toContain(claimTemp);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an over-budget historical checkpoint roster incrementally', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-outbox-budget-'));
    const store = new FileEvidenceCheckpointStore(
      root,
      checkpointStoreIdentityBytes('s01-checkpoint-store', root),
    );
    try {
      const value = request();
      await expect(store.compareAndSet(value)).resolves.toBe('COMMITTED');
      for (let index = 0; index < 4_097; index += 1) {
        writeFileSync(join(root, `.junk-${index.toString().padStart(4, '0')}`), '');
      }
      expect(() =>
        recoverCommittedCheckpointProjection(store, {
          repository_id: value.repository_id,
          workspace_id: value.workspace_id,
          program_id: value.program_id,
          sprint_id: value.sprint_id,
          authority_sha256: value.authority_sha256,
          evidence_id: value.evidence_id,
          version: value.next.version,
        }),
      ).toThrow(/entry limit/i);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
