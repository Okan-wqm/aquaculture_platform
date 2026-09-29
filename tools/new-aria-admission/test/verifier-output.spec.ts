import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { digestBytes } from '../src/kernel/evidence-object';
import {
  readVerifierFailureArtifact,
  readVerifierOutputArtifact,
  readVerifierSemanticVerdict,
} from '../src/runtime/verifier-output';

function baselineOutput(summary: string): Buffer {
  const projection = Buffer.concat([canonicalJsonBytes({ state: 'VERIFYING' }), Buffer.from('\n')]);
  return Buffer.concat([
    canonicalJsonBytes({
      contract_id: 'new-aria-verifier-report-v1',
      result: {
        code: 'VERIFICATION_PASSED',
        event_chain_sha256: '1'.repeat(64),
        history_sha256: '2'.repeat(64),
        object_closure_sha256: '3'.repeat(64),
        summary,
        verification_plan_sha256: '4'.repeat(64),
        verifying_projection: {
          bytes_base64: projection.toString('base64'),
          sha256: digestBytes(projection),
        },
      },
      schema_version: '1.0.0',
      verdict: 'PASSED',
    }),
    Buffer.from('\n'),
  ]);
}

const expectation = {
  run_id: 'BASELINE',
  run_context_sha256: '7'.repeat(64),
  baseline_input_sha256: '8'.repeat(64),
  input_object_sha256s: ['8'.repeat(64)],
};

describe('closed verifier output', () => {
  it.each([
    ['C0 control', 'accepted\u000dFAILED'],
    ['C1 control', 'accepted\u0085FAILED'],
    ['bidirectional override', 'accepted\u202eFAILED'],
    ['line separator', 'accepted\u2028FAILED'],
    ['zero-width direction mark', 'accepted\u200fFAILED'],
    ['non-normalized Unicode', 'Cafe\u0301'],
  ])('rejects a %s in the public baseline summary', (_label, summary) => {
    expect(() => readVerifierSemanticVerdict(baselineOutput(summary), expectation)).toThrow(
      /baseline verifier/,
    );
  });

  it('accepts normalized printable Unicode within the byte bound', () => {
    expect(readVerifierSemanticVerdict(baselineOutput('Doğrulama tamamlandı'), expectation)).toBe(
      'PASSED',
    );
  });

  it('separates the canonical JSON result artifact from its stdout newline', () => {
    const stdout = baselineOutput('Doğrulama tamamlandı');
    const artifact = readVerifierOutputArtifact(stdout, expectation);

    expect(Buffer.concat([artifact, Buffer.from('\n')])).toEqual(stdout);
    expect(artifact.at(-1)).not.toBe(0x0a);
  });

  it('accepts only a control-bound canonical failure-reason artifact', () => {
    const controlExpectation = {
      ...expectation,
      run_id: 'NC-S01-STALE-EVIDENCE',
      input_object_sha256s: [
        '8'.repeat(64),
        '9'.repeat(64),
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
        'd'.repeat(64),
      ],
    };
    const failure = canonicalJsonBytes({
      contract_id: 'new-aria-negative-control-failure-reason-v1',
      control_id: controlExpectation.run_id,
      reason_code: 'FRESHNESS_CONTEXT_STALE',
      run_context_sha256: controlExpectation.run_context_sha256,
      schema_version: '1.0.0',
      verdict: 'REJECTED',
    });
    const stderr = Buffer.concat([failure, Buffer.from('\n')]);

    expect(readVerifierFailureArtifact(stderr, controlExpectation)).toEqual(failure);
    expect(() =>
      readVerifierFailureArtifact(
        Buffer.concat([Buffer.from(failure).subarray(0, -1), Buffer.from('0}\n')]),
        controlExpectation,
      ),
    ).toThrow(/failure reason/);
  });
});
