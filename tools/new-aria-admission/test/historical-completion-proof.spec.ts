import {
  historicalCompletionProjectionBytes,
  verifyHistoricalCompletionProof,
} from '../src/application/historical-completion-proof';
import {
  loadCompletionProjectionArtifact,
  serializeCompletionProjectionArtifact,
} from '../src/kernel/completion-projection-artifact';
import { verifyHistoricalS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { serializeAdmittedCompletionProjection } from '../src/runtime/projection-renderer';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { admitScenario } from './admission-transaction-fixture';

function objectBytes(objects: ReadonlyMap<string, Uint8Array>, sha256: string): Uint8Array {
  const bytes = objects.get(`aria-evidence://sha256/${sha256}`);
  if (bytes === undefined) throw new TypeError('historical proof fixture object is missing');
  return bytes;
}

describe('historical completion proof', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('recomputes exact portable projection bytes after expiry and rejects asserted validity', async () => {
    const scenario = admissionInput();
    const admitted = await admitScenario(scenario);
    const expected = serializeAdmittedCompletionProjection(admitted);
    const current = scenario.context_input.progress_authority;
    const authority = verifyHistoricalS01ProgressAuthority({
      envelope_bytes: objectBytes(scenario.candidate.objects, current.envelope_sha256),
      trust_root_bytes: objectBytes(scenario.candidate.objects, current.trust_root_sha256),
      expected_trust_root_sha256: current.trust_root_sha256,
    });
    const input = {
      authority,
      target: scenario.context_input.verified_target,
      candidate: scenario.candidate,
      evidence_trust_root_bytes: scenario.context_input.evidence_trust_root_bytes,
      execution_trust_root_bytes: scenario.context_input.execution_trust_root_bytes,
      event_policy_bytes: scenario.context_input.event_policy_bytes,
      freshness_policy_bytes: scenario.context_input.freshness_policy_bytes,
      projection_artifact_bytes: expected,
    };

    jest.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const proof = verifyHistoricalCompletionProof(input);
    expect(historicalCompletionProjectionBytes(proof)).toEqual(expected);
    expect(proof).toMatchObject({
      current: false,
      historical_verdict: 'HISTORICALLY_VALID',
      valid_from: '2026-09-02T12:05:00.000Z',
    });

    const projection = loadCompletionProjectionArtifact(expected);
    const changed = serializeCompletionProjectionArtifact({
      ...projection,
      valid_from: '2026-09-02T12:06:00.000Z',
    });
    expect(() =>
      verifyHistoricalCompletionProof({ ...input, projection_artifact_bytes: changed }),
    ).toThrow(/projection.*recomputation/i);
  });
});
