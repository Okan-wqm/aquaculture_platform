import { createHash } from 'node:crypto';

import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import type { CurrentEpochProviderSnapshot } from '../adapters/file-current-epoch-provider';
import type { VerifiedCurrentEpochSnapshot } from '../kernel/current-epoch-provider';
import type { JsonRecord } from '../kernel/evidence-object';
import type { VerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import type { BundleRunDescriptor } from './executable-run-bundle-contract';
import type { ValidatedExecutionInputEnvelope } from './execution-input-envelope';
import { expectedVerifierProcessOutcome } from './verifier-process-outcome';
import { readVerifierOutputArtifact } from './verifier-output';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function stringField(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new TypeError(`signed execution ${key} is invalid`);
  return field;
}

function numberField(value: JsonRecord, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
    throw new TypeError(`signed execution ${key} is invalid`);
  }
  return field;
}

function recordField(value: JsonRecord, key: string): JsonRecord {
  const field = value[key];
  if (field === null || typeof field !== 'object' || Array.isArray(field)) {
    throw new TypeError(`signed execution ${key} is invalid`);
  }
  return field;
}

export function stringsField(value: JsonRecord, key: string): readonly string[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new TypeError(`signed execution ${key} is invalid`);
  }
  const strings: string[] = [];
  for (const item of field) {
    if (typeof item !== 'string') throw new TypeError(`signed execution ${key} is invalid`);
    strings.push(item);
  }
  return Object.freeze(strings);
}

export function bytesFor(
  artifacts: ReadonlyMap<string, Buffer>,
  descriptor: BundleRunDescriptor,
  index: number,
): Buffer {
  const path = descriptor.files[index]?.path;
  const bytes = path === undefined ? undefined : artifacts.get(path);
  if (bytes === undefined) throw new TypeError('run bundle artifact is absent');
  return bytes;
}

export function assertTargetAuthority(
  authority: VerifiedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
): void {
  const document = authority.authority.document;
  if (
    target.repository_id !== document.repository_id ||
    target.workspace_id !== document.workspace_id ||
    target.base_sha !== document.base_sha ||
    target.head_sha !== document.head_sha ||
    target.git_tool_id !== document.git_tool_id ||
    target.git_tool_sha256 !== document.git_tool_sha256
  )
    throw new TypeError('run bundle target differs from signed authority');
}

export function assertEpoch(execution: JsonRecord, snapshot: CurrentEpochProviderSnapshot): void {
  if (
    stringField(execution, 'current_epoch_provider_identity_sha256') !==
      snapshot.provider_identity_sha256 ||
    stringField(execution, 'current_epoch_snapshot_sha256') !== snapshot.sha256 ||
    numberField(execution, 'current_epoch_revision') !== snapshot.revision ||
    Date.parse(stringField(execution, 'current_epoch_read_at')) > Date.parse(snapshot.read_at)
  )
    throw new TypeError('run bundle execution used a stale or different current epoch');
}

export function assertHistoricalEpoch(
  execution: JsonRecord,
  authority: VerifiedS01ProgressAuthority,
  snapshot: VerifiedCurrentEpochSnapshot,
): void {
  const readAt = Date.parse(stringField(execution, 'current_epoch_read_at'));
  if (
    stringField(execution, 'current_epoch_provider_identity_sha256') !==
      authority.authority.document.invalidation_epoch_provider_identity_sha256 ||
    stringField(execution, 'current_epoch_snapshot_sha256') !== snapshot.sha256 ||
    numberField(execution, 'current_epoch_revision') !== snapshot.revision ||
    readAt < Date.parse(snapshot.observed_at) ||
    readAt > Date.parse(snapshot.valid_until)
  )
    throw new TypeError('historical run bundle epoch evidence is invalid');
}

export function assertInput(
  execution: JsonRecord,
  input: ValidatedExecutionInputEnvelope,
  baselineInput: ValidatedExecutionInputEnvelope,
): void {
  const objectDigests = stringsField(execution, 'input_object_sha256s');
  if (
    stringField(execution, 'input_reference_bundle_sha256') !==
      input.input_reference_bundle_sha256 ||
    stringField(execution, 'input_envelope_sha256') !== input.input_envelope_sha256 ||
    input.object_sha256s[3] !== stringField(execution, 'current_epoch_snapshot_sha256') ||
    objectDigests.length !== input.object_sha256s.length ||
    objectDigests.some((sha256, index) => sha256 !== input.object_sha256s[index]) ||
    input.object_sha256s
      .slice(0, 4)
      .some((sha256, index) => sha256 !== baselineInput.object_sha256s[index])
  )
    throw new TypeError('run bundle input is not the receipt-bound authentication roster');
}

export function assertExecutionAuthority(
  execution: JsonRecord,
  run: BundleRunDescriptor,
  authority: VerifiedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
  baselineArgv: readonly string[],
): void {
  const document = authority.authority.document;
  const runtime = recordField(execution, 'runtime');
  const tool = recordField(execution, 'tool');
  const result = recordField(execution, 'result');
  const runtimeVersion = stringField(runtime, 'version');
  const expectedArgv =
    run.run_id === 'BASELINE' ? baselineArgv : [...baselineArgv, '--negative-control', run.run_id];
  const argv = stringsField(execution, 'argv');
  if (
    stringField(execution, 'repository_id') !== document.repository_id ||
    stringField(execution, 'workspace_id') !== document.workspace_id ||
    stringField(execution, 'base_sha') !== document.base_sha ||
    stringField(execution, 'head_sha') !== document.head_sha ||
    stringField(execution, 'tree_sha') !== target.tree_sha ||
    stringField(execution, 'execution_session_id') !== document.execution_session_id ||
    stringField(execution, 'run_id') !== run.run_id ||
    stringField(execution, 'cwd_sha256') !== document.execution_cwd_sha256 ||
    stringField(runtime, 'id') !== document.runtime_id ||
    stringField(runtime, 'id') !== `node@${runtimeVersion}` ||
    stringField(runtime, 'executable_sha256') !== document.toolchain_sha256 ||
    stringField(tool, 'id') !== document.verifier_tool_id ||
    stringField(tool, 'sha256') !== document.verifier_sha256 ||
    baselineArgv[0] !== document.runtime_id ||
    baselineArgv[1] !== document.verifier_tool_id ||
    (run.run_id === 'BASELINE' &&
      stringField(execution, 'argv_sha256') !== document.verifier_argv_sha256) ||
    argv.length !== expectedArgv.length ||
    argv.some((argument, index) => argument !== expectedArgv[index]) ||
    stringField(result, 'semantic_verdict') !== run.semantic_verdict ||
    numberField(result, 'final_exit_code') !== run.final_exit_code
  )
    throw new TypeError('run bundle execution differs from signed authority or roster');
}

export function assertOutput(
  execution: JsonRecord,
  run: BundleRunDescriptor,
  input: ValidatedExecutionInputEnvelope,
  stdout: Buffer,
  stderr: Buffer,
  expected: ReturnType<typeof expectedVerifierProcessOutcome>,
): void {
  const stdoutEvidence = recordField(execution, 'stdout');
  const stderrEvidence = recordField(execution, 'stderr');
  const output = readVerifierOutputArtifact(stdout, {
    run_id: run.run_id,
    run_context_sha256: stringField(execution, 'run_context_sha256'),
    baseline_input_sha256: input.object_sha256s[0],
    input_object_sha256s: input.object_sha256s,
  });
  if (
    !stdout.equals(expected.stdout) ||
    !stderr.equals(expected.stderr) ||
    numberField(recordField(execution, 'process'), 'exit_code') !== expected.exit_code ||
    stringField(execution, 'output_sha256') !== digest(output) ||
    stringField(stdoutEvidence, 'sha256') !== digest(stdout) ||
    numberField(stdoutEvidence, 'byte_length') !== stdout.byteLength ||
    stringField(stderrEvidence, 'sha256') !== digest(stderr) ||
    numberField(stderrEvidence, 'byte_length') !== stderr.byteLength ||
    (run.failure !== null &&
      (run.failure.stderr_sha256 !== digest(stderr) ||
        run.failure.stderr_byte_length !== stderr.byteLength))
  )
    throw new TypeError('run bundle output differs from the signed semantic outcome');
}
