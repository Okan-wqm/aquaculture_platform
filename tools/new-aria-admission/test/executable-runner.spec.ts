import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import {
  abortRepositoryExecutionSession,
  finalizeExecutableRun,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';
import type { ExecutableRunResult } from '../src/runtime/executable-runner';
import { attestExecutableRun } from '../src/runtime/execution-signer';

import { authenticatedExecutionInputEnvelope } from './execution-input-envelope-fixture';
import { createGitTargetFixture, verifiedGitTarget } from './git-target-fixture';
import { finalizeTestRun, openTestExecutionSession } from './signed-execution-session-fixture';

const toolPath = realpathSync(join(__dirname, 'fixtures/baseline-verifier-fixture.cjs'));
const toolSha256 = createHash('sha256').update(readFileSync(toolPath)).digest('hex');
const runtimeSha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
const toolId = 'new-aria-admission-verifier';
const runContextSha256 = '7'.repeat(64);
const roots: string[] = [];

const baselineOutput = (verdict: string): Buffer =>
  Buffer.from(
    `${JSON.stringify({
      contract_id: 'new-aria-verifier-report-v1',
      result: {
        code: verdict === 'PASSED' ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED',
        summary: 'fixture verifier result',
      },
      schema_version: '1.0.0',
      verdict,
    })}\n`,
  );

function execute(
  verdict: string,
  exitCode: number,
): {
  readonly input: ReturnType<typeof authenticatedExecutionInputEnvelope>;
  readonly run: ExecutableRunResult;
} {
  const repository = createGitTargetFixture();
  roots.push(repository.root);
  const target = verifiedGitTarget(repository);
  const args = [verdict, String(exitCode)];
  const context = openTestExecutionSession(target, toolId, toolSha256, runtimeSha256, args);
  const input = authenticatedExecutionInputEnvelope(context.authentication_objects);
  try {
    const pending = runVerifierExecutable({
      session: context.session,
      run_id: 'BASELINE',
      run_context_sha256: runContextSha256,
      tool_path: toolPath,
      tool_sha256: toolSha256,
      runtime_sha256: runtimeSha256,
      tool_id: toolId,
      input_envelope_bytes: input.bytes,
      args,
    });
    return { input, run: finalizeTestRun(context, pending) };
  } finally {
    abortRepositoryExecutionSession(context.session);
  }
}

describe('canonical executable evidence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T13:00:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it('records exact logical command, target, streams, input, and signed session identity', () => {
    const { input, run: result } = execute('PASSED', 0);
    const stdout = baselineOutput('PASSED');
    const stderr = Buffer.from('fixture:PASSED:0\n');

    expect(result.stdout).toEqual(stdout);
    expect(result.stderr).toEqual(stderr);
    expect(result.execution_receipt?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.evidence).toMatchObject({
      schema_version: '1.0.0',
      contract_id: 'new-aria-executable-run-v1',
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      execution_session_id: 'execution-session-s01-0001',
      run_id: 'BASELINE',
      run_context_sha256: runContextSha256,
      argv: [`node@${process.version}`, toolId, 'PASSED', '0'],
      cwd: 'workspace://repo-1/workspace-1',
      input_reference_bundle_sha256: input.input_reference_bundle_sha256,
      input_envelope_sha256: input.input_envelope_sha256,
      output_sha256: createHash('sha256').update(stdout.subarray(0, -1)).digest('hex'),
      runtime: {
        id: `node@${process.version}`,
        version: process.version,
        executable_sha256: runtimeSha256,
      },
      tool: { id: toolId, sha256: toolSha256 },
      started_at_utc: '2026-09-02T13:00:00.000Z',
      ended_at_utc: '2026-09-02T13:00:00.000Z',
      process: { exit_code: 0, workflow_succeeded: true },
      result: { semantic_verdict: 'PASSED', final_exit_code: 0 },
      stdout: {
        byte_length: stdout.byteLength,
        sha256: createHash('sha256').update(stdout).digest('hex'),
      },
      stderr: {
        byte_length: stderr.byteLength,
        sha256: createHash('sha256').update(stderr).digest('hex'),
      },
    });
    expect(result.evidence.argv_sha256).toBe(
      createHash('sha256')
        .update(canonicalJsonBytes([`node@${process.version}`, toolId, 'PASSED', '0']))
        .digest('hex'),
    );
    expect(result.evidence.materialized_argv.slice(2)).toEqual(['PASSED', '0']);
    expect(result.evidence.materialized_argv[0]).not.toBe(result.evidence.argv[0]);
    expect(result.evidence.materialized_argv[1]).not.toBe(result.evidence.argv[1]);
    expect(result.evidence.materialized_argv_sha256).toBe(
      createHash('sha256')
        .update(canonicalJsonBytes(result.evidence.materialized_argv))
        .digest('hex'),
    );
  });

  it.each([
    ['PASSED', 0, true, 0],
    ['PASSED', 1, false, 1],
    ['FAILED', 0, true, 1],
    ['FAILED', 1, false, 1],
  ] as const)('propagates verdict=%s exit=%s fail-closed', (verdict, exit, succeeded, final) => {
    const result = execute(verdict, exit).run;
    expect(result.evidence.process).toEqual({ exit_code: exit, workflow_succeeded: succeeded });
    expect(result.evidence.result).toEqual({ semantic_verdict: verdict, final_exit_code: final });
  });

  it.each([
    ['tool', '0'.repeat(64), runtimeSha256, /tool digest/],
    ['runtime', toolSha256, '0'.repeat(64), /runtime digest/],
  ])(
    'rejects changed %s bytes against signed digests',
    (_label, toolDigest, runtimeDigest, error) => {
      const repository = createGitTargetFixture();
      roots.push(repository.root);
      const target = verifiedGitTarget(repository);
      const args = ['PASSED', '0'];
      const context = openTestExecutionSession(target, toolId, toolDigest, runtimeDigest, args);
      const input = authenticatedExecutionInputEnvelope(context.authentication_objects);
      try {
        expect(() =>
          runVerifierExecutable({
            session: context.session,
            run_id: 'BASELINE',
            run_context_sha256: runContextSha256,
            tool_path: toolPath,
            tool_sha256: toolDigest,
            runtime_sha256: runtimeDigest,
            tool_id: toolId,
            input_envelope_bytes: input.bytes,
            args,
          }),
        ).toThrow(error);
      } finally {
        abortRepositoryExecutionSession(context.session);
      }
    },
  );

  it.each([
    ['UNKNOWN', /baseline verifier report/],
    ['PADDED', /canonical JSON/],
  ])('rejects invalid semantic output %s', (verdict, error) => {
    expect(() => execute(verdict, 0)).toThrow(error);
  });

  it('does not consume a pending run when receipt verification fails', () => {
    const repository = createGitTargetFixture();
    roots.push(repository.root);
    const target = verifiedGitTarget(repository);
    const args = ['PASSED', '0'];
    const context = openTestExecutionSession(target, toolId, toolSha256, runtimeSha256, args);
    const input = authenticatedExecutionInputEnvelope(context.authentication_objects);
    try {
      const pending = runVerifierExecutable({
        session: context.session,
        run_id: 'BASELINE',
        run_context_sha256: runContextSha256,
        tool_path: toolPath,
        tool_sha256: toolSha256,
        runtime_sha256: runtimeSha256,
        tool_id: toolId,
        input_envelope_bytes: input.bytes,
        args,
      });
      const receipt = attestExecutableRun(context.capability, {
        authority: context.authority,
        target,
        run: pending,
      });

      expect(() =>
        finalizeExecutableRun(context.session, pending, {
          bytes: receipt.bytes,
          sha256: '0'.repeat(64),
        }),
      ).toThrow(/receipt/);
      expect(() => finalizeExecutableRun(context.session, pending, receipt)).not.toThrow();
      expect(() => finalizeExecutableRun(context.session, pending, receipt)).toThrow(/pending/);
    } finally {
      abortRepositoryExecutionSession(context.session);
    }
  });
});
