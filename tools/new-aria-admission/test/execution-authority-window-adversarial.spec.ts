import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  abortRepositoryExecutionSession,
  openRepositoryExecutionSession,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';
import { loadExecutionSigningCapability } from '../src/runtime/execution-signer';

import { executionPrivateKeyBytes } from './execution-receipt-fixture';
import { verifiedGitTarget } from './git-target-fixture';
import { productionVerifierFixture } from './production-verifier-fixture';

const workspaceRoot = realpathSync(join(__dirname, '../../..'));
const toolPath = join(
  workspaceRoot,
  'dist/tools/new-aria-admission/verifier/admission-verifier.cjs',
);
const roots: string[] = [];

describe('runner authority validity window', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it('rejects a run when the trusted clock precedes authority observation', () => {
    const fixture = productionVerifierFixture(toolPath);
    roots.push(fixture.repository.root, fixture.epoch_store_root);
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
    const beforeAuthority = Date.parse(fixture.authority.observed_at) - 1;
    jest.spyOn(Date, 'now').mockReturnValue(beforeAuthority);

    expect(() =>
      runVerifierExecutable({
        session,
        run_id: 'BASELINE',
        run_context_sha256: fixture.roster.baseline_run.run_context_sha256,
        tool_path: toolPath,
        tool_sha256: fixture.authority.authority.document.verifier_sha256,
        runtime_sha256: fixture.authority.authority.document.toolchain_sha256,
        tool_id: fixture.authority.authority.document.verifier_tool_id,
        input_envelope_bytes: fixture.roster.baseline_run.envelope.bytes,
        args: fixture.baseline_args,
      }),
    ).toThrow(/authority|clock|epoch/i);
    jest.restoreAllMocks();
    abortRepositoryExecutionSession(session);
  });
});
