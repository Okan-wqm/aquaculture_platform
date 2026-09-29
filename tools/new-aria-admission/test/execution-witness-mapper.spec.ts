import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { mapExecutableRunToEvidenceExecution } from '../src/application/execution-witness-mapper';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import {
  abortRepositoryExecutionSession,
  runVerifierExecutable,
} from '../src/runtime/executable-runner';

import {
  authenticatedExecutionInputEnvelope,
  executionInputEnvelope,
} from './execution-input-envelope-fixture';
import { createGitTargetFixture, verifiedGitTarget } from './git-target-fixture';
import { digest } from './operator-authority-fixture';
import { finalizeTestRun, openTestExecutionSession } from './signed-execution-session-fixture';

const toolPath = realpathSync(join(__dirname, 'fixtures/baseline-verifier-fixture.cjs'));
const toolSha256 = digest(readFileSync(toolPath));
const runtimeSha256 = digest(readFileSync(process.execPath));
const toolId = 'new-aria-admission-verifier';
const args = ['PASSED', '0'];
const argv = [`node@${process.version}`, toolId, ...args];
const logicalCwd = 'workspace://repo-1/workspace-1';
const roots: string[] = [];

function scenario() {
  const repository = createGitTargetFixture();
  roots.push(repository.root);
  const target = verifiedGitTarget(repository);
  const context = openTestExecutionSession(target, toolId, toolSha256, runtimeSha256, args);
  const inputEnvelope = authenticatedExecutionInputEnvelope(context.authentication_objects);
  const pending = runVerifierExecutable({
    session: context.session,
    run_id: 'BASELINE',
    run_context_sha256: '7'.repeat(64),
    tool_path: toolPath,
    tool_sha256: toolSha256,
    runtime_sha256: runtimeSha256,
    tool_id: toolId,
    input_envelope_bytes: inputEnvelope.bytes,
    args,
  });
  const run = finalizeTestRun(context, pending);
  abortRepositoryExecutionSession(context.session);
  return { authority: context.authority, inputEnvelope, run, target };
}

function mappingRequest(testScenario: ReturnType<typeof scenario>) {
  const outputBytes = testScenario.run.stdout.subarray(0, -1);
  const outputSha256 = digest(outputBytes);
  return {
    ...testScenario,
    input_envelope_bytes: testScenario.inputEnvelope.bytes,
    output_reference: {
      uri: `aria-evidence://sha256/${outputSha256}`,
      sha256: outputSha256,
    },
    output_bytes: outputBytes,
  };
}

describe('execution witness mapper trust boundary', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    let now = Date.parse('2026-09-02T12:30:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => {
      now += 1;
      return now;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it('maps one real target-bound process into the exact signed witness', () => {
    const request = mappingRequest(scenario());
    const witness = mapExecutableRunToEvidenceExecution(request);

    expect(witness).toMatchObject({
      argv,
      argv_sha256: digest(canonicalJsonBytes(argv)),
      tool_id: toolId,
      tool_sha256: toolSha256,
      runtime_id: `node@${process.version}`,
      runtime_sha256: runtimeSha256,
      cwd: logicalCwd,
      cwd_sha256: digest(Buffer.from(logicalCwd)),
      input_sha256: request.inputEnvelope.object_sha256s[0],
      input_reference_bundle_sha256: request.inputEnvelope.input_reference_bundle_sha256,
      input_envelope_sha256: request.inputEnvelope.input_envelope_sha256,
      input_object_sha256s: request.inputEnvelope.object_sha256s,
      execution_receipt: {
        uri: `aria-evidence://sha256/${request.run.execution_receipt.sha256}`,
        sha256: request.run.execution_receipt.sha256,
      },
      output_sha256: digest(request.output_bytes),
      exit_code: 0,
      stdout_sha256: digest(request.run.stdout),
      failure_reason_sha256: null,
      semantic_verdict: 'PASSED',
    });
    expect(Date.parse(witness.started_at)).toBeLessThan(Date.parse(witness.finished_at));
  });

  it('accepts a signed execution that starts and finishes in the same millisecond', () => {
    const instant = Date.parse('2026-09-02T12:30:00.001Z');
    jest.spyOn(Date, 'now').mockReturnValue(instant);

    const request = mappingRequest(scenario());
    const witness = mapExecutableRunToEvidenceExecution(request);

    expect(witness.started_at).toBe(new Date(instant).toISOString());
    expect(witness.finished_at).toBe(witness.started_at);
  });

  it('rejects substituted input object bytes or output bytes', () => {
    const request = mappingRequest(scenario());
    expect(() =>
      mapExecutableRunToEvidenceExecution({
        ...request,
        input_envelope_bytes: executionInputEnvelope([Buffer.from('substitute')]).bytes,
      }),
    ).toThrow(/issued executable run/);
    expect(() =>
      mapExecutableRunToEvidenceExecution({
        ...request,
        output_bytes: Buffer.from('substituted output\n'),
      }),
    ).toThrow(/executed stdout/);
  });

  it('rejects a structural runner-result copy', () => {
    const request = mappingRequest(scenario());
    expect(() =>
      mapExecutableRunToEvidenceExecution({ ...request, run: { ...request.run } }),
    ).toThrow(/not issued/);
  });
});
