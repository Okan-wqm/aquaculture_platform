/**
 * SE-3 — the module entry of the code-fact bridge (`moduleFacts`, `module-schemas-source.ts
 * --facts`) on fixture trees: tenant placement follows TENANT_SCOPED_MODULES, the owning service
 * comes from SCHEMA_REGISTRY, a schema no service owns is named, and registries the reader cannot
 * read completely are an environment failure (exit 2, nothing printed), never partial facts.
 * The live farm-service case is module-schemas-source.test.ts (v).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { makeFixtureTree } from '../gates/fixture-tree';

import {
  MODULE_SCHEMAS_SOURCE_PATH,
  moduleFacts,
  ModuleFactsUnavailable,
  readModuleSchemasSource,
  SCHEMA_REGISTRY_SOURCE_PATH,
} from './module-schemas-source';

const REPO_ROOT = resolve(__dirname, '..', '..');

const MODULE_SCHEMAS = [
  'export const MODULE_SCHEMAS = [',
  "  { moduleName: 'farm', sourceSchema: 'farm', infrastructureTables: ['migrations'], referenceDataTables: ['species'], tables: ['ponds', 'species'] },",
  "  { moduleName: 'billing', sourceSchema: 'billing', infrastructureTables: ['billing_outbox'], tables: ['invoices'] },",
  "  { moduleName: 'platform', sourceSchema: 'platform', infrastructureTables: ['release_ledger'], tables: [] },",
  '];',
].join('\n');

const REGISTRY = [
  'export const SCHEMA_REGISTRY = [',
  "  { service: 'farm-service', schema: 'farm', migrationsGlob: [], reason: 'domain' },",
  "  { service: 'billing-service', schema: 'billing', migrationsGlob: [], reason: 'platform' },",
  '];',
  '',
].join('\n');

function tree(scoped: string, registry: string | null = REGISTRY): string {
  const root = makeFixtureTree('aria-module-facts-');
  const files: Record<string, string> = {
    [MODULE_SCHEMAS_SOURCE_PATH]: `${MODULE_SCHEMAS}\nexport const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set([${scoped}]);\n`,
  };
  if (registry !== null) files[SCHEMA_REGISTRY_SOURCE_PATH] = registry;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return root;
}

function runEntry(root: string): { readonly status: number; readonly stdout: string } {
  try {
    const stdout = execFileSync(
      join(REPO_ROOT, 'node_modules', '.bin', 'ts-node'),
      [
        '--project',
        join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
        join(REPO_ROOT, 'tools', 'aria-adapters', 'module-schemas-source.ts'),
        '--facts',
        '--repo-root',
        root,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string };
    return { status: failed.status ?? -1, stdout: failed.stdout ?? '' };
  }
}

void test('placement follows TENANT_SCOPED_MODULES; the owner comes from SCHEMA_REGISTRY', () => {
  const facts = moduleFacts(tree("'farm'"));
  assert.deepEqual(
    facts.services.map(
      ({ service, module, tenant_scoped, per_tenant_tables, cross_tenant_tables }) => ({
        service,
        module,
        tenant_scoped,
        per_tenant_tables,
        cross_tenant_tables,
      }),
    ),
    [
      {
        service: 'billing-service',
        module: 'billing',
        tenant_scoped: false,
        per_tenant_tables: [],
        cross_tenant_tables: ['invoices', 'billing_outbox'],
      },
      {
        service: 'farm-service',
        module: 'farm',
        tenant_scoped: true,
        per_tenant_tables: ['ponds', 'species'],
        cross_tenant_tables: ['migrations'],
      },
    ],
  );
  assert.deepEqual(facts.services[1]?.reference_data_tables, ['species']);
  assert.equal(facts.services[1]?.ref, `${MODULE_SCHEMAS_SOURCE_PATH}:2`);
  // A schema no service owns is named, not dropped.
  assert.deepEqual(facts.modules_without_owner, [
    { module: 'platform', schema: 'platform', ref: `${MODULE_SCHEMAS_SOURCE_PATH}:4` },
  ]);
});

void test('a TENANT_SCOPED_MODULES element that is not a literal is a named error', () => {
  const root = tree("'farm', SCOPED");
  const source = readModuleSchemasSource(root);
  assert.deepEqual(source.tenantScopedModules, new Set(['farm']));
  assert.equal(source.errors.length, 1);
  assert.match(
    source.errors[0]?.message ?? '',
    /TENANT_SCOPED_MODULES element is not a string literal \(SCOPED\)/,
  );
  assert.throws(() => moduleFacts(root), ModuleFactsUnavailable);
});

void test('registries the reader cannot read completely: exit 2, no facts printed', () => {
  assert.throws(() => moduleFacts(tree("'farm'", null)), /schema-registry\.ts is not a file/);
  const unreadable = runEntry(
    tree("'farm'", "export const SCHEMA_REGISTRY = [{ service: SERVICE, schema: 'farm' }];\n"),
  );
  assert.equal(unreadable.status, 2);
  assert.equal(unreadable.stdout, '');
  const computed = runEntry(tree("'farm'"));
  assert.equal(computed.status, 0);
  assert.equal((JSON.parse(computed.stdout) as { schema: string }).schema, 'aria/module_facts/v1');
});
