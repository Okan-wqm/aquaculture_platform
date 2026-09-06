import { resolve } from 'node:path';

/** Shared Jest/Vitest JSON proof contract. Collection alone is not execution. */
export function evaluateTestProof(report, requiredFiles, changedFiles) {
  if (!report || !Array.isArray(report.testResults)) throw new Error('Missing testResults array');
  for (const key of ['numPassedTests', 'numFailedTests', 'numPendingTests']) {
    if (!Number.isSafeInteger(report[key]) || report[key] < 0) throw new Error(`Invalid ${key}`);
  }
  const files = report.testResults;
  for (const file of files) {
    if (typeof file.name !== 'string' || !Array.isArray(file.assertionResults)) throw new Error('Invalid test file record');
  }
  const executed = files.filter((file) => file.assertionResults.some((test) => test.status === 'passed'));
  const missing = requiredFiles.filter((path) => !executed.some((file) => file.name.endsWith(path)));
  const changed = new Set(changedFiles.map((file) => resolve(file)));
  const skippedChanged = files.filter((file) => changed.has(resolve(file.name)))
    .flatMap((file) => file.assertionResults).filter((test) => test.status !== 'passed');
  return {
    success: report.success === true && report.numPassedTests > 0 && report.numFailedTests === 0 &&
      missing.length === 0 && skippedChanged.length === 0,
    passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests,
    suite_count: executed.length, required_files_missing: missing, changed_tests_not_passed: skippedChanged.length,
  };
}
