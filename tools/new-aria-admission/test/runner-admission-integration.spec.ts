import { serializeCompletionProjectionArtifact } from '../src/kernel/completion-projection-artifact';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { admitScenario } from './admission-transaction-fixture';

describe('finalized runner roster to completion admission', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('admits the exact signed five-run roster through a provisioned durable store', async () => {
    const scenario = admissionInput();
    const manifest = scenario.fixture.manifest;

    expect(manifest.execution.run_id).toBe('BASELINE');
    expect(manifest.execution.input_object_sha256s).toHaveLength(4);
    expect(manifest.oracle.negative_controls).toHaveLength(4);
    expect(
      manifest.oracle.negative_controls.map(({ expected_verdict }) => expected_verdict),
    ).toEqual(['REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);

    const first = await admitScenario(scenario);
    const replay = await admitScenario(scenario);

    expect(first).toMatchObject({ state: 'DONE', freshness: 'VALID_AT' });
    expect(serializeCompletionProjectionArtifact(replay)).toEqual(
      serializeCompletionProjectionArtifact(first),
    );
  });
});
