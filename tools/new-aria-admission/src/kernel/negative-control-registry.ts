import { canonicalJsonBytes } from './canonical-json';
import { isJsonRecord, parseCanonicalEvidenceObject } from './evidence-object';
import type { JsonRecord } from './evidence-object';
import { loadOracleBaselineDocument, type OracleBaselineInput } from './oracle-baseline';
import {
  mutateEventHash,
  mutateEvidenceDigest,
  mutateStaleEvidence,
  mutateUnauthorizedTarget,
} from './negative-control-mutations';
import type { JsonValue } from './strict-json';

export type { OracleBaselineInput } from './oracle-baseline';

export type NegativeControlReasonCode =
  | 'EVENT_CONTEXT_PROBE_MISMATCH'
  | 'EVIDENCE_CONTEXT_PROBE_MISMATCH'
  | 'FRESHNESS_CONTEXT_STALE'
  | 'TARGET_HEAD_NOT_AUTHORIZED';

interface RegisteredNegativeControl {
  readonly id: string;
  readonly mutationKind: string;
  readonly reasonCode: NegativeControlReasonCode;
  readonly transform: (baseline: OracleBaselineInput) => JsonRecord;
}

export interface CanonicalNegativeControl {
  readonly bytes: Uint8Array;
  readonly reason_code: NegativeControlReasonCode;
}

const registry: readonly RegisteredNegativeControl[] = Object.freeze([
  Object.freeze({
    id: 'NC-S01-EVENT-HASH-TAMPER',
    mutationKind: 'EVENT-CONTEXT-PROBE-TAMPER',
    reasonCode: 'EVENT_CONTEXT_PROBE_MISMATCH',
    transform: mutateEventHash,
  }),
  Object.freeze({
    id: 'NC-S01-EVIDENCE-DIGEST-TAMPER',
    mutationKind: 'EVIDENCE-CONTEXT-PROBE-TAMPER',
    reasonCode: 'EVIDENCE_CONTEXT_PROBE_MISMATCH',
    transform: mutateEvidenceDigest,
  }),
  Object.freeze({
    id: 'NC-S01-STALE-EVIDENCE',
    mutationKind: 'STALE-EVIDENCE',
    reasonCode: 'FRESHNESS_CONTEXT_STALE',
    transform: mutateStaleEvidence,
  }),
  Object.freeze({
    id: 'NC-S01-UNAUTHORIZED-TARGET',
    mutationKind: 'UNAUTHORIZED-TARGET',
    reasonCode: 'TARGET_HEAD_NOT_AUTHORIZED',
    transform: mutateUnauthorizedTarget,
  }),
]);

function record(value: JsonValue | undefined, label: string): JsonRecord {
  if (!isJsonRecord(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertManifestBinding(baseline: OracleBaselineInput, manifest: JsonRecord): void {
  const target = record(manifest.target, 'oracle baseline target');
  const claim = record(manifest.claim, 'oracle baseline claim');
  if (
    baseline.authority_sha256 !== manifest.authority_sha256 ||
    baseline.evidence_id !== manifest.evidence_id ||
    baseline.repository_id !== target.repository_id ||
    baseline.workspace_id !== target.workspace_id ||
    baseline.base_sha !== target.base_sha ||
    baseline.head_sha !== target.head_sha ||
    baseline.program_id !== claim.program_id ||
    baseline.sprint_id !== claim.sprint_id
  )
    throw new TypeError('oracle baseline input is outside the admitted manifest scope');
}

export function loadOracleBaselineInput(
  reference: JsonValue | undefined,
  objects: ReadonlyMap<string, Uint8Array>,
  manifest: JsonRecord,
): OracleBaselineInput {
  const parsed = parseCanonicalEvidenceObject(reference, objects, 'oracle baseline input');
  const baseline = loadOracleBaselineDocument(parsed.reference.bytes);
  assertManifestBinding(baseline, manifest);
  return baseline;
}

export const requiredNegativeControlCount = registry.length;

export function canonicalRegisteredNegativeControl(
  index: number,
  id: string,
  mutationKind: string,
  baseline: OracleBaselineInput,
): CanonicalNegativeControl {
  const control = registry[index];
  if (control === undefined || control.id !== id || control.mutationKind !== mutationKind) {
    throw new TypeError('oracle negative control is not the required ordered registry entry');
  }
  return Object.freeze({
    bytes: canonicalJsonBytes(control.transform(baseline)),
    reason_code: control.reasonCode,
  });
}
