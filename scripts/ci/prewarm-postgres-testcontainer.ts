#!/usr/bin/env node
/**
 * Dependency-aware PostgreSQL testcontainer image prewarm (INFRA-HIGH-011).
 *
 * WHY this exists:
 * - `libs/migration-harness/src/setup.ts` owns the production-equivalent
 *   PostgreSQL image pin, and `bootPostgresContainer()` is consumed by
 *   every Testcontainers-backed integration suite (migration-harness
 *   itself, db-migrate's platform-bootstrap/rollback/provisioner specs,
 *   and any future consumer).
 * - The previous prewarm lived INSIDE the migration-harness CI step and
 *   only fired when migration-harness itself was affected. Any PR that
 *   affected a consumer (e.g. a root package.json change making
 *   db-migrate affected) but not the harness paid the multi-GB image
 *   download inside Jest's 120s beforeAll budget on a cold runner —
 *   structurally under-provisioned, red-or-lucky.
 * - Ownership fix: the prewarm follows the IMAGE DEPENDENCY, not one
 *   consumer project. This script asks the Nx project graph which
 *   affected test projects transitively depend on migration-harness and
 *   pulls the canonical image (read from the harness-owned SSOT via
 *   print-migration-harness-postgres-image.mjs — no digest duplication)
 *   before any Jest process starts.
 *
 * Fail-closed: if a needed pull cannot complete after retries, exit 1 —
 * letting Jest run would convert the explicit failure into a misleading
 * hook-timeout red.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface NxGraphDependency {
  readonly source: string;
  readonly target: string;
  readonly type: string;
}

interface NxGraphFile {
  readonly graph: {
    readonly dependencies: Record<string, readonly NxGraphDependency[]>;
  };
}

const IMAGE_OWNER_PROJECT = 'migration-harness';
const CONTAINER_BOOTING_TARGETS = ['test', 'test:integration'] as const;

function parseBaseArg(argv: readonly string[]): string {
  const idx = argv.indexOf('--base');
  const base = idx >= 0 ? argv[idx + 1] : undefined;
  if (base === undefined || base.length === 0) {
    process.stderr.write(
      'usage: prewarm-postgres-testcontainer.ts --base <git-ref>\n',
    );
    process.exit(2);
  }
  return base;
}

function run(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, [...args], { encoding: 'utf8' });
}

function affectedTestProjects(base: string): Set<string> {
  const projects = new Set<string>();
  for (const target of CONTAINER_BOOTING_TARGETS) {
    // Nx's JSON graph is the authority; target names are intentionally not
    // inferred from filesystem conventions or duplicated project catalogs.
    const out = run('npx', [
      'nx',
      'show',
      'projects',
      '--affected',
      '--base',
      base,
      `--with-target=${target}`,
      '--json',
    ]);
    for (const project of JSON.parse(out) as string[]) projects.add(project);
  }
  return projects;
}

/** Reverse transitive closure: every project that depends on `root`. */
function dependentsOf(root: string, graphPath: string): Set<string> {
  const parsed = JSON.parse(readFileSync(graphPath, 'utf8')) as NxGraphFile;
  const reverse = new Map<string, Set<string>>();
  for (const [source, deps] of Object.entries(parsed.graph.dependencies)) {
    for (const dep of deps) {
      const entry = reverse.get(dep.target) ?? new Set<string>();
      entry.add(source);
      reverse.set(dep.target, entry);
    }
  }
  const seen = new Set<string>([root]);
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const dependent of reverse.get(current) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return seen;
}

function pullWithRetry(image: string): void {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execFileSync('docker', ['pull', image], { stdio: 'inherit' });
      return;
    } catch {
      if (attempt === maxAttempts) {
        process.stderr.write(
          `PostgreSQL testcontainer image pull failed after ${maxAttempts} attempts: ${image}\n`,
        );
        process.exit(1);
      }
      const delaySeconds = attempt * 10;
      process.stderr.write(
        `Image pull attempt ${attempt} failed; retrying in ${delaySeconds}s.\n`,
      );
      execFileSync('sleep', [String(delaySeconds)]);
    }
  }
}

function main(): void {
  const base = parseBaseArg(process.argv.slice(2));

  const affected = affectedTestProjects(base);
  if (affected.size === 0) {
    process.stdout.write('No affected test projects; prewarm not needed.\n');
    return;
  }

  const graphPath = join(tmpdir(), `nx-graph-prewarm-${process.pid}.json`);
  run('npx', ['nx', 'graph', `--file=${graphPath}`]);
  const consumers = dependentsOf(IMAGE_OWNER_PROJECT, graphPath);

  const needy = [...affected].filter((project) => consumers.has(project));
  if (needy.length === 0) {
    process.stdout.write(
      `No affected test project depends on ${IMAGE_OWNER_PROJECT}; prewarm not needed.\n`,
    );
    return;
  }

  const image = run('node', [
    'scripts/ci/print-migration-harness-postgres-image.mjs',
  ]).trim();
  process.stdout.write(
    `Prewarming ${image} for affected consumers: ${needy.join(', ')}\n`,
  );
  pullWithRetry(image);
}

main();
