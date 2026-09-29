import { commitEvidenceCheckpoint } from '../src/application/evidence-checkpoint';
import type {
  EvidenceCheckpointRequest,
  EvidenceCheckpointStore,
} from '../src/application/evidence-checkpoint';

import { checkpointProjectionCommitFields } from './checkpoint-projection-fixture';
import { completionFixture, evidenceManifestContract } from './progress-fixture';

class MutatingCheckpointStore implements EvidenceCheckpointStore {
  request?: EvidenceCheckpointRequest;
  mutationSucceeded?: boolean;

  async compareAndSet(request: EvidenceCheckpointRequest): Promise<'COMMITTED'> {
    this.request = request;
    await Promise.resolve();
    this.mutationSucceeded =
      Reflect.set(request.next, 'version', 99) ||
      (request.expected !== null &&
        Reflect.set(request.expected, 'manifest_sha256', '0'.repeat(64)));
    return 'COMMITTED';
  }
}

describe('evidence checkpoint ownership boundary', () => {
  it('passes a deeply immutable request and tips to an asynchronous store', async () => {
    const fixture = completionFixture();
    const store = new MutatingCheckpointStore();

    await commitEvidenceCheckpoint(
      {
        manifest: evidenceManifestContract(fixture.manifest),
        manifest_sha256: fixture.manifestSha256,
        history_sha256: '6'.repeat(64),
        ...checkpointProjectionCommitFields(),
        valid_from: '2026-09-02T12:00:00.000Z',
        valid_until: '2099-01-01T00:00:00.000Z',
      },
      store,
    );

    expect(store.mutationSucceeded).toBe(false);
    expect(Object.isFrozen(store.request)).toBe(true);
    expect(Object.isFrozen(store.request?.next)).toBe(true);
  });
});
