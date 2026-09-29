import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import * as runnerModule from '../src/runtime/executable-runner';
import {
  abortRepositoryExecutionSession,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';

import { authenticatedExecutionInputEnvelope } from './execution-input-envelope-fixture';
import {
  cloneGitTargetFixture,
  createGitTargetFixture,
  GitTargetFixture,
  verifiedGitTarget,
} from './git-target-fixture';
import { finalizeTestRun, openTestExecutionSession } from './signed-execution-session-fixture';

const runtimeSha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
const toolBytes = Buffer.from(
  'process.stdout.write(\'{"contract_id":"new-aria-verifier-report-v1","result":{"code":"VERIFICATION_PASSED","summary":"portable"},"schema_version":"1.0.0","verdict":"PASSED"}\\n\'); process.exitCode = 0;\n',
);
const toolSha256 = createHash('sha256').update(toolBytes).digest('hex');
const roots: string[] = [];

function runAt(repository: GitTargetFixture) {
  const target = verifiedGitTarget(repository);
  const toolPath = join(repository.root, 'verifier.cjs');
  writeFileSync(toolPath, toolBytes, { mode: 0o700 });
  const args = ['--mode', 'full'];
  const context = openTestExecutionSession(
    target,
    'new-aria-admission-verifier',
    toolSha256,
    runtimeSha256,
    args,
  );
  const inputEnvelope = authenticatedExecutionInputEnvelope(context.authentication_objects);
  try {
    const pending = runVerifierExecutable({
      session: context.session,
      run_id: 'BASELINE',
      run_context_sha256: '7'.repeat(64),
      tool_path: toolPath,
      tool_sha256: toolSha256,
      runtime_sha256: runtimeSha256,
      tool_id: 'new-aria-admission-verifier',
      input_envelope_bytes: inputEnvelope.bytes,
      args,
    });
    return finalizeTestRun(context, pending);
  } finally {
    abortRepositoryExecutionSession(context.session);
  }
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('portable executable evidence', () => {
  it('separates portable logical argv from exact materialized spawn argv', () => {
    const leftRepository = createGitTargetFixture();
    const rightRepository = cloneGitTargetFixture(leftRepository);
    roots.push(leftRepository.root, rightRepository.root);

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    const left = runAt(leftRepository);
    const right = runAt(rightRepository);

    const {
      materialized_argv: leftMaterialized,
      materialized_argv_sha256: leftMaterializedSha256,
      ...leftLogicalEvidence
    } = left.evidence;
    const {
      materialized_argv: rightMaterialized,
      materialized_argv_sha256: rightMaterializedSha256,
      ...rightLogicalEvidence
    } = right.evidence;

    expect(rightLogicalEvidence).toEqual(leftLogicalEvidence);
    expect(leftMaterialized.slice(2)).toEqual(left.evidence.argv.slice(2));
    expect(rightMaterialized.slice(2)).toEqual(right.evidence.argv.slice(2));
    expect(rightMaterialized).not.toEqual(leftMaterialized);
    expect(leftMaterializedSha256).toBe(
      createHash('sha256').update(canonicalJsonBytes(leftMaterialized)).digest('hex'),
    );
    expect(rightMaterializedSha256).toBe(
      createHash('sha256').update(canonicalJsonBytes(rightMaterialized)).digest('hex'),
    );
    expect(JSON.stringify(left.evidence)).not.toContain(leftRepository.root);
    expect(JSON.stringify(right.evidence)).not.toContain(rightRepository.root);
  });

  it('does not export a callable result issuer', () => {
    expect(Object.keys(runnerModule)).not.toContain('issueExecutableRunResult');
  });

  afterEach(() => jest.useRealTimers());
});
