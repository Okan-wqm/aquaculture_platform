import type { VerifiedVerifierContext } from '../verifier/authenticated-input';
import { canonicalVerifierBaselineReport } from '../verifier/baseline-report';
import { evaluateNegativeControl } from '../verifier/negative-control';

import type { VerifierProcessObservation } from './verifier-process';

export interface ExpectedVerifierProcessOutcome {
  readonly exit_code: 0 | 1;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export function expectedVerifierProcessOutcome(
  runId: string,
  objects: readonly Buffer[],
  authenticated: VerifiedVerifierContext,
): ExpectedVerifierProcessOutcome {
  if (runId === 'BASELINE') {
    return Object.freeze({
      exit_code: 0,
      stdout: canonicalVerifierBaselineReport(authenticated.verification.dossier),
      stderr: Buffer.alloc(0),
    });
  }
  const negative = evaluateNegativeControl(runId, objects, authenticated);
  return Object.freeze({
    exit_code: 1,
    stdout: Buffer.from(negative.stdout),
    stderr: Buffer.from(negative.stderr),
  });
}

export function assertExactVerifierProcessOutcome(
  observation: VerifierProcessObservation,
  expected: ExpectedVerifierProcessOutcome,
): void {
  if (
    observation.exit_code !== expected.exit_code ||
    !observation.stdout.equals(expected.stdout) ||
    !observation.stderr.equals(expected.stderr)
  )
    throw new TypeError('verifier process outcome differs from authenticated oracle result');
}
