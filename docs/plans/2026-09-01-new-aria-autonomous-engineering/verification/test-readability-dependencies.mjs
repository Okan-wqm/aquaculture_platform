#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyReadability } from './lib/verify-readability.mjs';
import { mutateJson, planRoot, repositoryRoot, withPlanCopy } from './test-support.mjs';

const dynamicImportError = {
  code: 'READABILITY_LIMIT',
  message:
    'verification/lib/canonical.mjs: dynamic import requires exactly one string literal argument',
};
const dependencyLayerError = {
  code: 'READABILITY_POLICY',
  message: 'dependency layers drift',
};
const dependencyAssignmentError = {
  code: 'READABILITY_POLICY',
  message: 'dependency layer assignment drift',
};

function matching(errors, expected) {
  return errors.filter(
    (error) => error.code === expected.code && error.message === expected.message,
  );
}

for (const [name, statement] of [
  ['computed specifier', "void import('../' + 'verify-d0.mjs');"],
  ['identifier specifier', 'void import(specifier);'],
  ['missing argument', 'void import();'],
  ['import options', "void import('../verify-d0.mjs', { with: { type: 'json' } });"],
]) {
  withPlanCopy(`new-aria-${name.replaceAll(' ', '-')}-`, (copy, ownerRoot) => {
    const path = join(copy, 'verification/lib/canonical.mjs');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${statement}\n`);
    assert.deepEqual(
      matching(verifyReadability(copy, ownerRoot), dynamicImportError),
      [dynamicImportError],
      `${name} dynamic import must fail closed with the specific error`,
    );
  });
}

withPlanCopy('new-aria-layer-assignment-', (copy) => {
  mutateJson(copy, 'verification/readability-policy.json', (policy) => {
    const layers = policy.dependency_policy.d0_verification_layers;
    layers.domain = layers.domain.filter((path) => path !== 'verification/lib/canonical.mjs');
    layers.runtime.push('verification/lib/canonical.mjs');
  });
  assert.deepEqual(
    matching(verifyReadability(copy, repositoryRoot), dependencyAssignmentError),
    [dependencyAssignmentError],
    'moving a canonical domain module to runtime must fail closed',
  );
});

withPlanCopy('new-aria-syntax-error-', (copy, ownerRoot) => {
  const path = join(copy, 'verification/lib/canonical.mjs');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nvoid import;\n`);
  const syntaxErrors = verifyReadability(copy, ownerRoot).filter(
    (error) =>
      error.code === 'READABILITY_LIMIT' &&
      error.message.startsWith('verification/lib/canonical.mjs: syntax error '),
  );
  assert.equal(syntaxErrors.length, 1, 'invalid JavaScript syntax must fail closed exactly once');
  assert.match(syntaxErrors[0].message, /Expression expected\./u);
});

for (const [name, statement, specifier] of [
  ['file URL', "void import('file:///tmp/verify-d0.mjs');", 'file:///tmp/verify-d0.mjs'],
  ['absolute path', "void import('/tmp/verify-d0.mjs');", '/tmp/verify-d0.mjs'],
  [
    'data URL',
    "void import('data:text/javascript,export default 1');",
    'data:text/javascript,export default 1',
  ],
  ['local alias', "void import('#local-verifier');", '#local-verifier'],
  ['package', "void import('unapproved-package');", 'unapproved-package'],
  ['static file URL', "import 'file:///tmp/verify-d0.mjs';", 'file:///tmp/verify-d0.mjs'],
]) {
  withPlanCopy(`new-aria-unapproved-${name.replaceAll(' ', '-')}-`, (copy, ownerRoot) => {
    const path = join(copy, 'verification/lib/canonical.mjs');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${statement}\n`);
    const expected = {
      code: 'READABILITY_LIMIT',
      message: `verification/lib/canonical.mjs: unapproved external dependency ${specifier}`,
    };
    assert.deepEqual(
      matching(verifyReadability(copy, ownerRoot), expected),
      [expected],
      `${name} dependency must fail closed`,
    );
  });
}

for (const specifier of ['node:fs', 'typescript']) {
  withPlanCopy(`new-aria-approved-${specifier.replace(':', '-')}-`, (copy, ownerRoot) => {
    const path = join(copy, 'verification/lib/canonical.mjs');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nvoid import('${specifier}');\n`);
    assert.deepEqual(
      verifyReadability(copy, ownerRoot).filter((error) =>
        error.message.startsWith('verification/lib/canonical.mjs:'),
      ),
      [],
      `${specifier} is an explicitly approved external dependency`,
    );
  });
}

withPlanCopy('new-aria-layer-policy-', (copy) => {
  mutateJson(copy, 'verification/readability-policy.json', (policy) => {
    policy.dependency_policy.layers.reverse();
  });
  assert.deepEqual(
    matching(verifyReadability(copy, repositoryRoot), dependencyLayerError),
    [dependencyLayerError],
    'dependency policy identity drift must emit the specific error',
  );
});

assert.deepEqual(
  verifyReadability(planRoot, repositoryRoot),
  [],
  'canonical readability baseline must be completely clean',
);

process.stdout.write('PASS readability-dependencies\n');
