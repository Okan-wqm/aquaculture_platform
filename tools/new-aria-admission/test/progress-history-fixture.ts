import type {
  EvidenceReference,
  EvidenceTransitionManifest,
  EvidenceTransitionState,
} from '../src/domain/evidence-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';

import { progressEvidenceContext } from './progress-evidence-context-fixture';
import type { ProgressTargetFixture } from './progress-target-fixture';

export function transitionManifestBytes(
  authoritySha256: string,
  state: EvidenceTransitionState,
  version: number,
  previousManifestSha256: string | null,
  target: ProgressTargetFixture,
  report: EvidenceReference,
  artifact: EvidenceReference,
): Buffer {
  const context = progressEvidenceContext(
    authoritySha256,
    report,
    artifact,
    version,
    `observation-${version.toString().padStart(4, '0')}`,
    target,
  );
  const value: EvidenceTransitionManifest = {
    schema_version: '1.0.0',
    contract_id: 'aria-evidence-manifest-v1',
    evidence_id: 'S01-code-proof',
    version,
    previous_manifest_sha256: previousManifestSha256,
    observed_at: `2026-09-02T11:${(56 + version).toString().padStart(2, '0')}:00.000Z`,
    observation_id: `observation-${version.toString().padStart(4, '0')}`,
    authority_sha256: authoritySha256,
    claim: { ...context.claim, state },
    identities: {
      producer_principal_id: 'producer-1',
      reviewer_principal_id: 'reviewer-1',
      oracle_principal_id: 'oracle-1',
      appellate_principal_id: 'appellate-1',
    },
    target: context.target,
  };
  return Buffer.from(`${canonicalJsonBytes(value).toString()}\n`);
}
