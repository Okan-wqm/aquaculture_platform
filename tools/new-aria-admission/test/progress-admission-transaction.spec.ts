import {
  recoverCommittedCompletionProjection,
  recoveredCompletionProjectionBytes,
} from '../src/application/completion-publication-recovery';
import { verifyHistoricalCompletionProof } from '../src/application/historical-completion-proof';
import {
  commitPreparedSprintCompletion,
  prepareSprintCompletion,
  preparedCompletionProjectionBytes,
  snapshotCommittedCompletionProjection,
} from '../src/application/progress-admission';
import { verifyHistoricalS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { serializeAdmittedCompletionProjection } from '../src/runtime/projection-renderer';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';

function objectBytes(objects: ReadonlyMap<string, Uint8Array>, sha256: string): Uint8Array {
  const bytes = objects.get(`aria-evidence://sha256/${sha256}`);
  if (bytes === undefined) throw new TypeError('transaction fixture object is missing');
  return bytes;
}

describe('completion admission transaction', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('does not checkpoint until the exact staged historical proof is committed', async () => {
    const scenario = admissionInput();
    const current = scenario.context_input.progress_authority;
    const authority = verifyHistoricalS01ProgressAuthority({
      envelope_bytes: objectBytes(scenario.candidate.objects, current.envelope_sha256),
      trust_root_bytes: objectBytes(scenario.candidate.objects, current.trust_root_sha256),
      expected_trust_root_sha256: current.trust_root_sha256,
    });
    const prepared = prepareSprintCompletion(scenario.candidate, scenario.context);
    const artifact = preparedCompletionProjectionBytes(prepared);
    const recovery = {
      authority,
      checkpoint_store: scenario.context_input.checkpoint_store,
    };
    expect(recoverCommittedCompletionProjection(recovery)).toBeNull();

    const stagedProof = verifyHistoricalCompletionProof({
      authority,
      target: scenario.context_input.verified_target,
      candidate: scenario.candidate,
      evidence_trust_root_bytes: scenario.context_input.evidence_trust_root_bytes,
      execution_trust_root_bytes: scenario.context_input.execution_trust_root_bytes,
      event_policy_bytes: scenario.context_input.event_policy_bytes,
      freshness_policy_bytes: scenario.context_input.freshness_policy_bytes,
      projection_artifact_bytes: artifact,
    });
    await expect(commitPreparedSprintCompletion({ ...prepared }, stagedProof)).rejects.toThrow(
      /prepared completion.*issued/i,
    );
    expect(recoverCommittedCompletionProjection(recovery)).toBeNull();

    const inFlight = commitPreparedSprintCompletion(prepared, stagedProof);
    await expect(commitPreparedSprintCompletion(prepared, stagedProof)).rejects.toThrow(
      /in flight/i,
    );
    const committed = await inFlight;
    const projection = snapshotCommittedCompletionProjection(committed);
    expect(committed).toMatchObject({
      checkpoint_result: 'COMMITTED',
      authority_sha256: current.authority.sha256,
      evidence_id: current.authority.document.evidence_id,
      history_sha256: stagedProof.history_sha256,
      version: stagedProof.version,
      evidence_sha256: stagedProof.evidence_sha256,
      projection_sha256: stagedProof.projection_sha256,
    });
    expect(serializeAdmittedCompletionProjection(projection)).toEqual(artifact);
    const recovered = recoverCommittedCompletionProjection(recovery);
    expect(recovered).toMatchObject({
      authority_sha256: current.authority.sha256,
      evidence_sha256: stagedProof.evidence_sha256,
      projection_sha256: stagedProof.projection_sha256,
    });
    if (recovered === null) throw new TypeError('committed projection was not recovered');
    expect(recoveredCompletionProjectionBytes(recovered)).toEqual(artifact);
    expect(() => recoveredCompletionProjectionBytes({ ...recovered })).toThrow(/recovery.*issued/i);
    await expect(commitPreparedSprintCompletion(prepared, stagedProof)).rejects.toThrow(
      /already committed/i,
    );
  });
});
