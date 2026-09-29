import {
  recoverCommittedCompletionProjection,
  recoveredCompletionProjectionBytes,
} from '../src/application/completion-publication-recovery';
import { verifyHistoricalS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import {
  renderCompletionProjection,
  serializeAdmittedCompletionProjection,
} from '../src/runtime/projection-renderer';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { admitScenario } from './admission-transaction-fixture';

function objectBytes(objects: ReadonlyMap<string, Uint8Array>, sha256: string): Uint8Array {
  const bytes = objects.get(`aria-evidence://sha256/${sha256}`);
  if (bytes === undefined) throw new TypeError('publication recovery fixture object is missing');
  return bytes;
}

describe('completion projection publication recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('recovers exact committed bytes after expiry without opening a new admission', async () => {
    const scenario = admissionInput();
    const admitted = await admitScenario(scenario);
    const expected = serializeAdmittedCompletionProjection(admitted);
    const current = scenario.context_input.progress_authority;
    const objects = scenario.candidate.objects;
    jest.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    expect(() => renderCompletionProjection(admitted)).toThrow(/no longer current/i);
    const historical = verifyHistoricalS01ProgressAuthority({
      envelope_bytes: objectBytes(objects, current.envelope_sha256),
      trust_root_bytes: objectBytes(objects, current.trust_root_sha256),
      expected_trust_root_sha256: current.trust_root_sha256,
    });
    const recovery = {
      authority: historical,
      checkpoint_store: scenario.context_input.checkpoint_store,
    };
    scenario.candidate.event_bytes.fill(0);
    scenario.candidate.manifest_bytes.forEach((bytes) => bytes.fill(0));
    scenario.candidate.evidence_attestation_bytes.fill(0);
    for (const bytes of scenario.candidate.objects.values()) bytes.fill(0);

    const recovered = recoverCommittedCompletionProjection(recovery);
    if (recovered === null) throw new TypeError('completion projection was not recovered');
    expect(recoveredCompletionProjectionBytes(recovered)).toEqual(expected);
    expect(recovered.checkpoint_tip).toMatchObject({
      authority_sha256: historical.authority.sha256,
      evidence_id: historical.authority.document.evidence_id,
      version: historical.authority.document.evidence_version,
    });
  });
});
