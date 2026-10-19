import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';
import { MIGRATION_SQL_LINT_RULE_IDS } from '../gates/migration-sql-lint';

import {
  SQL_LINT_PROJECTION,
  analyzeMigrationSafety,
  assertLintProjectionComplete,
} from './sql-migration-safety-adapter';

// ARIA-HIGH-011. The workspace is built at run time because the delta-safety
// true positives (R1-R12) cannot be committed: the migration-sql-lint
// pre-commit and CI gates this adapter mirrors refuse an added migration that
// violates them. The committed fixture case covers the whole-tree owners.

const REPO_ROOT = resolve(__dirname, '..', '..');
const workspace = makeFixtureTree('aria-sql-migration-safety-');
const outside = makeFixtureTree('aria-sql-migration-outside-');

const FARM = 'apps/farm-service/src/database/migrations';
const BILLING = 'apps/billing-service/src/database/migrations';

function write(path: string, body: string): void {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), body, 'utf8');
}

function migration(
  className: string,
  up: readonly string[],
  down: readonly string[],
  decorator = '',
): string {
  return [
    "import { MigrationInterface, QueryRunner } from 'typeorm';",
    '',
    ...(decorator === '' ? [] : [decorator]),
    `export class ${className} implements MigrationInterface {`,
    '  public async up(queryRunner: QueryRunner): Promise<void> {',
    ...up.map((line) => `    ${line}`),
    '  }',
    '',
    '  public async down(queryRunner: QueryRunner): Promise<void> {',
    ...down.map((line) => `    ${line}`),
    '  }',
    '}',
    '',
  ].join('\n');
}

const UNSAFE_DELTA = migration(
  'UnsafeDelta1900000000010',
  [
    'await queryRunner.query(`ALTER TABLE ponds ADD COLUMN IF NOT EXISTS "depth_cm" integer NOT NULL`);',
  ],
  ['await queryRunner.query(`DROP TABLE farm.pond_depths`);'],
);
// The repository-approved forms of the same two changes: a nullable first
// step, and a guarded, marked drop.
const SAFE_DELTA = migration(
  'SafeDelta1900000000011',
  ['await queryRunner.query(`ALTER TABLE ponds ADD COLUMN IF NOT EXISTS "depth_cm" integer`);'],
  [
    'await queryRunner.query(`',
    '  -- DESTRUCTIVE: rollback re-creates farm.pond_depths from 1900000000011 up()',
    '  DROP TABLE IF EXISTS farm.pond_depths;',
    '`);',
  ],
);
const UNGUARDED_ENUM_DROP = migration(
  'EnumDrop1900000000012',
  ['await queryRunner.query(`DROP TYPE IF EXISTS "farm"."ponds_grade_enum"`);'],
  ['await queryRunner.query(`SELECT 1`);'],
);
const NON_CANONICAL_POLICY = migration(
  'InlinePolicy1900000000013',
  [
    'await queryRunner.query(`',
    '  CREATE POLICY tenant_isolation_policy ON ponds USING ("tenant_id" = current_setting(\'app.current_tenant\')::uuid);',
    '`);',
  ],
  ['await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON ponds`);'],
);

write(`${FARM}/1900000000010-UnsafeDelta.ts`, UNSAFE_DELTA);
write(`${FARM}/1900000000011-SafeDelta.ts`, SAFE_DELTA);
// The same unsafe delta, NOT in the change set: applied history.
write(
  `${FARM}/1800000000010-AppliedDelta.ts`,
  UNSAFE_DELTA.replace('UnsafeDelta1900000000010', 'AppliedDelta1800000000010'),
);
write(`${FARM}/1900000000012-EnumDrop.ts`, UNGUARDED_ENUM_DROP);
// Billing is not tenant-aware (platform catalog), so the orphan-type rule does
// not govern it: the source schema is the only schema.
write(`${BILLING}/1900000000012-EnumDrop.ts`, UNGUARDED_ENUM_DROP);
write(`${FARM}/1900000000013-InlinePolicy.ts`, NON_CANONICAL_POLICY);
// The owner's grandfather list names this path: pre-helper RLS rollout.
write(
  `${FARM}/1776000000000-EnableRowLevelSecurity.ts`,
  NON_CANONICAL_POLICY.replace('InlinePolicy1900000000013', 'EnableRowLevelSecurity1776000000000'),
);
write(
  `${FARM}/1900000000014-DanglingContract.ts`,
  migration(
    'DanglingContract1900000000014',
    ['await queryRunner.query(`ALTER TABLE ponds DROP COLUMN IF EXISTS "gone"`);'],
    ['await queryRunner.query(`ALTER TABLE ponds ADD COLUMN IF NOT EXISTS "gone" integer`);'],
    "@ExpandContract({ phase: 'contract', dependsOn: 'NoSuchExpandPhase' })",
  ),
);
// SQL no owner can read: a string literal, not a template.
write(
  `${FARM}/1900000000015-OpaqueSql.ts`,
  migration(
    'OpaqueSql1900000000015',
    ["await queryRunner.query('DROP TABLE farm.hidden');"],
    ["await queryRunner.query('SELECT 1');"],
  ),
);
// A migration that does not parse is an observation error, never clean.
write(
  `${FARM}/1900000000016-Broken.ts`,
  'export class Broken1900000000016 {\n  public async up( {\n',
);
// A tracked-looking migration that is a symlink out of the workspace.
writeFileSync(join(outside, 'secret.ts'), UNSAFE_DELTA, 'utf8');
symlinkSync(join(outside, 'secret.ts'), join(workspace, FARM, '1900000000017-Linked.ts'));

const ADDED = [
  `${FARM}/1900000000010-UnsafeDelta.ts`,
  `${FARM}/1900000000011-SafeDelta.ts`,
  `${FARM}/1900000000017-Linked.ts`,
  `${FARM}/1900000000099-Typo.ts`,
];
const input = {
  roots: ['apps'],
  addedPaths: ADDED,
  repo_snapshot: { base_commit_sha: '0123456789abcdef0123456789abcdef01234567' },
};
const result = analyzeMigrationSafety(input, workspace);

const findingsAt = (path: string): readonly (typeof result.findings)[number][] =>
  result.findings.filter((finding) => finding.path === path);
const rulesAt = (path: string): readonly string[] =>
  findingsAt(path)
    .map((finding) => finding.rule)
    .sort();
const observationAt = (path: string): Record<string, unknown> => {
  const found = result.observations.find(
    (observation) => observation.type === 'migration_safety_file' && observation.path === path,
  );
  assert.ok(found?.details, `no file observation for ${path}`);
  return found.details;
};
const summary = result.observations.find(
  (observation) => observation.type === 'migration_safety_summary',
)?.details;
assert.ok(summary, 'the summary observation is always emitted');

// --- delta-safety rules: the change set ------------------------------------
assert.deepEqual(rulesAt(`${FARM}/1900000000010-UnsafeDelta.ts`), [
  'destructive_ddl_without_marker',
  'drop_table_without_if_exists',
  'single_step_add_not_null',
]);
const notNull = findingsAt(`${FARM}/1900000000010-UnsafeDelta.ts`).find(
  (finding) => finding.rule === 'single_step_add_not_null',
);
assert.equal(notNull?.direction, 'up', 'the one-step NOT NULL is in up()');
assert.equal(notNull?.owner, 'tools/gates/migration-sql-lint.ts');
assert.equal(notNull?.owner_rule_id, 'R2-single-step-add-not-null');
assert.equal(notNull?.severity, 'high');
assert.equal(notNull?.target_sha, input.repo_snapshot.base_commit_sha);
assert.equal(notNull?.line, 5);
for (const finding of findingsAt(`${FARM}/1900000000010-UnsafeDelta.ts`).filter(
  (f) => f.rule !== 'single_step_add_not_null',
)) {
  assert.equal(finding.direction, 'down', `${finding.rule} is in down()`);
}
assert.deepEqual(
  rulesAt(`${FARM}/1900000000011-SafeDelta.ts`),
  [],
  'the approved forms raise nothing',
);

// --- grandfathering: applied history is observed, not raised ----------------
assert.deepEqual(rulesAt(`${FARM}/1800000000010-AppliedDelta.ts`), []);
assert.deepEqual(observationAt(`${FARM}/1800000000010-AppliedDelta.ts`).grandfathered_violations, {
  'R1-destructive-without-marker': 1,
  'R12-drop-table-without-if-exists': 1,
  'R2-single-step-add-not-null': 1,
});
assert.equal(observationAt(`${FARM}/1800000000010-AppliedDelta.ts`).in_change_set, false);

// --- orphan-type reclamation: tenant-aware scope only ------------------------
assert.deepEqual(rulesAt(`${FARM}/1900000000012-EnumDrop.ts`), ['unguarded_shared_enum_drop']);
const enumDrop = findingsAt(`${FARM}/1900000000012-EnumDrop.ts`)[0];
assert.equal(enumDrop?.subject, '"farm"."ponds_grade_enum"');
assert.equal(enumDrop?.direction, 'up');
assert.deepEqual(
  rulesAt(`${BILLING}/1900000000012-EnumDrop.ts`),
  [],
  'billing is not tenant-aware',
);

// --- canonical RLS predicate: owner's scope and grandfather list ------------
assert.deepEqual(rulesAt(`${FARM}/1900000000013-InlinePolicy.ts`), ['rls_predicate_not_canonical']);
assert.equal(
  findingsAt(`${FARM}/1900000000013-InlinePolicy.ts`)[0]?.subject,
  'tenant_isolation_policy',
);
assert.deepEqual(
  rulesAt(`${FARM}/1776000000000-EnableRowLevelSecurity.ts`),
  [],
  'grandfathered by the owner',
);

// --- expand-contract: whole-tree errors -------------------------------------
assert.deepEqual(rulesAt(`${FARM}/1900000000014-DanglingContract.ts`), [
  'expand_contract_depends_on_unresolved',
]);

// --- honesty: unreadable SQL, unparsable files, symlinks, the change set ----
assert.equal(observationAt(`${FARM}/1900000000015-OpaqueSql.ts`).opaque_query_calls, 2);
assert.deepEqual(
  rulesAt(`${FARM}/1900000000015-OpaqueSql.ts`),
  [],
  'no owner reads a string-literal query',
);
assert.equal(observationAt(`${FARM}/1900000000016-Broken.ts`).verdict, 'unparsable');
assert.ok(
  result.observations.some(
    (observation) =>
      observation.type === 'migration_parse_failure' &&
      observation.path === `${FARM}/1900000000016-Broken.ts`,
  ),
);
assert.equal(summary.parse_failures, 1);
assert.equal(summary.clean, false, 'a parse failure is never a clean result');
assert.ok(
  !result.read_paths.includes(`${FARM}/1900000000017-Linked.ts`),
  'a symlinked migration is never read',
);
const changeSet = result.observations.find(
  (observation) => observation.type === 'migration_change_set',
)?.details;
assert.deepEqual(changeSet?.unmatched, [
  `${FARM}/1900000000017-Linked.ts`,
  `${FARM}/1900000000099-Typo.ts`,
]);
assert.equal(
  summary.authorities_complete,
  false,
  'a workspace without the owners records no provenance hash',
);
assert.throws(
  () => analyzeMigrationSafety({ roots: ['../escape'] }, workspace),
  /not a contained workspace-relative path/,
);
assert.throws(() => analyzeMigrationSafety({}, workspace), /roots is required/);

// --- output contract --------------------------------------------------------
for (const finding of result.findings) {
  assert.ok(result.read_paths.includes(finding.path), `${finding.id} cites a path it did not read`);
  assert.deepEqual(finding.evidence, [{ path: finding.path, line: finding.line }]);
  assert.match(finding.fingerprint, /^sha256:[0-9a-f]{64}$/);
}
assert.deepEqual(
  [...result.findings].map((finding) => finding.id).sort(),
  result.findings.map((finding) => finding.id),
);
assert.deepEqual(
  analyzeMigrationSafety(input, workspace),
  result,
  'the observation is deterministic',
);

// A line shift moves the line, never the identity.
write(`${FARM}/1900000000010-UnsafeDelta.ts`, `\n\n${UNSAFE_DELTA}`);
const shifted = analyzeMigrationSafety(input, workspace).findings.filter(
  (finding) => finding.path === `${FARM}/1900000000010-UnsafeDelta.ts`,
);
assert.deepEqual(
  shifted.map((finding) => finding.id),
  findingsAt(`${FARM}/1900000000010-UnsafeDelta.ts`).map((finding) => finding.id),
);
assert.equal(shifted.find((finding) => finding.rule === 'single_step_add_not_null')?.line, 7);

// --- one vocabulary: every gate rule is projected and declared --------------
assertLintProjectionComplete();
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'sql-migration-safety-adapter.tool.json'), 'utf8'),
) as {
  readonly rules: Record<string, unknown>;
};
for (const ruleId of MIGRATION_SQL_LINT_RULE_IDS) {
  const projected = SQL_LINT_PROJECTION[ruleId];
  assert.ok(projected, `${ruleId} has no projection`);
  assert.ok(manifest.rules[projected.rule], `${projected.rule} has no manifest contract`);
}

// --- the committed fixture, against this repository's owners ----------------
const fixtureCase = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/sql-migration-safety-adapter/cases/semantic-expand-contract.json'),
    'utf8',
  ),
) as { readonly input: Parameters<typeof analyzeMigrationSafety>[0] };
const fixture = analyzeMigrationSafety(fixtureCase.input, REPO_ROOT);
assert.deepEqual(fixture.findings.map((finding) => finding.rule).sort(), [
  'breaking_ddl_without_expand_contract',
  'expand_contract_missing_depends_on',
  'rls_predicate_not_canonical',
  'unguarded_shared_enum_drop',
]);
const fixtureSummary = fixture.observations.find(
  (observation) => observation.type === 'migration_safety_summary',
)?.details;
assert.equal(
  fixtureSummary?.authorities_complete,
  true,
  'the repository holds every owner the verdicts came from',
);

process.stdout.write('sql-migration-safety-adapter.test.ts OK\n');
