import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { oracleBaselineRunContext } from '../src/kernel/oracle-baseline';
import { readVerifierSemanticVerdict } from '../src/runtime/verifier-output';

import { executionInputEnvelope } from './execution-input-envelope-fixture';
import { productionVerifierFixture } from './production-verifier-fixture';
import { digest } from './operator-authority-fixture';
import { verifierDossier } from './verifier-dossier-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const verifierPath = join(
  workspaceRoot,
  'dist/tools/new-aria-admission/verifier/admission-verifier.cjs',
);
type Fixture = ReturnType<typeof productionVerifierFixture>;
let fixture: Fixture | undefined;

function activeFixture(): Fixture {
  if (fixture === undefined) throw new TypeError('production verifier fixture is absent');
  return fixture;
}

function invoke(input: Uint8Array, controlId?: string) {
  const value = activeFixture();
  const args =
    controlId === undefined
      ? value.baseline_args
      : [...value.baseline_args, '--negative-control', controlId];
  return spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: value.repository.root,
    input,
  });
}

beforeEach(() => {
  fixture = productionVerifierFixture(verifierPath);
});

afterEach(() => {
  if (fixture !== undefined) {
    fixture.current_epoch_provider.close();
    rmSync(fixture.repository.root, { force: true, recursive: true });
    rmSync(fixture.epoch_store_root, { force: true, recursive: true });
  }
  fixture = undefined;
});

describe('production admission verifier executable', () => {
  it('authenticates and recomputes a real reviewed VERIFYING dossier', () => {
    const value = activeFixture();
    const result = invoke(value.roster.baseline_run.envelope.bytes);

    expect(result.status).toBe(0);
    expect(result.stderr).toHaveLength(0);
    expect(
      readVerifierSemanticVerdict(result.stdout, {
        run_id: 'BASELINE',
        run_context_sha256: value.roster.baseline_run.run_context_sha256,
        baseline_input_sha256: value.roster.baseline_run.envelope.object_sha256s[0],
        input_object_sha256s: value.roster.baseline_run.envelope.object_sha256s,
      }),
    ).toBe('PASSED');
  });

  it.each([0, 1, 2, 3])(
    'runs registered raw mutation %i through the same authenticated validator',
    (index) => {
      const value = activeFixture();
      const control = value.roster.controls[index];
      if (control === undefined) throw new TypeError('registered control fixture is absent');
      const result = invoke(control.envelope.bytes, control.run_id);

      expect(result.status).toBe(1);
      expect(
        readVerifierSemanticVerdict(result.stdout, {
          run_id: control.run_id,
          run_context_sha256: control.run_context_sha256,
          baseline_input_sha256: control.envelope.object_sha256s[0],
          input_object_sha256s: control.envelope.object_sha256s,
        }),
      ).toBe('FAILED');
    },
  );

  it('rejects repository artifact tamper even when the dossier stays self-consistent', () => {
    const value = activeFixture();
    writeFileSync(join(value.repository.root, 'reviewed.txt'), 'tampered\n');

    const result = invoke(value.roster.baseline_run.envelope.bytes);

    expect(result.status).toBe(2);
    expect(result.stdout).toHaveLength(0);
  });

  it('rejects a coherently rehashed alternate plan under the unchanged signed authority', () => {
    const value = activeFixture();
    const document = value.authority.authority.document;
    const artifact = Buffer.from('alternate\n');
    writeFileSync(join(value.repository.root, 'reviewed.txt'), artifact);
    const dossier = verifierDossier({
      authority_sha256: value.authority.authority.sha256,
      repository_id: document.repository_id,
      workspace_id: document.workspace_id,
      base_sha: document.base_sha,
      head_sha: document.head_sha,
      evidence_id: document.evidence_id,
      verification_time: value.verification_time,
      valid_until: value.valid_until,
      epoch_provider_id: document.invalidation_epoch_provider_id,
      epoch_provider_identity_sha256: document.invalidation_epoch_provider_identity_sha256,
      dependency_sha256: document.dependency_sha256,
      policy_epoch_sha256: document.policy_epoch_sha256,
      toolchain_sha256: document.toolchain_sha256,
      verifier_sha256: document.verifier_sha256,
      repository_artifact_bytes: artifact,
    });
    const staticScope = {
      authority_sha256: value.baseline.authority_sha256,
      repository_id: value.baseline.repository_id,
      workspace_id: value.baseline.workspace_id,
      base_sha: value.baseline.base_sha,
      head_sha: value.baseline.head_sha,
      evidence_id: value.baseline.evidence_id,
      program_id: value.baseline.program_id,
      sprint_id: value.baseline.sprint_id,
      event_policy_sha256: value.baseline.event_policy_sha256,
      freshness_policy_sha256: value.baseline.freshness_policy_sha256,
      epoch_provider_id: value.baseline.epoch_provider_id,
      epoch_provider_identity_sha256: value.baseline.epoch_provider_identity_sha256,
      verification_plan_sha256: digest(canonicalJsonBytes(dossier.plan)),
    };
    const alternate = {
      schema_version: '1.0.0',
      contract_id: 'new-aria-oracle-baseline-input-v4',
      run_context_sha256: oracleBaselineRunContext(staticScope),
      ...staticScope,
      verification_dossier: dossier,
    };
    const envelope = executionInputEnvelope([
      canonicalJsonBytes(alternate),
      value.operator_envelope_bytes,
      value.operator_trust_root_bytes,
      value.current_epoch_snapshot_bytes,
    ]);

    const result = invoke(envelope.bytes);

    expect(result.status).toBe(2);
    expect(result.stdout).toHaveLength(0);
  });
});
