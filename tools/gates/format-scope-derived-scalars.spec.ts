/**
 * The format-scope manifest carries no derived summary scalars.
 *
 * WHY THIS EXISTS. `tools/quality/format-scope.json` is a generated manifest
 * of ~9,300 tracked files. It used to carry three extra fields — `file_count`,
 * `managed_count`, `managed_file_list_sha256` — each a pure function of
 * `entries`, stored in the same file as `entries`.
 *
 * Measured before removal: one producer (`buildFormatScope`), ZERO readers.
 * `getManagedFormatFiles` is the manifest's only consumer and reads `.entries`
 * alone.
 *
 * The cost was not neutral. Adding or removing ANY single tracked file changes
 * all three scalars, so two branches conflict on those same lines regardless
 * of which files each one touched — a structurally certain merge conflict
 * rather than an occasional one. Five in a single day once two sessions were
 * working concurrently, every one resolved identically and none carrying any
 * information: `checkManifest` rebuilds the manifest from the tree and refuses
 * anything that differs, so whichever side of the conflict is taken the
 * content is recomputed anyway.
 *
 * WHAT THIS PINS. That the fields stay gone. Re-adding a summary scalar
 * reintroduces the guaranteed conflict, and the next person to do it would be
 * adding something that looks harmless and is measurably not — which is
 * exactly the situation a comment alone does not survive.
 *
 * WHAT IT DOES NOT CLAIM. That derived data is bad. A checksum over a file's
 * OWN contents, in that same file, is what carries no information; a checksum
 * of something external (the registry chain tip, an authority hash) is a real
 * control and is unaffected by this rule.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = process.cwd();
const MANIFEST = join(REPO_ROOT, 'tools', 'quality', 'format-scope.json');
const GENERATOR = join(REPO_ROOT, 'tools', 'quality', 'quality.mjs');

/** Fields removed because they are derived from `entries` and change on every branch. */
const BANNED_DERIVED_SCALARS = ['file_count', 'managed_count', 'managed_file_list_sha256'];

function withoutGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

function verifyImmutableEvidenceClassification(): void {
  const root = mkdtempSync(join(tmpdir(), 'format-scope-evidence-'));
  const poisonedIndex = join(root, 'caller-index-must-not-be-used');
  const childEnv = withoutGitEnvironment({ ...process.env, GIT_INDEX_FILE: poisonedIndex });
  const plan = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';
  const paths = [
    `${plan}/reviews/01-integrity.md`,
    `${plan}/reviews/c139f40f/A-foundations.md`,
    `${plan}/progress/evidence/review.json`,
    `${plan}/PLAN.md`,
  ];
  try {
    const generator = join(root, 'tools/quality/quality.mjs');
    mkdirSync(dirname(generator), { recursive: true });
    copyFileSync(GENERATOR, generator);
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `${path}\n`);
    }
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, env: childEnv, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: root, env: childEnv, stdio: 'pipe' });
    execFileSync('node', [generator, 'format-scope', 'generate'], {
      cwd: root,
      env: childEnv,
      stdio: 'pipe',
    });
    assert.equal(existsSync(poisonedIndex), false, 'fixture mutated its caller Git index');
    const generated = JSON.parse(
      readFileSync(join(root, 'tools/quality/format-scope.json'), 'utf8'),
    ) as { entries: Array<Record<string, unknown>> };
    const entries = new Map(generated.entries.map((entry) => [entry.path, entry]));
    for (const path of paths.slice(0, 3)) {
      assert.equal(entries.get(path)?.class, 'archive_immutable', `${path} is mutable`);
      assert.equal(entries.get(path)?.prettier_managed, false, `${path} is formatter-owned`);
    }
    assert.equal(entries.get(paths[3])?.prettier_managed, true, 'live plan docs must stay managed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;

  for (const field of BANNED_DERIVED_SCALARS) {
    assert.ok(
      !(field in manifest),
      `format-scope.json carries the derived scalar '${field}'. It is a pure function of ` +
        `'entries' in the same file, has no reader, and changes on every branch that adds or ` +
        `removes any tracked file — which makes a merge conflict here structurally certain. ` +
        `Remove it from buildFormatScope() and regenerate.`,
    );
  }

  const generatorSource = readFileSync(GENERATOR, 'utf8');
  const buildBody = generatorSource.slice(
    generatorSource.indexOf('function buildFormatScope()'),
    generatorSource.indexOf(
      'function ',
      generatorSource.indexOf('function buildFormatScope()') + 1,
    ),
  );
  assert.ok(buildBody.length > 0, 'buildFormatScope() not found — this spec has lost its subject');
  for (const field of BANNED_DERIVED_SCALARS) {
    // The generator is the source of truth: a field absent from today's
    // committed manifest but present in the generator would reappear on the
    // next `generate`, so checking only the artifact would pass while the
    // defect sat one command away.
    assert.ok(
      !new RegExp(`^\\s*${field}\\s*:`, 'm').test(buildBody),
      `buildFormatScope() still emits '${field}'; the committed manifest is only clean until ` +
        `the next regenerate.`,
    );
  }

  // The manifest must still be the real thing rather than an empty shell that
  // trivially satisfies the assertions above.
  const entries = manifest.entries;
  assert.ok(Array.isArray(entries) && entries.length > 1000, 'format-scope entries look wrong');

  // And it must still be FRESH by the existing gate — this spec must never
  // become a way to pass while the manifest drifts.
  execFileSync('node', [GENERATOR, 'format-scope', 'check'], { cwd: REPO_ROOT, stdio: 'pipe' });
  verifyImmutableEvidenceClassification();

  process.stdout.write(
    `format-scope-derived-scalars: ok (${entries.length} entries, no derived scalars)\n`,
  );
}

run();
