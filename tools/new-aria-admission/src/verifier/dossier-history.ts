import { canonicalJsonBytes, compareCodePoints } from '../kernel/canonical-json';
import type { EventRecord } from '../kernel/event-chain';
import { manifestSha256 } from '../kernel/evidence-chain';
import {
  canonicalTimestamp,
  claimKeys,
  identityKeys,
  sha40,
  targetKeys,
  transitionManifestKeys,
} from '../kernel/evidence-manifest-schema';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from '../kernel/evidence-object';
import { requireIdentifier } from '../kernel/identifiers';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonRecord } from '../kernel/evidence-object';
import type { JsonValue } from '../kernel/strict-json';

import { decodeDossierBytes } from './dossier-bytes';

const states = ['READY', 'IN_PROGRESS', 'VERIFYING'] as const;

export interface DossierHistoryScope {
  readonly authority_sha256: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly evidence_id: string;
  readonly program_id: string;
  readonly sprint_id: string;
  readonly acceptance_ids: readonly string[];
  readonly finding_ids: readonly string[];
  readonly identities: JsonRecord;
  readonly history: readonly {
    readonly state: string;
    readonly event_id: string;
    readonly actor_id: string;
    readonly observation_id: string;
    readonly manifest_observed_at: string;
    readonly event_occurred_at: string;
  }[];
}

export interface VerifiedDossierHistory {
  readonly sha256: string;
  readonly manifest_bytes: readonly Buffer[];
  readonly manifest_sha256s: readonly string[];
}

function timestamp(value: JsonValue | undefined, label: string): string {
  const result = requiredText(value, label);
  const parsed = Date.parse(result);
  if (
    !canonicalTimestamp.test(result) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== result
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return result;
}

function sortedIds(
  value: JsonValue | undefined,
  pattern: RegExp,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} is invalid`);
  const result = value.map((entry) => requireIdentifier(entry, label));
  const sorted = [...result].sort(compareCodePoints);
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => entry !== sorted[index] || !pattern.test(entry))
  )
    throw new TypeError(`${label} must be unique and sorted`);
  return result;
}

function identities(value: JsonValue | undefined): JsonRecord {
  if (!isJsonRecord(value) || !hasExactKeys(value, identityKeys)) {
    throw new TypeError('dossier manifest identities are invalid');
  }
  const ids = identityKeys.map((key) => requireIdentifier(value[key], `dossier ${key}`));
  if (new Set(ids).size !== ids.length) throw new TypeError('dossier identities are not separated');
  return value;
}

function target(value: JsonValue | undefined): JsonRecord {
  if (!isJsonRecord(value) || !hasExactKeys(value, targetKeys)) {
    throw new TypeError('dossier manifest target is invalid');
  }
  requireIdentifier(value.repository_id, 'dossier repository');
  requireIdentifier(value.workspace_id, 'dossier workspace');
  const baseSha = requiredText(value.base_sha, 'dossier base SHA');
  const headSha = requiredText(value.head_sha, 'dossier head SHA');
  if (!sha40.test(baseSha) || !sha40.test(headSha) || value.deployed_sha !== null) {
    throw new TypeError('dossier manifest target SHA is invalid');
  }
  return value;
}

function claim(value: JsonValue | undefined, state: string): JsonRecord {
  if (!isJsonRecord(value) || !hasExactKeys(value, claimKeys) || value.state !== state) {
    throw new TypeError('dossier manifest claim is invalid');
  }
  requireIdentifier(value.program_id, 'dossier program');
  requireIdentifier(value.sprint_id, 'dossier sprint');
  sortedIds(value.acceptance_ids, /^ACC-[A-Z0-9-]+$/u, 'dossier acceptance IDs');
  sortedIds(value.finding_ids, /^ARIA-AUDIT-\d{3}$/u, 'dossier finding IDs');
  return value;
}

function parseManifest(bytes: Uint8Array, state: string): JsonRecord {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new TypeError('dossier transition manifest is not newline terminated');
  }
  const body = bytes.slice(0, -1);
  const value = parseStrictJson(body);
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, transitionManifestKeys) ||
    !canonicalJsonBytes(value).equals(Buffer.from(body)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'aria-evidence-manifest-v1'
  )
    throw new TypeError('dossier transition manifest is not canonical and closed');
  if (
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    throw new TypeError('dossier transition version is invalid');
  }
  timestamp(value.observed_at, 'dossier manifest observation');
  identities(value.identities);
  target(value.target);
  claim(value.claim, state);
  return value;
}

function immutableScope(manifest: JsonRecord): Buffer {
  const targetValue = target(manifest.target);
  const claimValue = isJsonRecord(manifest.claim) ? manifest.claim : {};
  return canonicalJsonBytes({
    acceptance_ids: claimValue.acceptance_ids,
    authority_sha256: manifest.authority_sha256,
    evidence_id: manifest.evidence_id,
    finding_ids: claimValue.finding_ids,
    identities: manifest.identities,
    program_id: claimValue.program_id,
    sprint_id: claimValue.sprint_id,
    target: targetValue,
  });
}

function assertScope(manifest: JsonRecord, scope: DossierHistoryScope): void {
  const claimValue = isJsonRecord(manifest.claim) ? manifest.claim : {};
  const targetValue = isJsonRecord(manifest.target) ? manifest.target : {};
  if (
    manifest.authority_sha256 !== scope.authority_sha256 ||
    manifest.evidence_id !== scope.evidence_id ||
    claimValue.program_id !== scope.program_id ||
    claimValue.sprint_id !== scope.sprint_id ||
    targetValue.repository_id !== scope.repository_id ||
    targetValue.workspace_id !== scope.workspace_id ||
    targetValue.base_sha !== scope.base_sha ||
    targetValue.head_sha !== scope.head_sha ||
    canonicalJsonBytes(claimValue.acceptance_ids).compare(
      canonicalJsonBytes(scope.acceptance_ids),
    ) !== 0 ||
    canonicalJsonBytes(claimValue.finding_ids).compare(canonicalJsonBytes(scope.finding_ids)) !==
      0 ||
    canonicalJsonBytes(manifest.identities).compare(canonicalJsonBytes(scope.identities)) !== 0
  )
    throw new TypeError('dossier history is outside its authorized scope');
}

export function verifyDossierHistory(
  value: JsonValue | undefined,
  events: readonly EventRecord[],
  scope: DossierHistoryScope,
): VerifiedDossierHistory {
  if (!Array.isArray(value) || value.length !== states.length || events.length !== states.length) {
    throw new TypeError('dossier history requires exactly three transitions');
  }
  const bytes = value.map(
    (entry, index) => decodeDossierBytes(entry, `dossier manifest ${index + 1}`).bytes,
  );
  const manifests = bytes.map((entry, index) => parseManifest(entry, states[index] ?? ''));
  const digests = bytes.map(manifestSha256);
  if (new Set(digests).size !== digests.length)
    throw new TypeError('dossier manifest digest reuse');
  const first = manifests[0];
  if (first === undefined) throw new TypeError('dossier history is empty');
  const scopeBytes = immutableScope(first);
  manifests.forEach((manifest, index) => {
    const event = events[index];
    const previous = manifests[index - 1];
    const expected = scope.history[index];
    if (
      event === undefined ||
      expected === undefined ||
      manifest.version !== index + 1 ||
      manifest.previous_manifest_sha256 !== (index === 0 ? null : digests[index - 1]) ||
      event.evidence_sha256 !== digests[index] ||
      event.evidence_uri !== `aria-evidence://sha256/${digests[index]}` ||
      event.to_state !== states[index] ||
      event.to_state !== expected.state ||
      event.event_id !== expected.event_id ||
      event.actor_id !== expected.actor_id ||
      event.authority_sha256 !== scope.authority_sha256 ||
      event.program_id !== scope.program_id ||
      event.sprint_id !== scope.sprint_id ||
      event.target_sha !== scope.head_sha ||
      event.occurred_at !== expected.event_occurred_at ||
      manifest.observed_at !== expected.manifest_observed_at ||
      manifest.observation_id !== expected.observation_id ||
      Date.parse(requiredText(manifest.observed_at, 'dossier observation')) >
        Date.parse(requiredText(event.occurred_at, 'dossier event time')) ||
      !immutableScope(manifest).equals(scopeBytes)
    )
      throw new TypeError('dossier event and evidence history diverge');
    assertScope(manifest, scope);
    if (
      previous !== undefined &&
      (Date.parse(requiredText(manifest.observed_at, 'dossier observation')) <=
        Date.parse(requiredText(previous.observed_at, 'previous dossier observation')) ||
        requiredText(manifest.observation_id, 'dossier observation ID') <=
          requiredText(previous.observation_id, 'previous dossier observation ID'))
    )
      throw new TypeError('dossier observations are not increasing');
    requiredSha256(manifest.authority_sha256, 'dossier authority');
  });
  return Object.freeze({
    sha256: digestBytes(canonicalJsonBytes(digests)),
    manifest_bytes: Object.freeze(bytes.map((entry) => Buffer.from(entry))),
    manifest_sha256s: Object.freeze([...digests]),
  });
}
