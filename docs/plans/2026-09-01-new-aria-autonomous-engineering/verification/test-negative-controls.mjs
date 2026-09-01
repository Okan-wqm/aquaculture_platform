#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventHash, parseStrictJson } from './lib/canonical.mjs';
import { verifyD0 } from './lib/verify.mjs';

const planRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const scratchParent = dirname(planRoot);

function replace(root, relativePath, before, after) {
  const path = join(root, relativePath);
  const source = readFileSync(path, 'utf8');
  assert(source.includes(before), `fixture anchor missing: ${relativePath}`);
  writeFileSync(path, source.replace(before, after));
}

function mutateJson(root, relativePath, mutate) {
  const path = join(root, relativePath);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const cases = [
  {
    name: 'frozen title drift',
    code: 'AUDIT_SNAPSHOT',
    mutate: (root) =>
      replace(root, 'FINDING-COVERAGE.md', 'Scheduled compactor', 'Changed compactor'),
  },
  {
    name: 'PLAN/card acceptance drift',
    code: 'PROGRAM_PARITY',
    mutate: (root) => replace(root, 'phases/P01.md', '`ACC-S01`, `ACC-EVD-001`', '`ACC-S01`'),
  },
  {
    name: 'mandatory role removal',
    code: 'PHASE_GATES',
    mutate: (root) =>
      mutateJson(root, 'verification/phase-gates.json', (value) => value.roles.pop()),
  },
  {
    name: 'event-chain tamper',
    code: 'EVENT_CHAIN',
    mutate: (root) =>
      replace(root, 'progress/events.jsonl', 'D0 artifact seti materialize edildi', 'D0 tampered'),
  },
  {
    name: 'duplicate JSON key',
    code: 'EVENT_CHAIN',
    mutate: (root) =>
      replace(
        root,
        'progress/events.jsonl',
        '{"schema_version":"1.0.0"',
        '{"schema_version":"1.0.0","schema_version":"1.0.0"',
      ),
  },
  {
    name: 'historical evidence rewrite',
    code: 'HISTORICAL_EVIDENCE',
    mutate: (root) =>
      replace(
        root,
        'progress/evidence/D0-plan-materialization.json',
        'documentation-only',
        'rewritten',
      ),
  },
  {
    name: 'review report rewrite',
    code: 'REVIEW_EVIDENCE',
    mutate: (root) =>
      replace(root, 'reviews/01-integrity.md', 'D0 evidence/integrity', 'D0 rewritten/integrity'),
  },
  {
    name: 'review source rewrite',
    code: 'REVIEW_EVIDENCE',
    mutate: (root) =>
      replace(
        root,
        'reviews/source/01-integrity.md.raw',
        'D0 evidence/integrity',
        'D0 source rewritten/integrity',
      ),
  },
  {
    name: 'verifier input tamper',
    code: 'VERIFIER_PROVENANCE',
    mutate: (root) => {
      const path = join(root, 'verification/lib/markdown.mjs');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n// provenance tamper\n`);
    },
  },
  {
    name: 'generated projection drift',
    code: 'PROJECTION_PARITY',
    mutate: (root) =>
      replace(root, 'finding-projections/001-011.md', 'ARIA-AUDIT-001', 'ARIA-AUDIT-999'),
  },
  {
    name: 'readability declaration removal',
    code: 'READABILITY_POLICY',
    mutate: (root) =>
      mutateJson(root, 'verification/readability-policy.json', (value) => {
        delete value.limits.cyclomatic_complexity;
      }),
  },
  {
    name: 'god function',
    code: 'READABILITY_LIMIT',
    mutate: (root) => {
      const path = join(root, 'verification/lib/canonical.mjs');
      const lines = Array.from({ length: 61 }, (_, index) => `  // oversized ${index + 1}`);
      writeFileSync(
        path,
        `${readFileSync(path, 'utf8')}\nfunction oversized() {\n${lines.join('\n')}\n}\n`,
      );
    },
  },
  {
    name: 'reverse import',
    code: 'READABILITY_LIMIT',
    mutate: (root) =>
      replace(
        root,
        'verification/lib/canonical.mjs',
        "import { createHash } from 'node:crypto';",
        "import { createHash } from 'node:crypto';\nimport '../verify-d0.mjs';",
      ),
  },
  {
    name: 'forged readability exception',
    code: 'READABILITY_POLICY',
    mutate: (root) =>
      mutateJson(root, 'verification/readability-policy.json', (value) => {
        value.declarative_exceptions[0].owner = 'self-approved';
      }),
  },
  {
    name: 'false D0 completion',
    code: 'D0_STATE',
    mutate: (root) =>
      replace(root, 'PROGRESS.md', '**D0 state:** `VERIFYING`', '**D0 state:** `DONE`'),
  },
  {
    name: 'broken relative link',
    code: 'RELATIVE_LINK',
    mutate: (root) => replace(root, 'PLAN.md', '](authority/INDEX.md)', '](authority/MISSING.md)'),
  },
];

const eventLine = readFileSync(join(planRoot, 'progress/events.jsonl'), 'utf8').split('\n')[0];
const event = parseStrictJson(eventLine);
const reversed = Object.fromEntries(Object.entries(event).reverse());
assert.equal(
  eventHash(event),
  eventHash(reversed),
  'event key order must not change canonical hash',
);
assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate key/);
assert.throws(() => parseStrictJson('{"a":1.5}'), /integer/);
assert.throws(() => parseStrictJson('{"a":-0}'), /negative zero/);
assert.throws(() => parseStrictJson('{"a":"\\ud800"}'), /Unicode scalar/);

const baseline = verifyD0(planRoot, { repositoryRoot, changedPaths: [] });
assert.deepEqual(baseline, [], `baseline verifier errors:\n${JSON.stringify(baseline, null, 2)}`);

for (const testCase of cases) {
  const scratch = mkdtempSync(join(scratchParent, '.d0-negative-'));
  try {
    cpSync(planRoot, scratch, { recursive: true });
    testCase.mutate(scratch);
    const errors = verifyD0(scratch, { repositoryRoot, changedPaths: [] });
    assert(
      errors.some((error) => error.code === testCase.code),
      `${testCase.name}: expected ${testCase.code}, received ${JSON.stringify(errors)}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const [path, code] of [
  ['aria-kernel/src/state.py', 'PROTECTED_SCOPE'],
  ['apps/gateway-api/src/main.ts', 'PRODUCT_SCOPE'],
]) {
  const errors = verifyD0(planRoot, { repositoryRoot, changedPaths: [path] });
  assert(
    errors.some((error) => error.code === code),
    `${path}: expected ${code}`,
  );
}

process.stdout.write(`PASS negative-controls=${cases.length + 7}\n`);
