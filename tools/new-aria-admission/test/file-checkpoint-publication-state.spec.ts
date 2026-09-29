import { existsSync, linkSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkpointTransitionClaimName,
  claimCheckpointTransition,
} from '../src/adapters/file-checkpoint-transition-claim';
import { FileEvidenceCheckpointStore } from '../src/adapters/file-evidence-checkpoint-store';
import {
  evidenceCheckpointScopeSha256,
  type EvidenceCheckpointRequest,
} from '../src/application/evidence-checkpoint';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';

import { checkpointProjectionTipFields } from './checkpoint-projection-fixture';

const uuid = '00000000-0000-4000-8000-000000000003';

function request(validUntil = '2099-01-01T00:00:00.000Z'): EvidenceCheckpointRequest {
  return {
    repository_id: 'repo-checkpoint-recovery',
    workspace_id: 'workspace-checkpoint-recovery',
    program_id: 'program-checkpoint-recovery',
    sprint_id: 'S01',
    authority_sha256: 'a'.repeat(64),
    evidence_id: 'evidence-checkpoint-recovery',
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: validUntil,
    expected: null,
    next: {
      authority_sha256: 'a'.repeat(64),
      evidence_id: 'evidence-checkpoint-recovery',
      version: 1,
      manifest_sha256: 'b'.repeat(64),
      history_sha256: 'c'.repeat(64),
      ...checkpointProjectionTipFields(),
    },
  };
}

function namesFor(value: EvidenceCheckpointRequest): {
  readonly claim: string;
  readonly final: string;
  readonly record_temp: string;
  readonly claim_temp: string;
} {
  const scope = evidenceCheckpointScopeSha256(value);
  const version = value.next.version.toString().padStart(10, '0');
  const final = `${scope}-${version}-${value.next.manifest_sha256}.json`;
  const claim = checkpointTransitionClaimName(scope);
  return {
    claim,
    final,
    record_temp: `.${final}.100.${uuid}.tmp`,
    claim_temp: `.${claim}.101.${uuid}.tmp`,
  };
}

function storeAt(root: string): FileEvidenceCheckpointStore {
  return new FileEvidenceCheckpointStore(
    root,
    checkpointStoreIdentityBytes('s01-checkpoint-store', root),
  );
}

describe('checkpoint publication crash state machine', () => {
  it('resumes exact claim and record pre-link states only inside the validity window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-pending-'));
    const store = storeAt(root);
    try {
      const value = request();
      const names = namesFor(value);
      const scope = evidenceCheckpointScopeSha256(value);
      expect(claimCheckpointTransition(root, scope, value)).toBe('CLAIMED');
      linkSync(join(root, names.claim), join(root, names.claim_temp));
      writeFileSync(join(root, names.record_temp), canonicalJsonBytes(value.next), { mode: 0o600 });

      await expect(store.compareAndSet(value)).resolves.toBe('ALREADY_COMMITTED');
      expect(readdirSync(root)).toEqual(expect.arrayContaining([names.claim, names.final]));
      expect(readdirSync(root)).not.toEqual(
        expect.arrayContaining([names.claim_temp, names.record_temp]),
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not promote an expired exact pre-link record temp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-expired-'));
    const store = storeAt(root);
    try {
      const value = request('2026-01-02T00:00:00.000Z');
      const names = namesFor(value);
      const scope = evidenceCheckpointScopeSha256(value);
      expect(claimCheckpointTransition(root, scope, value)).toBe('CLAIMED');
      writeFileSync(join(root, names.record_temp), canonicalJsonBytes(value.next), { mode: 0o600 });

      await expect(store.compareAndSet(value)).resolves.toBe('CONFLICT');
      expect(existsSync(join(root, names.final))).toBe(false);
      expect(existsSync(join(root, names.record_temp))).toBe(true);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finishes publication cleanup after expiry when the exact final is already linked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-linked-'));
    const store = storeAt(root);
    try {
      const value = request('2026-01-02T00:00:00.000Z');
      const names = namesFor(value);
      const scope = evidenceCheckpointScopeSha256(value);
      expect(claimCheckpointTransition(root, scope, value)).toBe('CLAIMED');
      linkSync(join(root, names.claim), join(root, names.claim_temp));
      writeFileSync(join(root, names.record_temp), canonicalJsonBytes(value.next), { mode: 0o600 });
      linkSync(join(root, names.record_temp), join(root, names.final));

      await expect(store.compareAndSet(value)).resolves.toBe('ALREADY_COMMITTED');
      expect(readdirSync(root)).toEqual(expect.arrayContaining([names.claim, names.final]));
      expect(readdirSync(root)).not.toEqual(
        expect.arrayContaining([names.claim_temp, names.record_temp]),
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
