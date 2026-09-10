#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema } from 'graphql';
import { buildApiContract, buildSchemaClosure, loadApiSchema } from './lib/api-contract.mjs';
import { canonicalJson } from './lib/canonical.mjs';
import { verifyApiContract } from './lib/verify-api.mjs';
import { planRoot, withPlanCopy } from './test-support.mjs';

function closure(directives) {
  const schema = buildSchema(`
    directive @first on FIELD_DEFINITION
    directive @second on FIELD_DEFINITION
    type Query { value: String ${directives} }
  `);
  return canonicalJson(buildSchemaClosure(schema));
}

assert.notEqual(
  closure('@first @second'),
  closure('@second @first'),
  'semantic closure must preserve applied directive order',
);

const cancelPreview = loadApiSchema(planRoot)
  .getType('CancelMissionInput')
  ?.getFields().previewDigest;
assert.equal(
  String(cancelPreview?.type),
  'String!',
  'cancel requests must bind the exact operator preview digest',
);

withPlanCopy('new-aria-api-coordinated-drift-', (copy) => {
  const schemaPath = join(copy, 'authority/graphql/commands.graphql');
  const source = readFileSync(schemaPath, 'utf8');
  const changed = source.replace(
    '  missionId: ID!\n  previewDigest: String!\n  snapshotDigest:',
    '  missionId: ID!\n  snapshotDigest:',
  );
  assert.notEqual(changed, source, 'coordinated-drift fixture anchor missing');
  writeFileSync(schemaPath, changed);

  const policyPath = join(copy, 'verification/api-policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.terminal_closure = buildApiContract(copy).schema_closure;
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(
    join(copy, 'verification/generated-api-contract.json'),
    JSON.stringify(buildApiContract(copy)),
  );

  assert.equal(
    verifyApiContract(copy).some(
      (error) =>
        error.code === 'API_CONTRACT' &&
        error.message === 'terminal SDL closure differs from immutable D0 authority',
    ),
    true,
    'coordinated SDL, policy, and generated-snapshot drift was accepted',
  );
});

process.stdout.write('PASS api-closure-order\n');
