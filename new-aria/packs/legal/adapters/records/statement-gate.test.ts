// Tests for the statement verification gate.
//
// WHY: this module is the only thing standing between a model's proposal and a
// word that means a human took responsibility. A test suite that merely checked
// the happy path would leave the gate's whole purpose unverified, so every case
// below is a refusal the product depends on.
//
// WHAT: node:test cases. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/records/statement-gate.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptMachineStatement,
  applyHumanVerification,
  MACHINE_STATEMENT_STATUSES,
  StatementGateError,
  toUnverifiedRecord,
} from './statement-gate';

const SHA = 'a'.repeat(64);

/**
 * node:test's assert.throws returns void, so the error it caught cannot be
 * inspected. These tests assert WHICH field caused a refusal — a gate that
 * refuses for the wrong reason is a gate whose message misleads the operator —
 * so the error itself has to be captured.
 */
function refusal(run: () => unknown): StatementGateError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof StatementGateError, `expected a StatementGateError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a refusal, but the call returned' });
}

function machineStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    statementId: 'stmt_0001',
    statement: 'Milepæl 2 ble levert 01.03.2024.',
    status: 'asserted',
    assertedBy: 'party',
    assertedByPartyId: null,
    supportingSources: [{ documentId: 'doc_abc', sha256: SHA, locator: 'page:1' }],
    contradictingSources: [],
    missingEvidence: ['leveranseprotokoll for milepæl 2'],
    confidence: 0.4,
    relatedClaimIds: [],
    ...overrides,
  };
}

test('the machine status vocabulary cannot express verified', () => {
  assert.ok(!(MACHINE_STATEMENT_STATUSES as readonly string[]).includes('verified'));
  assert.deepEqual([...MACHINE_STATEMENT_STATUSES], ['asserted', 'disputed', 'supported', 'contradicted', 'unverifiable']);
});

test("a submission claiming status 'verified' is refused, and the reason names the status field", () => {
  const error = refusal(() => acceptMachineStatement(machineStatement({ status: 'verified' })));
  assert.equal(error.field, 'status');
  assert.match(error.message, /may not write status 'verified'/);
});

test('a submission naming a verifier is refused even when its status is honest', () => {
  const error = refusal(() => acceptMachineStatement(machineStatement({ status: 'supported', verifiedBy: 'Advokat Nordmann' })));
  assert.equal(error.field, 'verifiedBy');
});

test('a submission stamping a verification time is refused', () => {
  const error = refusal(() => acceptMachineStatement(machineStatement({ verifiedAt: '2026-09-04T10:00:00Z' })));
  assert.equal(error.field, 'verifiedAt');
});

test('the verification refusals are checked before shape complaints, so the real reason is never masked', () => {
  // Malformed everywhere AND claiming verification: the verification refusal wins.
  const error = refusal(() => acceptMachineStatement({ status: 'verified', statementId: '', confidence: 9 }));
  assert.equal(error.field, 'status');
});

test("a 'supported' verdict with no supporting source is refused", () => {
  const error = refusal(() => acceptMachineStatement(machineStatement({ status: 'supported', supportingSources: [] })));
  assert.equal(error.field, 'supportingSources');
});

test("a 'contradicted' verdict with no contradicting source is refused", () => {
  const error = refusal(() => acceptMachineStatement(machineStatement({ status: 'contradicted', contradictingSources: [] })));
  assert.equal(error.field, 'contradictingSources');
});

test('an evidence ref without a content hash is refused: it names a document but pins no bytes', () => {
  const error = refusal(() => acceptMachineStatement(machineStatement({ supportingSources: [{ documentId: 'doc_abc', locator: 'page:1' }] })));
  assert.equal(error.field, 'supportingSources');
  assert.match(error.message, /sha256/);
});

test('an accepted statement renders as unverified with human review required', () => {
  const accepted = acceptMachineStatement(machineStatement({ assertedBy: 'mechanical_extraction' }));
  const record = toUnverifiedRecord(accepted);
  assert.equal(record.status, 'asserted');
  assert.equal(record.assertedBy, 'mechanical_extraction');
  assert.equal(record.humanReviewRequired, true);
  assert.equal(record.verifiedBy, null);
  assert.equal(record.verifiedAt, null);
});

test('a human verification is the only path to verified, and it carries who and when', () => {
  const accepted = acceptMachineStatement(machineStatement({ status: 'supported' }));
  const record = applyHumanVerification(accepted, { verifiedBy: 'Advokat Kari Nordmann', verifiedAt: '2026-09-04T10:00:00Z' });
  assert.equal(record.status, 'verified');
  assert.equal(record.verifiedBy, 'Advokat Kari Nordmann');
  assert.equal(record.verifiedAt, '2026-09-04T10:00:00Z');
  assert.equal(record.humanReviewRequired, false);
  // The evidence the machine cited travels through unchanged.
  assert.deepEqual(record.supportingSources, accepted.supportingSources);
});

test('a verification with no verifier and a verification with a malformed time are both refused', () => {
  const accepted = acceptMachineStatement(machineStatement());
  assert.throws(() => applyHumanVerification(accepted, { verifiedBy: '   ', verifiedAt: '2026-09-04T10:00:00Z' }), StatementGateError);
  assert.throws(() => applyHumanVerification(accepted, { verifiedBy: 'Kari', verifiedAt: '4 September 2026' }), StatementGateError);
});

test('non-objects and arrays are refused rather than coerced', () => {
  for (const input of [null, undefined, 'stmt', 42, []]) {
    assert.throws(() => acceptMachineStatement(input), StatementGateError);
  }
});
