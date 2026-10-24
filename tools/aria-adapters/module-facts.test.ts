/**
 * SE-3 — the module entry of the code-fact bridge (`moduleFacts`, `module-schemas-source.ts
 * --facts`) on fixture trees: tenant placement follows TENANT_SCOPED_MODULES, the owning service
 * comes from SCHEMA_REGISTRY, a schema no service owns is named, and registries the reader cannot
 * read completely are an environment failure (exit 2, nothing printed), never partial facts.
 * The live farm-service case is module-schemas-source.test.ts (v).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { indexFixtureTree } from '../gates/fixture-git-index';
import { makeFixtureTree } from '../gates/fixture-tree';
import { hermeticGitEnv } from '../gates/hermetic-git';

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

/**
 * The nx applications of the fixture tree (apps/<dir>/project.json). SE-3-R2: each
 * SCHEMA_REGISTRY owner resolves through the SE-1 key reader, so the owners are applications;
 * farm-service's directory differs from its nx name, so the key is the name, not the directory.
 */
const APPLICATIONS: Readonly<Record<string, string>> = {
  'apps/farm/project.json': JSON.stringify({ name: 'farm-service', projectType: 'application' }),
  'apps/billing-service/project.json': JSON.stringify({
    name: 'billing-service',
    projectType: 'application',
  }),
  'apps/config-service/project.json': JSON.stringify({
    name: 'config-service',
    projectType: 'application',
  }),
};

function tree(scoped: string, registry: string | null = REGISTRY): string {
  const root = makeFixtureTree('aria-module-facts-');
  const files: Record<string, string> = {
    ...APPLICATIONS,
    [MODULE_SCHEMAS_SOURCE_PATH]: `${MODULE_SCHEMAS}\nexport const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set([${scoped}]);\n`,
  };
  if (registry !== null) files[SCHEMA_REGISTRY_SOURCE_PATH] = registry;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  // The SE-1 key reader reads the tree's tracked files (git ls-files), so the fixture is indexed.
  return indexFixtureTree(root);
}

function runEntry(root: string): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
} {
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
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: failed.status ?? -1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
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

// --- SE-3 review round 1 blockers (build/SE-3/review-r1-blockers.md), pinned before round 2 ----

/** A SCHEMA_REGISTRY source with the given `[service, schema]` entries. */
function registryOf(entries: readonly (readonly [string, string])[]): string {
  return [
    'export const SCHEMA_REGISTRY = [',
    ...entries.map(
      ([service, schema]) =>
        `  { service: '${service}', schema: '${schema}', migrationsGlob: [], reason: 'fixture' },`,
    ),
    '];',
    '',
  ].join('\n');
}

/** moduleFacts refuses the tree with ModuleFactsUnavailable naming every `names`, and the entry exits 2 printing nothing. */
function assertRefused(root: string, names: readonly string[]): void {
  assert.throws(
    () => moduleFacts(root),
    (error: unknown) => {
      assert.ok(error instanceof ModuleFactsUnavailable, String(error));
      for (const name of names)
        assert.ok(error.message.includes(name), `${error.message} names ${name}`);
      return true;
    },
  );
  const run = runEntry(root);
  assert.equal(run.status, 2, `exit ${run.status}, stdout ${JSON.stringify(run.stdout)}`);
  assert.equal(run.stdout, '');
}

void test('architecture B4: two SCHEMA_REGISTRY services claiming one schema refuse the facts by name', () => {
  // Round 1 kept the last owner in a Map and dropped billing-service with exit 0.
  assertRefused(
    tree(
      "'farm'",
      registryOf([
        ['farm-service', 'farm'],
        ['billing-service', 'billing'],
        ['config-service', 'billing'],
      ]),
    ),
    ['billing-service', 'config-service'],
  );
});

void test('architecture B4: one SCHEMA_REGISTRY service listed twice refuses the facts by name', () => {
  assertRefused(
    tree(
      "'farm'",
      registryOf([
        ['farm-service', 'farm'],
        ['farm-service', 'billing'],
      ]),
    ),
    ['farm-service'],
  );
});

void test('single-owner B3: an owner that is not an nx application refuses the facts by name', () => {
  // The module entry keys services by the SE-1 key (the nx project name of an apps/ project),
  // read by the one reader the event entry uses; SCHEMA_REGISTRY.service is never trusted as a
  // key on its own. A library project of that name is not an application either.
  const root = tree(
    "'farm'",
    registryOf([
      ['farm-service', 'farm'],
      ['ghost-service', 'billing'],
    ]),
  );
  mkdirSync(join(root, 'libs', 'ghost-service'), { recursive: true });
  writeFileSync(
    join(root, 'libs', 'ghost-service', 'project.json'),
    JSON.stringify({ name: 'ghost-service', projectType: 'library' }),
    'utf8',
  );
  assertRefused(root, ['ghost-service']);
});

// --- SE-3-R2 corrective round 1 (build/SE-3-R2/appellate-r1.md roots R2, R4) ------------------

// Root R2: the module entry resolves owners through the SE-1 key reader (applicationNames), which
// followed a symlinked apps/<dir>/project.json out of the tree; a target that is not JSON reached
// the kernel's witness through the SyntaxError's message (exit 1).
const OUTSIDE_MARKER = 'ZQXJ-outside-marker-7c41';

void test('R2: a tracked project.json that links out of the tree: exit 2 by name, no target content', () => {
  const outside = makeFixtureTree('aria-module-facts-outside-');
  writeFileSync(join(outside, 'marker.txt'), `${OUTSIDE_MARKER}\n`, 'utf8');
  const root = tree("'farm'");
  mkdirSync(join(root, 'apps', 'x-service'), { recursive: true });
  symlinkSync(join(outside, 'marker.txt'), join(root, 'apps', 'x-service', 'project.json'));
  indexFixtureTree(root);
  const run = runEntry(root);
  assert.equal(run.status, 2, `exit ${run.status}: ${run.stderr}`);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /SourceTreeUnavailable/);
  assert.match(run.stderr, /apps\/x-service\/project\.json/);
  assert.ok(!run.stderr.includes(OUTSIDE_MARKER.slice(0, 4)), run.stderr);
});

// Root R4: a SCHEMA_REGISTRY owner whose schema has no MODULE_SCHEMAS entry vanished from the
// facts with exit 0, so "owns a schema whose placement is unknown" read as "owns no schema". The
// platform invariants allow this state (a manifest is required only for tenant-aware schemas), so
// it is listed by name, not refused.
void test('R4: a registry owner whose schema has no MODULE_SCHEMAS entry is listed with its ref, exit 0', () => {
  const registry = registryOf([
    ['farm-service', 'farm'],
    ['billing-service', 'billing'],
    ['config-service', 'config'],
  ]);
  const run = runEntry(tree("'farm'", registry));
  assert.equal(run.status, 0, run.stderr);
  const facts = JSON.parse(run.stdout) as Record<string, unknown>;
  const configLine =
    registry.split('\n').findIndex((line) => line.includes("'config-service'")) + 1;
  assert.deepEqual(facts.owners_without_module, [
    {
      service: 'config-service',
      schema: 'config',
      ref: `${SCHEMA_REGISTRY_SOURCE_PATH}:${configLine}`,
    },
  ]);
  const services = facts.services as readonly { service: string }[];
  assert.deepEqual(
    services.map((entry) => entry.service),
    ['billing-service', 'farm-service'],
  );
});

// SE-3-R2 corrective round 2, root RB (build/SE-3-R2/appellate-r2.md), the module entry's half:
// its import-chain resolution read any file under the tree, so a tracked MODULE_SCHEMAS that
// spreads a constant from an ignored module took that module's tables as placement facts. The
// reader now resolves only within the tree's tracked set, the one the event entry enumerates.
const PLANTED_TABLE = 'planted_ignored_table';

function moduleFactsOutcome(root: string): string {
  try {
    return JSON.stringify({ facts: moduleFacts(root) });
  } catch (error) {
    if (!(error instanceof ModuleFactsUnavailable)) throw error;
    return JSON.stringify({ unavailable: error.message });
  }
}

void test('RB: a MODULE_SCHEMAS constant imported from an ignored module never becomes placement facts', () => {
  const root = tree("'farm'");
  const ssot = join(root, MODULE_SCHEMAS_SOURCE_PATH);
  writeFileSync(
    ssot,
    [
      "import { PLANTED_TABLES } from './tmp/planted-tables';",
      MODULE_SCHEMAS.replace("tables: ['invoices']", "tables: ['invoices', ...PLANTED_TABLES]"),
      "export const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set(['farm']);",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(root, '.gitignore'), 'tmp\n', 'utf8');
  indexFixtureTree(root);
  const before = moduleFactsOutcome(root);
  const planted = join(dirname(ssot), 'tmp', 'planted-tables.ts');
  mkdirSync(dirname(planted), { recursive: true });
  writeFileSync(planted, `export const PLANTED_TABLES = ['${PLANTED_TABLE}'] as const;\n`, 'utf8');
  const status = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain', '--untracked-files=all'],
    {
      encoding: 'utf8',
      env: hermeticGitEnv(),
    },
  );
  // The fixture is indexed, not committed: its files are staged, and the planted one is not listed.
  assert.ok(!status.includes('tmp'), status);
  const after = moduleFactsOutcome(root);
  assert.equal(after, before, 'an ignored module changed the module facts');
  assert.ok(!after.includes(PLANTED_TABLE), after);
});
