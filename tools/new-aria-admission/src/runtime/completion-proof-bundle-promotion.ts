import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

import {
  assertRecoveredCommittedCompletion,
  type RecoveredCommittedCompletion,
} from '../application/completion-publication-recovery';
import type { EvidenceTip } from '../application/evidence-checkpoint';
import {
  assertCommittedSprintCompletion,
  type CommittedSprintCompletion,
} from '../application/progress-admission';

import { readBoundCompletionProofBundle } from './completion-proof-bundle-reader';
import {
  assertVerifiedCompletionProofBundle,
  type VerifiedCompletionProofBundle,
} from './completion-proof-bundle-verifier';
import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';

type TrustedCompletionCommit = CommittedSprintCompletion | RecoveredCommittedCompletion;
export type CompletionProofBundleState = 'ABSENT' | 'CANDIDATE' | 'COMPLETE' | 'PARTIAL';
const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function closeIgnoringFailure(descriptor: number): void {
  if (descriptor < 0) return;
  try {
    closeSync(descriptor);
  } catch {
    // Promotion preserves the originating verification failure.
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function hasOwnedMarker(rootFd: number, name: 'CANDIDATE.json' | 'COMPLETE.json'): boolean {
  let descriptor = -1;
  try {
    descriptor = openSync(
      join(descriptorPath(rootFd), name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(descriptor);
    const effectiveUser = process.geteuid?.();
    if (
      effectiveUser === undefined ||
      !stat.isFile() ||
      stat.uid !== effectiveUser ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new TypeError('completion bundle marker metadata is unsafe');
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  } finally {
    closeIgnoringFailure(descriptor);
  }
}

export function completionProofBundleState(bundlePath: string): CompletionProofBundleState {
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('completion bundle path must be absolute and canonical');
  }
  let rootFd = -1;
  try {
    rootFd = openSync(
      bundlePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const rootBinding = bindOwnerControlledDirectory(bundlePath, rootFd);
    const candidate = hasOwnedMarker(rootFd, 'CANDIDATE.json');
    const complete = hasOwnedMarker(rootFd, 'COMPLETE.json');
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    if (candidate && !complete) return 'CANDIDATE';
    if (complete && !candidate) return 'COMPLETE';
    return 'PARTIAL';
  } catch (error) {
    if (isMissing(error)) return 'ABSENT';
    throw error;
  } finally {
    closeIgnoringFailure(rootFd);
  }
}

function trustedTip(value: TrustedCompletionCommit): EvidenceTip {
  if (value.contract_id === 'new-aria-committed-sprint-completion-v1') {
    assertCommittedSprintCompletion(value);
  } else {
    assertRecoveredCommittedCompletion(value);
  }
  return value.checkpoint_tip;
}

export function assertCompletionProofBundleCommit(
  verified: VerifiedCompletionProofBundle,
  committed: TrustedCompletionCommit,
): void {
  assertVerifiedCompletionProofBundle(verified);
  const tip = trustedTip(committed);
  const projectionBytes = Buffer.from(tip.projection_artifact_base64, 'base64');
  if (
    committed.authority_sha256 !== verified.authority_sha256 ||
    committed.evidence_id !== verified.historical_proof.evidence_id ||
    committed.evidence_sha256 !== verified.evidence_sha256 ||
    committed.history_sha256 !== verified.history_sha256 ||
    committed.event_chain_sha256 !== verified.historical_proof.event_chain_sha256 ||
    committed.attestation_sha256 !== verified.historical_proof.attestation_sha256 ||
    committed.projection_sha256 !== verified.projection_sha256 ||
    committed.version !== verified.version ||
    tip.authority_sha256 !== verified.authority_sha256 ||
    tip.manifest_sha256 !== verified.evidence_sha256 ||
    tip.history_sha256 !== verified.history_sha256 ||
    tip.projection_sha256 !== verified.projection_sha256 ||
    tip.version !== verified.version ||
    sha256(projectionBytes) !== verified.projection_sha256
  ) {
    throw new TypeError('staged completion bundle differs from trusted checkpoint tip');
  }
}

export function promoteStagedCompletionProofBundle(
  bundlePath: string,
  verified: VerifiedCompletionProofBundle,
  committed: TrustedCompletionCommit,
): void {
  assertCompletionProofBundleCommit(verified, committed);
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('completion bundle path must be absolute and canonical');
  }
  const parentPath = dirname(bundlePath);
  let parentFd = -1;
  let rootFd = -1;
  try {
    parentFd = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentBinding = bindOwnerControlledDirectory(parentPath, parentFd);
    rootFd = openSync(
      join(descriptorPath(parentFd), basename(bundlePath)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const rootBinding = bindOwnerControlledDirectory(bundlePath, rootFd);
    const loaded = readBoundCompletionProofBundle(bundlePath, rootFd, 'CANDIDATE.json');
    if (sha256(loaded.marker_bytes) !== verified.bundle_sha256) {
      throw new TypeError('staged completion marker differs from verified candidate');
    }
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    renameSync(
      join(descriptorPath(rootFd), 'CANDIDATE.json'),
      join(descriptorPath(rootFd), 'COMPLETE.json'),
    );
    fsyncSync(rootFd);
    fsyncSync(parentFd);
    const completed = readBoundCompletionProofBundle(bundlePath, rootFd, 'COMPLETE.json');
    if (sha256(completed.marker_bytes) !== verified.bundle_sha256) {
      throw new TypeError('completed bundle differs from verified candidate');
    }
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    verifyOwnerControlledDirectory(parentPath, parentFd, parentBinding);
  } finally {
    closeIgnoringFailure(rootFd);
    closeIgnoringFailure(parentFd);
  }
}
