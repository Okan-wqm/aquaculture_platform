import { verifyHistoricalCompletionProof } from '../src/application/historical-completion-proof';
import {
  commitPreparedSprintCompletion,
  prepareSprintCompletion,
  preparedCompletionProjectionBytes,
  snapshotCommittedCompletionProjection,
} from '../src/application/progress-admission';
import type { CompletionProjection } from '../src/domain/progress-contracts';
import { verifyHistoricalS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import type { AdmissionScenario } from './admission-fixture';

function objectBytes(objects: ReadonlyMap<string, Uint8Array>, sha256: string): Uint8Array {
  const bytes = objects.get(`aria-evidence://sha256/${sha256}`);
  if (bytes === undefined) throw new TypeError('admission transaction object is missing');
  return bytes;
}

export async function admitScenario(scenario: AdmissionScenario): Promise<CompletionProjection> {
  const current = scenario.context_input.progress_authority;
  const authority = verifyHistoricalS01ProgressAuthority({
    envelope_bytes: objectBytes(scenario.candidate.objects, current.envelope_sha256),
    trust_root_bytes: objectBytes(scenario.candidate.objects, current.trust_root_sha256),
    expected_trust_root_sha256: current.trust_root_sha256,
  });
  const prepared = prepareSprintCompletion(scenario.candidate, scenario.context);
  const historicalProof = verifyHistoricalCompletionProof({
    authority,
    target: scenario.context_input.verified_target,
    candidate: scenario.candidate,
    evidence_trust_root_bytes: scenario.context_input.evidence_trust_root_bytes,
    execution_trust_root_bytes: scenario.context_input.execution_trust_root_bytes,
    event_policy_bytes: scenario.context_input.event_policy_bytes,
    freshness_policy_bytes: scenario.context_input.freshness_policy_bytes,
    projection_artifact_bytes: preparedCompletionProjectionBytes(prepared),
  });
  const committed = await commitPreparedSprintCompletion(prepared, historicalProof);
  return snapshotCommittedCompletionProjection(committed);
}
