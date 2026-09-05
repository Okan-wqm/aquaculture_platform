/**
 * Spec-runner resolution — shared SSoT for "what executes this spec file?".
 *
 * spec-has-a-runner.spec.ts asks it for EVERY spec on disk (nothing may exist
 * without an owner); claude-md-accuracy.spec.ts asks it for every spec a
 * steering file cites as enforcement (a claim must name something CI runs).
 * Both used to be answerable only by re-implementing the walk and the owner
 * table, and the second question was never asked at all — which is how
 * CLAUDE.md came to cite a farm-service spec in a lane no workflow invoked
 * and an e2e spec no job executed (INFRA-MEDIUM-158, SENSOR-MEDIUM-052).
 *
 * A spec can have several runners (an e2e script that globs its directory
 * AND a workflow line that names it outright), so the resolver returns every
 * candidate; existence is "at least one", and a caller judging CI reach
 * passes when ANY candidate is actually invoked.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { nxProjectRoot, nxProjectsWithTarget } from './nx';
import { REPO_ROOT, workflowRunLines } from './workflows';

export type SpecRunner =
  /** A root package.json script whose command names the spec (path or jest --testPathPatterns token). */
  | { readonly kind: 'script'; readonly script: string }
  /** A workflow run line names the spec path outright. */
  | { readonly kind: 'workflow'; readonly workflow: string; readonly line: number }
  /** An Nx project with a `test` target whose root contains the spec. */
  | { readonly kind: 'nx-test'; readonly project: string }
  /** A non-Nx runner script that globs the spec's directory (tools:test, gates:test). */
  | { readonly kind: 'declared-non-nx'; readonly script: string }
  /** A tree whose specs run in their own workflows against a live environment. */
  | { readonly kind: 'blanket'; readonly owner: string };

/**
 * Runners that are NOT Nx projects, each with the glob it owns. Adding a
 * runner here is a deliberate act; the point is that no spec may exist
 * without one.
 */
export const DECLARED_NON_NX_RUNNERS: ReadonlyArray<{
  readonly kind: 'declared-non-nx' | 'blanket';
  readonly script: string;
  readonly owns: (relPath: string) => boolean;
}> = [
  {
    // package.json `tools:test`, invoked by .github/workflows/quality-gates.yml
    kind: 'declared-non-nx',
    script: 'tools:test',
    owns: (p) => /^tools\/(supervisor|watchdog)\/[^/]+\.spec\.(ts|mjs)$/.test(p),
  },
  {
    // package.json `gates:test` (globs the directory), invoked by
    // .github/workflows/closes-footer-check.yml
    kind: 'declared-non-nx',
    script: 'gates:test',
    owns: (p) => /^tools\/gates\/[^/]+\.spec\.ts$/.test(p),
  },
  {
    // aria-kernel runs under python unittest in the aria-kernel workflows
    kind: 'blanket',
    script: 'aria-kernel workflows',
    owns: (p) => p.startsWith('aria-kernel/'),
  },
  {
    // e2e specs run in their own workflows against a live environment
    kind: 'blanket',
    script: 'e2e workflows',
    owns: (p) => p.startsWith('e2e/') || p.startsWith('tests/e2e/'),
  },
];

/**
 * Specs that have no runner TODAY, with the reason. This list may shrink and
 * may not grow — that is the whole contract. Each entry is a real gap, not an
 * exemption: the code is tested on someone's laptop and nowhere else.
 *
 * `tools/lint-gates` and `tools/worktree-audit` are ts-node CommonJS specs
 * like `tools/gates/**`, but without the npm scripts that make those
 * reachable; they need the same treatment as tools/gates rather than the
 * strip-types runner.
 */
export const KNOWN_UNRUNNABLE_SPECS: ReadonlySet<string> = new Set([
  'tools/lint-gates',
  'tools/worktree-audit',
]);

export function isKnownUnrunnable(relPath: string): boolean {
  for (const prefix of KNOWN_UNRUNNABLE_SPECS) {
    if (relPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.nx', '.claude']);

/** Every spec file in the repo, repo-relative with forward slashes. */
export function walkSpecs(dir: string = REPO_ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkSpecs(full, acc);
    } else if (/\.spec\.(ts|tsx|mts|mjs|cts)$/.test(entry)) {
      acc.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  }
  return acc;
}

interface PackageScript {
  readonly script: string;
  readonly command: string;
  /** Repo-relative directory the script runs in ('' for the root manifest). */
  readonly dir: string;
}

let scriptsCache: ReadonlyArray<PackageScript> | undefined;

/**
 * Scripts that can name a spec: the root manifest and the e2e manifest, whose
 * Jest/Playwright scripts are what the e2e workflows invoke.
 */
function packageScripts(): ReadonlyArray<PackageScript> {
  if (scriptsCache !== undefined) return scriptsCache;
  const out: PackageScript[] = [];
  for (const dir of ['', 'e2e']) {
    const manifest = join(REPO_ROOT, dir, 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
    for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
      out.push({ script, command, dir });
    }
  }
  scriptsCache = out;
  return out;
}

/** Tokens a jest invocation restricts itself to: `--testPathPatterns a b`. */
function testPathPatternTokens(command: string): string[] {
  const match = /--testPathPatterns(?:=|\s+)((?:(?!--)\S+\s*)+)/.exec(command);
  return match?.[1]?.trim().split(/\s+/) ?? [];
}

/** The regex of a `--testPathPattern='…'` (singular, quoted) flag, if any. */
function testPathPatternRegex(command: string): RegExp | undefined {
  const match = /--testPathPattern=(?:'([^']+)'|"([^"]+)")/.exec(command);
  const source = match?.[1] ?? match?.[2];
  return source === undefined ? undefined : new RegExp(source);
}

/** Positional path arguments of a jest invocation (`jest --config x tests/integration`). */
function positionalPaths(command: string): string[] {
  const tokens = command.split(/\s+/);
  const out: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const previous = tokens[index - 1] ?? '';
    if (token.startsWith('-')) continue;
    if (/^--?(config|c|testPathPatterns?|project|reporters?|maxWorkers)$/.test(previous)) continue;
    if (/^(npx|jest|playwright|test|run|npm|vitest|node)$/.test(token)) continue;
    if (token.includes('&&') || token.includes('||')) continue;
    out.push(token.replace(/^\.\//, ''));
  }
  return out;
}

/** The testDir a Playwright invocation runs: `--project` block first, then the config's top-level. */
function playwrightTestDir(dir: string, command: string): string | undefined {
  const configName = /--config[= ](\S+)/.exec(command)?.[1] ?? 'playwright.config.ts';
  const configPath = join(REPO_ROOT, dir, configName);
  let config: string;
  try {
    config = readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }
  const project = /--project[= ](\S+)/.exec(command)?.[1];
  if (project !== undefined) {
    const block = new RegExp(`\\{[^{}]*name:\\s*'${project}'[^{}]*\\}`).exec(config)?.[0];
    const projectDir = block === undefined ? undefined : /testDir:\s*'([^']+)'/.exec(block)?.[1];
    if (projectDir !== undefined) return projectDir.replace(/^\.\//, '');
  }
  return /testDir:\s*'([^']+)'/.exec(config)?.[1]?.replace(/^\.\//, '');
}

function scriptOwns(entry: PackageScript, spec: string): boolean {
  const { command, dir } = entry;
  if (dir !== '' && !spec.startsWith(`${dir}/`)) return false;
  const relSpec = dir === '' ? spec : spec.slice(dir.length + 1);
  if (command.includes(relSpec)) return true;
  if (/\bplaywright test\b/.test(command)) {
    const testDir = playwrightTestDir(dir, command);
    return testDir !== undefined && relSpec.startsWith(`${testDir}/`);
  }
  if (!/\bjest\b/.test(command)) return false;
  if (testPathPatternTokens(command).some((token) => token.length > 0 && relSpec.includes(token))) {
    return true;
  }
  const pattern = testPathPatternRegex(command);
  if (pattern !== undefined && pattern.test(relSpec)) return true;
  return positionalPaths(command).some(
    (positional) =>
      relSpec === positional || relSpec.startsWith(`${positional.replace(/\/$/, '')}/`),
  );
}

function scriptsNaming(spec: string): string[] {
  return packageScripts()
    .filter((entry) => scriptOwns(entry, spec))
    .map((entry) => entry.script);
}

let testRootsCache: ReadonlyArray<readonly [string, string]> | undefined;

/** `[project, root]` for every project with a `test` target. */
function nxTestRoots(): ReadonlyArray<readonly [string, string]> {
  if (testRootsCache !== undefined) return testRootsCache;
  testRootsCache = nxProjectsWithTarget('test').map((name) => [name, nxProjectRoot(name)] as const);
  return testRootsCache;
}

/** Every runner that executes `spec` (repo-relative path); empty when nothing does. */
export function runnersOf(spec: string): SpecRunner[] {
  const runners: SpecRunner[] = [];

  for (const script of scriptsNaming(spec)) runners.push({ kind: 'script', script });

  for (const { workflow, line, text } of workflowRunLines()) {
    if (text.includes(spec)) runners.push({ kind: 'workflow', workflow, line });
  }

  const nx = nxTestRoots().find(([, root]) => spec === root || spec.startsWith(`${root}/`));
  if (nx !== undefined) runners.push({ kind: 'nx-test', project: nx[0] });

  for (const declared of DECLARED_NON_NX_RUNNERS) {
    if (!declared.owns(spec)) continue;
    runners.push(
      declared.kind === 'blanket'
        ? { kind: 'blanket', owner: declared.script }
        : { kind: 'declared-non-nx', script: declared.script },
    );
  }

  return runners;
}
