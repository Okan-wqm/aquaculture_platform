import { verifyExecutionReceiptEvidence } from '../src/kernel/execution-receipt-admission';
import {
  verifyCurrentExecutionReceipt,
  verifyExecutionReceipt,
  verifyHistoricalExecutionReceipt,
} from '../src/kernel/execution-trust-root';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { verifyHistoricalS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import { receiptAdmissionScenario } from './execution-receipt-admission-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
} from './operator-authority-fixture';

describe('execution receipt admission binding', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('accepts the exact signed mapped execution and rejects field substitution', () => {
    const scenario = receiptAdmissionScenario();
    expect(() => verifyExecutionReceiptEvidence(scenario.witness, scenario.input)).not.toThrow();
    expect(() =>
      verifyExecutionReceiptEvidence(
        { ...scenario.witness, input_envelope_sha256: '0'.repeat(64) },
        scenario.input,
      ),
    ).toThrow(/mapped execution|target/);
    expect(() =>
      verifyExecutionReceiptEvidence(scenario.witness, {
        ...scenario.input,
        current_epoch: { ...scenario.input.current_epoch, revision: 2 },
      }),
    ).toThrow(/mapped execution|target/);
  });

  it('allows a canonical report body digest to differ from the newline-delimited stdout', () => {
    const scenario = receiptAdmissionScenario('5'.repeat(64));
    expect(() => verifyExecutionReceiptEvidence(scenario.witness, scenario.input)).not.toThrow();
  });

  it('rejects raw stderr substitution outside the signed execution', () => {
    const scenario = receiptAdmissionScenario();
    expect(() =>
      verifyExecutionReceiptEvidence(
        { ...scenario.witness, stderr_sha256: '9'.repeat(64), stderr_byte_length: 1 },
        scenario.input,
      ),
    ).toThrow(/mapped execution|target/);
  });

  it('rejects a materialized spawn path substitution outside the signed receipt', () => {
    const scenario = receiptAdmissionScenario();
    const materializedArgv = [...scenario.witness.materialized_argv];
    materializedArgv[1] = '/attacker/replacement-tool';
    expect(() =>
      verifyExecutionReceiptEvidence(
        {
          ...scenario.witness,
          materialized_argv: materializedArgv,
          materialized_argv_sha256: digest(canonicalJsonBytes(materializedArgv)),
        },
        scenario.input,
      ),
    ).toThrow(/mapped execution|target/);
  });

  it('separates historical signature validity from live-admission freshness', () => {
    const scenario = receiptAdmissionScenario();
    const receiptBytes = scenario.input.objects.get(scenario.witness.execution_receipt.uri);
    if (receiptBytes === undefined) throw new TypeError('receipt fixture bytes are missing');
    const verification = {
      receipt_bytes: receiptBytes,
      trust_root_bytes: scenario.input.trust_root_bytes,
      authority: scenario.input.authority,
      expected_run_id: scenario.witness.run_id,
      expected_run_context_sha256: scenario.witness.run_context_sha256,
    };
    jest.setSystemTime(new Date('2026-09-02T14:00:00.001Z'));
    expect(() => verifyExecutionReceipt(verification)).not.toThrow();
    expect(() => verifyCurrentExecutionReceipt(verification)).toThrow(/current|window|stale/i);

    const operatorRoot = operatorTrustRootBytes();
    const current = scenario.input.authority;
    const historical = verifyHistoricalS01ProgressAuthority({
      envelope_bytes: operatorEnvelopeBytes({
        authorityBytes: canonicalJsonBytes(current.authority.document),
        observedAt: current.observed_at,
        validUntil: current.valid_until,
      }),
      trust_root_bytes: operatorRoot,
      expected_trust_root_sha256: digest(operatorRoot),
    });
    expect(historical.envelope_sha256).toBe(current.envelope_sha256);
    expect(() =>
      verifyHistoricalExecutionReceipt({ ...verification, authority: historical }),
    ).not.toThrow();
  });
});
