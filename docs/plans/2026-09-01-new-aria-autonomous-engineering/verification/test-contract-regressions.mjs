#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApiContract } from './lib/api-contract.mjs';
import { parseStrictJson } from './lib/canonical.mjs';
import { verifyAuthorityContracts } from './lib/verify-authority.mjs';
import { verifyApiContract } from './lib/verify-api.mjs';
import { verifyReadability } from './lib/verify-readability.mjs';
import { mutateJson, planRoot, replace, repositoryRoot, withPlanCopy } from './test-support.mjs';
const failures = [];

function source(path) {
  return readFileSync(join(planRoot, path), 'utf8');
}

function requireText(name, path, patterns) {
  const text = source(path);
  for (const pattern of patterns) {
    if (!pattern.test(text)) failures.push(`${name}: ${path} missing ${pattern}`);
  }
}

function rejectText(name, path, patterns) {
  const text = source(path);
  for (const pattern of patterns) {
    if (pattern.test(text)) failures.push(`${name}: ${path} still contains ${pattern}`);
  }
}

function readabilityCase(name, fixture) {
  withPlanCopy('new-aria-d0-readability-', (copy, root) => {
    const target = join(copy, 'verification/lib/canonical.mjs');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n${fixture}\n`);
    const errors = verifyReadability(copy, root);
    if (!errors.some((error) => error.code === 'READABILITY_LIMIT')) {
      failures.push(`${name}: hostile AST fixture accepted`);
    }
  });
}

function authorityCase(name, path, before, after) {
  withPlanCopy('new-aria-d0-authority-', (copy) => {
    replace(copy, path, before, after);
    if (!verifyAuthorityContracts(copy).some((error) => error.code === 'AUTHORITY_CONTRACT')) {
      failures.push(`${name}: authority mutant accepted`);
    }
  });
}

function regeneratedApiCase(prefix, mutate, message, failure) {
  withPlanCopy(prefix, (copy) => {
    mutate(copy);
    writeFileSync(
      join(copy, 'verification/generated-api-contract.json'),
      `${JSON.stringify(buildApiContract(copy), null, 2)}\n`,
    );
    if (!verifyApiContract(copy).some((error) => error.message === message)) {
      failures.push(failure);
    }
  });
}

requireText('issuer topology', 'authority/identity-authority-tcb.md', [
  /IssuerTopologyManifest/u,
  /aria-medium-permit-assembler/u,
  /recovery_epoch/u,
]);
requireText('issuer sprint ownership', 'phases/P07.md', [/\*\*Dependencies:\*\* S49, `OP-03`\./u]);
requireText('issuer sprint ownership', 'phases/P08.md', [/\*\*Dependencies:\*\* S57, `OP-03`\./u]);

requireText('repository isolation', 'authority/data-privacy.md', [
  /WorkspaceRepositoryBinding/u,
  /MissionRepositoryScope/u,
  /code_repository_id \+ base_repository_id \+ head_repository_id \+ snapshot_sha/u,
]);

requireText('toolchain ordering', 'PLAN.md', [/`OP-05` \|[^\n]*complete `ToolchainManifest`/u]);
requireText('toolchain ordering', 'phases/P03.md', [
  /S20[\s\S]*provider process count sıfır/u,
  /S21[\s\S]*provider process count sıfır/u,
]);

rejectText('stack denial', 'phases/P07.md', [/stack ordering/u, /out-of-order stack/u]);
requireText('async provider states', 'phases/P07.md', [
  /pending\|merged\|enqueued\|failed/u,
  /non-empty\/unknown stack/u,
  /merge_action=default/u,
]);

requireText('dispatch continuity', 'authority/operations-reliability.md', [
  /journalSequence/u,
  /journalGeneration/u,
  /rangeRoot/u,
  /rangeCount/u,
  /highWater/u,
]);
requireText('physical retry accounting', 'authority/operations-reliability.md', [
  /PhysicalDispatchReservation/u,
  /KNOWN_ZERO/u,
  /KNOWN_CHARGED/u,
  /UNKNOWN_CHARGE/u,
]);

requireText('projection enum matrix', 'FINDING-COVERAGE.md', [
  /ARIA-AUDIT-082[^\n]*`OK\\\|EMPTY\\\|MISSING\\\|CORRUPT\\\|UNAVAILABLE`[^\n]*`CURRENT\\\|STALE`/u,
]);
for (const path of ['phases/P01.md', 'phases/P05.md', 'phases/P06.md']) {
  requireText('projection enum cards', path, [
    /OK\|EMPTY\|MISSING\|CORRUPT\|UNAVAILABLE/u,
    /CURRENT\|STALE/u,
  ]);
}

for (const input of ['{"a":1.0}', '{"a":1e0}']) {
  try {
    parseStrictJson(input);
    failures.push(`numeric lexeme accepted: ${input}`);
  } catch {
    // Required rejection.
  }
}

const longBody = Array.from({ length: 61 }, (_, index) => `  value += ${index};`).join('\n');
readabilityCase('single-argument arrow', `const hostileArrow = value => {\n${longBody}\n};`);
readabilityCase('object method', `const hostileObject = { run(value) {\n${longBody}\n} };`);
readabilityCase('class method', `class Hostile { run(value) {\n${longBody}\n} }`);
readabilityCase(
  'callback',
  `const hostileCallback = [1].map(value => {\n${longBody}\n  return value;\n});`,
);
readabilityCase(
  'cognitive nesting',
  'function nested(flags){if(flags[0]){if(flags[1]){if(flags[2]){if(flags[3]){if(flags[4]){if(flags[5]){return 1;}}}}}}return 0;}',
);
readabilityCase('re-export dependency', "export { verifyD0 } from '../verify-d0.mjs';");
readabilityCase('dynamic dependency', "const later = import('../verify-d0.mjs');");

requireText('lost response replay', 'authority/api-ui.md', [
  /same `requestId` \+ same canonical\s+payload digest/u,
  /stored exact result/u,
  /same `requestId` \+\s+different payload/u,
]);

assert.deepEqual(verifyAuthorityContracts(planRoot), [], 'current authority contract rejected');
assert.deepEqual(verifyApiContract(planRoot), [], 'current generated API contract rejected');
assert.ok(
  source('verification/generated-api-contract.json').trimEnd().split('\n').length <= 250,
  'generated API contract exceeds the readability target',
);
for (const entry of [
  [
    'issuer roster',
    'authority/identity-authority-tcb.md',
    '`aria-medium-permit-assembler`',
    '`removed-assembler`',
  ],
  [
    'repository tuple',
    'authority/data-privacy.md',
    'head_repository_id + snapshot_sha',
    'snapshot_sha',
  ],
  [
    'toolchain owner',
    'authority/execution-supply-chain.md',
    '`OP-05` tarafından',
    '`OP-99` tarafından',
  ],
  [
    'stack denial',
    'authority/github-delivery.md',
    'non-empty veya unknown stack permit',
    'ordered stack permit',
  ],
  [
    'journal high-water',
    'authority/operations-reliability.md',
    'rangeRoot, rangeCount, highWater',
    'rangeRoot, rangeCount',
  ],
  [
    'physical unknown',
    'authority/operations-reliability.md',
    'UNKNOWN_CHARGE -> HELD_UNKNOWN',
    'UNKNOWN_CHARGE -> RETRY',
  ],
  [
    'projection enum',
    'FINDING-COVERAGE.md',
    'OK\\|EMPTY\\|MISSING\\|CORRUPT\\|UNAVAILABLE',
    'OK\\|MISSING',
  ],
  ['response replay', 'authority/api-ui.md', 'stored exact result', 'unreachable result'],
]) {
  authorityCase(...entry);
}
withPlanCopy('new-aria-d0-delivery-', (copy) => {
  mutateJson(copy, 'verification/delivery-policy.json', (policy) => {
    policy.merge_method = 'SQUASH';
  });
  replace(copy, 'PLAN.md', "tek yöntem merge\ncommit'tir", "tek yöntem squash'tır");
  if (!verifyAuthorityContracts(copy).some((error) => error.code === 'AUTHORITY_CONTRACT')) {
    failures.push('delivery merge-method mutant accepted');
  }
});

regeneratedApiCase(
  'new-aria-d0-api-closure-',
  (copy) =>
    replace(
      copy,
      'authority/graphql/read-model.graphql',
      '  snapshotSha: String!\n}',
      '  snapshotSha: String!\n  unreviewedDebug: String\n}',
    ),
  'terminal SDL closure drift',
  'regenerated snapshot accepted an unreviewed object field',
);

const activeS06 = buildApiContract(planRoot).phase_contracts?.S06;
if (activeS06?.query_count !== 7 || activeS06?.mutation_count !== 0 || activeS06?.mutation_root) {
  failures.push('S06 active contract is not exactly 7Q/0M with no Mutation root');
}
regeneratedApiCase(
  'new-aria-d0-api-activation-',
  (copy) =>
    mutateJson(copy, 'verification/api-policy.json', (policy) => {
      policy.mutation_activations[0].sprint = 'S06';
    }),
  'phase activation policy drift',
  'regenerated snapshot accepted an early S06 mutation',
);
withPlanCopy('new-aria-d0-api-phase-card-', (copy) => {
  replace(
    copy,
    'phases/P01.md',
    'Phase-active exact `7Q/0M` SDL',
    'Phase-active exact `7Q/9M` SDL',
  );
  if (!verifyApiContract(copy).some((error) => error.message === 'S06 phase-card parity drift')) {
    failures.push('S06 phase card accepted the terminal mutation catalog');
  }
});

assert.deepEqual(failures, [], `contract regressions accepted:\n${failures.join('\n')}`);
process.stdout.write('PASS contract-regressions\n');
