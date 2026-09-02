import { canonicalJson } from './canonical.mjs';

export const D0_SUITE_POLICY = Object.freeze({
  runnable: Object.freeze([
    'test-api-closure-order.mjs',
    'test-appellate-evidence.mjs',
    'test-bootstrap-import-boundary.mjs',
    'test-contract-regressions.mjs',
    'test-d0-suite-runner.mjs',
    'test-delivery-controls.mjs',
    'test-delivery-readback-races.mjs',
    'test-delivery-readback.mjs',
    'test-dossier-admission.mjs',
    'test-dossier-controls.mjs',
    'test-dossier-key-separation.mjs',
    'test-dossier-resolution.mjs',
    'test-event-controls.mjs',
    'test-external-json-snapshot.mjs',
    'test-github-delivery-provider.mjs',
    'test-github-final-note.mjs',
    'test-hermetic-git.mjs',
    'test-integrity-regressions.mjs',
    'test-provenance-snapshot.mjs',
    'test-private-node.mjs',
    'test-readability-dependencies.mjs',
    'test-review-authority-controls.mjs',
    'test-review-evidence-controls.mjs',
    'test-review-semantic-evidence.mjs',
    'test-runtime-dependencies.mjs',
    'test-secure-tree.mjs',
    'test-target-controls.mjs',
  ]),
  controllers: Object.freeze([
    'test-negative-controls.mjs',
    'test-parallel-isolation.mjs',
    'test-target-command.mjs',
  ]),
  helpers: Object.freeze(['test-support.mjs']),
});

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}

function difference(left, right) {
  const accepted = new Set(right);
  return left.filter((value) => !accepted.has(value)).sort();
}

export function validateSuiteRoster(discovered, policy = D0_SUITE_POLICY) {
  const groups = [policy.runnable, policy.controllers, policy.helpers];
  if (groups.some((group) => !Array.isArray(group))) throw new Error('D0 suite policy is invalid');
  const classified = groups.flat();
  const duplicate = duplicates(classified);
  if (duplicate.length > 0) throw new Error(`duplicate D0 suite classification: ${duplicate[0]}`);
  const missing = difference(classified, discovered);
  if (missing.length > 0) throw new Error(`missing D0 suite file: ${missing[0]}`);
  const unknown = difference(discovered, classified);
  if (unknown.length > 0) throw new Error(`unknown D0 suite file: ${unknown[0]}`);
  if (canonicalJson([...discovered].sort()) !== canonicalJson([...classified].sort())) {
    throw new Error('D0 suite roster is not closed');
  }
  return [...policy.runnable];
}
