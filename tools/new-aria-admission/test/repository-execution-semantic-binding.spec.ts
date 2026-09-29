import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  abortRepositoryExecutionSession,
  openRepositoryExecutionSession,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { isJsonRecord } from '../src/kernel/evidence-object';
import { parseStrictJson } from '../src/kernel/strict-json';
import { loadExecutionSigningCapability } from '../src/runtime/execution-signer';
import { readBaselineVerifierOutput } from '../src/runtime/verifier-baseline-output';
import { authenticateVerifierInput } from '../src/verifier/authenticated-input';

import { executionPrivateKeyBytes } from './execution-receipt-fixture';
import { currentEpochSnapshotBytes } from './current-epoch-fixture';
import { verifiedGitTarget } from './git-target-fixture';
import { productionVerifierFixture } from './production-verifier-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const verifierPath = join(
  workspaceRoot,
  'dist/tools/new-aria-admission/verifier/admission-verifier.cjs',
);

type ProductionFixture = ReturnType<typeof productionVerifierFixture>;

function open(fixture: ProductionFixture) {
  const target = verifiedGitTarget(fixture.repository);
  const capability = loadExecutionSigningCapability({
    authority: fixture.authority,
    trust_root_bytes: fixture.execution_trust_root_bytes,
    evidence_trust_root_bytes: fixture.evidence_trust_root_bytes,
    private_key_pkcs8_der: executionPrivateKeyBytes(),
  });
  const session = openRepositoryExecutionSession({
    authority: fixture.authority,
    target,
    signing_capability: capability,
    execution_trust_root_bytes: fixture.execution_trust_root_bytes,
    current_epoch_provider: fixture.current_epoch_provider,
  });
  return { session, target };
}

function baselineRequest(
  fixture: ProductionFixture,
  session: ReturnType<typeof open>['session'],
  runContextSha256 = fixture.baseline.run_context_sha256,
  toolPath = verifierPath,
) {
  return {
    session,
    run_id: 'BASELINE',
    run_context_sha256: runContextSha256,
    tool_path: toolPath,
    tool_sha256: fixture.authority.authority.document.verifier_sha256,
    runtime_sha256: fixture.authority.authority.document.toolchain_sha256,
    tool_id: fixture.authority.authority.document.verifier_tool_id,
    input_envelope_bytes: fixture.roster.baseline_run.envelope.bytes,
    args: fixture.baseline_args,
  } as const;
}

describe('repository execution semantic binding', () => {
  let fixture: ProductionFixture | undefined;

  beforeEach(() => {
    fixture = productionVerifierFixture(verifierPath);
  });

  afterEach(() => {
    if (fixture !== undefined) {
      fixture.current_epoch_provider.close();
      rmSync(fixture.repository.root, { force: true, recursive: true });
      rmSync(fixture.epoch_store_root, { force: true, recursive: true });
    }
  });

  function active(): ProductionFixture {
    if (fixture === undefined) throw new TypeError('production fixture is absent');
    return fixture;
  }

  it('derives run context from authenticated baseline before resolving the tool', () => {
    const value = active();
    const { session } = open(value);
    try {
      expect(() =>
        runVerifierExecutable(baselineRequest(value, session, '0'.repeat(64), '/missing/verifier')),
      ).toThrow(/run context differs/);
      const pending = runVerifierExecutable(baselineRequest(value, session));
      expect(pending.evidence.run_context_sha256).toBe(value.baseline.run_context_sha256);
      expect(pending.evidence.result).toEqual({ semantic_verdict: 'PASSED', final_exit_code: 0 });
      const trusted = authenticateVerifierInput(
        [
          canonicalJsonBytes(value.baseline),
          value.operator_envelope_bytes,
          value.operator_trust_root_bytes,
          value.current_epoch_snapshot_bytes,
        ],
        value.operator_root_sha256,
        value.repository.root,
        value.baseline_args,
      );
      const output = readBaselineVerifierOutput(pending.stdout);
      expect(output.verification_plan_sha256).toBe(
        trusted.verification.dossier.verification_plan_sha256,
      );
      expect(output.verifying_projection_bytes).toEqual(
        trusted.verification.dossier.verifying_projection_bytes,
      );
      const projection = parseStrictJson(output.verifying_projection_bytes.subarray(0, -1));
      if (!isJsonRecord(projection)) throw new TypeError('VERIFYING projection is invalid');
      expect(projection.freshness).toBe('VALID_AT');
    } finally {
      abortRepositoryExecutionSession(session);
    }
  });

  it('rejects replayed D1 input after the durable epoch provider advances to D2', () => {
    const value = active();
    const { session } = open(value);
    try {
      writeFileSync(
        value.current_epoch_snapshot_path,
        currentEpochSnapshotBytes(value.authority, {
          revision: 2,
          observed_at: new Date(Date.now() - 30_000).toISOString(),
          valid_until: value.valid_until,
        }),
        { mode: 0o600 },
      );
      expect(() =>
        runVerifierExecutable(
          baselineRequest(value, session, value.baseline.run_context_sha256, '/missing/verifier'),
        ),
      ).toThrow(/authentication roster is stale/);
    } finally {
      abortRepositoryExecutionSession(session);
    }
  });
});
