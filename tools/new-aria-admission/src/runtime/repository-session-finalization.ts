import { createHash } from 'node:crypto';

import type { ExecutableRunEvidence, ExecutableRunResult } from './executable-run-result';
import type { SignedExecutionReceipt } from './execution-signer';
import { readVerifierOutputArtifact } from './verifier-output';

export interface SessionRunCandidate {
  readonly evidence: ExecutableRunEvidence;
  readonly input_envelope: Uint8Array;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function snapshotFinalizedSessionRun(
  candidate: SessionRunCandidate,
  receipt: SignedExecutionReceipt,
): ExecutableRunResult {
  const stdout = Buffer.from(candidate.stdout);
  const stderr = Buffer.from(candidate.stderr);
  const inputEnvelope = Buffer.from(candidate.input_envelope);
  const output = readVerifierOutputArtifact(stdout, {
    run_id: candidate.evidence.run_id,
    run_context_sha256: candidate.evidence.run_context_sha256,
    baseline_input_sha256: candidate.evidence.input_object_sha256s[0],
    input_object_sha256s: candidate.evidence.input_object_sha256s,
  });
  if (
    candidate.evidence.input_envelope_sha256 !== digest(inputEnvelope) ||
    candidate.evidence.stdout.byte_length !== stdout.byteLength ||
    candidate.evidence.stdout.sha256 !== digest(stdout) ||
    candidate.evidence.output_sha256 !== digest(output) ||
    candidate.evidence.stderr.byte_length !== stderr.byteLength ||
    candidate.evidence.stderr.sha256 !== digest(stderr)
  ) {
    throw new TypeError('session run artifacts do not match runner evidence');
  }
  return Object.freeze({
    evidence: candidate.evidence,
    input_envelope: inputEnvelope,
    stdout,
    stderr,
    execution_receipt: Object.freeze({
      bytes: Buffer.from(receipt.bytes),
      sha256: receipt.sha256,
    }),
  });
}

export function orderedFinalizedSessionRuns(
  expectedRunIds: readonly string[],
  finalizedRuns: ReadonlyMap<string, ExecutableRunResult>,
): readonly ExecutableRunResult[] {
  const runs = expectedRunIds.map((runId) => finalizedRuns.get(runId));
  if (runs.some((run) => run === undefined)) {
    throw new TypeError('repository execution session roster is incomplete');
  }
  const completed = runs.filter((run): run is ExecutableRunResult => run !== undefined);
  const baseline = completed[0];
  const controlsPassed = completed
    .slice(1)
    .every(
      (run) =>
        run.evidence.result.semantic_verdict === 'FAILED' &&
        run.evidence.result.final_exit_code === 1,
    );
  if (
    baseline?.evidence.run_id !== 'BASELINE' ||
    baseline.evidence.result.semantic_verdict !== 'PASSED' ||
    baseline.evidence.result.final_exit_code !== 0 ||
    !controlsPassed
  ) {
    throw new TypeError('repository execution session semantic outcomes are invalid');
  }
  return Object.freeze(completed);
}
