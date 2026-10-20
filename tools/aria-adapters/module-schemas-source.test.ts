import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
const workspace = mkdtempSync(join(tmpdir(), 'aria-module-schemas-source-'));
process.on('exit', () => {
  rmSync(workspace, { recursive: true, force: true });
});

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
  const bareWorkspace = mkdtempSync(join(tmpdir(), 'aria-module-schemas-bare-'));
  process.on('exit', () => {
    rmSync(bareWorkspace, { recursive: true, force: true });
  });
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
  const shapedWorkspace = mkdtempSync(join(tmpdir(), 'aria-module-schemas-shaped-'));
  process.on('exit', () => {
    rmSync(shapedWorkspace, { recursive: true, force: true });
  });
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
  const outside = mkdtempSync(join(tmpdir(), 'aria-module-schemas-outside-'));
  process.on('exit', () => {
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, 'evil.ts'), "export const HOOK = 'hooked';\n", 'utf8');
  const linkedWorkspace = mkdtempSync(join(tmpdir(), 'aria-module-schemas-linked-'));
  process.on('exit', () => {
    rmSync(linkedWorkspace, { recursive: true, force: true });
  });
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
