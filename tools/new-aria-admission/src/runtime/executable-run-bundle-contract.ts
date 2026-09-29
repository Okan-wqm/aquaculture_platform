import { canonicalJsonBytes } from '../kernel/canonical-json';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonValue } from '../kernel/strict-json';

export interface BundleArtifactDescriptor {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

export interface BundleRunDescriptor {
  readonly run_id: string;
  readonly semantic_verdict: 'PASSED' | 'FAILED';
  readonly final_exit_code: 0 | 1;
  readonly failure: null | {
    readonly code: 'EXPECTED_NEGATIVE_CONTROL_REJECTION';
    readonly stderr_sha256: string;
    readonly stderr_byte_length: number;
  };
  readonly files: readonly BundleArtifactDescriptor[];
}

export interface ExecutionSessionBundleMarker {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-execution-session-bundle-v1';
  readonly execution_verdict: 'PASSED';
  readonly runs: readonly BundleRunDescriptor[];
}

type JsonRecord = { [key: string]: JsonValue };
const sha64 = /^[a-f0-9]{64}$/u;
const markerKeys = ['contract_id', 'execution_verdict', 'runs', 'schema_version'] as const;
const runKeys = ['failure', 'files', 'final_exit_code', 'run_id', 'semantic_verdict'] as const;
const artifactKeys = ['byte_length', 'path', 'sha256'] as const;
const failureKeys = ['code', 'stderr_byte_length', 'stderr_sha256'] as const;

function record(value: JsonValue | undefined, keys: readonly string[], label: string): JsonRecord {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new TypeError(`${label} schema is invalid`);
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function artifact(value: JsonValue, expectedPath: string): BundleArtifactDescriptor {
  const item = record(value, artifactKeys, 'run bundle artifact');
  if (item.path !== expectedPath || typeof item.sha256 !== 'string' || !sha64.test(item.sha256))
    throw new TypeError('run bundle artifact identity is invalid');
  return Object.freeze({
    path: expectedPath,
    byte_length: integer(item.byte_length, 'run bundle artifact byte length'),
    sha256: item.sha256,
  });
}

function failure(value: JsonValue | undefined, baseline: boolean) {
  if (baseline) {
    if (value !== null) throw new TypeError('baseline run bundle failure must be null');
    return null;
  }
  const item = record(value, failureKeys, 'run bundle failure');
  if (
    item.code !== 'EXPECTED_NEGATIVE_CONTROL_REJECTION' ||
    typeof item.stderr_sha256 !== 'string' ||
    !sha64.test(item.stderr_sha256)
  )
    throw new TypeError('run bundle failure identity is invalid');
  return Object.freeze({
    code: 'EXPECTED_NEGATIVE_CONTROL_REJECTION' as const,
    stderr_sha256: item.stderr_sha256,
    stderr_byte_length: integer(item.stderr_byte_length, 'run bundle stderr byte length'),
  });
}

function parseRun(value: JsonValue, runId: string, index: number): BundleRunDescriptor {
  const item = record(value, runKeys, 'run bundle entry');
  const baseline = index === 0;
  if (
    item.run_id !== runId ||
    item.semantic_verdict !== (baseline ? 'PASSED' : 'FAILED') ||
    item.final_exit_code !== (baseline ? 0 : 1) ||
    !Array.isArray(item.files) ||
    item.files.length !== 5
  )
    throw new TypeError('run bundle roster outcome is invalid');
  const prefix = `run-${index.toString().padStart(2, '0')}`;
  const names = [
    `${prefix}-evidence.json`,
    `${prefix}-input-envelope.json`,
    `${prefix}-stdout.bin`,
    `${prefix}-stderr.bin`,
    `${prefix}-receipt.json`,
  ];
  return Object.freeze({
    run_id: runId,
    semantic_verdict: baseline ? 'PASSED' : 'FAILED',
    final_exit_code: baseline ? 0 : 1,
    failure: failure(item.failure, baseline),
    files: Object.freeze(
      item.files.map((entry, fileIndex) => {
        const name = names[fileIndex];
        if (name === undefined) throw new TypeError('run bundle artifact name is absent');
        return artifact(entry, `payload/${name}`);
      }),
    ),
  });
}

export function parseExecutionSessionBundleMarker(
  bytes: Uint8Array,
  expectedRunIds: readonly string[],
): ExecutionSessionBundleMarker {
  const owned = Buffer.from(bytes);
  if (
    owned.byteLength < 2 ||
    owned.byteLength > 256 * 1024 ||
    owned.at(-1) !== 0x0a ||
    owned.at(-2) === 0x0a
  )
    throw new TypeError('run bundle marker framing is invalid');
  const body = owned.subarray(0, -1);
  const value = record(parseStrictJson(body), markerKeys, 'run bundle marker');
  if (
    !canonicalJsonBytes(value).equals(body) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-execution-session-bundle-v1' ||
    value.execution_verdict !== 'PASSED' ||
    !Array.isArray(value.runs) ||
    value.runs.length !== expectedRunIds.length ||
    expectedRunIds.length !== 5
  )
    throw new TypeError('run bundle marker identity or roster is invalid');
  return Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-session-bundle-v1',
    execution_verdict: 'PASSED',
    runs: Object.freeze(
      value.runs.map((entry, index) => {
        const runId = expectedRunIds[index];
        if (runId === undefined) throw new TypeError('expected run bundle ID is absent');
        return parseRun(entry, runId, index);
      }),
    ),
  });
}
