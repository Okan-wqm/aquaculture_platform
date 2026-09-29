import { createHash } from 'node:crypto';

import { EvidenceManifest } from '../domain/evidence-contracts';

import { canonicalJsonBytes, compareCodePoints } from './canonical-json';
import { deepFreezeJson } from './deep-freeze-json';
import {
  canonicalTimestamp,
  claimKeys,
  identityKeys,
    manifestKeys,
    sha40,
  sha64,
  targetKeys,
} from './evidence-manifest-schema';
import { validateOracleEvidence } from './evidence-oracle';
import { validateEvidenceReferenceRoster } from './evidence-reference-roster';
import { validateExecutionWitness } from './execution-witness';
import { assertFreshnessProofShape } from './freshness';
import { requireIdentifier } from './identifiers';
import { loadOracleBaselineInput } from './negative-control-registry';
import { JsonValue, parseStrictJson } from './strict-json';

type JsonRecord = { [key: string]: JsonValue };

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const manifestSha256 = (bytes: Uint8Array): string => digest(bytes);

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateIdentities(value: JsonValue): void {
  if (!isRecord(value) || !exactKeys(value, identityKeys)) {
    throw new TypeError('evidence identities schema is open or incomplete');
  }
  const identities = identityKeys.map((key) => requireIdentifier(value[key], key));
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(
      'evidence producer, reviewer, oracle, and appellate identities must be distinct',
    );
  }
}

function validateTarget(value: JsonValue): void {
  if (!isRecord(value) || !exactKeys(value, targetKeys)) {
    throw new TypeError('evidence target schema is open or incomplete');
  }
  requireIdentifier(value.repository_id, 'repository identifier');
  requireIdentifier(value.workspace_id, 'workspace identifier');
  for (const field of ['base_sha', 'head_sha']) {
    if (!sha40.test(requiredString(value[field], field)))
      throw new TypeError(`${field} is invalid`);
  }
  if (
    value.deployed_sha !== null &&
    !sha40.test(requiredString(value.deployed_sha, 'deployed SHA'))
  ) {
    throw new TypeError('deployed SHA is invalid');
  }
}

function validateIdentifiers(value: JsonValue, pattern: RegExp, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  const identifiers = value as string[];
  const sorted = [...identifiers].sort(compareCodePoints);
  if (
    identifiers.some((item) => !pattern.test(item)) ||
    new Set(identifiers).size !== identifiers.length ||
    identifiers.some((item, index) => item !== sorted[index])
  ) {
    throw new TypeError(`${label} must contain unique, sorted identifiers`);
  }
}

function validateClaim(value: JsonValue): void {
  if (!isRecord(value) || !exactKeys(value, claimKeys)) {
    throw new TypeError('evidence claim schema is open or incomplete');
  }
  requireIdentifier(value.program_id, 'evidence claim program identifier');
  requireIdentifier(value.sprint_id, 'evidence claim sprint identifier');
  if (value.state !== 'DONE') throw new TypeError('evidence claim state must be DONE');
  validateIdentifiers(value.acceptance_ids as JsonValue, /^ACC-[A-Z0-9-]+$/u, 'acceptance IDs');
  validateIdentifiers(value.finding_ids as JsonValue, /^ARIA-AUDIT-\d{3}$/u, 'finding IDs');
}

function assertManifest(
  value: unknown,
  objects: ReadonlyMap<string, Uint8Array>,
): asserts value is EvidenceManifest {
  if (!isRecord(value) || !exactKeys(value, manifestKeys)) {
    throw new TypeError('evidence manifest schema is open or incomplete');
  }
  if (value.schema_version !== '1.0.0' || value.contract_id !== 'aria-evidence-manifest-v1') {
    throw new TypeError('evidence manifest contract identity mismatch');
  }
  requireIdentifier(value.evidence_id, 'evidence identifier');
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new TypeError('evidence manifest version is invalid');
  }
  if (
    value.previous_manifest_sha256 !== null &&
    (typeof value.previous_manifest_sha256 !== 'string' ||
      !sha64.test(value.previous_manifest_sha256))
  ) {
    throw new TypeError('evidence predecessor digest is invalid');
  }
  if (
    typeof value.observed_at !== 'string' ||
    !canonicalTimestamp.test(value.observed_at) ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    new Date(Date.parse(value.observed_at)).toISOString() !== value.observed_at
  ) {
    throw new TypeError('evidence observation timestamp is invalid');
  }
  requireIdentifier(value.observation_id, 'evidence observation identifier');
  if (typeof value.authority_sha256 !== 'string' || !sha64.test(value.authority_sha256)) {
    throw new TypeError('evidence authority digest is invalid');
  }
  validateClaim(value.claim as JsonValue);
  assertFreshnessProofShape(value.freshness);
  if ((value.freshness as { observed_at: string }).observed_at !== value.observed_at) {
    throw new TypeError('evidence freshness observation does not match manifest');
  }
  validateIdentities(value.identities as JsonValue);
  validateTarget(value.target as JsonValue);
  validateEvidenceReferenceRoster(value.inputs, value.artifacts, value.report, objects);
  if (!Array.isArray(value.inputs) || !isRecord(value.report)) {
    throw new TypeError('validated evidence reference roster is unavailable');
  }
  const baselineInput = value.inputs[0];
  if (!isRecord(baselineInput)) throw new TypeError('baseline input reference is invalid');
  const baselineDocument = loadOracleBaselineInput(baselineInput, objects, value);
  validateExecutionWitness(value.execution, objects, {
    run_context_sha256: baselineDocument.run_context_sha256,
    input_sha256: requiredString(baselineInput.sha256, 'baseline input object digest'),
    output_sha256: requiredString(value.report.sha256, 'evidence report digest'),
    semantic_verdict: 'PASSED',
    observed_at: value.observed_at,
  });
  validateOracleEvidence(value, objects);
  if (
    value.verdict !== 'ACCEPTED' ||
    !Array.isArray(value.unresolved_findings) ||
    value.unresolved_findings.length !== 0
  ) {
    throw new TypeError('accepted evidence cannot contain unresolved findings');
  }
}

export function parseEvidenceManifest(
  bytes: Uint8Array,
  objects: ReadonlyMap<string, Uint8Array>,
): EvidenceManifest {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new TypeError('evidence manifest must be newline-terminated');
  }
  const body = bytes.slice(0, -1);
  const value = parseStrictJson(body);
  if (!canonicalJsonBytes(value).equals(Buffer.from(body))) {
    throw new TypeError('evidence manifest must use canonical JSON');
  }
  assertManifest(value, objects);
  deepFreezeJson(value);
  return value;
}

export function verifyEvidenceChain(
  manifestBytes: readonly Uint8Array[],
  objects: ReadonlyMap<string, Uint8Array>,
): readonly EvidenceManifest[] {
  if (manifestBytes.length === 0) throw new TypeError('evidence manifest chain is empty');
  const manifests = manifestBytes.map((bytes) => parseEvidenceManifest(bytes, objects));
  const initial = manifests[0];
  manifests.forEach((manifest, index) => {
    if (manifest.version !== index + 1) throw new TypeError('evidence version gap or reuse');
    const previousBytes = manifestBytes[index - 1];
    const expectedPrevious =
      index === 0 || previousBytes === undefined ? null : manifestSha256(previousBytes);
    if (manifest.previous_manifest_sha256 !== expectedPrevious) {
      throw new TypeError('evidence predecessor digest mismatch');
    }
    if (
      initial === undefined ||
      manifest.evidence_id !== initial.evidence_id ||
      manifest.authority_sha256 !== initial.authority_sha256 ||
      canonicalJsonBytes(manifest.claim).compare(canonicalJsonBytes(initial.claim)) !== 0 ||
      canonicalJsonBytes(manifest.target).compare(canonicalJsonBytes(initial.target)) !== 0
    ) {
      throw new TypeError('evidence chain identity or target fork');
    }
    if (index > 0) {
      const previous = manifests[index - 1];
      if (previous === undefined) throw new TypeError('evidence predecessor is missing');
      if (
        manifest.observation_id <= previous.observation_id ||
        Date.parse(manifest.observed_at) <= Date.parse(previous.observed_at)
      ) {
        throw new TypeError('evidence observations are not strictly increasing');
      }
    }
  });
  return Object.freeze(manifests);
}
