import { createHash } from 'node:crypto';

import type { CompletionProjection } from '../domain/progress-contracts';
import { serializeCompletionProjectionArtifact } from '../kernel/completion-projection-artifact';

import {
  evaluateCompletionCandidate,
  projectionFor,
  type CompletionAdmissionEvaluation,
} from './completion-admission-evaluation';
import type { CompletionCandidate } from './completion-candidate';
import { verifyCurrentCompletionProof } from './current-completion-proof';
import {
  commitEvidenceCheckpoint,
  type EvidenceCheckpointResult,
  type EvidenceTip,
} from './evidence-checkpoint';
import {
  historicalCompletionProjectionBytes,
  type HistoricallyVerifiedCompletionProof,
} from './historical-completion-proof';
import type { TrustedCompletionContext } from './trusted-completion-context';

export type { CompletionCandidate } from './completion-candidate';

export interface PreparedSprintCompletion {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-prepared-sprint-completion-v1';
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly evidence_sha256: string;
  readonly history_sha256: string;
  readonly event_chain_sha256: string;
  readonly attestation_sha256: string;
  readonly projection_sha256: string;
  readonly version: number;
}

export interface CommittedSprintCompletion {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-committed-sprint-completion-v1';
  readonly checkpoint_result: Exclude<EvidenceCheckpointResult, 'CONFLICT'>;
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly evidence_sha256: string;
  readonly history_sha256: string;
  readonly event_chain_sha256: string;
  readonly attestation_sha256: string;
  readonly projection_sha256: string;
  readonly version: number;
  readonly checkpoint_tip: EvidenceTip;
}

interface PreparedState {
  phase: 'PREPARED' | 'COMMITTING' | 'COMMITTED';
  readonly evaluation: CompletionAdmissionEvaluation;
  readonly projectionBytes: Buffer;
}

const preparedStates = new WeakMap<object, PreparedState>();
const committedProjections = new WeakMap<object, CompletionProjection>();
const admittedProjections = new WeakMap<object, CompletionProjection>();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function issueCompletionProjection(value: CompletionProjection): CompletionProjection {
  const projection = Object.freeze({ ...value });
  admittedProjections.set(projection, projection);
  return projection;
}

function preparedState(value: unknown): PreparedState {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('prepared completion was not issued by admission');
  }
  const state = preparedStates.get(value);
  if (state === undefined) throw new TypeError('prepared completion was not issued by admission');
  return state;
}

export function snapshotAdmittedCompletionProjection(value: unknown): CompletionProjection {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('completion projection was not issued by admission');
  }
  const projection = admittedProjections.get(value);
  if (projection === undefined) {
    throw new TypeError('completion projection was not issued by admission');
  }
  return Object.freeze({ ...projection });
}

export function prepareSprintCompletion(
  candidate: CompletionCandidate,
  context: TrustedCompletionContext,
): PreparedSprintCompletion {
  const { evaluation, proof } = evaluateCompletionCandidate(candidate, context);
  const projection = projectionFor(evaluation, proof);
  const projectionBytes = serializeCompletionProjectionArtifact(projection);
  const prepared: PreparedSprintCompletion = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-prepared-sprint-completion-v1',
    authority_sha256: context.progress_authority.authority.sha256,
    evidence_id: evaluation.manifest.evidence_id,
    evidence_sha256: evaluation.manifest_sha256,
    history_sha256: evaluation.history_sha256,
    event_chain_sha256: evaluation.event_chain_sha256,
    attestation_sha256: proof.attestation.sha256,
    projection_sha256: sha256(projectionBytes),
    version: evaluation.manifest.version,
  });
  preparedStates.set(prepared, {
    phase: 'PREPARED',
    evaluation,
    projectionBytes,
  });
  return prepared;
}

export function preparedCompletionProjectionBytes(value: PreparedSprintCompletion): Buffer {
  return Buffer.from(preparedState(value).projectionBytes);
}

function assertStagedProof(
  prepared: PreparedSprintCompletion,
  state: PreparedState,
  proof: HistoricallyVerifiedCompletionProof,
): void {
  const bytes = historicalCompletionProjectionBytes(proof);
  if (
    proof.authority_sha256 !== prepared.authority_sha256 ||
    proof.evidence_id !== prepared.evidence_id ||
    proof.version !== prepared.version ||
    proof.evidence_sha256 !== prepared.evidence_sha256 ||
    proof.history_sha256 !== prepared.history_sha256 ||
    proof.event_chain_sha256 !== prepared.event_chain_sha256 ||
    proof.attestation_sha256 !== prepared.attestation_sha256 ||
    proof.projection_sha256 !== prepared.projection_sha256 ||
    !bytes.equals(state.projectionBytes)
  )
    throw new TypeError('staged historical proof differs from prepared completion');
}

function exactProjection(state: PreparedState, projection: CompletionProjection): Buffer {
  const bytes = serializeCompletionProjectionArtifact(projection);
  if (!bytes.equals(state.projectionBytes)) {
    throw new TypeError('completion proof changed before durable checkpoint');
  }
  return bytes;
}

export async function commitPreparedSprintCompletion(
  prepared: PreparedSprintCompletion,
  stagedProof: HistoricallyVerifiedCompletionProof,
): Promise<CommittedSprintCompletion> {
  const state = preparedState(prepared);
  if (state.phase === 'COMMITTED') throw new TypeError('prepared completion was already committed');
  if (state.phase === 'COMMITTING') throw new TypeError('prepared completion commit is in flight');
  assertStagedProof(prepared, state, stagedProof);
  state.phase = 'COMMITTING';
  try {
    const proof = verifyCurrentCompletionProof(state.evaluation.proof_input);
    const projection = projectionFor(state.evaluation, proof);
    const projectionBytes = exactProjection(state, projection);
    const manifest = state.evaluation.manifest;
    const checkpointTip: EvidenceTip = Object.freeze({
      authority_sha256: prepared.authority_sha256,
      evidence_id: manifest.evidence_id,
      version: prepared.version,
      manifest_sha256: prepared.evidence_sha256,
      history_sha256: prepared.history_sha256,
      projection_sha256: prepared.projection_sha256,
      projection_artifact_base64: projectionBytes.toString('base64'),
    });
    const checkpointResult = await commitEvidenceCheckpoint(
      {
        manifest,
        manifest_sha256: prepared.evidence_sha256,
        history_sha256: prepared.history_sha256,
        projection_sha256: prepared.projection_sha256,
        projection_artifact_bytes: projectionBytes,
        valid_from: proof.checkpoint_valid_from,
        valid_until: proof.valid_until,
      },
      proof.resources.checkpoint_store,
    );
    const committed: CommittedSprintCompletion = Object.freeze({
      schema_version: '1.0.0',
      contract_id: 'new-aria-committed-sprint-completion-v1',
      checkpoint_result: checkpointResult,
      authority_sha256: prepared.authority_sha256,
      evidence_id: prepared.evidence_id,
      evidence_sha256: prepared.evidence_sha256,
      history_sha256: prepared.history_sha256,
      event_chain_sha256: prepared.event_chain_sha256,
      attestation_sha256: prepared.attestation_sha256,
      projection_sha256: prepared.projection_sha256,
      version: prepared.version,
      checkpoint_tip: checkpointTip,
    });
    state.phase = 'COMMITTED';
    committedProjections.set(committed, issueCompletionProjection(projection));
    return committed;
  } catch (error) {
    state.phase = 'PREPARED';
    throw error;
  }
}

export function assertCommittedSprintCompletion(
  value: unknown,
): asserts value is CommittedSprintCompletion {
  if (value === null || typeof value !== 'object' || !committedProjections.has(value)) {
    throw new TypeError('committed completion was not issued by admission');
  }
}

export function snapshotCommittedCompletionProjection(
  value: CommittedSprintCompletion,
): CompletionProjection {
  assertCommittedSprintCompletion(value);
  const projection = committedProjections.get(value);
  if (projection === undefined) throw new TypeError('committed completion projection is absent');
  return projection;
}
