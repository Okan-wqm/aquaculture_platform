/**
 * The FE GraphQL operation check is one module that CI and ARIA both run
 * (DET crossfile-5, ledger Z-E3 / Z38).
 *
 * WHY. `scripts/ci/validate-graphql-operations.mjs` is the exact check: it runs
 * `graphql.validate(schema, parse(op))` over every FE operation against the
 * composed supergraph and holds a zero-new-drift ratchet. It was a CI-only
 * script with a top-level `main`: nothing could import `collectDrift`, it
 * printed text only, and ARIA's seeder never ran it, so a hook that selects a
 * field the supergraph does not serve (`shelfLifeDays` where the type has
 * `shelfLifeMonths`) was seen by CI alone. A second static validator inside
 * ARIA would duplicate graphql-js (arguments, variables, fragments, unions)
 * with a hand-built contract table, so the owner is made reusable instead:
 *
 *   1. `collectDrift` lives in `scripts/ci/lib/graphql-operations.mjs`, an
 *      importable module (NEW API: the first group imports it and is red at the
 *      base because the module does not exist);
 *   2. `--json` prints the drift as machine output and changes nothing else.
 *      Exit codes, the baseline and the ratchet are the script's, byte for byte:
 *      the `--json` list is the drift the gate holds against the tree, the NEW
 *      drift, so a baselined key stays quiet for every reader of it.
 *
 * Every probe runs the REAL owner, copied into a fixture repository with its
 * own tracked sources, baseline and schema, so a drift is the owner's verdict
 * and not a re-implementation's. The text-mode group is a guard: it is green at
 * the base by construction and pins what "byte for byte" means.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from '@jest/globals';

import { indexFixtureTree } from '../../tools/gates/fixture-git-index';
import { makeFixtureTree, removeFixtureTree } from '../../tools/gates/fixture-tree';
import { hermeticGitEnv } from '../../tools/gates/hermetic-git';

const REPO_ROOT = resolve(__dirname, '..', '..');
const OWNER = 'scripts/ci/validate-graphql-operations.mjs';
const OWNER_LIB = 'scripts/ci/lib';
const CORE_MODULE = 'scripts/ci/lib/graphql-operations.mjs';
const BASELINE = 'scripts/ci/graphql-fe-drift.baseline.json';
const SCHEMA = 'schema/supergraph.graphql';
const HOOK = 'web/modules/farm-module/src/hooks/useChemicals.ts';
const CHILD_TIMEOUT_MS = 60_000;

/** The type serves `shelfLifeMonths`; the Z38 hook asks for `shelfLifeDays`. */
const SUPERGRAPH_SDL = [
  'type Query {',
  '  chemical(id: ID!): ChemicalResponse',
  '}',
  '',
  'type ChemicalResponse {',
  '  id: ID!',
  '  name: String!',
  '  shelfLifeMonths: Int',
  '}',
  '',
].join('\n');

/** `${...}` spelled without a template-curly string literal in this file. */
const INTERPOLATION = '$' + '{FRAGMENT_NAME}';

interface DriftEntry {
  readonly key: string;
  readonly file: string;
  readonly op: string;
  readonly category: string;
  readonly messages: readonly string[];
}

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const trees: string[] = [];
afterAll(() => {
  for (const tree of trees) removeFixtureTree(tree);
});

/** One FE document: a named query selecting `field` of the chemical. */
function document(name: string, field: string): string {
  return [
    'export const DOCUMENT = `',
    `  query ${name}($id: ID!) {`,
    '    chemical(id: $id) {',
    '      id',
    `      ${field}`,
    '    }',
    '  }',
    '`;',
    '',
  ].join('\n');
}

function baselineJson(entries: readonly { key: string; file: string; op: string }[]): string {
  const operations = entries.map((entry) => ({ ...entry, category: 'MISSING-FIELD' }));
  return `${JSON.stringify({ count: operations.length, operations })}\n`;
}

interface FixtureOptions {
  readonly files: Readonly<Record<string, string>>;
  readonly baseline?: readonly { key: string; file: string; op: string }[];
}

/**
 * A repository holding the owner as this checkout ships it: the script and its
 * lib directory copied, the checkout's `node_modules` linked (graphql), the
 * given FE sources tracked, a baseline and a schema file.
 */
function fixture({ files, baseline = [] }: FixtureOptions): string {
  const root = makeFixtureTree('graphql-operations-owner-');
  trees.push(root);
  mkdirSync(join(root, dirname(OWNER)), { recursive: true });
  cpSync(join(REPO_ROOT, OWNER), join(root, OWNER));
  cpSync(join(REPO_ROOT, OWNER_LIB), join(root, OWNER_LIB), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, '.gitignore'), 'node_modules\n', 'utf8');
  const sources: Record<string, string> = {
    [BASELINE]: baselineJson(baseline),
    [SCHEMA]: SUPERGRAPH_SDL,
    ...files,
  };
  for (const [path, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return indexFixtureTree(root);
}

function node(root: string, args: readonly string[]): Outcome {
  const run = spawnSync(process.execPath, [...args], {
    cwd: root,
    encoding: 'utf8',
    env: hermeticGitEnv(),
    timeout: CHILD_TIMEOUT_MS,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function owner(root: string, ...flags: string[]): Outcome {
  return node(root, [OWNER, '--schema', SCHEMA, ...flags]);
}

/** The `--json` stdout as the drift list; fails on anything but one JSON array. */
function driftFrom(outcome: Outcome): DriftEntry[] {
  expect(() => JSON.parse(outcome.stdout)).not.toThrow();
  const parsed: unknown = JSON.parse(outcome.stdout);
  expect(Array.isArray(parsed)).toBe(true);
  return parsed as DriftEntry[];
}

const FAILING = { [HOOK]: document('Chemical', 'shelfLifeDays') };
const FAILING_ENTRY = {
  key: `${HOOK}::Chemical`,
  file: HOOK,
  op: 'Chemical',
  category: 'MISSING-FIELD',
  messages: [expect.stringContaining('Cannot query field "shelfLifeDays"')],
};

describe('the owner as a module (new API: scripts/ci/lib/graphql-operations.mjs)', () => {
  it('exports collectDrift, which returns the drift of the tracked tree for a schema', () => {
    const root = fixture({ files: FAILING });
    const program = [
      "import { buildSchema } from 'graphql';",
      "import { readFileSync } from 'node:fs';",
      `const { collectDrift } = await import('./${CORE_MODULE}');`,
      `const schema = buildSchema(readFileSync('${SCHEMA}', 'utf8'), { assumeValidSDL: true });`,
      'process.stdout.write(JSON.stringify(await collectDrift(schema)));',
    ].join('\n');
    const outcome = node(root, ['--input-type=module', '-e', program]);
    expect(outcome.stderr).toBe('');
    expect(JSON.parse(outcome.stdout)).toEqual([FAILING_ENTRY]);
  });

  it('leaves the script a caller of the module, not a second definition of the check', () => {
    // Booleans, not toMatch: a failing toMatch prints the whole script.
    const script = readFileSync(join(REPO_ROOT, OWNER), 'utf8');
    expect(/function\s+collectDrift\b/u.test(script)).toBe(false);
    expect(/from\s+['"]\.\/lib\/graphql-operations\.mjs['"]/u.test(script)).toBe(true);
    const core = readFileSync(join(REPO_ROOT, CORE_MODULE), 'utf8');
    expect(/export\s+(?:async\s+)?function\s+collectDrift\b/u.test(core)).toBe(true);
  });
});

describe('--json: the owner as machine output', () => {
  it("prints the owner's own failing document as {key,file,op,category,messages} and keeps exit 1", () => {
    const outcome = owner(fixture({ files: FAILING }), '--json');
    expect(driftFrom(outcome)).toEqual([FAILING_ENTRY]);
    expect(outcome.status).toBe(1);
  });

  it('reports only the failing document, none of the near-misses beside it', () => {
    const interpolated = [
      'export const DOCUMENT = `',
      '  query Interpolated($id: ID!) {',
      '    chemical(id: $id) {',
      '      id',
      '      shelfLifeDays',
      `      ...${INTERPOLATION}`,
      '    }',
      '  }',
      '`;',
      '',
    ].join('\n');
    const siblingFragments = [
      'export const DOCUMENT = `',
      '  query WithSiblingFragment { chemical(id: "1") { ...ChemicalFields } }',
      '`;',
      'export const UNUSED = `',
      '  query Plain { chemical(id: "1") { id } }',
      '  fragment UnusedFields on ChemicalResponse { id }',
      '`;',
      '',
    ].join('\n');
    const root = fixture({
      files: {
        ...FAILING,
        // The same operation with the field the type serves.
        'web/modules/farm-module/src/hooks/useChemicalsFixed.ts': document(
          'ChemicalFixed',
          'shelfLifeMonths',
        ),
        // The interpolation cannot parse once removed, so the owner skips the document.
        'web/modules/farm-module/src/hooks/useInterpolated.ts': interpolated,
        // "Unknown fragment" and "never used" are fragment wiring, not schema drift.
        'web/modules/farm-module/src/hooks/useSiblingFragments.ts': siblingFragments,
        // Specs, tests, generated code and build output are not shipped operations.
        'web/modules/farm-module/src/hooks/useChemicals.spec.ts': document(
          'SpecDrift',
          'shelfLifeDays',
        ),
        'web/modules/farm-module/src/hooks/useChemicals.test.tsx': document(
          'TestDrift',
          'shelfLifeDays',
        ),
        'web/modules/farm-module/src/generated/chemicals.ts': document(
          'GeneratedDrift',
          'shelfLifeDays',
        ),
        'web/modules/farm-module/dist/chemicals.ts': document('DistDrift', 'shelfLifeDays'),
        // Not a frontend source root.
        'apps/farm-service/src/chemicals.ts': document('BackendDrift', 'shelfLifeDays'),
      },
    });
    const drift = driftFrom(owner(root, '--json'));
    expect(drift.map((entry) => entry.file)).toEqual([HOOK]);
  });

  it('keeps a baselined drift quiet: nothing listed, exit 0', () => {
    const root = fixture({
      files: FAILING,
      baseline: [{ key: `${HOOK}::Chemical`, file: HOOK, op: 'Chemical' }],
    });
    const outcome = owner(root, '--json');
    expect(driftFrom(outcome)).toEqual([]);
    expect(outcome.status).toBe(0);
  });

  it('lists a new drift beside a baselined one and keeps exit 1', () => {
    const other = 'web/modules/farm-module/src/hooks/useBatches.ts';
    const root = fixture({
      files: { ...FAILING, [other]: document('Batch', 'shelfLifeDays') },
      baseline: [{ key: `${HOOK}::Chemical`, file: HOOK, op: 'Chemical' }],
    });
    const outcome = owner(root, '--json');
    expect(driftFrom(outcome).map((entry) => entry.key)).toEqual([`${other}::Batch`]);
    expect(outcome.status).toBe(1);
  });

  it('keeps exit 1 for a baselined drift that now passes, and lists nothing', () => {
    const root = fixture({
      files: { [HOOK]: document('Chemical', 'shelfLifeMonths') },
      baseline: [{ key: `${HOOK}::Chemical`, file: HOOK, op: 'Chemical' }],
    });
    const outcome = owner(root, '--json');
    expect(driftFrom(outcome)).toEqual([]);
    expect(outcome.status).toBe(1);
  });

  it('keeps exit 0 and an empty list for a tree without drift', () => {
    const outcome = owner(
      fixture({ files: { [HOOK]: document('Chemical', 'shelfLifeMonths') } }),
      '--json',
    );
    expect(driftFrom(outcome)).toEqual([]);
    expect(outcome.status).toBe(0);
  });
});

describe('unchanged behaviour (guards: green at the base by construction)', () => {
  const HEADER = '[graphql-validate] schema=schema/supergraph.graphql';
  const PASS_LINE = (tracked: number): string =>
    `\n✅ GraphQL FE↔supergraph contract gate PASS — no new drift; ${tracked} tracked drifts pending burn-down.\n`;

  it('passes a tree without drift', () => {
    const outcome = owner(fixture({ files: { [HOOK]: document('Chemical', 'shelfLifeMonths') } }));
    expect(outcome).toEqual({
      status: 0,
      stdout: `${HEADER} | current drift=0 | baseline=0\n${PASS_LINE(0)}`,
      stderr: '',
    });
  });

  it('fails a new drift with the operation, its category, its file and the first messages', () => {
    const outcome = owner(fixture({ files: FAILING }));
    expect(outcome).toEqual({
      status: 1,
      stdout: `${HEADER} | current drift=1 | baseline=0\n`,
      stderr:
        '\n❌ 1 NEW GraphQL contract drift(s) — these reference fields/ops the supergraph does not serve:\n\n' +
        `  • Chemical (MISSING-FIELD)  [${HOOK}]\n` +
        '      → Cannot query field "shelfLifeDays" on type "ChemicalResponse". Did you mean "shelfLifeMonths"?\n' +
        '\nFix the operation (author it as a typed gql document in src/graphql/) or the resolver. ' +
        'The gate is a hard wall at zero new drift.\n',
    });
  });

  it('passes a baselined drift and counts it as pending burn-down', () => {
    const outcome = owner(
      fixture({
        files: FAILING,
        baseline: [{ key: `${HOOK}::Chemical`, file: HOOK, op: 'Chemical' }],
      }),
    );
    expect(outcome).toEqual({
      status: 0,
      stdout: `${HEADER} | current drift=1 | baseline=1\n${PASS_LINE(1)}`,
      stderr: '',
    });
  });

  it('fails a baselined drift that now passes until the baseline is regenerated', () => {
    const outcome = owner(
      fixture({
        files: { [HOOK]: document('Chemical', 'shelfLifeMonths') },
        baseline: [{ key: `${HOOK}::Chemical`, file: HOOK, op: 'Chemical' }],
      }),
    );
    expect(outcome).toEqual({
      status: 1,
      stdout: `${HEADER} | current drift=0 | baseline=1\n`,
      stderr:
        '\n❌ 1 baselined drift(s) now PASS — burn them down by regenerating the baseline:\n\n' +
        `  • ${HOOK}::Chemical\n` +
        '\nRun: node scripts/ci/validate-graphql-operations.mjs --update-baseline  ' +
        '(then commit the shrunk baseline)\n',
    });
  });

  it('keeps exit 2 with --json when the schema file is absent: no drift list that reads as clean', () => {
    const outcome = node(fixture({ files: FAILING }), [
      OWNER,
      '--schema',
      'schema/missing.graphql',
      '--json',
    ]);
    expect(outcome.status).toBe(2);
    expect(outcome.stdout).toBe('');
  });

  it('fails loud with exit 2 when the schema file is absent', () => {
    const outcome = node(fixture({ files: FAILING }), [
      OWNER,
      '--schema',
      'schema/missing.graphql',
    ]);
    expect(outcome.status).toBe(2);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toContain(
      'FATAL: supergraph schema not found at schema/missing.graphql',
    );
  });

  it('regenerates the baseline from the current drift', () => {
    const root = fixture({ files: FAILING });
    const outcome = owner(root, '--update-baseline');
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe(
      '[graphql-validate] baseline written: 1 known drifts → scripts/ci/graphql-fe-drift.baseline.json\n',
    );
    // The owner writes the baseline as two-space JSON with a final newline.
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(
      [
        '{',
        '  "$schema": "GraphQL FE↔supergraph drift baseline — burn-down ratchet, MUST only shrink",',
        `  "generatedAgainst": "${SCHEMA}",`,
        '  "report": "docs/reviews/2026-06-24-graphql-fe-be-contract-drift-audit.md",',
        '  "count": 1,',
        '  "operations": [',
        '    {',
        `      "key": "${HOOK}::Chemical",`,
        `      "file": "${HOOK}",`,
        '      "op": "Chemical",',
        '      "category": "MISSING-FIELD"',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });
});
