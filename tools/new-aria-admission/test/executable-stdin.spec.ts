import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  abortRepositoryExecutionSession,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';

import { authenticatedExecutionInputEnvelope } from './execution-input-envelope-fixture';
import { createGitTargetFixture, verifiedGitTarget } from './git-target-fixture';
import { finalizeTestRun, openTestExecutionSession } from './signed-execution-session-fixture';

const toolPath = realpathSync(join(__dirname, 'fixtures/stdin-verifier-fixture.cjs'));
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];

const freshTarget = () => {
  const repository = createGitTargetFixture();
  roots.push(repository.root);
  return verifiedGitTarget(repository);
};

function execute(primaryObject: Uint8Array = Buffer.from('verified-input-object\n')) {
  const target = freshTarget();
  const args = ['--mode', 'full'];
  const context = openTestExecutionSession(
    target,
    'stdin-verifier',
    digest(readFileSync(toolPath)),
    digest(readFileSync(process.execPath)),
    args,
  );
  const envelope = authenticatedExecutionInputEnvelope(
    context.authentication_objects,
    primaryObject,
  );
  try {
    const pending = runVerifierExecutable({
      session: context.session,
      run_id: 'BASELINE',
      run_context_sha256: '7'.repeat(64),
      tool_path: toolPath,
      tool_sha256: digest(readFileSync(toolPath)),
      runtime_sha256: digest(readFileSync(process.execPath)),
      tool_id: 'stdin-verifier',
      input_envelope_bytes: envelope.bytes,
      args,
    });
    return { envelope, run: finalizeTestRun(context, pending) };
  } finally {
    abortRepositoryExecutionSession(context.session);
  }
}

describe('verifier stdin binding', () => {
  it('executes against the exact immutable canonical input bytes it records', () => {
    const { envelope, run } = execute();

    expect(run.evidence.input_reference_bundle_sha256).toBe(envelope.input_reference_bundle_sha256);
    expect(run.evidence.input_envelope_sha256).toBe(envelope.input_envelope_sha256);
    expect(run.evidence.result).toEqual({ semantic_verdict: 'PASSED', final_exit_code: 0 });
  });

  it('returns a failed quadrant when canonical but mutated stdin reaches the verifier', () => {
    const { run } = execute(Buffer.from('unexpected-primary-object\n'));
    expect(run.evidence.result).toEqual({ semantic_verdict: 'FAILED', final_exit_code: 1 });
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });
});
