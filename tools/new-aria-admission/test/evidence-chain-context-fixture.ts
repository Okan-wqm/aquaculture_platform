import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';

import { OracleBaselineInput, oracleBaselineInput } from './negative-control-fixture';

export interface ChainReference {
  readonly uri: string;
  readonly sha256: string;
}

interface ChainClaim {
  readonly program_id: string;
  readonly sprint_id: string;
  readonly state: 'DONE';
  readonly acceptance_ids: string[];
  readonly finding_ids: string[];
}

interface ChainTarget {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly deployed_sha: null;
}

interface ChainFreshness {
  readonly type: string;
  readonly observed_at: string;
  readonly valid_until: string;
  readonly invalidation_epochs: { readonly key: string; readonly epoch: string }[];
}

export const chainObservationTime = (version: number): string =>
  `2026-09-02T12:0${version}:00.000Z`;

export const chainClaim = (): ChainClaim => ({
  program_id: 'new-aria-autonomous-engineering',
  sprint_id: 'S01',
  state: 'DONE',
  acceptance_ids: ['ACC-EVD-001', 'ACC-S01'],
  finding_ids: ['ARIA-AUDIT-001', 'ARIA-AUDIT-026'],
});

export const chainTarget = (): ChainTarget => ({
  repository_id: 'repo-1',
  workspace_id: 'workspace-1',
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  deployed_sha: null,
});

export const chainFreshness = (version: number): ChainFreshness => ({
  type: 'SOURCE_CODE_ORACLE',
  observed_at: chainObservationTime(version),
  valid_until: `2026-09-02T13:0${version}:00.000Z`,
  invalidation_epochs: [{ key: 'source_head', epoch: `git:${'b'.repeat(40)}` }],
});

export function chainBaseline(
  version: number,
  report: ChainReference,
  artifact: ChainReference,
): OracleBaselineInput {
  return oracleBaselineInput({
    authority_sha256: 'd'.repeat(64),
    evidence_id: 'S01-code-proof',
    version,
    observation_id: `observation-${version.toString().padStart(4, '0')}`,
    observed_at: chainObservationTime(version),
    claim: chainClaim(),
    freshness: chainFreshness(version),
    target: chainTarget(),
    report,
    artifacts: [artifact],
  });
}

export function chainInputBytes(
  version: number,
  report: ChainReference,
  artifact: ChainReference,
): Uint8Array {
  return canonicalJsonBytes(chainBaseline(version, report, artifact));
}

export function chainInputReference(
  version: number,
  report: ChainReference,
  artifact: ChainReference,
): ChainReference {
  const bytes = chainInputBytes(version, report, artifact);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { uri: `aria-evidence://sha256/${sha256}`, sha256 };
}
