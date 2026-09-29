/**
 * A dependency bump never stales a generated quality manifest.
 *
 * WHY THIS EXISTS. Until 2026-09-29 no Dependabot PR in this repo could go
 * green. `tools/quality/format-scope.json` stored the sha256 of every
 * `package-lock.json`, and `tools/quality/rust-toolchain-manifest.json` stored
 * the sha256 of `Cargo.lock`. A bot that rewrites a lockfile cannot rerun
 * `quality.mjs`, so every npm bump failed `banned-phrase-gate` +
 * `validate-closes` ("format-scope.json is stale") and every cargo bump failed
 * sens lint/build/test the same way. Seventeen PRs sat red; advisories piled up
 * behind them until main's own `npm audit` gate went red.
 *
 * Neither digest was a control. Both had zero readers besides the equality
 * check, and that check's only remedy is "regenerate", which recomputes the
 * digest. A generated file's authority is its generator (npm, cargo, codegen,
 * tsc), each already gated where it runs (`npm ci`, `cargo --locked`, the
 * eslint-rules dist diff, the openapi parity spec).
 *
 * WHAT THIS PINS, behaviourally, with the real generator in a throwaway repo:
 *   1. Rewriting every lockfile and generated artifact — exactly what
 *      Dependabot or a codegen run does — leaves both manifests byte-identical,
 *      and `format-scope check` still passes against the pre-bump manifest.
 *   2. The controls that ARE real survive: editing an archive file still
 *      changes format-scope (its bytes are the authority and nothing
 *      regenerates them), and changing rust-toolchain.toml still changes the
 *      toolchain manifest. Without these two, (1) would also pass for a
 *      generator that had stopped hashing or reading anything at all.
 *   3. The committed manifests match: no `generated` entry carries a digest,
 *      and the toolchain manifest carries no `cargo_lock_sha256`.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { removeFixtureTree } from './fixture-tree';

const REPO_ROOT = process.cwd();
const GENERATOR = join(REPO_ROOT, 'tools', 'quality', 'quality.mjs');
/** Sibling ESM modules quality.mjs imports; the fixture copy needs them beside it. */
const GENERATOR_MODULES = ['format-merge-base.mjs'];
const FORMAT_SCOPE_REL = 'tools/quality/format-scope.json';
const RUST_MANIFEST_REL = 'tools/quality/rust-toolchain-manifest.json';

/** Files a dependency bot or a codegen run rewrites; none may move a manifest. */
const REGENERATED_FILES = [
  'package-lock.json',
  'e2e/package-lock.json',
  'Cargo.lock',
  'tools/eslint-rules/dist/index.js',
] as const;
const ARCHIVE_FILE = 'docs/archive/2026-01-01-evidence.md';

interface FormatScopeEntry {
  path: string;
  class: string;
  prettier_managed: boolean;
  content_sha256?: string | null;
}

function withoutGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

function writeFixtureFile(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function verifyFixture(): void {
  const root = mkdtempSync(join(tmpdir(), 'lockfile-bump-manifest-'));
  const env = withoutGitEnvironment(process.env);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  };
  const generator = join(root, 'tools/quality/quality.mjs');
  const quality = (...args: string[]): void => {
    execFileSync('node', [generator, ...args], { cwd: root, env, stdio: 'pipe' });
  };
  const generateBoth = (): { formatScope: string; rust: string } => {
    quality('format-scope', 'generate');
    quality('rust-toolchain', 'generate');
    return {
      formatScope: readFileSync(join(root, FORMAT_SCOPE_REL), 'utf8'),
      rust: readFileSync(join(root, RUST_MANIFEST_REL), 'utf8'),
    };
  };

  try {
    mkdirSync(dirname(generator), { recursive: true });
    copyFileSync(GENERATOR, generator);
    for (const module of GENERATOR_MODULES) {
      copyFileSync(join(dirname(GENERATOR), module), join(dirname(generator), module));
    }
    writeFixtureFile(
      root,
      'rust-toolchain.toml',
      '[toolchain]\nchannel = "1.88.0"\ncomponents = ["clippy", "rustfmt"]\ntargets = []\n',
    );
    writeFixtureFile(root, 'Cargo.toml', '[workspace]\nmembers = [\n  "crates/a",\n]\n');
    writeFixtureFile(root, 'src/index.ts', 'export const value = 1;\n');
    writeFixtureFile(root, ARCHIVE_FILE, 'original evidence\n');
    for (const rel of REGENERATED_FILES) writeFixtureFile(root, rel, `${rel} v1\n`);
    // Both manifests are tracked files in the real repo, so they are in the
    // fixture's tracked set from the start; otherwise the second generate
    // would see them as newly added files and the comparison would be noise.
    writeFixtureFile(root, FORMAT_SCOPE_REL, '{}\n');
    writeFixtureFile(root, RUST_MANIFEST_REL, '{}\n');
    git('init', '--quiet', '--initial-branch=main');
    git('add', '--all');

    const before = generateBoth();
    const scope = JSON.parse(before.formatScope) as { entries: FormatScopeEntry[] };
    const byPath = new Map(scope.entries.map((entry) => [entry.path, entry]));
    // Guard against a vacuous fixture: the files under test must actually be
    // classified the way production classifies them.
    for (const rel of ['package-lock.json', 'e2e/package-lock.json', REGENERATED_FILES[3]]) {
      assert.equal(byPath.get(rel)?.class, 'generated', `${rel} is not classified generated`);
    }
    assert.equal(byPath.get(ARCHIVE_FILE)?.class, 'archive_immutable');

    // (1) The bump.
    for (const rel of REGENERATED_FILES) writeFixtureFile(root, rel, `${rel} v2 bumped\n`);
    git('add', '--all');
    const afterBump = generateBoth();
    assert.equal(
      afterBump.formatScope,
      before.formatScope,
      'a lockfile/generated-artifact rewrite changed format-scope.json — a dependency bot ' +
        'cannot regenerate it, so every such PR would go red',
    );
    assert.equal(
      afterBump.rust,
      before.rust,
      'a Cargo.lock rewrite changed rust-toolchain-manifest.json — every Dependabot cargo PR ' +
        'would fail sens lint/build/test on it',
    );
    // The gate CI actually runs, against the manifest committed before the bump.
    writeFileSync(join(root, FORMAT_SCOPE_REL), before.formatScope);
    quality('format-scope', 'check');

    // (2) The real controls still fire.
    writeFixtureFile(root, ARCHIVE_FILE, 'edited evidence\n');
    const afterArchiveEdit = generateBoth();
    assert.notEqual(
      afterArchiveEdit.formatScope,
      before.formatScope,
      'editing archive_immutable evidence no longer changes format-scope.json — the ' +
        'committed_hash pin was lost along with the generated-file digests',
    );
    writeFixtureFile(
      root,
      'rust-toolchain.toml',
      '[toolchain]\nchannel = "1.89.0"\ncomponents = ["clippy", "rustfmt"]\ntargets = []\n',
    );
    assert.notEqual(
      generateBoth().rust,
      afterArchiveEdit.rust,
      'changing rust-toolchain.toml no longer changes the toolchain manifest',
    );
  } finally {
    removeFixtureTree(root);
  }
}

function verifyCommittedManifests(): void {
  const scope = JSON.parse(readFileSync(join(REPO_ROOT, FORMAT_SCOPE_REL), 'utf8')) as {
    entries: FormatScopeEntry[];
  };
  const pinnedGenerated = scope.entries
    .filter((entry) => entry.class === 'generated' && 'content_sha256' in entry)
    .map((entry) => entry.path);
  assert.deepEqual(pinnedGenerated, [], 'generated entries still carry content_sha256');
  const committedHash = scope.entries.filter(
    (entry) => entry.class === 'archive_immutable' && typeof entry.content_sha256 === 'string',
  );
  assert.ok(committedHash.length > 0, 'archive entries lost their content_sha256 pins');

  const rust = JSON.parse(readFileSync(join(REPO_ROOT, RUST_MANIFEST_REL), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.ok(!('cargo_lock_sha256' in rust), 'rust-toolchain-manifest.json pins Cargo.lock again');
}

function run(): void {
  verifyFixture();
  verifyCommittedManifests();
  process.stdout.write('lockfile-bump-manifest-stability: ok\n');
}

run();
