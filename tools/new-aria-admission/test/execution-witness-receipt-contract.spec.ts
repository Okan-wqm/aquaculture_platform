import { validateExecutionWitness } from '../src/kernel/execution-witness';

import { evidenceBundle } from './progress-fixture';

describe('evidence execution receipt contract', () => {
  it('requires runner identity, exact input envelope, and a receipt CAS reference', () => {
    const fixture = evidenceBundle('d'.repeat(64));
    const witness = fixture.manifest.execution;

    expect(() =>
      validateExecutionWitness(witness, fixture.objects, {
        run_context_sha256: witness.run_context_sha256,
        input_sha256: witness.input_sha256,
        output_sha256: fixture.manifest.report.sha256,
        semantic_verdict: 'PASSED',
        observed_at: fixture.manifest.observed_at,
      }),
    ).not.toThrow();
    const { execution_receipt: _missing, ...unsigned } = witness;
    expect(() =>
      validateExecutionWitness(unsigned, fixture.objects, {
        run_context_sha256: witness.run_context_sha256,
        input_sha256: witness.input_sha256,
        output_sha256: fixture.manifest.report.sha256,
        semantic_verdict: 'PASSED',
        observed_at: fixture.manifest.observed_at,
      }),
    ).toThrow(/receipt|schema/i);
  });
});
