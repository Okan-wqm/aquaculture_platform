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

/** Playwright proof requires every collected test to have actually passed once. */
export function evaluatePlaywrightProof(report, requiredFiles) {
  if (!report || !Array.isArray(report.suites) || !report.stats || !Array.isArray(report.errors)) {
    throw new Error('Malformed Playwright report');
  }
  for (const key of ['expected', 'unexpected', 'skipped', 'flaky']) {
    if (!Number.isSafeInteger(report.stats[key]) || report.stats[key] < 0) throw new Error(`Invalid Playwright ${key}`);
  }
  const specifications = [];
  function collect(suites) {
    for (const suite of suites) {
      if (!Array.isArray(suite.specs)) throw new Error('Missing Playwright specifications');
      specifications.push(...suite.specs);
      if (suite.suites) collect(suite.suites);
    }
  }
  collect(report.suites);
  const executed = specifications.filter((spec) => Array.isArray(spec.tests) && spec.tests.length > 0 &&
    spec.tests.every((test) => test.status === 'expected' && Array.isArray(test.results) &&
      test.results.length === 1 && test.results[0].status === 'passed'));
  const missing = requiredFiles.filter((file) => !executed.some((spec) =>
    typeof spec.file === 'string' && spec.file.split('/').at(-1) === file.split('/').at(-1)));
  return { success: report.stats.expected > 0 && report.stats.unexpected === 0 && report.stats.skipped === 0 &&
    report.stats.flaky === 0 && report.errors.length === 0 && missing.length === 0 &&
    executed.length === specifications.length,
    passed: report.stats.expected, failed: report.stats.unexpected, pending: report.stats.skipped,
    flaky: report.stats.flaky, suite_count: new Set(executed.map((spec) => spec.file)).size,
    required_files_missing: missing };
}
