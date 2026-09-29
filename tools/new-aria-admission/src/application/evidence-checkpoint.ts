import { createHash } from 'node:crypto';

import { EvidenceManifest } from '../domain/evidence-contracts';
import { canonicalJsonBytes } from '../kernel/canonical-json';

export interface EvidenceTip {
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly version: number;
  readonly manifest_sha256: string;
  readonly history_sha256: string;
  readonly projection_sha256: string;
  readonly projection_artifact_base64: string;
}

export type EvidenceCheckpointResult = 'COMMITTED' | 'ALREADY_COMMITTED' | 'CONFLICT';

export interface EvidenceCheckpointRequest {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly program_id: string;
  readonly sprint_id: string;
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly expected: EvidenceTip | null;
  readonly next: EvidenceTip;
}

export interface EvidenceCheckpointStore {
  compareAndSet(request: EvidenceCheckpointRequest): Promise<EvidenceCheckpointResult>;
}

export function evidenceCheckpointScopeSha256(
  request: Pick<
    EvidenceCheckpointRequest,
    'program_id' | 'repository_id' | 'sprint_id' | 'workspace_id'
  >,
): string {
  return createHash('sha256')
    .update(
      canonicalJsonBytes({
        program_id: request.program_id,
        repository_id: request.repository_id,
        sprint_id: request.sprint_id,
        workspace_id: request.workspace_id,
      }),
    )
    .digest('hex');
}

export interface EvidenceCheckpointCommit {
  readonly manifest: EvidenceManifest;
  readonly manifest_sha256: string;
  readonly history_sha256: string;
  readonly projection_sha256: string;
  readonly projection_artifact_bytes: Uint8Array;
  readonly valid_from: string;
  readonly valid_until: string;
}

const sha256 = /^[a-f0-9]{64}$/u;
const maximumProjectionArtifactBytes = 64 * 1024;

function projectionArtifact(commit: EvidenceCheckpointCommit): Buffer {
  const value = commit.projection_artifact_bytes;
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('checkpoint projection artifact must be bytes');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError('checkpoint projection artifact cannot use shared memory');
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 1 || bytes.byteLength > maximumProjectionArtifactBytes) {
    throw new TypeError('checkpoint projection artifact size is invalid');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== commit.projection_sha256) {
    throw new TypeError('checkpoint projection artifact digest mismatch');
  }
  return bytes;
}

export async function commitEvidenceCheckpoint(
  commit: EvidenceCheckpointCommit,
  store: EvidenceCheckpointStore,
): Promise<Exclude<EvidenceCheckpointResult, 'CONFLICT'>> {
  if (store === null || typeof store !== 'object' || typeof store.compareAndSet !== 'function') {
    throw new TypeError('evidence checkpoint store is unavailable');
  }
  const { manifest } = commit;
  const previous = manifest.previous_manifest_sha256;
  if (manifest.version > 1 && previous === null) {
    throw new TypeError('versioned evidence checkpoint requires its predecessor digest');
  }
  if (
    !sha256.test(commit.manifest_sha256) ||
    !sha256.test(commit.history_sha256) ||
    !sha256.test(commit.projection_sha256)
  ) {
    throw new TypeError('evidence checkpoint digest is invalid');
  }
  const projectionBytes = projectionArtifact(commit);
  const validFromMs = Date.parse(commit.valid_from);
  const validUntilMs = Date.parse(commit.valid_until);
  if (
    !Number.isFinite(validFromMs) ||
    new Date(validFromMs).toISOString() !== commit.valid_from ||
    !Number.isFinite(validUntilMs) ||
    new Date(validUntilMs).toISOString() !== commit.valid_until ||
    validFromMs > validUntilMs
  ) {
    throw new TypeError('evidence checkpoint validity interval is invalid');
  }
  const request: EvidenceCheckpointRequest = Object.freeze({
    repository_id: manifest.target.repository_id,
    workspace_id: manifest.target.workspace_id,
    program_id: manifest.claim.program_id,
    sprint_id: manifest.claim.sprint_id,
    authority_sha256: manifest.authority_sha256,
    evidence_id: manifest.evidence_id,
    valid_from: commit.valid_from,
    valid_until: commit.valid_until,
    expected: null,
    next: Object.freeze({
      authority_sha256: manifest.authority_sha256,
      evidence_id: manifest.evidence_id,
      version: manifest.version,
      manifest_sha256: commit.manifest_sha256,
      history_sha256: commit.history_sha256,
      projection_sha256: commit.projection_sha256,
      projection_artifact_base64: projectionBytes.toString('base64'),
    }),
  });
  const result = await store.compareAndSet(request);
  if (result !== 'COMMITTED' && result !== 'ALREADY_COMMITTED') {
    throw new TypeError('evidence checkpoint compare-and-set rejected replay or fork');
  }
  return result;
}
