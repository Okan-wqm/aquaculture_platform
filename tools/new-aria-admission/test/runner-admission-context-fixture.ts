import { createHash } from 'node:crypto';

import { EvidenceManifest, EvidenceReference } from '../src/domain/evidence-contracts';
import { EvidenceCheckpointStore } from '../src/application/evidence-checkpoint';
import type { RepositoryExecutionSnapshot } from '../src/application/repository-execution-snapshot';
import {
  RepositoryTargetPort,
  verifyRepositoryTarget,
} from '../src/application/repository-target-verifier';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { S01_PROGRESS_AUTHORITY_SCOPE } from '../src/kernel/operator-progress-authority';

import { sourceFreshness } from './attestation-fixture';
import { oracleBaselineInput } from './negative-control-fixture';
import { digest } from './operator-authority-fixture';

export class RunnerTargetPort implements RepositoryTargetPort {
  readonly git_tool_id = 'git-2.43.0';
  readonly git_sha256 = '9'.repeat(64);
  resolved_ref_reads = 0;
  move_on_read: number | undefined;

  constructor(private readonly repositoryRoot: string) {}

  canonicalRoot(): string {
    return this.repositoryRoot;
  }
  resolveCommit(): string {
    this.resolved_ref_reads += 1;
    return this.move_on_read !== undefined && this.resolved_ref_reads >= this.move_on_read
      ? 'a'.repeat(40)
      : 'b'.repeat(40);
  }
  objectType(): string {
    return 'commit';
  }
  isAncestor(): boolean {
    return true;
  }
  mergeBase(): string {
    return 'a'.repeat(40);
  }

  captureExecutionSnapshot(): RepositoryExecutionSnapshot {
    const bytes = Buffer.from('immutable reviewed tree\n');
    const blobHeader = Buffer.from(`blob ${bytes.byteLength}\0`);
    return {
      head_sha: 'b'.repeat(40),
      tree_sha: 'c'.repeat(40),
      files: [
        {
          path: 'reviewed.txt',
          mode: '100644',
          blob_sha: createHash('sha1').update(blobHeader).update(bytes).digest('hex'),
          content_sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        },
      ],
    };
  }
}

export function verifiedRunnerTarget(repositoryRoot: string, port?: RunnerTargetPort) {
  return verifyRepositoryTarget(
    {
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      repository_root: repositoryRoot,
      reviewed_ref: 'refs/remotes/origin/reviewed',
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
    },
    port ?? new RunnerTargetPort(repositoryRoot),
  );
}

export class PassCheckpointStore implements EvidenceCheckpointStore {
  compareAndSet(): Promise<'COMMITTED'> {
    return Promise.resolve('COMMITTED');
  }
}

export function runnerAdmissionContext(
  authoritySha256: string,
  report: EvidenceReference,
  artifact: EvidenceReference,
  toolchainSha256: string,
  verifierSha256: string,
  baseSha = 'a'.repeat(40),
  headSha = 'b'.repeat(40),
) {
  const claim: EvidenceManifest['claim'] = {
    program_id: 'new-aria-autonomous-engineering',
    sprint_id: 'S01',
    state: 'DONE',
    acceptance_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.acceptance_ids],
    finding_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.finding_ids],
  };
  const freshness = sourceFreshness(authoritySha256, headSha, {
    toolchain: `sha256:${toolchainSha256}`,
    verifier: `sha256:${verifierSha256}`,
  });
  const target: EvidenceManifest['target'] = {
    repository_id: 'repo-1',
    workspace_id: 'workspace-1',
    base_sha: baseSha,
    head_sha: headSha,
    deployed_sha: null,
  };
  const baseline = oracleBaselineInput({
    authority_sha256: authoritySha256,
    evidence_id: 'S01-code-proof',
    version: 1,
    observation_id: 'observation-0001',
    observed_at: '2026-09-02T12:00:00.000Z',
    claim,
    freshness,
    target,
    report,
    artifacts: [artifact],
  });
  const inputObject = canonicalJsonBytes(baseline);
  const inputSha256 = digest(inputObject);
  return {
    claim,
    freshness,
    target,
    baseline,
    inputObject,
    inputReference: {
      uri: `aria-evidence://sha256/${inputSha256}`,
      sha256: inputSha256,
    },
  };
}
