import { createHash } from 'node:crypto';

import type { CompletionCandidate } from '../application/completion-candidate';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonValue } from '../kernel/strict-json';

import { CanonicalFileReadBudget } from './canonical-file-read-budget';

const keys = [
  'schema_version',
  'contract_id',
  'target_request_path',
  'git_path',
  'git_sha256',
  'operator_envelope_path',
  'operator_trust_root_path',
  'evidence_trust_root_path',
  'execution_trust_root_path',
  'event_policy_path',
  'freshness_policy_path',
  'event_chain_path',
  'manifest_paths',
  'objects',
  'evidence_attestation_path',
] as const;
const objectKeys = ['path', 'uri'] as const;
const sha64 = /^[a-f0-9]{64}$/u;
const evidenceUri = /^aria-evidence:\/\/sha256\/([a-f0-9]{64})$/u;
const MEBIBYTE = 1024 * 1024;
const MAX_REFERENCED_BYTES = 64 * MEBIBYTE;
type JsonRecord = { [key: string]: JsonValue };

export interface LoadedCompletionAdmissionRequest {
  readonly descriptor: CompletionAdmissionDescriptor;
  readonly operator_envelope_bytes: Buffer;
  readonly operator_trust_root_bytes: Buffer;
  readonly evidence_trust_root_bytes: Buffer;
  readonly execution_trust_root_bytes: Buffer;
  readonly event_policy_bytes: Buffer;
  readonly freshness_policy_bytes: Buffer;
  readonly candidate: CompletionCandidate;
}

export interface CompletionEvidenceObjectDescriptor {
  readonly path: string;
  readonly uri: string;
}

export interface CompletionAdmissionDescriptor {
  readonly target_request_path: string;
  readonly git_path: string;
  readonly git_sha256: string;
  readonly operator_envelope_path: string;
  readonly operator_trust_root_path: string;
  readonly evidence_trust_root_path: string;
  readonly execution_trust_root_path: string;
  readonly event_policy_path: string;
  readonly freshness_policy_path: string;
  readonly event_chain_path: string;
  readonly manifest_paths: readonly string[];
  readonly objects: readonly CompletionEvidenceObjectDescriptor[];
  readonly evidence_attestation_path: string;
}

function record(value: JsonValue | undefined, exact: readonly string[], label: string): JsonRecord {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== exact.length ||
    exact.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError(`${label} schema is invalid`);
  }
  return value;
}

function text(value: JsonRecord, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.length === 0) {
    throw new TypeError(`completion admission ${field} is invalid`);
  }
  return result;
}

function objectDescriptors(
  value: JsonValue | undefined,
): readonly CompletionEvidenceObjectDescriptor[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new TypeError('completion admission object roster is invalid');
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((entryValue) => {
      const entry = record(entryValue, objectKeys, 'completion admission object');
      const uri = text(entry, 'uri');
      if (evidenceUri.exec(uri) === null || seen.has(uri)) {
        throw new TypeError('completion admission object URI is invalid or duplicated');
      }
      seen.add(uri);
      return Object.freeze({ path: text(entry, 'path'), uri });
    }),
  );
}

function loadObjects(
  descriptors: readonly CompletionEvidenceObjectDescriptor[],
  budget: CanonicalFileReadBudget,
): ReadonlyMap<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  for (const descriptor of descriptors) {
    const uri = descriptor.uri;
    const match = evidenceUri.exec(uri);
    if (match === null) throw new TypeError('completion admission object URI is invalid');
    const expectedSha256 = match[1];
    if (expectedSha256 === undefined) throw new TypeError('completion object digest is absent');
    const bytes = budget.read(descriptor.path, 'completion evidence object', 16 * MEBIBYTE);
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new TypeError('completion evidence object content address mismatch');
    }
    objects.set(uri, bytes);
  }
  return objects;
}

export function parseCompletionAdmissionDescriptor(
  bytes: Uint8Array,
): CompletionAdmissionDescriptor {
  const value = record(parseStrictJson(bytes), keys, 'completion admission request');
  if (
    !canonicalJsonBytes(value).equals(Buffer.from(bytes)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-completion-admission-request-v1' ||
    !sha64.test(text(value, 'git_sha256')) ||
    !Array.isArray(value.manifest_paths) ||
    value.manifest_paths.length === 0 ||
    value.manifest_paths.length > 64 ||
    value.manifest_paths.some((path) => typeof path !== 'string' || path.length === 0)
  ) {
    throw new TypeError('completion admission request is not canonical, closed, or bounded');
  }
  const manifestPaths = value.manifest_paths.map((path) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('completion manifest path is invalid');
    }
    return path;
  });
  return Object.freeze({
    target_request_path: text(value, 'target_request_path'),
    git_path: text(value, 'git_path'),
    git_sha256: text(value, 'git_sha256'),
    operator_envelope_path: text(value, 'operator_envelope_path'),
    operator_trust_root_path: text(value, 'operator_trust_root_path'),
    evidence_trust_root_path: text(value, 'evidence_trust_root_path'),
    execution_trust_root_path: text(value, 'execution_trust_root_path'),
    event_policy_path: text(value, 'event_policy_path'),
    freshness_policy_path: text(value, 'freshness_policy_path'),
    event_chain_path: text(value, 'event_chain_path'),
    manifest_paths: Object.freeze(manifestPaths),
    objects: objectDescriptors(value.objects),
    evidence_attestation_path: text(value, 'evidence_attestation_path'),
  });
}

export function loadCompletionAdmissionResources(
  descriptor: CompletionAdmissionDescriptor,
  operatorEnvelopeBytes: Uint8Array,
  operatorTrustRootBytes: Uint8Array,
): LoadedCompletionAdmissionRequest {
  const budget = new CanonicalFileReadBudget(MAX_REFERENCED_BYTES);
  const manifestBytes = descriptor.manifest_paths.map((path) => {
    return budget.read(path, 'completion evidence manifest', 4 * MEBIBYTE);
  });
  return Object.freeze({
    descriptor,
    operator_envelope_bytes: Buffer.from(operatorEnvelopeBytes),
    operator_trust_root_bytes: Buffer.from(operatorTrustRootBytes),
    evidence_trust_root_bytes: budget.read(
      descriptor.evidence_trust_root_path,
      'evidence trust root',
      MEBIBYTE,
    ),
    execution_trust_root_bytes: budget.read(
      descriptor.execution_trust_root_path,
      'execution trust root',
      MEBIBYTE,
    ),
    event_policy_bytes: budget.read(descriptor.event_policy_path, 'event policy', MEBIBYTE),
    freshness_policy_bytes: budget.read(
      descriptor.freshness_policy_path,
      'freshness policy',
      MEBIBYTE,
    ),
    candidate: Object.freeze({
      event_bytes: budget.read(descriptor.event_chain_path, 'completion event chain', 4 * MEBIBYTE),
      manifest_bytes: Object.freeze(manifestBytes),
      objects: loadObjects(descriptor.objects, budget),
      evidence_attestation_bytes: budget.read(
        descriptor.evidence_attestation_path,
        'evidence attestation',
        4 * MEBIBYTE,
      ),
    }),
  });
}
