/**
 * The format scope is derived where it is read; only its two real properties are gated.
 *
 * WHY THIS EXISTS (PROC-MEDIUM-040). `tools/quality/format-scope.json` used to
 * be committed: one entry per tracked formattable file, every entry a pure
 * function of `git ls-files --cached` and `classifyFormatFile`, and
 * `format-scope check` refused any commit whose copy differed from a fresh
 * build. So every PR that added or removed a tracked file had to regenerate it
 * — 41 of the 89 first-parent merges on main from 2026-09-18 to b28a5216a
 * changed it — concurrent PRs conflicted on it whatever files they touched,
 * and automation PRs that add one file (the ARIA daily report, the rule-health
 * report) went red as "stale" because nothing in them regenerates a manifest.
 * Its 209 `content_sha256` pins duplicated what git already shows in a diff
 * and never enforced what they stood for: an archived file could be edited and
 * re-pinned by regenerating, and a new archive file stayed unpinned.
 *
 * WHAT THIS PINS.
 *   1. The manifest is not committed and cannot be generated: no tracked file,
 *      no npm script, and `format-scope generate` is refused.
 *   2. Classification is total. On the real tracked tree every formattable
 *      file gets a declared class, and when a path falls through the
 *      classifier — or comes out with a class outside the declared vocabulary,
 *      which would silently exempt it from the archive rule — `format-scope
 *      check` and every format lane fail naming it.
 *   3. Archives only grow. Over the change range an archive_immutable file may
 *      be Added; Modified, Deleted or Renamed fails naming path and status.
 *      Moving a live file INTO an archive (how archiving happens) passes.
 *   4. Adding a file under `aria-tools/reports/daily/` or `docs/` needs no
 *      other committed change, runtime evidence stays editable, and the live
 *      sensor-service `src/archive/` module is ordinary source, not an archive.
 *
 * Fixture repositories supply the A/M/D/R statuses; the real tree is only read.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { removeFixtureTree } from './fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const QUALITY_DIR = join(REPO_ROOT, 'tools', 'quality');
const RUNNER = join(QUALITY_DIR, 'quality.mjs');
/** Sibling ESM modules quality.mjs imports; a fixture copy needs them beside it. */
const RUNNER_MODULES = ['format-merge-base.mjs'];
const MANIFEST_PATH = 'tools/quality/format-scope.json';

/** The classifier's last statement; the totality probe replaces it. */
const CLASSIFIER_CATCH_ALL = "return managed(path, 'canonical_source', 'source');";

const ARCHIVED = 'apps/svc/src/migrations/.archive/2026-01-01/1700000000000-Old.ts';
const LIVE_MIGRATION = 'apps/svc/src/migrations/1800000000000-Live.ts';
const LIVE_ARCHIVE_MODULE = 'apps/sensor-service/src/archive/telemetry-archive.service.ts';
const RUNTIME_EVIDENCE = 'aria-tools/reports/daily/2026-09-30.md';

const BASE_FILES: Readonly<Record<string, string>> = {
  [ARCHIVED]: 'export const archived = 1;\n',
  [LIVE_MIGRATION]: 'export const live = 1;\n',
  [LIVE_ARCHIVE_MODULE]: 'export const archiveModule = 1;\n',
  [RUNTIME_EVIDENCE]: '# 2026-09-30\n',
  'docs/guide.md': '# Guide\n',
  'src/index.ts': 'export const value = 1;\n',
};

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every GIT_* variable dropped: under the pre-commit hook they point at the OUTER index. */
function withoutGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

function runFixtureGit(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      // gc.auto / maintenance.auto off: `git commit` otherwise daemonises a gc
      // that keeps writing under .git while the fixture is being removed
      // (INFRA-HIGH-172).
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'user.name',
      GIT_CONFIG_VALUE_2: 'Aqua Test',
      GIT_CONFIG_KEY_3: 'user.email',
      GIT_CONFIG_VALUE_3: 'aqua-test@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * A committed fixture repository carrying a copy of the runner. `transform`
 * rewrites the runner's source, which is how the totality probe breaks the
 * classifier without touching the real one.
 */
function createFixture(transform: (source: string) => string = (source) => source): {
  root: string;
  base: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'format-scope-derived-'));
  const runner = join(root, 'tools', 'quality', 'quality.mjs');
  mkdirSync(dirname(runner), { recursive: true });
  writeFileSync(runner, transform(readFileSync(RUNNER, 'utf8')));
  for (const module of RUNNER_MODULES) {
    copyFileSync(join(QUALITY_DIR, module), join(dirname(runner), module));
  }
  writeTree(root, BASE_FILES);
  runFixtureGit(root, ['init', '-q', '-b', 'main']);
  runFixtureGit(root, ['add', '.']);
  runFixtureGit(root, ['commit', '-q', '-m', 'base']);
  return { root, base: runFixtureGit(root, ['rev-parse', 'HEAD']) };
}

function runRunner(root: string, args: readonly string[], base: string): RunResult {
  const result = spawnSync('node', [join(root, 'tools', 'quality', 'quality.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...withoutGitEnvironment(process.env), FORMAT_BASE_SHA: base },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Reset the fixture to `base`, apply one change, commit it, and run
 * `format-scope check` over base..HEAD — the comparison CI makes for a PR.
 */
function checkAfter(
  fixture: { root: string; base: string },
  change: (root: string) => void,
): RunResult {
  const { root, base } = fixture;
  runFixtureGit(root, ['checkout', '-q', '-f', '-B', 'scenario', base]);
  runFixtureGit(root, ['clean', '-q', '-f', '-d']);
  change(root);
  runFixtureGit(root, ['add', '.']);
  runFixtureGit(root, ['commit', '-q', '--allow-empty', '-m', 'scenario']);
  return runRunner(root, ['format-scope', 'check'], base);
}

function explain(result: RunResult): string {
  return `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function assertPasses(label: string, result: RunResult): void {
  assert.equal(result.status, 0, `${label} must pass format-scope check; got ${explain(result)}`);
}

function assertRefuses(label: string, result: RunResult, status: string, path: string): void {
  assert.equal(result.status, 1, `${label} must fail format-scope check; got ${explain(result)}`);
  const line = new RegExp(`^\\s+${status}\\s+${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
  assert.match(
    result.stderr,
    line,
    `${label} must name '${status}  ${path}'; got ${explain(result)}`,
  );
}

function verifyManifestIsGone(): void {
  const tracked = spawnSync('git', ['ls-files', '--', MANIFEST_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, `git ls-files failed: ${tracked.stderr}`);
  assert.equal(
    tracked.stdout.trim(),
    '',
    `${MANIFEST_PATH} is tracked again. It is a pure function of the tree; committing it makes ` +
      'every PR that adds or removes a file regenerate it and every concurrent PR conflict on it.',
  );

  const scripts = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    }
  ).scripts;
  assert.ok(scripts, 'package.json has no scripts block');
  assert.equal(scripts['quality:format-scope:generate'], undefined, 'the generate script is back');
  assert.equal(
    scripts['quality:format-scope:check'],
    'node tools/quality/quality.mjs format-scope check',
    'quality:format-scope:check must stay the CI entrypoint',
  );

  const fixture = createFixture();
  try {
    const generate = runRunner(fixture.root, ['format-scope', 'generate'], fixture.base);
    assert.notEqual(
      generate.status,
      0,
      `format-scope generate must be refused; got ${explain(generate)}`,
    );
    assert.equal(
      existsSync(join(fixture.root, MANIFEST_PATH)),
      false,
      'format-scope generate wrote a manifest',
    );
  } finally {
    removeFixtureTree(fixture.root);
  }
}

function verifyTotalityOnTheRealTree(): void {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(head.status, 0, `git rev-parse HEAD failed: ${head.stderr}`);
  // Base = HEAD: this assertion is about classification of the tracked tree,
  // and must not depend on HEAD^ existing (shallow clones) or on history.
  const result = spawnSync('node', [RUNNER, 'format-scope', 'check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORMAT_BASE_SHA: head.stdout.trim() },
  });
  const run = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  assertPasses('the real tracked tree', run);
  const counted = /format-scope check: (\d+) tracked format file\(s\) classified/.exec(run.stdout);
  assert.ok(
    counted !== null,
    `format-scope check did not report its classification; ${explain(run)}`,
  );
  const classified = Number(counted[1]);
  assert.ok(classified > 1000, `only ${classified} files classified — the scope looks empty`);
}

function verifyTotalityIsAsserted(): void {
  const source = readFileSync(RUNNER, 'utf8');
  assert.ok(
    source.includes(CLASSIFIER_CATCH_ALL),
    `the classifier catch-all '${CLASSIFIER_CATCH_ALL}' moved; this probe lost its subject`,
  );
  const probes: ReadonlyArray<readonly [string, string]> = [
    ['a path that falls through the classifier', 'return null;'],
    [
      'a class outside the declared vocabulary',
      "return managed(path, 'canonical_sorce', 'source');",
    ],
  ];
  for (const [label, replacement] of probes) {
    const fixture = createFixture((text) => text.replace(CLASSIFIER_CATCH_ALL, replacement));
    try {
      for (const args of [
        ['format-scope', 'check'],
        ['format', 'check-changed'],
      ]) {
        const result = runRunner(fixture.root, args, fixture.base);
        assert.equal(result.status, 1, `${args.join(' ')} with ${label}: ${explain(result)}`);
        assert.match(
          result.stderr,
          /unclassified/,
          `${args.join(' ')} with ${label}: ${explain(result)}`,
        );
        assert.match(
          result.stderr,
          /^\s+src\/index\.ts$/m,
          `${args.join(' ')} must name src/index.ts`,
        );
      }
    } finally {
      removeFixtureTree(fixture.root);
    }
  }
}

function verifyArchiveImmutability(): void {
  const fixture = createFixture();
  try {
    assertPasses(
      'adding a file to an archive',
      checkAfter(fixture, (root) =>
        writeTree(root, {
          'apps/svc/src/migrations/.archive/2026-01-01/1700000000001-New.ts':
            'export const n = 1;\n',
        }),
      ),
    );
    assertPasses(
      'archiving a live file (rename into .archive/)',
      checkAfter(fixture, (root) => {
        const target = join(
          root,
          'apps/svc/src/migrations/.archive/2026-10-02/1800000000000-Live.ts',
        );
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(root, LIVE_MIGRATION), target);
      }),
    );
    assertRefuses(
      'modifying an archived file',
      checkAfter(fixture, (root) =>
        writeFileSync(join(root, ARCHIVED), 'export const archived = 2;\n'),
      ),
      'M',
      ARCHIVED,
    );
    assertRefuses(
      'deleting an archived file',
      checkAfter(fixture, (root) => unlinkSync(join(root, ARCHIVED))),
      'D',
      ARCHIVED,
    );
    assertRefuses(
      'renaming an archived file',
      checkAfter(fixture, (root) => {
        const target = join(
          root,
          'apps/svc/src/migrations/.archive/2026-01-02/1700000000000-Old.ts',
        );
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(root, ARCHIVED), target);
      }),
      'R',
      ARCHIVED,
    );

    // The hook's case: the edit is staged but not committed yet. The check
    // compares the worktree, so it must catch it before the commit exists.
    runFixtureGit(fixture.root, ['checkout', '-q', '-f', '-B', 'scenario', fixture.base]);
    writeFileSync(join(fixture.root, ARCHIVED), 'export const archived = 3;\n');
    runFixtureGit(fixture.root, ['add', '.']);
    assertRefuses(
      'a staged, uncommitted archive edit',
      runRunner(fixture.root, ['format-scope', 'check'], fixture.base),
      'M',
      ARCHIVED,
    );
  } finally {
    removeFixtureTree(fixture.root);
  }
}

function verifyNoCommittedChangeNeeded(): void {
  const fixture = createFixture();
  try {
    assertPasses(
      'adding the ARIA daily report and a docs file',
      checkAfter(fixture, (root) =>
        writeTree(root, {
          'aria-tools/reports/daily/2026-10-01.md': '# 2026-10-01\n',
          'docs/reviews/rule-health/2026-10-01.md': '# Rule health\n',
        }),
      ),
    );
    // runtime_evidence was regenerate-to-edit under the manifest; it stays editable.
    assertPasses(
      'editing runtime evidence',
      checkAfter(fixture, (root) => writeFileSync(join(root, RUNTIME_EVIDENCE), '# amended\n')),
    );
    // `src/archive/` is a live sensor-service module, not an archive directory.
    assertPasses(
      'editing the live sensor-service archive module',
      checkAfter(fixture, (root) =>
        writeFileSync(join(root, LIVE_ARCHIVE_MODULE), 'export const archiveModule = 2;\n'),
      ),
    );
  } finally {
    removeFixtureTree(fixture.root);
  }
}

function run(): void {
  verifyManifestIsGone();
  verifyTotalityOnTheRealTree();
  verifyTotalityIsAsserted();
  verifyArchiveImmutability();
  verifyNoCommittedChangeNeeded();
  process.stdout.write('format-scope-derived: ok\n');
}

run();
