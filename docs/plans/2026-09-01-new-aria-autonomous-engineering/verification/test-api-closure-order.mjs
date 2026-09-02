#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildSchema } from 'graphql';
import { buildSchemaClosure } from './lib/api-contract.mjs';
import { canonicalJson } from './lib/canonical.mjs';

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

process.stdout.write('PASS api-closure-order\n');
