import type { EvidenceTip } from '../application/evidence-checkpoint';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { digestBytes } from '../kernel/evidence-object';
import { decodeCanonicalBase64 } from '../kernel/evidence-trust-root';
import { parseStrictJson } from '../kernel/strict-json';

import { readCheckpointFile } from './file-checkpoint-directory-io';
import type { CheckpointDirectoryAccess } from './file-checkpoint-directory-io';
import { boundedDirectoryEntryNames } from './bounded-directory-entries';

const checkpointName = /^([a-f0-9]{64})-([0-9]{10})-([a-f0-9]{64})\.json$/u;
const storedTipKeys = [
  'authority_sha256',
  'evidence_id',
  'version',
  'manifest_sha256',
  'history_sha256',
  'projection_sha256',
  'projection_artifact_base64',
] as const;

export type StoredCheckpointTip = EvidenceTip;

export function parseStoredCheckpointTip(
  bytes: Uint8Array,
  version: number,
  manifestSha256: string,
): StoredCheckpointTip {
  const parsed = parseStrictJson(bytes);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([...storedTipKeys].sort()) ||
    typeof parsed.version !== 'number' ||
    parsed.version !== version ||
    typeof parsed.authority_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(parsed.authority_sha256) ||
    typeof parsed.evidence_id !== 'string' ||
    parsed.evidence_id.length === 0 ||
    typeof parsed.manifest_sha256 !== 'string' ||
    parsed.manifest_sha256 !== manifestSha256 ||
    typeof parsed.history_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(parsed.history_sha256) ||
    typeof parsed.projection_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(parsed.projection_sha256) ||
    typeof parsed.projection_artifact_base64 !== 'string' ||
    !canonicalJsonBytes(parsed).equals(bytes)
  )
    throw new TypeError('evidence checkpoint record is invalid');
  const tip: StoredCheckpointTip = Object.freeze({
    authority_sha256: parsed.authority_sha256,
    evidence_id: parsed.evidence_id,
    version,
    manifest_sha256: manifestSha256,
    history_sha256: parsed.history_sha256,
    projection_sha256: parsed.projection_sha256,
    projection_artifact_base64: parsed.projection_artifact_base64,
  });
  checkpointProjectionArtifactBytes(tip);
  return tip;
}

export function checkpointProjectionArtifactBytes(tip: StoredCheckpointTip): Buffer {
  const bytes = decodeCanonicalBase64(
    tip.projection_artifact_base64,
    'checkpoint projection artifact',
  );
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > 64 * 1024 ||
    digestBytes(bytes) !== tip.projection_sha256
  ) {
    throw new TypeError('checkpoint projection artifact is invalid');
  }
  return bytes;
}

export function readStoredCheckpointTip(
  directory: CheckpointDirectoryAccess,
  scope: string,
): StoredCheckpointTip | null {
  const matches = boundedDirectoryEntryNames(
    directory.descriptor_path,
    4_096,
    'checkpoint directory',
  )
    .map((name) => ({ match: checkpointName.exec(name), name }))
    .filter(({ match }) => match?.[1] === scope);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new TypeError('checkpoint scope contains multiple immutable final tips');
  }
  const entry = matches[0];
  const match = entry?.match;
  if (entry === undefined || match === null || match === undefined) {
    throw new TypeError('checkpoint index is malformed');
  }
  const bytes = readCheckpointFile(directory, entry.name, 128 * 1024);
  const version = match[2] === undefined ? Number.NaN : Number(match[2]);
  const manifestSha256 = match[3];
  if (!Number.isSafeInteger(version) || version < 1 || manifestSha256 === undefined)
    throw new TypeError('evidence checkpoint record is invalid');
  return parseStoredCheckpointTip(bytes, version, manifestSha256);
}

export function sameCheckpointTip(
  left: StoredCheckpointTip | null,
  right: EvidenceTip | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.authority_sha256 === right.authority_sha256 &&
      left.evidence_id === right.evidence_id &&
      left.version === right.version &&
      left.manifest_sha256 === right.manifest_sha256 &&
      left.history_sha256 === right.history_sha256 &&
      left.projection_sha256 === right.projection_sha256 &&
      left.projection_artifact_base64 === right.projection_artifact_base64)
  );
}
