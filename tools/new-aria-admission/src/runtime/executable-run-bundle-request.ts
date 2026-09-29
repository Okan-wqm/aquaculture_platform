import { canonicalJsonBytes } from '../kernel/canonical-json';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonValue } from '../kernel/strict-json';

const keys = [
  'contract_id',
  'execution_trust_root_path',
  'git_path',
  'git_sha256',
  'operator_envelope_path',
  'operator_trust_root_path',
  'schema_version',
  'target_request_path',
] as const;
const sha64 = /^[a-f0-9]{64}$/u;
type JsonRecord = { [key: string]: JsonValue };

export interface ExecutableRunBundleRequest {
  readonly target_request_path: string;
  readonly git_path: string;
  readonly git_sha256: string;
  readonly operator_envelope_path: string;
  readonly operator_trust_root_path: string;
  readonly execution_trust_root_path: string;
}

function record(value: JsonValue): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new TypeError('run bundle verification request schema is invalid');
  return value;
}

function text(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new TypeError(`run bundle verification ${key} is invalid`);
  }
  return field;
}

export function parseExecutableRunBundleRequest(bytes: Uint8Array): ExecutableRunBundleRequest {
  const value = record(parseStrictJson(bytes));
  const gitSha256 = text(value, 'git_sha256');
  if (
    !canonicalJsonBytes(value).equals(Buffer.from(bytes)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-execution-bundle-verification-request-v1' ||
    !sha64.test(gitSha256)
  )
    throw new TypeError('run bundle verification request is not canonical or versioned');
  return Object.freeze({
    target_request_path: text(value, 'target_request_path'),
    git_path: text(value, 'git_path'),
    git_sha256: gitSha256,
    operator_envelope_path: text(value, 'operator_envelope_path'),
    operator_trust_root_path: text(value, 'operator_trust_root_path'),
    execution_trust_root_path: text(value, 'execution_trust_root_path'),
  });
}
