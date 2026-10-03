/**
 * GraphQL call-site variables gate (FE-MEDIUM-315).
 *
 * WHY: GraphQL drops a variable its operation does not declare, so a call site
 * that sends `{ filter, pagination }` to an operation declaring `$status $page`
 * is a filter the server never applies, and a missing required variable is a
 * request the server rejects. `scripts/ci/validate-graphql-operations.mjs`
 * validated document text only, and skipped every document whose `${...}`
 * interpolation left an empty selection set (223 of 1039 on 405f2ecac).
 *
 * WHAT: the fixture tests run the gate inside a throwaway git repository (the
 * gate resolves its repository from its own location, so it is copied there
 * with `node_modules` linked) and pin each behaviour the gate owes: undeclared
 * keys and missing required variables fail by name, spread variables are
 * counted unresolved instead of passing, and an interpolated document is
 * validated. The repo test pins the committed baseline to what the gate
 * measures today and caps it so the ratchet can only move down.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const GATE = 'scripts/ci/validate-graphql-operations.mjs';
const BASELINE = 'scripts/ci/graphql-call-site-variables.baseline.json';

/**
 * Ratchet ceilings. They may only DECREASE, in the same commit that fixes a
 * call site and regenerates the baseline; raising one silences a regression.
 */
const MISMATCH_CEILING = 14;
const UNRESOLVED_CEILING = 53;
const UNPARSEABLE_CEILING = 0;

const SCHEMA = `
type Query {
  leaveRequests(employeeId: ID, status: String, page: Int, limit: Int): LeavePage!
  leaveRequest(id: ID!): LeaveRequest
  things: [Thing!]!
}
type LeavePage { items: [LeaveRequest!]! total: Int! }
type LeaveRequest { id: ID! status: String! }
type Thing { id: ID! name: String! }
`;

const OPERATIONS = `
import { gql } from 'graphql-request';
import { LEAVE_REQUEST_FRAGMENT } from './fragments';

export const GET_LEAVE_REQUESTS = gql\`
  query GetLeaveRequests($employeeId: ID, $status: String, $page: Int, $limit: Int) {
    leaveRequests(employeeId: $employeeId, status: $status, page: $page, limit: $limit) {
      items { ...LeaveRequestFull }
      total
    }
  }
  \${LEAVE_REQUEST_FRAGMENT}
\`;

export const GET_LEAVE_REQUEST = gql\`
  query GetLeaveRequest($id: ID!) {
    leaveRequest(id: $id) { ...LeaveRequestFull }
  }
  \${LEAVE_REQUEST_FRAGMENT}
\`;
`;

const FRAGMENTS = `
export const LEAVE_REQUEST_FRAGMENT = \`
  fragment LeaveRequestFull on LeaveRequest { id status }
\`;
`;

function hook(call: string): string {
  return `
import { graphqlRequest } from './useGraphQL';
import { GET_LEAVE_REQUESTS, GET_LEAVE_REQUEST } from '../graphql';

export function useLeaves(client: unknown, filter: unknown, pagination: unknown) {
  return ${call};
}
`;
}

interface GateRun {
  readonly status: number | null;
  readonly output: string;
}

function runGate(files: Record<string, string>, args: readonly string[] = []): GateRun {
  const root = mkdtempSync(join(tmpdir(), 'gql-call-site-'));
  try {
    mkdirSync(join(root, 'scripts', 'ci', 'lib'), { recursive: true });
    cpSync(join(REPO_ROOT, GATE), join(root, GATE));
    const lib = join(REPO_ROOT, 'scripts', 'ci', 'lib');
    for (const entry of readdirSync(lib).filter((name) => name.startsWith('graphql-'))) {
      cpSync(join(lib, entry), join(root, 'scripts', 'ci', 'lib', entry));
    }
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(join(root, 'schema.graphql'), SCHEMA);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', '-A'], { cwd: root });
    const run = spawnSync('node', [GATE, '--schema', 'schema.graphql', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
    return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
  } finally {
    removeFixtureTree(root);
  }
}

const HR = 'web/modules/hr-module/src';
const BASE_FILES = {
  [`${HR}/graphql/leave.operations.ts`]: OPERATIONS,
  [`${HR}/graphql/fragments.ts`]: FRAGMENTS,
  [`${HR}/graphql/index.ts`]: "export * from './leave.operations';\n",
  [`${HR}/hooks/useGraphQL.ts`]:
    'export async function graphqlRequest(c: unknown, d: string, v?: object) { return { c, d, v }; }\n',
};

describe('graphql call-site variables gate', () => {
  it('fails a useLeaves-shaped call site and names both undeclared keys', () => {
    const run = runGate({
      ...BASE_FILES,
      [`${HR}/hooks/useLeaves.ts`]: hook(
        'graphqlRequest(client, GET_LEAVE_REQUESTS, { filter, pagination })',
      ),
    });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/GetLeaveRequests/);
    expect(run.output).toMatch(/undeclared: filter, pagination/);
  });

  it('fails a call site that omits a required variable', () => {
    const run = runGate({
      ...BASE_FILES,
      [`${HR}/hooks/useLeaves.ts`]: hook('graphqlRequest(client, GET_LEAVE_REQUEST, {})'),
    });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/GetLeaveRequest\b/);
    expect(run.output).toMatch(/missing required: id/);
  });

  it('counts spread variables as unresolved instead of passing them', () => {
    const run = runGate({
      ...BASE_FILES,
      [`${HR}/hooks/useLeaves.ts`]: hook(
        'graphqlRequest(client, GET_LEAVE_REQUESTS, { ...(filter as object), page: 1 })',
      ),
    });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/unresolved call sites: 1 \(baseline 0\)/);
    expect(run.output).toMatch(/spread/);
  });

  it('passes a call site that sends exactly what the operation declares', () => {
    const run = runGate({
      ...BASE_FILES,
      [`${HR}/hooks/useLeaves.ts`]: hook(
        'graphqlRequest(client, GET_LEAVE_REQUESTS, { status: "PENDING", page: 1 })',
      ),
    });

    expect(run.output).toMatch(/call sites: 1 resolved, 0 unresolved, 0 mismatched/);
    expect(run.status).toBe(0);
  });

  it('validates an interpolated document instead of skipping it', () => {
    const run = runGate({
      'web/modules/farm-module/src/graphql/things.ts': [
        'const THING_FIELDS = `id name`;',
        'export const GET_THINGS = `',
        '  query GetThings {',
        '    things { ${THING_FIELDS} }',
        '    bogusRoot',
        '  }',
        '`;',
      ].join('\n'),
    });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/GetThings/);
    expect(run.output).toMatch(/Cannot query field "bogusRoot" on type "Query"/);
  });
});

describe('graphql call-site variables baseline — repository', () => {
  interface CallSiteBaseline {
    readonly unresolved: number;
    readonly mismatches: ReadonlyArray<{ readonly key: string }>;
    readonly unparseableDocuments: ReadonlyArray<{ readonly key: string }>;
  }

  it('the committed baseline is what the gate measures on this tree', () => {
    expect(existsSync(join(REPO_ROOT, BASELINE))).toBe(true);
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, BASELINE), 'utf8'),
    ) as CallSiteBaseline;

    const run = spawnSync('node', [GATE, '--call-sites-only'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });

    expect(`${run.stdout}\n${run.stderr}`).toMatch(
      new RegExp(
        `unresolved call sites: ${baseline.unresolved} \\(baseline ${baseline.unresolved}\\)`,
      ),
    );
    expect(run.status).toBe(0);
  }, 180_000);

  it('the baseline only shrinks — every list is unique and under its ceiling', () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, BASELINE), 'utf8'),
    ) as CallSiteBaseline;
    const keys = baseline.mismatches.map((m) => m.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(baseline.mismatches.length).toBeLessThanOrEqual(MISMATCH_CEILING);
    expect(baseline.unresolved).toBeLessThanOrEqual(UNRESOLVED_CEILING);
    expect(baseline.unparseableDocuments.length).toBeLessThanOrEqual(UNPARSEABLE_CEILING);
  });
});
