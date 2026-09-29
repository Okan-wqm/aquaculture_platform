import { createHash } from 'node:crypto';

import { EvidenceManifest, EvidenceReference } from '../src/domain/evidence-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import type { JsonRecord } from '../src/kernel/evidence-object';
import { S01_PROGRESS_AUTHORITY_SCOPE } from '../src/kernel/operator-progress-authority';

import { sourceFreshness } from './attestation-fixture';
import { OracleBaselineInput, oracleBaselineInput } from './negative-control-fixture';
import { defaultProgressTarget } from './progress-target-fixture';
import type { ProgressTargetFixture } from './progress-target-fixture';

interface ProgressEvidenceContext {
  readonly claim: EvidenceManifest['claim'];
  readonly freshness: EvidenceManifest['freshness'];
  readonly target: EvidenceManifest['target'];
  readonly baseline: OracleBaselineInput;
  readonly inputObject: Uint8Array;
  readonly inputReference: EvidenceReference;
}

const referenceFor = (bytes: Uint8Array): EvidenceReference => {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { uri: `aria-evidence://sha256/${sha256}`, sha256 };
};

export function progressEvidenceContext(
  authoritySha256: string,
  report: EvidenceReference,
  artifact: EvidenceReference,
  evidenceVersion = 1,
  observationId = 'observation-0001',
  sourceTarget: ProgressTargetFixture = defaultProgressTarget(),
  verificationDossier?: JsonRecord,
): ProgressEvidenceContext {
  const claim: EvidenceManifest['claim'] = {
    program_id: 'new-aria-autonomous-engineering',
    sprint_id: 'S01',
    state: 'DONE',
    acceptance_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.acceptance_ids],
    finding_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.finding_ids],
  };
  const freshness = sourceFreshness(authoritySha256, sourceTarget.head_sha);
  const target: EvidenceManifest['target'] = {
    repository_id: 'repo-1',
    workspace_id: 'workspace-1',
    base_sha: sourceTarget.base_sha,
    head_sha: sourceTarget.head_sha,
    deployed_sha: null,
  };
  const baseline = oracleBaselineInput({
    authority_sha256: authoritySha256,
    evidence_id: 'S01-code-proof',
    version: evidenceVersion,
    observation_id: observationId,
    observed_at: '2026-09-02T12:00:00.000Z',
    claim,
    freshness,
    target,
    report,
    artifacts: [artifact],
    verification_dossier: verificationDossier,
  });
  const inputObject = canonicalJsonBytes(baseline);
  return {
    claim,
    freshness,
    target,
    baseline,
    inputObject,
    inputReference: referenceFor(inputObject),
  };
}
