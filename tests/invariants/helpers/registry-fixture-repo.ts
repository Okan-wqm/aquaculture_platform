/**
 * A throwaway repository that runs the finding-registry CLIs on its own
 * history (MF-1, PROC-HIGH-039).
 *
 * WHY. Closure is derived from merged `Closes:` trailers, so every claim about
 * it is a claim about a git history: which commit carries the trailer, which
 * first-parent commit of the ref merged it, which branch never merged. The
 * only honest test of that is a real repository with that history, read by
 * the real CLI exactly as CI and the kernel read this repository.
 *
 * WHAT. The fixture carries a copy of `tools/gates/` (the CLIs and everything
 * they import), the registry schema, the path corrections and CODEOWNERS, and
 * links this checkout's `node_modules` so `node_modules/.bin/ts-node` resolves
 * the same way it does here. The registry, the alias sidecar and the
 * debt-plan truth table are written by the test. Commits carry explicit
 * author and committer dates so a merge-into-ref date is distinguishable from
 * the date of the commit it merged. No hook and no merge driver is installed:
 * merges happen the way GitHub performs them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { TRUTH_TABLE_PATH } from '../../../tools/gates/debt-plan-truth';
import {
  type Finding,
  rechain,
  serializeRegistryJsonl,
} from '../../../tools/gates/finding-registry-chain';
import { removeFixtureTree } from '../../../tools/gates/fixture-tree';
import { hermeticGitEnv } from '../../../tools/gates/hermetic-git';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const REGISTRY_RELATIVE_PATH = 'docs/reviews/_registry/findings.jsonl';
export const ALIASES_RELATIVE_PATH = 'docs/reviews/_registry/finding-id-aliases.yaml';
export const FIXTURE_REVIEW_FILE = 'docs/reviews/claude/2026-10-23-mf-1-fixture.md';
export const FIXTURE_ALIAS_REVIEW_FILE = 'docs/reviews/claude/2026-10-23-mf-1-alias-fixture.md';
export { TRUTH_TABLE_PATH };

const REGISTRY_CLI = 'tools/gates/finding-registry.ts';
const DEBT_PLAN_CLI = 'tools/gates/debt-plan-truth.ts';
const GATES_TSCONFIG = 'tools/gates/tsconfig.json';
const CLI_TIMEOUT_MS = 120_000;

const REGISTRY_DIR = 'docs/reviews/_registry';

/**
 * Files the CLIs read from the repository they run in, besides the registry:
 * every schema of the registry directory (the row contract, and the event
 * contract once the store has one), the path corrections and CODEOWNERS.
 */
function copiedFiles(): string[] {
  const schemas = readdirSync(join(REPO_ROOT, REGISTRY_DIR))
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
    .map((name) => `${REGISTRY_DIR}/${name}`);
  return [...schemas, `${REGISTRY_DIR}/path-corrections.yaml`, '.github/CODEOWNERS'];
}

const FIXTURE_GIT_ENV: NodeJS.ProcessEnv = {
  ...hermeticGitEnv(),
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '5',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'user.name',
  GIT_CONFIG_VALUE_2: 'Registry Projection Fixture',
  GIT_CONFIG_KEY_3: 'user.email',
  GIT_CONFIG_VALUE_3: 'fixture@example.invalid',
  GIT_CONFIG_KEY_4: 'commit.gpgsign',
  GIT_CONFIG_VALUE_4: 'false',
};

export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Wall time of the whole process, ts-node start-up included. */
  readonly ms: number;
}

export interface ProjectionRun extends CliRun {
  /** The JSONL rows on stdout; empty when the run failed. */
  readonly rows: readonly Finding[];
}

/** A registry row with every field the schema requires, OPEN unless overridden. */
export function fixtureFinding(id: string, overrides: Partial<Finding> = {}): Finding {
  const severity = id.split('-')[1] as Finding['severity'];
  return {
    id,
    severity,
    state: 'OPEN',
    title: `fixture finding ${id}`,
    layer: 1,
    evidence: ['tools/gates/finding-registry.ts:1'],
    owner_agent: 'claude',
    raised_in_cycle: '2026-10-23-mf-1-fixture',
    review_file: FIXTURE_REVIEW_FILE,
    created_at: '2026-10-01T00:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: '2026-12-31',
    owner_user: 'Okan-wqm',
    override_of: null,
    prev_hash: '',
    content_hash: '',
    ...overrides,
  };
}

/** The `Closes:` trailer a fix commit carries for a finding of the fixture review file. */
export function closesTrailer(findingId: string, reviewFile = FIXTURE_REVIEW_FILE): string {
  return `Closes: ${reviewFile}#${findingId}`;
}

function excludedFromCopy(source: string): boolean {
  const parts = source.split(sep);
  return (
    parts.includes('fixtures') || parts.includes('node_modules') || source.endsWith('.spec.ts')
  );
}

/** Parse JSONL strictly: a line that is not a JSON object fails the caller's assertion. */
export function parseJsonlRows(stdout: string): Finding[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Finding);
}

/** Run the registry CLI of the repository at `repoRoot`, from that repository. */
export function runRegistryCli(repoRoot: string, args: readonly string[]): CliRun {
  return runTsNode(repoRoot, REGISTRY_CLI, args);
}

/** `finding-registry project --format=jsonl` at `repoRoot`, rows parsed when it succeeds. */
export function runProjection(repoRoot: string, args: readonly string[] = []): ProjectionRun {
  const run = runRegistryCli(repoRoot, ['project', '--format=jsonl', ...args]);
  return { ...run, rows: run.status === 0 ? parseJsonlRows(run.stdout) : [] };
}

function runTsNode(repoRoot: string, script: string, args: readonly string[]): CliRun {
  const started = Date.now();
  const result = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'ts-node'),
    ['--project', GATES_TSCONFIG, script, ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: hermeticGitEnv(),
      maxBuffer: 256 * 1024 * 1024,
      timeout: CLI_TIMEOUT_MS,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`,
    ms: Date.now() - started,
  };
}

export class RegistryFixtureRepo {
  private constructor(readonly root: string) {}

  /** A fresh repository on `main` holding the CLIs and the support files, nothing committed. */
  static create(prefix: string): RegistryFixtureRepo {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const fixture = new RegistryFixtureRepo(root);
    cpSync(join(REPO_ROOT, 'tools', 'gates'), join(root, 'tools', 'gates'), {
      recursive: true,
      filter: (source) => !excludedFromCopy(source),
    });
    for (const rel of copiedFiles()) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(join(REPO_ROOT, rel), join(root, rel));
    }
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    fixture.write('.gitignore', 'node_modules\n');
    fixture.write(FIXTURE_REVIEW_FILE, '# MF-1 fixture review\n');
    fixture.write(FIXTURE_ALIAS_REVIEW_FILE, '# MF-1 alias fixture review\n');
    fixture.writeAliases([]);
    fixture.git(['init', '-q', '-b', 'main']);
    return fixture;
  }

  dispose(): void {
    removeFixtureTree(this.root);
  }

  /**
   * A `--depth 1` clone of the checked-out branch, with its own node_modules
   * link: the history a CI checkout without `fetch-depth: 0` holds.
   */
  shallowClone(prefix: string): RegistryFixtureRepo {
    const root = mkdtempSync(join(tmpdir(), prefix));
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${this.root}`, root], {
      encoding: 'utf8',
      env: FIXTURE_GIT_ENV,
    });
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    return new RegistryFixtureRepo(root);
  }

  git(args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
    return execFileSync('git', ['-C', this.root, ...args], {
      encoding: 'utf8',
      env: { ...FIXTURE_GIT_ENV, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  write(rel: string, text: string): void {
    mkdirSync(dirname(join(this.root, rel)), { recursive: true });
    writeFileSync(join(this.root, rel), text, 'utf8');
  }

  read(rel: string): string {
    return readFileSync(join(this.root, rel), 'utf8');
  }

  /** Chain the rows from genesis and write them as the registry. */
  writeRegistry(rows: readonly Finding[]): void {
    const entries = rows.map((row) => ({ ...row }));
    rechain(entries, 0);
    this.write(REGISTRY_RELATIVE_PATH, serializeRegistryJsonl(entries));
  }

  writeAliases(
    aliases: readonly {
      alias: string;
      canonical: string;
      review_file: string;
      commits: readonly string[];
    }[],
  ): void {
    const body = aliases
      .map((entry) =>
        [
          `  - alias: ${entry.alias}`,
          `    canonical: ${entry.canonical}`,
          `    review_file: ${entry.review_file}`,
          `    commits:`,
          ...entry.commits.map((sha) => `      - '${sha}'`),
          `    effective_date: '2026-10-23'`,
          `    reason: MF-1 fixture alias.`,
        ].join('\n'),
      )
      .join('\n');
    this.write(
      ALIASES_RELATIVE_PATH,
      aliases.length === 0 ? 'version: 1\n\naliases: []\n' : `version: 1\n\naliases:\n${body}\n`,
    );
  }

  /** The debt-plan truth table with one active row per id (bucket real-open). */
  writeTruthTable(activeIds: readonly string[]): void {
    this.write(
      TRUTH_TABLE_PATH,
      [
        '# Finding truth table (MF-1 fixture)',
        '',
        '## Active CRITICAL findings',
        '',
        '| Finding | Owner | Sprint | Status | Bucket |',
        '| --- | --- | --- | --- | --- |',
        ...activeIds.map((id) => `| \`${id}\` | claude | S1 | open | real-open |`),
        '',
        '## Resolved Evidence',
        '',
        '- No resolved row in this fixture.',
        '',
      ].join('\n'),
    );
  }

  /** Stage everything and commit with the given author and committer date; returns the full sha. */
  commit(message: string, isoDate: string): string {
    this.git(['add', '-A']);
    this.git(['commit', '-q', '--allow-empty', '-m', message], {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    });
    return this.head();
  }

  /** `git merge --no-ff` of `branch` into the checked-out branch, dated; returns the merge sha. */
  merge(branch: string, isoDate: string): string {
    this.git(['merge', '--no-ff', '--no-edit', branch], {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    });
    return this.head();
  }

  head(): string {
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  committerDate(sha: string): string {
    return this.git(['show', '-s', '--format=%cI', sha]).trim();
  }

  status(): string {
    return this.git(['status', '--porcelain']).trim();
  }

  registry(args: readonly string[]): CliRun {
    return runRegistryCli(this.root, args);
  }

  project(args: readonly string[] = []): ProjectionRun {
    return runProjection(this.root, args);
  }

  debtPlanTruth(args: readonly string[] = []): CliRun {
    return runTsNode(this.root, DEBT_PLAN_CLI, args);
  }

  /** Any CLI of the fixture's tools/gates copy, run from the fixture (e.g. the branch converter). */
  gate(script: string, args: readonly string[] = []): CliRun {
    return runTsNode(this.root, script, args);
  }
}
