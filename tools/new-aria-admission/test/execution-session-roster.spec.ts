import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  abortRepositoryExecutionSession,
  closeRepositoryExecutionSession,
  finalizeExecutableRun,
  openRepositoryExecutionSession,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';
import type {
  ExecutableRunResult,
  RepositoryExecutionSession,
} from '../src/runtime/executable-runner';
import {
  attestExecutableRun,
  loadExecutionSigningCapability,
} from '../src/runtime/execution-signer';

import { executionPrivateKeyBytes } from './execution-receipt-fixture';
import { verifiedGitTarget } from './git-target-fixture';
import { productionVerifierFixture } from './production-verifier-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const verifierPath = join(
  workspaceRoot,
  'dist/tools/new-aria-admission/verifier/admission-verifier.cjs',
);
type Fixture = ReturnType<typeof productionVerifierFixture>;
let fixture: Fixture | undefined;

function active(): Fixture {
  if (fixture === undefined) throw new TypeError('production verifier fixture is absent');
  return fixture;
}

describe('production repository execution roster', () => {
  let session: RepositoryExecutionSession | undefined;

  beforeAll(() => {
    fixture = productionVerifierFixture(verifierPath);
  });

  afterAll(() => {
    if (session !== undefined) abortRepositoryExecutionSession(session);
    if (fixture !== undefined) {
      fixture.current_epoch_provider.close();
      rmSync(fixture.repository.root, { force: true, recursive: true });
      rmSync(fixture.epoch_store_root, { force: true, recursive: true });
    }
  });

  it('runs and signs one baseline plus the exact four registered controls', () => {
    const value = active();
    const target = verifiedGitTarget(value.repository);
    const capability = loadExecutionSigningCapability({
      authority: value.authority,
      trust_root_bytes: value.execution_trust_root_bytes,
      evidence_trust_root_bytes: value.evidence_trust_root_bytes,
      private_key_pkcs8_der: executionPrivateKeyBytes(),
    });
    session = openRepositoryExecutionSession({
      authority: value.authority,
      target,
      signing_capability: capability,
      execution_trust_root_bytes: value.execution_trust_root_bytes,
      current_epoch_provider: value.current_epoch_provider,
    });
    const runs = [value.roster.baseline_run, ...value.roster.controls];
    const finalized: ExecutableRunResult[] = [];
    for (const run of runs) {
      const args =
        run.run_id === 'BASELINE'
          ? value.baseline_args
          : [...value.baseline_args, '--negative-control', run.run_id];
      const pending = runVerifierExecutable({
        session,
        run_id: run.run_id,
        run_context_sha256: run.run_context_sha256,
        tool_path: verifierPath,
        tool_sha256: value.authority.authority.document.verifier_sha256,
        runtime_sha256: value.authority.authority.document.toolchain_sha256,
        tool_id: value.authority.authority.document.verifier_tool_id,
        input_envelope_bytes: run.envelope.bytes,
        args,
      });
      const receipt = attestExecutableRun(capability, {
        authority: value.authority,
        target,
        run: pending,
      });
      finalized.push(finalizeExecutableRun(session, pending, receipt));
    }
    expect(
      finalized.map(({ evidence }) => [
        evidence.run_id,
        evidence.process.exit_code,
        evidence.result.semantic_verdict,
        evidence.input_object_sha256s.length,
      ]),
    ).toEqual([
      ['BASELINE', 0, 'PASSED', 4],
      ['NC-S01-EVENT-HASH-TAMPER', 1, 'FAILED', 6],
      ['NC-S01-EVIDENCE-DIGEST-TAMPER', 1, 'FAILED', 6],
      ['NC-S01-STALE-EVIDENCE', 1, 'FAILED', 6],
      ['NC-S01-UNAUTHORIZED-TARGET', 1, 'FAILED', 6],
    ]);
    const roster = closeRepositoryExecutionSession(session);
    session = undefined;
    expect(roster).toMatchObject({
      execution_session_id: value.authority.authority.document.execution_session_id,
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      tree_sha: target.tree_sha,
    });
  });
});
