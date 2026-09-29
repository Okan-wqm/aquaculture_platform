import type { EvidenceExecution, EvidenceManifest } from '../domain/evidence-contracts';

import {
  hasExactKeys,
  isJsonRecord,
  parseCanonicalEvidenceObject,
  verifyEvidenceObject,
} from './evidence-object';
import type { JsonRecord } from './evidence-object';
import {
  assertMappedExecutionReceipt,
  type ExecutionReceiptBindingScope,
  type ExecutionReceiptTarget,
} from './execution-receipt-binding';
import {
  verifyCurrentExecutionReceipt,
  verifyHistoricalExecutionReceipt,
} from './execution-trust-root';
import type { VerifiedExecutionReceipt } from './execution-trust-root';
import { executionWitnessKeys } from './execution-witness';
import type {
  AuthorizedS01ProgressAuthority,
  HistoricallyVerifiedS01ProgressAuthority,
  VerifiedS01ProgressAuthority,
} from './operator-progress-authority';
export type { ExecutionReceiptTarget } from './execution-receipt-binding';

interface ExecutionReceiptRosterScope extends ExecutionReceiptBindingScope {
  readonly manifest: EvidenceManifest;
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly authority: VerifiedS01ProgressAuthority;
  readonly trust_root_bytes: Uint8Array;
  readonly target: ExecutionReceiptTarget;
  readonly current_epoch: {
    readonly provider_identity_sha256: string;
    readonly sha256: string;
    readonly revision: number;
  };
}

export interface ExecutionReceiptRosterInput extends ExecutionReceiptRosterScope {
  readonly authority: AuthorizedS01ProgressAuthority;
}

export interface HistoricalExecutionReceiptRosterInput extends ExecutionReceiptRosterScope {
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly current_epoch: ExecutionReceiptRosterScope['current_epoch'] & {
    readonly observed_at: string;
    readonly valid_until: string;
  };
}

function assertMappedReceipt(
  witness: EvidenceExecution,
  input: ExecutionReceiptRosterScope,
  receipt: VerifiedExecutionReceipt,
): VerifiedExecutionReceipt {
  assertMappedExecutionReceipt(witness, receipt, input);
  return receipt;
}

export function verifyExecutionReceiptEvidence(
  witness: EvidenceExecution,
  input: ExecutionReceiptRosterInput,
): VerifiedExecutionReceipt {
  const receiptObject = verifyEvidenceObject(witness.execution_receipt, input.objects, 'receipt');
  return assertMappedReceipt(
    witness,
    input,
    verifyCurrentExecutionReceipt({
      receipt_bytes: receiptObject.bytes,
      trust_root_bytes: input.trust_root_bytes,
      authority: input.authority,
      expected_run_id: witness.run_id,
      expected_run_context_sha256: witness.run_context_sha256,
    }),
  );
}

function verifyHistoricalReceiptEvidence(
  witness: EvidenceExecution,
  input: HistoricalExecutionReceiptRosterInput,
): VerifiedExecutionReceipt {
  const receiptObject = verifyEvidenceObject(witness.execution_receipt, input.objects, 'receipt');
  const receipt = assertMappedReceipt(
    witness,
    input,
    verifyHistoricalExecutionReceipt({
      receipt_bytes: receiptObject.bytes,
      trust_root_bytes: input.trust_root_bytes,
      authority: input.authority,
      expected_run_id: witness.run_id,
      expected_run_context_sha256: witness.run_context_sha256,
    }),
  );
  const readAt = Date.parse(witness.current_epoch_read_at);
  if (
    readAt < Date.parse(input.current_epoch.observed_at) ||
    readAt > Date.parse(input.current_epoch.valid_until)
  ) {
    throw new TypeError('historical execution receipt epoch instant is invalid');
  }
  return receipt;
}

function controlExecution(
  control: EvidenceManifest['oracle']['negative_controls'][number],
  objects: ReadonlyMap<string, Uint8Array>,
): EvidenceExecution {
  const result = parseCanonicalEvidenceObject(
    control.result,
    objects,
    `negative control ${control.id} result`,
  );
  if (!isEvidenceExecution(result.document.execution)) {
    throw new TypeError(`negative control ${control.id} execution is absent`);
  }
  return result.document.execution;
}

function isEvidenceExecution(value: unknown): value is EvidenceExecution & JsonRecord {
  return isJsonRecord(value) && hasExactKeys(value, executionWitnessKeys);
}

function verifyReceiptRoster(
  input: ExecutionReceiptRosterScope,
  verifyReceipt: (witness: EvidenceExecution) => VerifiedExecutionReceipt,
): readonly VerifiedExecutionReceipt[] {
  const authority = input.authority.authority.document;
  const controls = input.manifest.oracle.negative_controls;
  const baselineObjects = input.manifest.execution.input_object_sha256s;
  if (
    input.manifest.execution.run_id !== 'BASELINE' ||
    input.manifest.execution.execution_session_id !== authority.execution_session_id ||
    baselineObjects.length !== 4 ||
    baselineObjects[1] !== input.authority.envelope_sha256 ||
    baselineObjects[2] !== input.authority.trust_root_sha256 ||
    baselineObjects[3] !== input.current_epoch.sha256 ||
    controls.length !== authority.required_negative_control_ids.length
  ) {
    throw new TypeError('execution receipt roster does not match the authorized session');
  }
  const receipts: VerifiedExecutionReceipt[] = [
    verifyReceipt(input.manifest.execution),
  ];
  controls.forEach((control, index) => {
    if (control.id !== authority.required_negative_control_ids[index]) {
      throw new TypeError('execution receipt roster order or identity is invalid');
    }
    const execution = controlExecution(control, input.objects);
    const baselineInput = baselineObjects[0];
    if (
      execution.run_id !== control.id ||
      execution.execution_session_id !== authority.execution_session_id ||
      execution.input_object_sha256s.length !== 6 ||
      execution.input_object_sha256s
        .slice(0, 4)
        .some((digest, role) => digest !== baselineObjects[role]) ||
      execution.input_object_sha256s[0] !== baselineInput ||
      execution.input_object_sha256s[4] !== control.mutant.sha256 ||
      execution.input_object_sha256s[5] !== execution.input_sha256
    ) {
      throw new TypeError('negative-control execution receipt roster is invalid');
    }
    receipts.push(verifyReceipt(execution));
  });
  return Object.freeze(receipts);
}

export function verifyExecutionReceiptRoster(
  input: ExecutionReceiptRosterInput,
): readonly VerifiedExecutionReceipt[] {
  return verifyReceiptRoster(input, (witness) => verifyExecutionReceiptEvidence(witness, input));
}

export function verifyHistoricalExecutionReceiptRoster(
  input: HistoricalExecutionReceiptRosterInput,
): readonly VerifiedExecutionReceipt[] {
  return verifyReceiptRoster(input, (witness) =>
    verifyHistoricalReceiptEvidence(witness, input),
  );
}
