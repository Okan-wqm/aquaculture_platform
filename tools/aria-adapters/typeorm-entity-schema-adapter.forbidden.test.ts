import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeTypeOrmEntities } from './typeorm-entity-schema-adapter';

// DET-typeorm2 / Z34 (+ Z-B2 inverse half). ADR-011 has two directions; the adapter models
// "a cross-tenant table must declare `schema:`". This file pins the other one: a per-tenant
// table of a tenant-scoped service must OMIT it, because a literal schema pins every tenant's
// rows into the shared schema and defeats search_path routing. The per-tenant / cross-tenant
// split comes from the SSoT (TENANT_SCOPED_MODULES + MODULE_SCHEMAS[].infrastructureTables).
// The rule id is compared as a `string`: it is the new id this package introduces.
const RULE = 'typeorm_entity_schema_forbidden';
const isForbidden = (rule: string): boolean => rule === RULE;
const SSOT = 'libs/backend-common/src/database/schema-manager.service.ts';
const HR = 'apps/hr-service/src';
const NAME_CONST = `const SCHEMA_NAME = 'hr';`;

// [file, decorator, class, expected to be flagged, preamble]
type Case = readonly [string, string, string, boolean, string?];
const HR_CASES: readonly Case[] = [
  // Z34 fixture: hr `leave_balances` is per-tenant, so `schema: 'hr'` is a defect.
  ['leave/leave-balance', `@Entity('leave_balances', { schema: 'hr' })`, 'LeaveBalance', true],
  // Single-object form, and a non-literal schema, are declared schemas too.
  [
    'leave/leave-request',
    `@Entity({ name: 'leave_requests', schema: 'hr' })`,
    'LeaveRequest',
    true,
  ],
  ['leave/shift', `@Entity('shifts', { schema: SCHEMA_NAME })`, 'Shift', true, NAME_CONST],
  ['leave/overtime', `@Entity('overtime', { schema })`, 'Overtime', true, `const schema = 'hr';`],
  ['legacy/legacy-balance', `@Entity('legacy_balances', { schema: 'hr' })`, 'LegacyBalance', true],
  // Near-miss negatives: a per-tenant table without schema; cross-tenant infrastructure tables
  // (explicit name, snake_case default name, non-literal schema) KEEP `schema:`.
  ['ok/employee', `@Entity('employees')`, 'Employee', false],
  ['infra/outbox', `@Entity('hr_outbox_events', { schema: 'hr' })`, 'HrOutboxEvent', false],
  ['infra/ledger', `@Entity({ schema: 'hr' })`, 'HrAuditLedger', false],
  [
    'infra/keys',
    `@Entity('hr_idempotency_keys', { schema: SCHEMA_NAME })`,
    'Keys',
    false,
    NAME_CONST,
  ],
];
const pathOf = (file: string): string => `${HR}/${file}.entity.ts`;
const sourceOf = ([, decorator, className, , preamble]: Case): string =>
  `import { Entity } from 'typeorm';\n${preamble ?? ''}\n${decorator}\nexport class ${className} {}\n`;
const HR_FILES: Record<string, string> = Object.fromEntries(
  HR_CASES.map((item) => [pathOf(item[0]), sourceOf(item)]),
);
// Platform service: `schema:` is mandatory there, so it is never forbidden.
const BILLING = 'apps/billing-service/src';
HR_FILES[`${BILLING}/subscription.entity.ts`] = sourceOf([
  '',
  `@Entity('subscriptions', { schema: 'billing' })`,
  'Subscription',
  false,
]);
const FLAGGED = HR_CASES.filter((item) => item[3]).map((item) => pathOf(item[0]));
const LEAVE = pathOf('leave/leave-balance');
const without = (path: string): string[] => FLAGGED.filter((item) => item !== path).sort();

function ssot(tenantScoped: readonly string[] = ['hr'], infra: readonly string[] = []): string {
  const hrInfra = ['migrations', 'hr_outbox_events', 'hr_audit_ledger', 'hr_idempotency_keys'];
  const entry = (name: string, tables: readonly string[]): string =>
    `{ moduleName: '${name}', sourceSchema: '${name}', infrastructureTables: ${JSON.stringify(tables)}, referenceDataTables: [], tables: [] }`;
  return `
    export const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set(${JSON.stringify(tenantScoped)});
    export const MODULE_SCHEMAS = [${entry('hr', [...hrInfra, ...infra])}, ${entry('zeta', ['migrations'])}, ${entry('billing', ['migrations'])}];
  `;
}

function workspaceOf(files: Readonly<Record<string, string>>): string {
  const workspace = makeFixtureTree('aria-typeorm-forbidden-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), text, 'utf8');
  }
  return workspace;
}

type Output = ReturnType<typeof analyzeTypeOrmEntities>;
const run = (
  workspace: string,
  root: string,
  serviceName: string,
  allowlist: string[] = [],
): Output =>
  analyzeTypeOrmEntities({ root, serviceName, checks: ['entity_schema'], allowlist }, workspace);
const flagged = (output: Output): string[] =>
  output.findings
    .filter((finding) => isForbidden(finding.rule))
    .map((finding) => finding.path)
    .sort();
const flaggedIn = (files: Record<string, string>, root = HR, service = 'hr'): string[] =>
  flagged(run(workspaceOf(files), root, service));

const workspace = workspaceOf({ ...HR_FILES, [SSOT]: ssot() });

// Z34: each per-tenant table that declares a schema is reported at its decorator line, as a
// high finding that cites the SSoT the per-tenant verdict came from.
const output = run(workspace, HR, 'hr');
assert.deepEqual(flagged(output), [...FLAGGED].sort());
const z34 = output.findings.find((finding) => isForbidden(finding.rule) && finding.path === LEAVE);
assert.ok(z34, 'Z34: hr leave_balances with schema:hr must be reported');
const decoratorRow = readFileSync(join(workspace, LEAVE), 'utf8')
  .split('\n')
  .findIndex((row) => row.startsWith('@Entity('));
assert.equal(z34.line, decoratorRow + 1);
assert.equal(z34.severity, 'high');
assert.equal(z34.className, 'LeaveBalance');
assert.ok(z34.evidence.some((ref) => ref.path === LEAVE && ref.line === z34.line));
assert.ok(z34.evidence.some((ref) => ref.path === SSOT));
for (const finding of output.findings) {
  for (const ref of finding.evidence) {
    assert.ok(output.read_paths.includes(ref.path), `evidence ${ref.path} must be a read path`);
  }
}
// The two directions never both fire on one entity.
assert.deepEqual(
  output.findings.filter(
    (finding) =>
      finding.rule === 'typeorm_entity_schema_required' && FLAGGED.includes(finding.path),
  ),
  [],
);

// Near-miss: an allowlisted entity stays quiet, its siblings do not.
const legacy = pathOf('legacy/legacy-balance');
assert.deepEqual(flagged(run(workspace, HR, 'hr', [legacy])), without(legacy));
// Near-miss: `schema:` is required in a platform service (not in TENANT_SCOPED_MODULES).
assert.deepEqual(flagged(run(workspace, BILLING, 'billing')), []);

// One owner: the verdict follows the SSoT, not a list kept in the adapter.
assert.deepEqual(
  flaggedIn({ ...HR_FILES, [SSOT]: ssot(['hr'], ['leave_balances']) }),
  without(LEAVE),
);
assert.deepEqual(flaggedIn({ ...HR_FILES, [SSOT]: ssot([]) }), []);
const zeta = 'apps/zeta-service/src/row.entity.ts';
const zetaRow = sourceOf(['', `@Entity('zeta_rows', { schema: 'zeta' })`, 'ZetaRow', true]);
assert.deepEqual(
  flaggedIn({ [zeta]: zetaRow, [SSOT]: ssot(['zeta']) }, 'apps/zeta-service/src', 'zeta'),
  [zeta],
);

// A tenant-scoped module with no MODULE_SCHEMAS entry has no infrastructure set to test the
// table against, so the claim's second premise is unread and nothing is reported.
const ghost = 'apps/ghost-service/src/row.entity.ts';
const ghostRow = sourceOf(['', `@Entity('ghost_rows', { schema: 'ghost' })`, 'GhostRow', true]);
assert.deepEqual(
  flaggedIn({ [ghost]: ghostRow, [SSOT]: ssot(['ghost']) }, 'apps/ghost-service/src', 'ghost'),
  [],
);

// No registry, no claim: an absent SSoT, one without TENANT_SCOPED_MODULES, and a partially
// resolved registry (an unresolvable infrastructure element) all stay quiet.
const leaveOnly = { [LEAVE]: HR_FILES[LEAVE] ?? '' };
const sources = [
  undefined,
  ssot().replace(/export const TENANT_SCOPED_MODULES.*\n/, ''),
  ssot().replace('"migrations"', '...UNRESOLVED_TABLES, "migrations"'),
];
for (const text of sources) {
  assert.deepEqual(flaggedIn(text === undefined ? leaveOnly : { ...leaveOnly, [SSOT]: text }), []);
}

// The rule is declared in the manifest, with the premises a claim needs.
type Manifest = {
  rules: Record<string, { claim_type?: string; severity_cap?: string; premises?: string[] }>;
};
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'typeorm-entity-schema-adapter.tool.json'), 'utf8'),
) as Manifest;
const declared = manifest.rules[RULE];
assert.ok(declared, `${RULE} must be declared in typeorm-entity-schema-adapter.tool.json`);
assert.equal(declared.claim_type, 'wrong_code');
assert.equal(declared.severity_cap, 'HIGH');
for (const term of ['TENANT_SCOPED_MODULES', 'infrastructureTables']) {
  assert.ok(
    (declared.premises ?? []).some((premise) => premise.includes(term)),
    term,
  );
}
for (const finding of output.findings) {
  assert.ok(manifest.rules[finding.rule], `${finding.rule} is emitted but not declared`);
}

// Baseline pin (0 -> 0 on clean main): the 200 per-tenant entities of the seven tenant-scoped
// services omit `schema:` and the 20 infrastructure ones keep it. Green before the rule exists
// by design; it fails the day a per-tenant table of the real SSoT declares a schema.
const repoRoot = resolve(__dirname, '..', '..');
assert.deepEqual(flagged(analyzeTypeOrmEntities({ checks: ['entity_schema'] }, repoRoot)), []);

process.stdout.write('typeorm-entity-schema-adapter forbidden tests passed\n');
