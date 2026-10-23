import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { makeFixtureTree } from '../gates/fixture-tree';

import { readModuleSchemasSource } from './module-schemas-source';

/**
 * ARIA-MEDIUM-588 — unit coverage for the one adapter-side MODULE_SCHEMAS
 * reader. The production-shaped case reproduces the SSoT's real shape: a
 * module entry whose infrastructureTables spreads a local const whose element
 * is an identifier imported from a path-mapped module that re-exports it from
 * a sibling file — exactly the chain
 * `...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES` →
 * `TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE` → `@platform/outbox` follows in
 * this repository. The failure cases pin the contract that an unresolvable
 * element is a NAMED error, never a silent drop.
 */
const workspace = makeFixtureTree('aria-module-schemas-source-');

function write(path: string, body: string): void {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), body, 'utf8');
}

const SSOT = 'libs/backend-common/src/database/schema-manager.service.ts';

write(
  'tsconfig.base.json',
  [
    '{',
    '  "compilerOptions": {',
    '    "baseUrl": ".",',
    '    "paths": {',
    '      "@platform/outbox": ["platform/libs/outbox/src/index.ts"]',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'),
);
write(
  'platform/libs/outbox/src/index.ts',
  "export { LEDGER_TABLE as TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE } from './outbox-migration';\n",
);
write(
  'platform/libs/outbox/src/outbox-migration.ts',
  "export const LEDGER_TABLE = 'tenant_erasure_target_proofs';\n",
);
write(
  SSOT,
  [
    "import { TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE } from '@platform/outbox';",
    'const ERASURE_TABLES = [TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE] as const;',
    'export const MODULE_SCHEMAS = [',
    '  {',
    "    moduleName: 'farm',",
    "    sourceSchema: 'farm',",
    '    strictOwnership: true,',
    "    infrastructureTables: ['migrations', ...ERASURE_TABLES],",
    '    referenceDataTables: [],',
    "    tables: ['ponds'],",
    '  },',
    '] as const;',
    '',
  ].join('\n'),
);

const source = readModuleSchemasSource(workspace);
assert.deepEqual(source.errors, [], 'the production shape resolves with no errors');
const farm = source.modules.find((module) => module.moduleName === 'farm');
assert.ok(farm, 'the farm module is read');
assert.deepEqual(farm.infrastructureTables, ['migrations', 'tenant_erasure_target_proofs']);
assert.equal(farm.strictOwnership, true);
assert.deepEqual(farm.tables, ['ponds']);
assert.deepEqual(source.readPaths, [
  SSOT,
  'platform/libs/outbox/src/index.ts',
  'platform/libs/outbox/src/outbox-migration.ts',
  'tsconfig.base.json',
]);

// --- no path map: the imported constant is a NAMED error, never a drop -----
{
  const bareWorkspace = makeFixtureTree('aria-module-schemas-bare-');
  mkdirSync(dirname(join(bareWorkspace, SSOT)), { recursive: true });
  writeFileSync(
    join(bareWorkspace, SSOT),
    "const X = 'x';\nexport const MODULE_SCHEMAS = [{ moduleName: 'a', sourceSchema: 'a', infrastructureTables: ['migrations', ...MISSING], tables: [X] }];\n",
    'utf8',
  );
  const bare = readModuleSchemasSource(bareWorkspace);
  assert.equal(bare.modules.length, 1, 'the module itself is still returned');
  assert.equal(bare.errors.length, 1);
  assert.match(bare.errors[0]?.message ?? '', /module 'a': infrastructureTables/);
  assert.match(bare.errors[0]?.message ?? '', /'MISSING' is not bound/);
  // A bound local identifier still resolves without any tsconfig.
  assert.deepEqual(bare.modules[0]?.tables, ['x']);
}

// --- a non-array initializer is a named error, not a silent [] -------------
{
  const shapedWorkspace = makeFixtureTree('aria-module-schemas-shaped-');
  mkdirSync(dirname(join(shapedWorkspace, SSOT)), { recursive: true });
  writeFileSync(
    join(shapedWorkspace, SSOT),
    "export const MODULE_SCHEMAS = [{ moduleName: 'a', sourceSchema: 'a', tables: 'ponds' }];\n",
    'utf8',
  );
  const shaped = readModuleSchemasSource(shapedWorkspace);
  assert.equal(shaped.modules.length, 1);
  assert.equal(shaped.errors.length, 1);
  assert.match(shaped.errors[0]?.message ?? '', /module 'a': tables: expected an array literal/);
}

// --- the caller's read policy governs the import chain ----------------------
{
  const blocked = readModuleSchemasSource(workspace, SSOT, {
    pathAllowed: (path) => path !== 'platform/libs/outbox/src/index.ts',
  });
  assert.equal(blocked.errors.length, 1);
  assert.match(
    blocked.errors[0]?.message ?? '',
    /'@platform\/outbox' which resolves to no workspace file/,
  );
  assert.deepEqual(
    blocked.modules.find((module) => module.moduleName === 'farm')?.infrastructureTables,
    ['migrations'],
  );
}

// --- a symlinked import target is refused, never followed (ARIA-LOW-543) ---
{
  const outside = makeFixtureTree('aria-module-schemas-outside-');
  writeFileSync(join(outside, 'evil.ts'), "export const HOOK = 'hooked';\n", 'utf8');
  const linkedWorkspace = makeFixtureTree('aria-module-schemas-linked-');
  mkdirSync(join(linkedWorkspace, 'platform/libs/outbox/src'), { recursive: true });
  writeFileSync(
    join(linkedWorkspace, 'platform/libs/outbox/src/index.ts'),
    "export { HOOK } from './hooked';\n",
    'utf8',
  );
  symlinkSync(
    join(outside, 'evil.ts'),
    join(linkedWorkspace, 'platform/libs/outbox/src/hooked.ts'),
  );
  mkdirSync(dirname(join(linkedWorkspace, SSOT)), { recursive: true });
  writeFileSync(
    join(linkedWorkspace, SSOT),
    "import { HOOK } from '@platform/outbox';\nexport const MODULE_SCHEMAS = [{ moduleName: 'a', sourceSchema: 'a', infrastructureTables: [HOOK], tables: [] }];\n",
    'utf8',
  );
  writeFileSync(
    join(linkedWorkspace, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: { paths: { '@platform/outbox': ['platform/libs/outbox/src/index.ts'] } },
    }),
    'utf8',
  );
  const linked = readModuleSchemasSource(linkedWorkspace);
  // Both the re-export resolution and the binding lookup name the failure: the
  // symlinked target is refused by containment, so nothing outside the
  // workspace is ever read and the element surfaces as errors, not a value.
  assert.equal(linked.errors.length, 2);
  assert.match(linked.errors[0]?.message ?? '', /cannot resolve re-export '\.\/hooked'/);
  assert.match(linked.errors[1]?.message ?? '', /is not an exported constant/);
}

process.stdout.write('module-schemas-source tests passed\n');

// --- SE-3: the module entry of the code-fact bridge -----------------------------------------
//
// service-expertise PLAN §8 SE-3 (v): one JSON entry in this module gives, per service, its
// tenant schema and table placement, read through this one reader (SO-19). The kernel runs it as
// a subprocess on the diff's base tree (plan_coverage's runner), so the case runs it the same way
// on this checkout and compares it with readModuleSchemasSource's own reading of the farm module.
const REPO_ROOT = resolve(__dirname, '..', '..');

void test('SE-3 (v): the --facts entry gives the schema and table placement of farm-service', () => {
  let stdout: string;
  try {
    stdout = execFileSync(
      join(REPO_ROOT, 'node_modules', '.bin', 'ts-node'),
      [
        '--project',
        join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
        join(REPO_ROOT, 'tools', 'aria-adapters', 'module-schemas-source.ts'),
        '--facts',
        '--repo-root',
        REPO_ROOT,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const failed = error as { status?: number | null; stderr?: string };
    assert.fail(`--facts exited ${String(failed.status)}: ${failed.stderr ?? ''}`);
  }
  assert.ok(stdout.trim().startsWith('{'), `--facts printed no JSON object: ${stdout}`);
  const facts = JSON.parse(stdout) as {
    readonly services: readonly {
      readonly service: string;
      readonly schema: string;
      readonly per_tenant_tables: readonly string[];
      readonly cross_tenant_tables: readonly string[];
      readonly ref: string;
    }[];
  };
  const farmService = facts.services.filter((entry) => entry.service === 'farm-service');
  assert.equal(farmService.length, 1, 'exactly one tenant entry for farm-service');
  const [entry] = farmService;
  assert.ok(entry !== undefined);

  const live = readModuleSchemasSource(REPO_ROOT);
  assert.deepEqual(live.errors, []);
  const farmModule = live.modules.find((module) => module.moduleName === 'farm');
  assert.ok(farmModule, 'the farm module is read');
  assert.equal(entry.schema, farmModule.sourceSchema);
  assert.equal(entry.schema, 'farm');
  assert.deepEqual([...entry.per_tenant_tables].sort(), [...farmModule.tables].sort());
  assert.deepEqual(
    [...entry.cross_tenant_tables].sort(),
    [...farmModule.infrastructureTables].sort(),
  );
  assert.equal(entry.ref, `${farmModule.path}:${farmModule.line}`);
});
