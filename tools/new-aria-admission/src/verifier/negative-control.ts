import { canonicalJsonBytes } from '../kernel/canonical-json';
import { digestBytes, requiredSha256, requiredText } from '../kernel/evidence-object';
import type { JsonRecord } from '../kernel/evidence-object';
import { canonicalRegisteredNegativeControl } from '../kernel/negative-control-registry';
import {
  canonicalNegativeControlFailureReason,
  canonicalRejectionReceipt,
} from '../kernel/negative-control-receipt';
import { negativeControlMutantKeys } from '../kernel/negative-control-schema';
import { parseStrictJson } from '../kernel/strict-json';

import { verifyVerifierBaselineInput } from './baseline-input';
import type { VerifiedVerifierContext } from './authenticated-input';
import { VerificationRejection } from './verification-rejection';

const controls = [
  ['NC-S01-EVENT-HASH-TAMPER', 'EVENT-CONTEXT-PROBE-TAMPER'],
  ['NC-S01-EVIDENCE-DIGEST-TAMPER', 'EVIDENCE-CONTEXT-PROBE-TAMPER'],
  ['NC-S01-STALE-EVIDENCE', 'STALE-EVIDENCE'],
  ['NC-S01-UNAUTHORIZED-TARGET', 'UNAUTHORIZED-TARGET'],
] as const;

export interface NegativeControlOutput {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function declaration(bytes: Uint8Array): JsonRecord {
  const value = parseStrictJson(bytes);
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== negativeControlMutantKeys.length ||
    negativeControlMutantKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    !canonicalJsonBytes(value).equals(Buffer.from(bytes))
  )
    throw new TypeError('negative-control declaration schema is invalid');
  return value;
}

function controlIndex(runId: string): number {
  return controls.findIndex(([id]) => id === runId);
}

export function evaluateNegativeControl(
  runId: string,
  objects: readonly Buffer[],
  authenticated: VerifiedVerifierContext,
): NegativeControlOutput {
  if (objects.length !== 6) throw new TypeError('negative-control object roster is invalid');
  const baselineBytes = objects[0];
  const declarationBytes = objects[4];
  const mutatedBytes = objects[5];
  if (baselineBytes === undefined || declarationBytes === undefined || mutatedBytes === undefined) {
    throw new TypeError('negative-control object roster is incomplete');
  }
  const baseline = authenticated.verification.baseline;
  const mutant = declaration(declarationBytes);
  const index = controlIndex(runId);
  const facts = controls[index];
  if (facts === undefined) throw new TypeError('negative-control ID is not registered');
  const [controlId, mutationKind] = facts;
  const implementationSha256 = requiredSha256(
    mutant.implementation_sha256,
    'negative-control implementation',
  );
  const oracleId = requiredText(mutant.oracle_id, 'negative-control oracle');
  const authorityDocument = authenticated.authority.authority.document;
  if (
    implementationSha256 !== authorityDocument.oracle_sha256 ||
    oracleId !== authorityDocument.oracle_id
  )
    throw new TypeError('negative-control oracle identity differs from signed authority');
  const expectedMutation = canonicalRegisteredNegativeControl(
    index,
    controlId,
    mutationKind,
    baseline,
  );
  const mutatedInput = mutant.mutated_input;
  if (
    mutant.schema_version !== '1.0.0' ||
    mutant.contract_id !== 'new-aria-negative-control-mutant-v1' ||
    mutant.control_id !== controlId ||
    mutant.mutation_kind !== mutationKind ||
    mutant.run_context_sha256 !== baseline.run_context_sha256 ||
    mutant.baseline_input_sha256 !== digestBytes(baselineBytes) ||
    mutatedInput === null ||
    typeof mutatedInput !== 'object' ||
    Array.isArray(mutatedInput) ||
    Object.keys(mutatedInput).length !== 2 ||
    mutatedInput.sha256 !== digestBytes(mutatedBytes) ||
    mutatedInput.uri !== `aria-evidence://sha256/${digestBytes(mutatedBytes)}` ||
    !Buffer.from(expectedMutation.bytes).equals(mutatedBytes)
  )
    throw new TypeError('negative-control declaration or mutation is not exact');
  try {
    verifyVerifierBaselineInput(mutatedBytes, authenticated.scope);
    throw new TypeError('negative control was not rejected by the production verifier');
  } catch (error) {
    if (
      !(error instanceof VerificationRejection) ||
      error.reason_code !== expectedMutation.reason_code
    ) {
      throw error;
    }
  }
  const expectation = {
    oracle_id: oracleId,
    implementation_sha256: implementationSha256,
    control_id: controlId,
    mutation_kind: mutationKind,
    reason_code: expectedMutation.reason_code,
    baseline_input_sha256: digestBytes(baselineBytes),
    mutant_document_sha256: digestBytes(declarationBytes),
    mutated_input_sha256: digestBytes(mutatedBytes),
    baseline,
  };
  return Object.freeze({
    stdout: Buffer.concat([Buffer.from(canonicalRejectionReceipt(expectation)), Buffer.from('\n')]),
    stderr: Buffer.concat([
      Buffer.from(canonicalNegativeControlFailureReason(expectation)),
      Buffer.from('\n'),
    ]),
  });
}
