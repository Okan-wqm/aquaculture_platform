import type {
  EvidenceHistoryManifest,
  EvidenceIdentities,
  EvidenceManifest,
  EvidenceTarget,
  EvidenceTransitionManifest,
  EvidenceTransitionState,
} from '../domain/evidence-contracts';

import { canonicalJsonBytes, compareCodePoints } from './canonical-json';
import type { EventRecord } from './event-chain';
import { manifestSha256, parseEvidenceManifest } from './evidence-chain';
import {
  canonicalTimestamp,
  claimKeys,
  identityKeys,
  sha40,
  targetKeys,
  transitionManifestKeys,
} from './evidence-manifest-schema';
import { hasExactKeys, isJsonRecord, requiredSha256, requiredText } from './evidence-object';
import { requireIdentifier } from './identifiers';
import type { JsonValue } from './strict-json';
import { parseStrictJson } from './strict-json';

const transitionStates: readonly EvidenceTransitionState[] = ['READY', 'IN_PROGRESS', 'VERIFYING'];

export interface VerifiedEventEvidenceHistory {
  readonly manifests: readonly EvidenceHistoryManifest[];
  readonly final_manifest: EvidenceManifest;
}

function canonicalTime(value: JsonValue | undefined, label: string): string {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (
    !canonicalTimestamp.test(text) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return text;
}

function sortedIdentifiers(
  value: JsonValue | undefined,
  pattern: RegExp,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
  const values = value.map((entry) => requireIdentifier(entry, label));
  const sorted = [...values].sort(compareCodePoints);
  if (
    new Set(values).size !== values.length ||
    values.some((entry, index) => entry !== sorted[index] || !pattern.test(entry))
  ) {
    throw new TypeError(`${label} must be unique and sorted`);
  }
  return Object.freeze(values);
}

function identities(value: JsonValue | undefined): EvidenceIdentities {
  if (!isJsonRecord(value) || !hasExactKeys(value, identityKeys)) {
    throw new TypeError('transition evidence identities are invalid');
  }
  const result = {
    producer_principal_id: requireIdentifier(value.producer_principal_id, 'producer principal'),
    reviewer_principal_id: requireIdentifier(value.reviewer_principal_id, 'reviewer principal'),
    oracle_principal_id: requireIdentifier(value.oracle_principal_id, 'oracle principal'),
    appellate_principal_id: requireIdentifier(value.appellate_principal_id, 'appellate principal'),
  };
  if (new Set(Object.values(result)).size !== identityKeys.length) {
    throw new TypeError('transition evidence identities must be distinct');
  }
  return Object.freeze(result);
}

function target(value: JsonValue | undefined): EvidenceTarget {
  if (!isJsonRecord(value) || !hasExactKeys(value, targetKeys)) {
    throw new TypeError('transition evidence target is invalid');
  }
  const baseSha = requiredText(value.base_sha, 'transition base SHA');
  const headSha = requiredText(value.head_sha, 'transition head SHA');
  const deployedSha = value.deployed_sha;
  if (
    !sha40.test(baseSha) ||
    !sha40.test(headSha) ||
    (deployedSha !== null && (typeof deployedSha !== 'string' || !sha40.test(deployedSha)))
  ) {
    throw new TypeError('transition evidence target SHA is invalid');
  }
  return Object.freeze({
    repository_id: requireIdentifier(value.repository_id, 'transition repository'),
    workspace_id: requireIdentifier(value.workspace_id, 'transition workspace'),
    base_sha: baseSha,
    head_sha: headSha,
    deployed_sha: deployedSha,
  });
}

function transitionClaim(
  value: JsonValue | undefined,
  state: EvidenceTransitionState,
): EvidenceTransitionManifest['claim'] {
  if (!isJsonRecord(value) || !hasExactKeys(value, claimKeys) || value.state !== state) {
    throw new TypeError('transition evidence claim is invalid');
  }
  return Object.freeze({
    program_id: requireIdentifier(value.program_id, 'transition program'),
    sprint_id: requireIdentifier(value.sprint_id, 'transition sprint'),
    state,
    acceptance_ids: sortedIdentifiers(value.acceptance_ids, /^ACC-[A-Z0-9-]+$/u, 'acceptance IDs'),
    finding_ids: sortedIdentifiers(value.finding_ids, /^ARIA-AUDIT-\d{3}$/u, 'finding IDs'),
  });
}

function parseTransitionManifest(
  bytes: Uint8Array,
  expectedState: EvidenceTransitionState,
): EvidenceTransitionManifest {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new TypeError('transition evidence must be newline-terminated');
  }
  const body = bytes.slice(0, -1);
  const value = parseStrictJson(body);
  if (
    !isJsonRecord(value) ||
    !canonicalJsonBytes(value).equals(Buffer.from(body)) ||
    !hasExactKeys(value, transitionManifestKeys) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'aria-evidence-manifest-v1'
  ) {
    throw new TypeError('transition evidence schema or canonical encoding is invalid');
  }
  const version = value.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new TypeError('transition evidence version is invalid');
  }
  const previous =
    value.previous_manifest_sha256 === null
      ? null
      : requiredSha256(value.previous_manifest_sha256, 'transition predecessor');
  return Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'aria-evidence-manifest-v1',
    evidence_id: requireIdentifier(value.evidence_id, 'transition evidence'),
    version: Number(version),
    previous_manifest_sha256: previous,
    observed_at: canonicalTime(value.observed_at, 'transition observation time'),
    observation_id: requireIdentifier(value.observation_id, 'transition observation'),
    authority_sha256: requiredSha256(value.authority_sha256, 'transition authority'),
    claim: transitionClaim(value.claim, expectedState),
    identities: identities(value.identities),
    target: target(value.target),
  });
}

function immutableScope(manifest: EvidenceHistoryManifest): object {
  return {
    acceptance_ids: manifest.claim.acceptance_ids,
    authority_sha256: manifest.authority_sha256,
    evidence_id: manifest.evidence_id,
    finding_ids: manifest.claim.finding_ids,
    identities: manifest.identities,
    program_id: manifest.claim.program_id,
    sprint_id: manifest.claim.sprint_id,
    target: manifest.target,
  };
}

function eventText(event: EventRecord, field: string): string {
  return requiredText(event[field], `historical event ${field}`);
}

export function verifyEventEvidenceHistory(
  events: readonly EventRecord[],
  manifestBytes: readonly Uint8Array[],
  objects: ReadonlyMap<string, Uint8Array>,
): VerifiedEventEvidenceHistory {
  if (events.length !== 4 || manifestBytes.length !== events.length) {
    throw new TypeError('event and evidence history require one-to-one count');
  }
  const manifests: EvidenceHistoryManifest[] = manifestBytes.map((bytes, index) => {
    const state = transitionStates[index];
    return state === undefined
      ? parseEvidenceManifest(bytes, objects)
      : parseTransitionManifest(bytes, state);
  });
  const digests = manifestBytes.map(manifestSha256);
  if (new Set(digests).size !== digests.length) {
    throw new TypeError('historical event evidence digest reuse is forbidden');
  }
  const initial = manifests[0];
  if (initial === undefined) throw new TypeError('historical evidence is empty');
  const initialScope = canonicalJsonBytes(immutableScope(initial));
  manifests.forEach((manifest, index) => {
    const event = events[index];
    if (event === undefined) throw new TypeError('historical event is missing');
    const digest = digests[index];
    const previousDigest = index === 0 ? null : digests[index - 1];
    if (
      manifest.version !== index + 1 ||
      manifest.previous_manifest_sha256 !== previousDigest ||
      event.sequence !== index + 1 ||
      event.evidence_sha256 !== digest ||
      event.evidence_uri !== `aria-evidence://sha256/${digest}` ||
      manifest.claim.state !== event.to_state ||
      manifest.authority_sha256 !== event.authority_sha256 ||
      manifest.claim.program_id !== event.program_id ||
      manifest.claim.sprint_id !== event.sprint_id ||
      manifest.target.head_sha !== event.target_sha ||
      Date.parse(manifest.observed_at) > Date.parse(eventText(event, 'occurred_at')) ||
      !canonicalJsonBytes(immutableScope(manifest)).equals(initialScope)
    ) {
      throw new TypeError('event evidence order, state, predecessor, time, or scope mismatch');
    }
    const previous = manifests[index - 1];
    if (
      previous !== undefined &&
      (Date.parse(manifest.observed_at) <= Date.parse(previous.observed_at) ||
        manifest.observation_id <= previous.observation_id)
    ) {
      throw new TypeError('historical evidence observations are not strictly increasing');
    }
  });
  const finalManifest = manifests.at(-1);
  if (
    finalManifest === undefined ||
    finalManifest.claim.state !== 'DONE' ||
    !('oracle' in finalManifest)
  ) {
    throw new TypeError('historical evidence tail is not a DONE completion manifest');
  }
  return Object.freeze({
    manifests: Object.freeze(manifests),
    final_manifest: finalManifest,
  });
}
