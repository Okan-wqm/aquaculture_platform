import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePlaywrightProof, evaluateTestProof } from './test-proof-report.mjs';

function report(status = 'passed') {
  return { success: true, numPassedTests: status === 'passed' ? 1 : 0, numFailedTests: 0,
    numPendingTests: status === 'pending' ? 1 : 0,
    testResults: [{ name: '/repo/new.postgres.spec.ts', assertionResults: [{ status }] }] };
}
test('requires a real executed test in every named contract suite', () => {
  assert.equal(evaluateTestProof(report(), ['new.postgres.spec.ts'], []).success, true);
  assert.equal(evaluateTestProof(report(), ['missing.postgres.spec.ts'], []).success, false);
  assert.equal(evaluateTestProof(report('pending'), ['new.postgres.spec.ts'], []).success, false);
});
test('zero collection and falsely green aggregate reports fail', () => {
  assert.equal(evaluateTestProof({ ...report(), numPassedTests: 0, testResults: [] }, [], []).success, false);
  assert.equal(evaluateTestProof({ ...report(), numFailedTests: 1 }, [], []).success, false);
  assert.equal(evaluateTestProof({ ...report(), success: false }, [], []).success, false);
});
test('changed suites cannot hide skipped tests behind other passing tests', () => {
  const proof = report();
  proof.numPendingTests = 1;
  proof.testResults[0].assertionResults.push({ status: 'pending' });
  assert.equal(evaluateTestProof(proof, [], ['/repo/new.postgres.spec.ts']).success, false);
  const unchanged = evaluateTestProof(proof, [], ['/repo/another.spec.ts']);
  assert.equal(unchanged.success, true);
  assert.equal(unchanged.pending, 1);
});
test('malformed reports fail before they can become evidence', () => {
  assert.throws(() => evaluateTestProof({}, [], []), /testResults/);
  assert.throws(() => evaluateTestProof({ ...report(), numPassedTests: '1' }, [], []), /numPassedTests/);
});

test('Playwright proof rejects empty, skipped, retried and missing-file reports', () => {
  const passing = { stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 }, errors: [],
    suites: [{ specs: [{ file: 'login.spec.ts', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }] }] };
  assert.equal(evaluatePlaywrightProof(passing, ['tests/login.spec.ts']).success, true);
  assert.equal(evaluatePlaywrightProof(passing, ['missing.spec.ts']).success, false);
  assert.equal(evaluatePlaywrightProof({ ...passing, suites: [], stats: { ...passing.stats, expected: 0 } }, []).success, false);
  assert.equal(evaluatePlaywrightProof({ ...passing, stats: { ...passing.stats, skipped: 1 } }, []).success, false);
  const retried = structuredClone(passing);
  retried.suites[0].specs[0].tests[0].results.unshift({ status: 'failed' });
  assert.equal(evaluatePlaywrightProof(retried, []).success, false);
});
