import { createHash } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { isJsonRecord } from '../src/kernel/evidence-object';
import {
  verifyCurrentExecutionReceipt,
  verifyExecutionReceipt,
} from '../src/kernel/execution-trust-root';
import { parseStrictJson } from '../src/kernel/strict-json';
import {
  abortRepositoryExecutionSession,
  openRepositoryExecutionSession,
  RepositoryExecutionSession,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';
import {
  attestExecutableRun,
  loadExecutionSigningCapability,
} from '../src/runtime/execution-signer';

import { executionPrivateKeyBytes } from './execution-receipt-fixture';
import { verifiedGitTarget } from './git-target-fixture';
import { productionVerifierFixture } from './production-verifier-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const toolPath = join(
  workspaceRoot,
  'dist/tools/new-aria-admission/verifier/admission-verifier.cjs',
);
const roots: string[] = [];
const sessions: RepositoryExecutionSession[] = [];

function runScenario(): {
  readonly authority: ReturnType<typeof productionVerifierFixture>['authority'];
  readonly capability: ReturnType<typeof loadExecutionSigningCapability>;
  readonly executionRoot: Buffer;
  readonly run: ReturnType<typeof runVerifierExecutable>;
  readonly runContextSha256: string;
  readonly session: RepositoryExecutionSession;
  readonly target: ReturnType<typeof verifiedGitTarget>;
} {
  const fixture = productionVerifierFixture(toolPath);
  roots.push(fixture.repository.root, fixture.epoch_store_root);
  const target = verifiedGitTarget(fixture.repository);
  const authority = fixture.authority;
  const executionRoot = fixture.execution_trust_root_bytes;
  const capability = loadExecutionSigningCapability({
    authority,
    trust_root_bytes: executionRoot,
    evidence_trust_root_bytes: fixture.evidence_trust_root_bytes,
    private_key_pkcs8_der: executionPrivateKeyBytes(),
  });
  const session = openRepositoryExecutionSession({
    authority,
    target,
    signing_capability: capability,
    execution_trust_root_bytes: executionRoot,
    current_epoch_provider: fixture.current_epoch_provider,
  });
  sessions.push(session);
  const runContextSha256 = fixture.roster.baseline_run.run_context_sha256;
  const run = runVerifierExecutable({
    session,
    run_id: 'BASELINE',
    run_context_sha256: runContextSha256,
    tool_path: toolPath,
    tool_sha256: authority.authority.document.verifier_sha256,
    runtime_sha256: authority.authority.document.toolchain_sha256,
    tool_id: authority.authority.document.verifier_tool_id,
    input_envelope_bytes: fixture.roster.baseline_run.envelope.bytes,
    args: fixture.baseline_args,
  });
  return { authority, capability, executionRoot, run, runContextSha256, session, target };
}

describe('execution receipt signing root', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    for (const session of sessions.splice(0)) abortRepositoryExecutionSession(session);
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it('signs and verifies the full runner-issued baseline receipt under the pinned session key', () => {
    const scenario = runScenario();
    const receipt = attestExecutableRun(scenario.capability, scenario);
    const verified = verifyExecutionReceipt({
      receipt_bytes: receipt.bytes,
      trust_root_bytes: scenario.executionRoot,
      authority: scenario.authority,
      expected_run_id: 'BASELINE',
      expected_run_context_sha256: scenario.runContextSha256,
    });

    expect(receipt.sha256).toBe(createHash('sha256').update(receipt.bytes).digest('hex'));
    expect(verified.document).toMatchObject({
      authority_sha256: scenario.authority.authority.sha256,
      authority_envelope_sha256: scenario.authority.envelope_sha256,
      execution_session_id: 'execution-session-s01-0001',
      repository_id: scenario.target.repository_id,
      workspace_id: scenario.target.workspace_id,
      base_sha: scenario.target.base_sha,
      head_sha: scenario.target.head_sha,
      tree_sha: scenario.target.tree_sha,
      reference_list_sha256: scenario.run.evidence.input_reference_bundle_sha256,
      object_envelope_sha256: scenario.run.evidence.input_envelope_sha256,
      run_id: 'BASELINE',
      run_context_sha256: scenario.runContextSha256,
      run_nonce_sha256: scenario.run.evidence.run_nonce_sha256,
      execution: scenario.run.evidence,
    });
    expect(Object.isFrozen(verified.document.execution)).toBe(true);
    expect(Object.isFrozen(verified.document.execution.runtime)).toBe(true);
    expect(Object.isFrozen(verified.document.execution.argv)).toBe(true);
  });

  it('rejects a forged run object and a copied signing capability', () => {
    const scenario = runScenario();
    const capability = scenario.capability;
    const request = scenario;

    expect(() => attestExecutableRun(capability, { ...request, run: { ...scenario.run } })).toThrow(
      /runner|issued/i,
    );
    expect(() => attestExecutableRun({ ...capability }, request)).toThrow(/capability|issued/i);
  });

  it('consumes a runner-issued run exactly once', () => {
    const scenario = runScenario();
    attestExecutableRun(scenario.capability, scenario);

    expect(() => attestExecutableRun(scenario.capability, scenario)).toThrow(/already attested/i);
  });

  it('rejects a receipt tamper, context substitution, and stale authority replay', () => {
    const scenario = runScenario();
    const receipt = attestExecutableRun(scenario.capability, scenario);
    const parsed = parseStrictJson(receipt.bytes);
    if (!isJsonRecord(parsed) || !isJsonRecord(parsed.payload)) {
      throw new TypeError('signed receipt fixture is invalid');
    }
    const tampered = canonicalJsonBytes({
      ...parsed,
      payload: { ...parsed.payload, tree_sha: '0'.repeat(40) },
    });
    const verification = (
      bytes: Uint8Array,
      context = scenario.runContextSha256,
    ): ReturnType<typeof verifyCurrentExecutionReceipt> =>
      verifyCurrentExecutionReceipt({
        receipt_bytes: bytes,
        trust_root_bytes: scenario.executionRoot,
        authority: scenario.authority,
        expected_run_id: 'BASELINE',
        expected_run_context_sha256: context,
      });

    expect(() => verification(tampered)).toThrow(/signature/i);
    expect(() => verification(receipt.bytes, '6'.repeat(64))).toThrow(/context/i);
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(scenario.authority.valid_until) + 1);
    expect(() => verification(receipt.bytes)).toThrow(/stale|window/i);
  });
});
