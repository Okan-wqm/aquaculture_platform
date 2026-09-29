import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import type { CompletionProofBundleSource } from '../src/runtime/completion-proof-bundle';

import type { AdmissionScenario } from './admission-fixture';
import { gitPath } from './git-target-fixture';

function write(root: string, name: string, bytes: Uint8Array): string {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

function authorityObject(scenario: AdmissionScenario, sha256: string): Uint8Array {
  const bytes = scenario.candidate.objects.get(`aria-evidence://sha256/${sha256}`);
  if (bytes === undefined) throw new TypeError('completion command authority object is absent');
  return bytes;
}

export function completionProofBundleSource(
  scenario: AdmissionScenario,
  projectionArtifactBytes: Uint8Array,
): CompletionProofBundleSource {
  const target = scenario.context_input.verified_target;
  const authority = scenario.context_input.progress_authority;
  return Object.freeze({
    target_request_bytes: canonicalJsonBytes({
      repository_id: target.repository_id,
      workspace_id: target.workspace_id,
      repository_root: target.repository_root,
      reviewed_ref: target.reviewed_ref,
      base_sha: target.base_sha,
      head_sha: target.head_sha,
    }),
    operator_envelope_bytes: authorityObject(scenario, authority.envelope_sha256),
    operator_trust_root_bytes: authorityObject(scenario, authority.trust_root_sha256),
    evidence_trust_root_bytes: scenario.context_input.evidence_trust_root_bytes,
    execution_trust_root_bytes: scenario.context_input.execution_trust_root_bytes,
    event_policy_bytes: scenario.context_input.event_policy_bytes,
    freshness_policy_bytes: scenario.context_input.freshness_policy_bytes,
    event_chain_bytes: scenario.candidate.event_bytes,
    manifest_bytes: scenario.candidate.manifest_bytes,
    objects: scenario.candidate.objects,
    evidence_attestation_bytes: scenario.candidate.evidence_attestation_bytes,
    projection_artifact_bytes: projectionArtifactBytes,
  });
}

export interface CompletionCommandFixture {
  readonly request_path: string;
  readonly output_path: string;
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
  readonly current_epoch_root: string;
  readonly removable_source_paths: readonly string[];
}

export function completionCommandFixture(
  root: string,
  scenario: AdmissionScenario,
): CompletionCommandFixture {
  const target = scenario.context_input.verified_target;
  const authority = scenario.context_input.progress_authority;
  const targetPath = write(
    root,
    'target.json',
    canonicalJsonBytes({
      repository_id: target.repository_id,
      workspace_id: target.workspace_id,
      repository_root: target.repository_root,
      reviewed_ref: target.reviewed_ref,
      base_sha: target.base_sha,
      head_sha: target.head_sha,
    }),
  );
  const operatorEnvelopePath = write(
    root,
    'operator-envelope.json',
    authorityObject(scenario, authority.envelope_sha256),
  );
  const operatorRootPath = write(
    root,
    'operator-root.json',
    authorityObject(scenario, authority.trust_root_sha256),
  );
  const sourcePaths = [
    targetPath,
    write(root, 'evidence-root.json', scenario.context_input.evidence_trust_root_bytes),
    write(root, 'execution-root.json', scenario.context_input.execution_trust_root_bytes),
    write(root, 'event-policy.json', scenario.context_input.event_policy_bytes),
    write(root, 'freshness-policy.json', scenario.context_input.freshness_policy_bytes),
    write(root, 'event-chain.jsonl', scenario.candidate.event_bytes),
    write(root, 'attestation.json', scenario.candidate.evidence_attestation_bytes),
    ...scenario.candidate.manifest_bytes.map((bytes, index) =>
      write(root, `manifest-${index.toString()}.json`, bytes),
    ),
  ];
  const objectDescriptors = [...scenario.candidate.objects].map(([uri, bytes], index) => ({
    uri,
    path: write(root, `object-${index.toString()}.bin`, bytes),
  }));
  sourcePaths.push(...objectDescriptors.map(({ path }) => path));
  const requestPath = write(
    root,
    'completion-request.json',
    canonicalJsonBytes({
      schema_version: '1.0.0',
      contract_id: 'new-aria-completion-admission-request-v1',
      target_request_path: targetPath,
      git_path: gitPath,
      git_sha256: authority.authority.document.git_tool_sha256,
      operator_envelope_path: operatorEnvelopePath,
      operator_trust_root_path: operatorRootPath,
      evidence_trust_root_path: sourcePaths[1],
      execution_trust_root_path: sourcePaths[2],
      event_policy_path: sourcePaths[3],
      freshness_policy_path: sourcePaths[4],
      event_chain_path: sourcePaths[5],
      manifest_paths: sourcePaths.slice(7, 7 + scenario.candidate.manifest_bytes.length),
      objects: objectDescriptors,
      evidence_attestation_path: sourcePaths[6],
    }),
  );
  return Object.freeze({
    request_path: requestPath,
    output_path: join(root, 'completion-projection.json'),
    bundle_path: join(root, 'completion-bundle'),
    operator_trust_root_sha256: authority.trust_root_sha256,
    current_epoch_root: scenario.current_epoch_root,
    removable_source_paths: Object.freeze(sourcePaths),
  });
}
