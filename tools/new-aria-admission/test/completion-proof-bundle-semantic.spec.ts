import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { verifyHistoricalS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { recoverCommittedCompletionProjection } from '../src/application/completion-publication-recovery';
import {
  commitPreparedSprintCompletion,
  prepareSprintCompletion,
  preparedCompletionProjectionBytes,
} from '../src/application/progress-admission';
import { CompletionProofBundlePublication } from '../src/runtime/completion-proof-bundle';
import { promoteStagedCompletionProofBundle } from '../src/runtime/completion-proof-bundle-promotion';
import {
  executeCurrentCompletionBundleCommand,
  executeRecoveredCompletionBundleCommand,
} from '../src/runtime/completion-proof-bundle-command';
import type { CompletionProofBundleSource } from '../src/runtime/completion-proof-bundle';
import {
  verifyHistoricalCompletionProofBundle,
  verifyStagedCompletionProofBundle,
} from '../src/runtime/completion-proof-bundle-verifier';

import {
  admissionInput,
  cleanupAdmissionFixtures,
  type AdmissionScenario,
} from './admission-fixture';
import { cliPath } from './cli-invocation-fixture';
import { gitPath, runGit } from './git-target-fixture';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function objectBytes(scenario: AdmissionScenario, sha256: string): Uint8Array {
  const bytes = scenario.candidate.objects.get(`aria-evidence://sha256/${sha256}`);
  if (bytes === undefined) throw new TypeError('completion bundle fixture object is absent');
  return bytes;
}

function source(
  scenario: AdmissionScenario,
  projectionArtifact: Uint8Array,
): CompletionProofBundleSource {
  const target = scenario.context_input.verified_target;
  const authority = scenario.context_input.progress_authority;
  return {
    target_request_bytes: canonicalJsonBytes({
      repository_id: target.repository_id,
      workspace_id: target.workspace_id,
      repository_root: target.repository_root,
      reviewed_ref: target.reviewed_ref,
      base_sha: target.base_sha,
      head_sha: target.head_sha,
    }),
    operator_envelope_bytes: objectBytes(scenario, authority.envelope_sha256),
    operator_trust_root_bytes: objectBytes(scenario, authority.trust_root_sha256),
    evidence_trust_root_bytes: scenario.context_input.evidence_trust_root_bytes,
    execution_trust_root_bytes: scenario.context_input.execution_trust_root_bytes,
    event_policy_bytes: scenario.context_input.event_policy_bytes,
    freshness_policy_bytes: scenario.context_input.freshness_policy_bytes,
    event_chain_bytes: scenario.candidate.event_bytes,
    manifest_bytes: scenario.candidate.manifest_bytes,
    objects: scenario.candidate.objects,
    evidence_attestation_bytes: scenario.candidate.evidence_attestation_bytes,
    projection_artifact_bytes: projectionArtifact,
  };
}

describe('portable completion proof bundle semantics', () => {
  let root: string;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    root = mkdtempSync(join(tmpdir(), 'new-aria-completion-proof-'));
    chmodSync(root, 0o700);
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
    rmSync(root, { recursive: true, force: true });
  });

  it('recomputes and promotes a final proof that remains historically valid after expiry', async () => {
    const scenario = admissionInput();
    const prepared = prepareSprintCompletion(scenario.candidate, scenario.context);
    const projectionPath = join(root, 'projection.json');
    writeFileSync(projectionPath, preparedCompletionProjectionBytes(prepared));
    const bundlePath = join(root, 'bundle');
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(source(scenario, preparedCompletionProjectionBytes(prepared)));
    publication.detachCandidate();
    const current = scenario.context_input.progress_authority;
    const historical = verifyHistoricalS01ProgressAuthority({
      envelope_bytes: objectBytes(scenario, current.envelope_sha256),
      trust_root_bytes: objectBytes(scenario, current.trust_root_sha256),
      expected_trust_root_sha256: current.trust_root_sha256,
    });
    const verification = {
      bundle_path: bundlePath,
      authority: historical,
      target: scenario.context_input.verified_target,
    };
    const verified = verifyStagedCompletionProofBundle(verification);
    const committed = await commitPreparedSprintCompletion(prepared, verified.historical_proof);
    const recovered = recoverCommittedCompletionProjection({
      authority: historical,
      checkpoint_store: scenario.context_input.checkpoint_store,
    });
    if (recovered === null) throw new TypeError('committed completion was not recovered');
    promoteStagedCompletionProofBundle(bundlePath, verified, recovered);
    expect(committed.checkpoint_tip).toEqual(recovered.checkpoint_tip);

    expect(
      executeCurrentCompletionBundleCommand({
        kind: 'verify-completion-bundle',
        bundle_path: bundlePath,
        operator_trust_root_sha256: current.trust_root_sha256,
        current_epoch_root: scenario.current_epoch_root,
        checkpoint_root: scenario.checkpoint_root,
        repository_root: scenario.context_input.verified_target.repository_root,
        projection_path: projectionPath,
        git_path: gitPath,
      }),
    ).toMatchObject({
      current: true,
      current_verdict: 'CURRENT',
      historical_verdict: 'HISTORICALLY_VALID',
    });

    scenario.write_current_epochs({ revision: 2, dependency_sha256: 'a'.repeat(64) });
    expect(() =>
      executeCurrentCompletionBundleCommand({
        kind: 'verify-completion-bundle',
        bundle_path: bundlePath,
        operator_trust_root_sha256: current.trust_root_sha256,
        current_epoch_root: scenario.current_epoch_root,
        checkpoint_root: scenario.checkpoint_root,
        repository_root: scenario.context_input.verified_target.repository_root,
        projection_path: projectionPath,
        git_path: gitPath,
      }),
    ).toThrow(/invalidated by the current epoch/i);

    const target = scenario.context_input.verified_target;
    writeFileSync(join(target.repository_root, 'reviewed.txt'), 'newer completion head\n');
    runGit(target.repository_root, 'commit', '--quiet', '-am', 'newer completion head');
    runGit(
      target.repository_root,
      'update-ref',
      target.reviewed_ref,
      runGit(target.repository_root, 'rev-parse', 'HEAD'),
    );
    expect(() =>
      executeCurrentCompletionBundleCommand({
        kind: 'verify-completion-bundle',
        bundle_path: bundlePath,
        operator_trust_root_sha256: current.trust_root_sha256,
        current_epoch_root: scenario.current_epoch_root,
        checkpoint_root: scenario.checkpoint_root,
        repository_root: scenario.context_input.verified_target.repository_root,
        projection_path: projectionPath,
        git_path: gitPath,
      }),
    ).toThrow(/reviewed ref|changed after verification/i);

    const relocatedRepositoryRoot = join(root, 'relocated-repository');
    renameSync(target.repository_root, relocatedRepositoryRoot);
    expect(
      executeRecoveredCompletionBundleCommand({
        bundle_path: bundlePath,
        operator_trust_root_sha256: current.trust_root_sha256,
        git_path: gitPath,
        repository_root: relocatedRepositoryRoot,
      }),
    ).toMatchObject({ head_sha: target.head_sha });
    jest.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    expect(verifyHistoricalCompletionProofBundle(verification)).toMatchObject({
      current: false,
      historical_verdict: 'HISTORICALLY_VALID',
    });
    const historyArgs = [
      cliPath,
      'verify-completion-bundle-history',
      '--bundle',
      bundlePath,
      '--operator-trust-root-sha256',
      current.trust_root_sha256,
      '--repository-root',
      relocatedRepositoryRoot,
      '--projection',
      projectionPath,
      '--git',
      gitPath,
    ];
    const processResult = spawnSync(process.execPath, historyArgs, {
      encoding: 'utf8',
      timeout: 900_000,
    });
    expect(processResult.status).toBe(0);
    expect(JSON.parse(processResult.stdout)).toMatchObject({
      contract_id: 'new-aria-completion-bundle-readback-v1',
      current: false,
      head_sha: target.head_sha,
      projection_sha256: verified.projection_sha256,
      verdict: 'HISTORICALLY_VALID',
    });
    expect(processResult.stderr).toBe('');
    writeFileSync(projectionPath, '{"manual":"edit"}\n');
    expect(spawnSync(process.execPath, historyArgs, { encoding: 'utf8' }).status).toBe(1);
  });

  it('rejects a semantically forged projection even if the marker is repinned', async () => {
    const scenario = admissionInput();
    const prepared = prepareSprintCompletion(scenario.candidate, scenario.context);
    const bundlePath = join(root, 'bundle');
    const publication = new CompletionProofBundlePublication(bundlePath);
    publication.stage(source(scenario, preparedCompletionProjectionBytes(prepared)));
    const projectionPath = join(bundlePath, 'payload', 'completion-projection.json');
    const projection = JSON.parse(readFileSync(projectionPath, 'utf8')) as Record<string, unknown>;
    projection.tail_event_hash = 'f'.repeat(64);
    const projectionBytes = Buffer.concat([canonicalJsonBytes(projection), Buffer.from('\n')]);
    writeFileSync(projectionPath, projectionBytes);
    const markerPath = join(bundlePath, 'CANDIDATE.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      files: { projection_artifact: { byte_length: number; sha256: string } };
    };
    marker.files.projection_artifact.byte_length = projectionBytes.byteLength;
    marker.files.projection_artifact.sha256 = digest(projectionBytes);
    writeFileSync(markerPath, Buffer.concat([canonicalJsonBytes(marker), Buffer.from('\n')]));
    const current = scenario.context_input.progress_authority;
    const authority = verifyHistoricalS01ProgressAuthority({
      envelope_bytes: objectBytes(scenario, current.envelope_sha256),
      trust_root_bytes: objectBytes(scenario, current.trust_root_sha256),
      expected_trust_root_sha256: current.trust_root_sha256,
    });

    expect(() =>
      verifyStagedCompletionProofBundle({
        bundle_path: bundlePath,
        authority,
        target: scenario.context_input.verified_target,
      }),
    ).toThrow(/projection differs/i);
    publication.abort();
  });
});
