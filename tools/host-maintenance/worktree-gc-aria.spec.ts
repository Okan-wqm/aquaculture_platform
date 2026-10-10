#!/usr/bin/env node
/**
 * ARIA's own records are never deleted (user decision, 2026-10-09:
 * "ARIA'ya özgü yapılar silinmemeli"), and finished ARIA worktrees may be
 * removed (2026-10-10: "bitmiş ARIA worktree'leri silinsin"). Canonical ARIA
 * state is never collectable whatever the roots say; a worktree holding an
 * untracked or ignored file under an ARIA artifact path is kept (kept_aria)
 * - never removed, never moved into quarantine; an ARIA-named worktree
 * without one is judged like any other.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUILTIN_PROTECTED, classifyLocation, isAriaStatePath, readConfig } from './gc-config.ts';
import { addWorktree, fixture, git, reportFor, runGc, wrappedGit } from './gc-test-fixture.ts';
import { ARIA_ARCHIVE_PATHS } from './worktree-state.ts';

void test('canonical ARIA state is never collectable, however wide the roots', () => {
  const cases: Array<[string, string]> = [
    ['/root/aria-8b', '/root'],
    ['/root/aria-8b/.aria-state-store', '/root'],
    ['/var/lib/aria/code', '/var/lib'],
    ['/var/lib/aria-runner/work', '/var/lib'],
    ['/home/gharunner/_work/repo/repo', '/home'],
    ['/root/wt/x/.aria-state-store', '/root/wt'],
    ['/var/aqua-saas/.worktrees/a/.aria-state-store/b', '/var/aqua-saas/.worktrees'],
  ];
  for (const [path, root] of cases) {
    assert.ok(isAriaStatePath(path), path);
    assert.equal(
      classifyLocation(path, null, [root, '/'], BUILTIN_PROTECTED),
      'protected_path',
      path,
    );
  }
  assert.equal(isAriaStatePath('/root/wt/aria-8b-notes'), false);
  assert.equal(isAriaStatePath('/var/aqua-saas/.worktrees/aria-zc'), false);
});

void test('a worktree under a .aria-state-store directory is kept', () => {
  const fx = fixture();
  const storeDir = join(fx.roots, 'host', '.aria-state-store');
  mkdirSync(storeDir, { recursive: true });
  const store = addWorktree(fx, 'store', { under: storeDir });

  assert.equal(reportFor(runGc(fx), store).reason, 'protected_path');
  assert.ok(existsSync(store));
});

void test('tracked, unmodified ARIA code does not keep a worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'plain');
  assert.ok(existsSync(join(wt, 'aria-tools', 'repo_identity.json')));

  const run = runGc(fx);

  assert.equal(reportFor(run, wt).decision, 'removed');
  // Still in git: removing the worktree deleted no ARIA structure.
  assert.equal(git(['-C', fx.repo, 'show', 'origin/main:aria-tools/repo_identity.json']), '{}\n');
});

interface Manifest {
  worktree: string;
  head: string;
  branch: string | null;
  created_at: string;
  files: Array<{ path: string; type: string; size: number; sha256?: string }>;
}

function manifestOf(archive: string): Manifest {
  return JSON.parse(
    readFileSync(archive.replace(/\.tar\.(zst|gz)$/, '.manifest.json'), 'utf8'),
  ) as Manifest;
}

function extract(archive: string, into: string): void {
  const flag = archive.endsWith('.tar.zst') ? '--zstd' : '--gzip';
  execFileSync('tar', [flag, '-xf', archive, '-C', into]);
}

void test('ARIA records are archived and verified, then the worktree is removed', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'aria-finished', { branch: 'fix/aria-plan' });
  // untracked (aria-tools is not ignored in the fixture) and ignored (.aria-ci)
  writeFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), '{"cycle":1}\n');
  mkdirSync(join(wt, '.aria-ci'));
  writeFileSync(join(wt, '.aria-ci', 'evidence.json'), '{"ok":true}\n');

  const run = runGc(fx);

  const report = reportFor(run, wt);
  assert.equal(report.decision, 'removed_with_archive');
  assert.equal(existsSync(wt), false);
  const archive = String(report.archive);
  assert.ok(archive.startsWith(fx.archive));
  assert.ok(run.summary.removals.some((r) => r.archive === archive));
  const manifest = manifestOf(archive);
  assert.deepEqual(
    manifest.files.map((f) => f.path),
    ['.aria-ci/evidence.json', 'aria-tools/cycles.jsonl'],
  );
  assert.equal(manifest.branch, 'fix/aria-plan');
  const out = mkdtempSync(join(fx.tmp, 'out-'));
  extract(archive, out);
  assert.equal(readFileSync(join(out, 'aria-tools', 'cycles.jsonl'), 'utf8'), '{"cycle":1}\n');
  const digest = createHash('sha256').update('{"ok":true}\n').digest('hex');
  assert.equal(manifest.files.find((f) => f.path === '.aria-ci/evidence.json')?.sha256, digest);
  // Tracked ARIA code is not archived: git keeps it.
  assert.equal(existsSync(join(out, 'aria-tools', 'repo_identity.json')), false);
});

void test('a finished ARIA worktree with no ARIA records is removed without an archive', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'train', { branch: 'train/aria-2026-10-07' });

  const report = reportFor(runGc(fx), wt);

  assert.equal(report.decision, 'removed');
  assert.equal(report.archive, undefined);
  assert.equal(existsSync(fx.archive), false);
});

void test('every ARIA archive path is archived before removal', () => {
  const fx = fixture();
  const files = [
    'aria-findings/F-001.json',
    'aria-worktrees/lane-1/x',
    '.claude/agents/.dispatch-log.jsonl',
    'aria-agent-outputs-2026-10-09/out.json',
  ];
  assert.ok(
    ARIA_ARCHIVE_PATHS.every(
      (p) => p === 'aria-tools' || p === '.aria-ci' || files.some((f) => f.startsWith(p)),
    ),
  );
  const holders = files.map((file, i) => {
    const wt = addWorktree(fx, `holder-${i}`);
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), 'aria\n');
    return wt;
  });

  const run = runGc(fx);

  holders.forEach((wt, i) => {
    const report = reportFor(run, wt);
    assert.equal(report.decision, 'removed_with_archive', files[i]);
    assert.deepEqual(
      manifestOf(String(report.archive)).files.map((f) => f.path),
      [files[i]],
    );
  });
});

void test('a real ARIA store keeps its worktree and is never archived', () => {
  const fx = fixture();
  const stateGit = addWorktree(fx, 'state-git');
  mkdirSync(join(stateGit, 'aria-tools', 'nested', 'state.git'), { recursive: true });
  const topStore = addWorktree(fx, 'top-store');
  mkdirSync(join(topStore, '.aria-state-store'));
  writeFileSync(join(topStore, '.aria-state-store', 'HEAD'), 'ref: refs/heads/state\n');
  const large = addWorktree(fx, 'large');
  writeFileSync(join(large, 'aria-tools', 'ledger.jsonl'), '');
  truncateSync(join(large, 'aria-tools', 'ledger.jsonl'), 51 * 1024 * 1024);

  const run = runGc(fx);

  for (const [wt, why] of [
    [stateGit, /state\.git/],
    [topStore, /\.aria-state-store/],
    [large, /50 MB/],
  ] as const) {
    const report = reportFor(run, wt);
    assert.equal(report.reason, 'aria_store', wt);
    assert.match(String(report.detail), why);
    assert.ok(existsSync(wt));
  }
  assert.equal(existsSync(fx.archive), false);
});

void test('an archive that does not verify keeps the worktree and its ARIA records', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'bad-archive');
  writeFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), '{"cycle":1}\n');
  // The real tar writes the archive; the wrapper then damages it before the
  // collector reads it back. Extraction goes to the real tar unchanged.
  const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
  const corrupting = join(fx.tmp, 'corrupting-tar');
  writeFileSync(
    corrupting,
    [
      '#!/bin/sh',
      `"${realTar}" "$@" || exit $?`,
      'case "$*" in *-cf*) for a in "$@"; do case "$a" in *.partial) printf garbage > "$a" ;; esac; done ;; esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  const run = runGc(fx, [], { WORKTREE_GC_TAR_BIN: corrupting });

  const report = reportFor(run, wt);
  assert.equal(report.reason, 'archive_failed');
  assert.equal(report.decision, 'kept');
  assert.equal(run.exitCode, 3);
  assert.equal(readFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), 'utf8'), '{"cycle":1}\n');
});

void test('an archive whose content differs from the manifest keeps the worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'tampered-archive');
  writeFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), '{"cycle":1}\n');
  // A readable archive with the wrong bytes: only the manifest comparison
  // can tell it from a good one.
  const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
  const tampering = join(fx.tmp, 'tampering-tar');
  writeFileSync(
    tampering,
    [
      '#!/bin/sh',
      `"${realTar}" "$@" || exit $?`,
      'case "$*" in *-cf*)',
      '  for a in "$@"; do case "$a" in *.partial) arch="$a" ;; esac; done',
      '  case "$arch" in *.tar.zst.partial) z=--zstd ;; *) z=--gzip ;; esac',
      '  d=$(mktemp -d)',
      `  "${realTar}" $z -xf "$arch" -C "$d"`,
      '  echo tampered >> "$d/aria-tools/cycles.jsonl"',
      `  "${realTar}" $z -cf "$arch" -C "$d" aria-tools ;;`,
      'esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  const report = reportFor(runGc(fx, [], { WORKTREE_GC_TAR_BIN: tampering }), wt);

  assert.equal(report.reason, 'archive_failed');
  assert.match(String(report.detail), /differs from the manifest/);
  assert.ok(existsSync(join(wt, 'aria-tools', 'cycles.jsonl')));
});

void test('an unwritable archive root keeps the worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'no-archive-room');
  mkdirSync(join(wt, '.aria-ci'));
  writeFileSync(join(wt, '.aria-ci', 'evidence.json'), '{}\n');
  writeFileSync(fx.archive, 'a file where the archive root should be\n');

  const report = reportFor(runGc(fx), wt);

  assert.equal(report.reason, 'archive_failed');
  assert.ok(existsSync(join(wt, '.aria-ci', 'evidence.json')));
});

void test('a refused removal puts the archived ARIA records back into the tree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'refused-aria');
  writeFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), '{"cycle":1}\n');
  const intruding = wrappedGit(
    fx,
    'intruding-git',
    '*"worktree remove"*',
    'for last; do :; done; echo work > "$last/notes.txt"',
  );

  const run = runGc(fx, [], { AQUA_GIT_BIN: intruding });

  const report = reportFor(run, wt);
  assert.equal(report.reason, 'remove_refused');
  assert.equal(readFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), 'utf8'), '{"cycle":1}\n');
  assert.ok(existsSync(join(wt, 'notes.txt')));
});

void test('the archive root may not overlap a root, the deploy tree or ARIA state', () => {
  for (const root of ['/root/wt/archive', '/var/lib/aqua/deploy/x', '/var/lib/aria/archive']) {
    assert.throws(() => readConfig([], { WORKTREE_GC_ARCHIVE_ROOT: root }), root);
  }
});

void test('ARIA records that change after the archive move the tree back, losing nothing', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'late-append');
  mkdirSync(join(wt, '.aria-ci'));
  writeFileSync(join(wt, '.aria-ci', 'ledger.jsonl'), '{"n":1}\n');
  // An ARIA ledger is appended to right after the tree reaches quarantine:
  // the archive no longer holds it, and git would delete the ignored file.
  const appending = wrappedGit(
    fx,
    'appending-git',
    '*"worktree move"*',
    'for last; do :; done; case "$last" in *.gc-quarantine*) "$REAL_GIT" "$@" || exit $?; ' +
      'echo \'{"n":2}\' >> "$last/.aria-ci/ledger.jsonl"; exit 0 ;; esac',
  );

  const run = runGc(fx, [], { AQUA_GIT_BIN: appending });

  const report = reportFor(run, wt);
  assert.equal(report.reason, 'changed_during_removal');
  assert.equal(report.decision, 'kept');
  assert.equal(run.exitCode, 3);
  assert.equal(readFileSync(join(wt, '.aria-ci', 'ledger.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');
});

void test('too many ARIA bytes keep the worktree unarchived', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'heavy');
  writeFileSync(join(wt, 'aria-tools', 'big.jsonl'), 'x'.repeat(64));

  const report = reportFor(runGc(fx, [], { WORKTREE_GC_ARIA_MAX_BYTES: '32' }), wt);

  assert.equal(report.reason, 'aria_large');
  assert.ok(existsSync(join(wt, 'aria-tools', 'big.jsonl')));
  assert.equal(existsSync(fx.archive), false);
});

void test('too little free space for the archive keeps the worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'no-space');
  writeFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), '{}\n');

  const run = runGc(fx, [], { WORKTREE_GC_ARCHIVE_RESERVE_BYTES: String(2 ** 62) });

  assert.equal(reportFor(run, wt).reason, 'low_space');
  assert.equal(run.exitCode, 3);
  assert.equal(existsSync(fx.archive), false);
});

void test('archives are private, carry their own hash, and failed attempts leave nothing', () => {
  const fx = fixture();
  const first = addWorktree(fx, 'retry');
  writeFileSync(join(first, 'aria-tools', 'cycles.jsonl'), '{"cycle":1}\n');
  const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
  const corrupting = join(fx.tmp, 'corrupting-tar');
  writeFileSync(
    corrupting,
    [
      '#!/bin/sh',
      `"${realTar}" "$@" || exit $?`,
      'case "$*" in *-cf*) for a in "$@"; do case "$a" in *.partial) printf garbage > "$a" ;; esac; done ;; esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  // A pre-existing, too-open archive root is tightened, not trusted.
  mkdirSync(fx.archive, { mode: 0o755 });
  chmodSync(fx.archive, 0o755);
  const failed = runGc(fx, [], { WORKTREE_GC_TAR_BIN: corrupting });
  assert.equal(reportFor(failed, first).reason, 'archive_failed');
  const [day] = readdirSync(fx.archive);
  assert.ok(day);
  assert.deepEqual(readdirSync(join(fx.archive, day)), []);

  const done = runGc(fx);
  const archive = String(reportFor(done, first).archive);
  assert.doesNotMatch(archive, /-2\.tar/);
  const manifest = archive.replace(/\.tar\.(zst|gz)$/, '.manifest.json');
  const mode = (p: string): number => statSync(p).mode & 0o777;
  assert.equal(mode(fx.archive), 0o700);
  assert.equal(mode(join(fx.archive, day)), 0o700);
  assert.equal(mode(archive), 0o600);
  assert.equal(mode(manifest), 0o600);
  const body = JSON.parse(readFileSync(manifest, 'utf8')) as { archive_sha256: string };
  assert.equal(
    body.archive_sha256,
    createHash('sha256').update(readFileSync(archive)).digest('hex'),
  );
});

void test('a quarantine leftover is re-checked after its archive, before --force', () => {
  const fx = fixture();
  const quarantine = join(fx.roots, '.gc-quarantine');
  mkdirSync(quarantine);
  const wt = addWorktree(fx, 'leftover');
  const moved = join(quarantine, 'leftover');
  git(['-C', fx.repo, 'worktree', 'move', wt, moved]);
  execFileSync('rm', [join(moved, 'README.md')]);
  mkdirSync(join(moved, '.aria-ci'));
  writeFileSync(join(moved, '.aria-ci', 'ledger.jsonl'), '{"n":1}\n');
  // tar archives the ledger; the ledger is appended to right after.
  const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
  const appending = join(fx.tmp, 'appending-tar');
  writeFileSync(
    appending,
    [
      '#!/bin/sh',
      `"${realTar}" "$@" || exit $?`,
      'case "$*" in *-cf*)',
      '  prev=""; for a in "$@"; do [ "$prev" = "-C" ] && dir="$a"; prev="$a"; done',
      `  echo '{"n":2}' >> "$dir/.aria-ci/ledger.jsonl" ;;`,
      'esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );

  const run = runGc(fx, [], { WORKTREE_GC_TAR_BIN: appending });

  const report = reportFor(run, moved);
  assert.equal(report.reason, 'changed_during_removal');
  assert.equal(readFileSync(join(moved, '.aria-ci', 'ledger.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');
});

void test('the unit sets no UMask, so git fetch keeps writing shared-readable objects', () => {
  const unit = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../infrastructure/host-maintenance/aqua-worktree-gc.service',
    ),
    'utf8',
  );
  assert.doesNotMatch(unit, /^\s*UMask=/m);
});
