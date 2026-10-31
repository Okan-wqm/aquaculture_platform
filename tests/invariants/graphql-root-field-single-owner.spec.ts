/**
 * Every GraphQL root field has one resolver method, in every subgraph.
 *
 * NestJS code-first lets two resolver methods claim the same Query / Mutation /
 * Subscription name. The schema keeps one declaration's type and arguments,
 * while the runtime resolver map can call the other, so one name answers with
 * two shapes, and load order decides which. It happened twice:
 *   - farm `availableTanks` (2026-06-24): the schema lost `siteId`, and the
 *     browser saw intermittent "Unknown argument" 400s;
 *   - sensor `sensor(id)` (2026-10-31): the schema served the raw `Sensor`
 *     entity while the device page asked for the registration read model's
 *     `activatedByData`.
 *
 * The check lives in tools/scripts/emit-subgraph-sdl.ts, which builds each
 * subgraph's schema from the same decorator metadata the service runs on, so
 * it sees exactly what is served. It fails the emit, and with it the
 * supergraph `compose` job, for every subgraph a PR's resolvers can change.
 * This spec proves the check itself against two fixture subgraphs: one where
 * each field has one owner, one where `thing` has two.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd());
const FIXTURES = 'tests/invariants/fixtures/graphql-root-field-owner';
const EMITTER = join(REPO_ROOT, 'tools/scripts/emit-subgraph-sdl.ts');
const TS_NODE = join(REPO_ROOT, 'node_modules/.bin/ts-node');

interface Emit {
  status: number | null;
  stderr: string;
  sdlPath: string;
}

function emit(fixture: 'one-owner' | 'two-owners'): Emit {
  const subgraph = `invariant-fixture-${fixture}`;
  const result = spawnSync(
    TS_NODE,
    [
      '--transpile-only',
      '-r',
      'tsconfig-paths/register',
      EMITTER,
      subgraph,
      `${FIXTURES}/${fixture}`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: join(REPO_ROOT, FIXTURES, 'tsconfig.json') },
    },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    sdlPath: join(REPO_ROOT, 'dist/graphql/subgraphs', `${subgraph}.graphql`),
  };
}

describe('GraphQL root field single owner (emit-subgraph-sdl)', () => {
  const emitted: string[] = [];

  afterAll(() => {
    for (const path of emitted) rmSync(path, { force: true });
  });

  it('emits a subgraph whose root fields each have one resolver method', () => {
    const run = emit('one-owner');
    emitted.push(run.sdlPath);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const sdl = readFileSync(run.sdlPath, 'utf8');
    expect(sdl).toMatch(/^\s+thing: FixtureThing$/m);
    expect(sdl).toMatch(/^\s+things: \[FixtureThing!\]!$/m);
  });

  it('refuses a subgraph where two resolver methods claim one root field, naming both', () => {
    const run = emit('two-owners');
    emitted.push(run.sdlPath);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Query.thing: OtherResolver.findThing, ThingResolver.thing');
  });
});
