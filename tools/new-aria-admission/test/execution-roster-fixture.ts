import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { canonicalRegisteredNegativeControl } from '../src/kernel/negative-control-registry';

import { executionInputEnvelope } from './execution-input-envelope-fixture';
import { oracleBaselineInput } from './negative-control-fixture';
import type { OracleBaselineInput } from './negative-control-fixture';
import { digest } from './operator-authority-fixture';

export const controlFacts = [
  ['NC-S01-EVENT-HASH-TAMPER', 'EVENT-CONTEXT-PROBE-TAMPER'],
  ['NC-S01-EVIDENCE-DIGEST-TAMPER', 'EVIDENCE-CONTEXT-PROBE-TAMPER'],
  ['NC-S01-STALE-EVIDENCE', 'STALE-EVIDENCE'],
  ['NC-S01-UNAUTHORIZED-TARGET', 'UNAUTHORIZED-TARGET'],
] as const;

interface RosterTarget {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
}

export interface ExecutionAuthenticationObjects {
  readonly operator_envelope_bytes: Uint8Array;
  readonly operator_trust_root_bytes: Uint8Array;
  readonly current_epoch_snapshot_bytes: Uint8Array;
}

function requiredDigest(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined) throw new TypeError('execution roster digest is missing');
  return value;
}

export function createExecutionRoster(
  target: RosterTarget,
  authoritySha256: string,
  authentication?: ExecutionAuthenticationObjects,
  baselineOverride?: OracleBaselineInput,
) {
  const baseline =
    baselineOverride ??
    oracleBaselineInput({
      authority_sha256: authoritySha256,
      evidence_id: 'S01-code-proof',
      version: 1,
      observation_id: 'observation-0001',
      observed_at: '2026-09-02T12:30:00.000Z',
      claim: { program_id: 'new-aria-autonomous-engineering', sprint_id: 'S01' },
      freshness: {
        observed_at: '2026-09-02T12:30:00.000Z',
        valid_until: '2026-09-02T13:00:00.000Z',
      },
      target,
      report: { sha256: '4'.repeat(64) },
      artifacts: [{ sha256: '5'.repeat(64), uri: `aria-evidence://sha256/${'5'.repeat(64)}` }],
    });
  const authenticatedObjects =
    authentication === undefined
      ? []
      : [
          authentication.operator_envelope_bytes,
          authentication.operator_trust_root_bytes,
          authentication.current_epoch_snapshot_bytes,
        ];
  const baselineEnvelope = executionInputEnvelope([
    canonicalJsonBytes(baseline),
    ...authenticatedObjects,
  ]);
  const controls = controlFacts.map(([runId, mutationKind], index) => {
    const registered = canonicalRegisteredNegativeControl(index, runId, mutationKind, baseline);
    const mutatedInputSha256 = digest(registered.bytes);
    const mutantDocument = canonicalJsonBytes({
      baseline_input_sha256: requiredDigest(baselineEnvelope.object_sha256s, 0),
      contract_id: 'new-aria-negative-control-mutant-v1',
      control_id: runId,
      implementation_sha256: '2'.repeat(64),
      mutated_input: {
        sha256: mutatedInputSha256,
        uri: `aria-evidence://sha256/${mutatedInputSha256}`,
      },
      mutation_kind: mutationKind,
      oracle_id: 'new-aria-s01-admission-oracle',
      run_context_sha256: baseline.run_context_sha256,
      schema_version: '1.0.0',
    });
    return Object.freeze({
      run_id: runId,
      run_context_sha256: baseline.run_context_sha256,
      envelope: executionInputEnvelope([
        canonicalJsonBytes(baseline),
        ...authenticatedObjects,
        mutantDocument,
        registered.bytes,
      ]),
    });
  });
  return Object.freeze({
    baseline,
    baseline_run: Object.freeze({
      run_id: 'BASELINE',
      run_context_sha256: baseline.run_context_sha256,
      envelope: baselineEnvelope,
    }),
    controls: Object.freeze(controls),
  });
}
