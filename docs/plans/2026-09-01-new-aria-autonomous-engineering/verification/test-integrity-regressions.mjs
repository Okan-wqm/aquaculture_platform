#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyMapping } from './lib/verify-mapping.mjs';
import { verifyProvenance } from './lib/verify-provenance.mjs';
import {
  mutateJson,
  mutateJsonLine,
  replace,
  repositoryRoot,
  withPlanCopy,
} from './test-support.mjs';

const failures = [];
const withCopy = (run) => withPlanCopy('new-aria-d0-integrity-', run);

function record(name, errors, code) {
  if (!errors.some((error) => error.code === code)) {
    failures.push(`${name}: expected ${code}, received ${JSON.stringify(errors)}`);
  }
}

function mutatePlanRow(root, sprintId, column, value) {
  const target = join(root, 'PLAN.md');
  const lines = readFileSync(target, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.startsWith(`| ${sprintId} `));
  assert.notEqual(index, -1, `${sprintId} PLAN row missing`);
  const cells = lines[index].split('|');
  cells[column] = ` ${value} `;
  lines[index] = cells.join('|');
  writeFileSync(target, lines.join('\n'));
}

withCopy((copy) => {
  const target = join(copy, 'verification/verifier-inputs.jsonl');
  const lines = readFileSync(target, 'utf8').trimEnd().split('\n');
  const metadata = JSON.parse(lines[0]);
  metadata.runtime = {
    node_version: 'v99.99.99',
    node_executable: '/forged/node',
    node_executable_sha256: 'f'.repeat(64),
  };
  lines[0] = JSON.stringify(metadata);
  writeFileSync(target, `${lines.join('\n')}\n`);
  record('forged runtime observation', verifyProvenance(copy), 'VERIFIER_RUNTIME');
});

withCopy((copy) => {
  replace(copy, 'FINDING-COVERAGE.md', 'Scheduled compactor', 'Forged compactor');
  replace(copy, 'verification/frozen-audit.jsonl', 'Scheduled compactor', 'Forged compactor');
  replace(copy, 'finding-projections/001-011.md', 'Scheduled compactor', 'Forged compactor');
  record('coordinated audit forgery', verifyMapping(copy, repositoryRoot), 'AUDIT_ORACLE');
});

withCopy((copy) => {
  mutateJsonLine(copy, 'verification/program-map.jsonl', 0, (row) => {
    row.owned_finding_ids.push('ARIA-AUDIT-999');
  });
  record('unknown owned finding', verifyMapping(copy, repositoryRoot), 'CLOSED_RELATION');
});

withCopy((copy) => {
  const target = join(copy, 'verification/program-map.jsonl');
  const lines = readFileSync(target, 'utf8').trimEnd().split('\n');
  const extra = { ...JSON.parse(lines.at(-1)), sprint_id: 'S99', phase_id: 'P13' };
  writeFileSync(target, `${lines.join('\n')}\n${JSON.stringify(extra)}\n`);
  record('extra sprint', verifyMapping(copy, repositoryRoot), 'PROGRAM_PARITY');
});

withCopy((copy) => {
  mutateJsonLine(copy, 'verification/program-map.jsonl', 0, (row) => {
    row.dependencies = ['S99'];
    row.dependency_text = 'S99';
  });
  record('dangling dependency', verifyMapping(copy, repositoryRoot), 'CLOSED_RELATION');
});

withCopy((copy) => {
  mutateJsonLine(copy, 'verification/program-map.jsonl', 0, (row) => {
    row.dependencies = ['S02'];
    row.dependency_text = 'S02';
  });
  record('dependency cycle/forward edge', verifyMapping(copy, repositoryRoot), 'PROGRAM_DAG');
});

withCopy((copy) => {
  mutateJsonLine(copy, 'verification/program-map.jsonl', 0, (row) => {
    row.dependencies.push('OP-99');
  });
  record('unknown operator', verifyMapping(copy, repositoryRoot), 'CLOSED_RELATION');
});

withCopy((copy) => {
  replace(copy, 'PLAN.md', 'S14, S23, S39, S61', 'S01, S14, S23, S39, S61');
  record('extra operator reverse entry', verifyMapping(copy, repositoryRoot), 'PROGRAM_PARITY');
});

withCopy((copy) => {
  replace(copy, 'phases/P01.md', '- **Dependencies:** S01.', '- **Dependencies:** S03.');
  mutatePlanRow(copy, 'S02', 3, 'S03');
  mutateJsonLine(copy, 'verification/program-map.jsonl', 1, (row) => {
    row.dependency_text = 'S03';
    row.dependencies = ['S03'];
  });
  record('forward dependency', verifyMapping(copy, repositoryRoot), 'PROGRAM_DAG');
});

withCopy((copy) => {
  replace(
    copy,
    'phases/P01.md',
    '- **Acceptance IDs:** `ACC-S02`, `ACC-READ-001`, `ACC-ISO-001`.',
    '- **Acceptance IDs:** `ACC-S02`, `ACC-UNKNOWN-999`, `ACC-ISO-001`.',
  );
  mutatePlanRow(copy, 'S02', 4, '`ACC-S02`, `ACC-UNKNOWN-999`, `ACC-ISO-001`');
  mutateJsonLine(copy, 'verification/program-map.jsonl', 1, (row) => {
    row.acceptance_ids = ['ACC-S02', 'ACC-UNKNOWN-999', 'ACC-ISO-001'];
  });
  record('unknown acceptance', verifyMapping(copy, repositoryRoot), 'CLOSED_RELATION');
});

withCopy((copy) => {
  mutateJson(copy, 'verification/phase-gates.json', (gates) => {
    gates.required_artifacts = Array.from({ length: 9 }, (_, index) => `junk-${index}`);
  });
  record('junk gate artifacts', verifyMapping(copy, repositoryRoot), 'PHASE_GATES');
});

withCopy((copy) => {
  replace(copy, 'phases/P01.md', '`ARIA-AUDIT-069`, `072`', '`ARIA-AUDIT-069`, `069`, `072`');
  record('duplicate card finding relation', verifyMapping(copy, repositoryRoot), 'CLOSED_RELATION');
});

withCopy((copy) => {
  mutateJson(copy, 'verification/phase-gates.json', (gates) => {
    gates.unknown = 'deny';
  });
  record('open phase gate schema', verifyMapping(copy, repositoryRoot), 'PHASE_GATES');
});

assert.deepEqual(failures, [], `integrity regressions accepted:\n${failures.join('\n')}`);
process.stdout.write('PASS integrity-regressions\n');
