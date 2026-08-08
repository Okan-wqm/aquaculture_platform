import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { computeCanonicalGitWorktreeEvidence, HERMETIC_GIT_RUNTIME } from './hermetic-git-runtime';

const fixtureRoots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: root,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TZ: 'UTC',
    },
  }).trim();
}

function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1'): string {
  const root = mkdtempSync(join(tmpdir(), 'hermetic-git-runtime-'));
  fixtureRoots.push(root);
  execFileSync('/usr/bin/git', [
    'init',
    '--quiet',
    '--initial-branch=main',
    ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []),
    root,
  ]);
  writeFileSync(join(root, '.gitignore'), '.env\n*.key\n', 'utf8');
  mkdirSync(join(root, 'tracked'), { recursive: true });
  writeFileSync(join(root, 'tracked', 'payload.txt'), 'governed\n', 'utf8');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Hermetic Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  return root;
}

function linkedFixture(): { readonly root: string; readonly linked: string } {
  const root = fixture();
  const linked = `${root}-linked`;
  fixtureRoots.push(linked);
  git(root, 'worktree', 'add', '--quiet', '-b', 'linked-fixture', linked);
  return { root, linked };
}

function injectPersistedFsmonitorIndexBit(root: string): void {
  const indexPath = join(root, '.git', 'index');
  const index = readFileSync(indexPath);
  const entryStart = 12;
  const flagsOffset = entryStart + 60;
  const flags = index.readUInt16BE(flagsOffset);
  assert.equal(flags & 0x4000, 0, 'fixture index entry unexpectedly has extended flags');
  const pathEnd = index.indexOf(0, entryStart + 62);
  assert.notEqual(pathEnd, -1, 'fixture index entry has no path terminator');
  const oldEntryEnd = entryStart + Math.ceil((pathEnd + 1 - entryStart) / 8) * 8;
  const fixed = Buffer.from(index.subarray(entryStart, entryStart + 62));
  fixed.writeUInt16BE(flags | 0x4000, 60);
  const extendedFlags = Buffer.alloc(2);
  extendedFlags.writeUInt16BE(0x20, 0);
  const path = Buffer.from(index.subarray(entryStart + 62, pathEnd + 1));
  const unpadded = Buffer.concat([fixed, extendedFlags, path]);
  const padding = Buffer.alloc(Math.ceil(unpadded.length / 8) * 8 - unpadded.length);
  const body = Buffer.concat([
    index.subarray(0, entryStart),
    unpadded,
    padding,
    index.subarray(oldEntryEnd, index.length - 20),
  ]);
  writeFileSync(indexPath, Buffer.concat([body, createHash('sha1').update(body).digest()]));
}

async function withProcessEnvironment(
  overrides: Readonly<Record<string, string>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

void describe('HermeticGitRuntime', () => {
  void it('attests one absolute Git binary and ignores PATH/HOME/XDG/system/alternate env', async () => {
    const root = fixture();
    const maliciousRoot = mkdtempSync(join(tmpdir(), 'malicious-git-env-'));
    fixtureRoots.push(maliciousRoot);
    const fakeBin = join(maliciousRoot, 'bin');
    const fakeGit = join(fakeBin, 'git');
    const invocationSentinel = join(maliciousRoot, 'fake-git-ran');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeGit, `#!/bin/sh\nprintf invoked > ${invocationSentinel}\nexit 97\n`, 'utf8');
    chmodSync(fakeGit, 0o755);
    const home = join(maliciousRoot, 'home');
    const xdg = join(maliciousRoot, 'xdg');
    mkdirSync(join(xdg, 'git'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const excludes = join(maliciousRoot, 'global-excludes');
    writeFileSync(excludes, 'visible.txt\n', 'utf8');
    writeFileSync(join(home, '.gitconfig'), `[core]\nexcludesFile = ${excludes}\n`, 'utf8');
    writeFileSync(join(xdg, 'git', 'config'), `[core]\nexcludesFile = ${excludes}\n`, 'utf8');
    const systemConfig = join(maliciousRoot, 'system.gitconfig');
    writeFileSync(systemConfig, `[core]\nexcludesFile = ${excludes}\n`, 'utf8');
    const alternateObjects = join(maliciousRoot, 'objects');
    mkdirSync(alternateObjects);
    writeFileSync(join(root, 'visible.txt'), 'must remain visible\n', 'utf8');

    await withProcessEnvironment(
      {
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects,
        GIT_CONFIG_SYSTEM: systemConfig,
        GIT_DIR: join(maliciousRoot, 'not-the-repository'),
        HOME: home,
        LD_PRELOAD: join(maliciousRoot, 'not-a-library.so'),
        PATH: `${fakeBin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: xdg,
      },
      async () => {
        const evidence = await computeCanonicalGitWorktreeEvidence(root);
        assert.equal(evidence.dirty, true);
        assert.equal(HERMETIC_GIT_RUNTIME.attestation.binaryPath, '/usr/bin/git');
        assert.match(HERMETIC_GIT_RUNTIME.attestation.binarySha256, /^[0-9a-f]{64}$/);
      },
    );
    assert.equal(readFileSync(join(root, 'visible.txt'), 'utf8'), 'must remain visible\n');
    assert.throws(() => readFileSync(invocationSentinel), /ENOENT/);
  });

  void it('makes mutable info/exclude ineffective while preserving .gitignore semantics', async () => {
    const root = fixture();
    writeFileSync(join(root, 'evidence.txt'), 'visible\n', 'utf8');
    const before = await computeCanonicalGitWorktreeEvidence(root);
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'evidence.txt\n', 'utf8');
    const after = await computeCanonicalGitWorktreeEvidence(root);
    assert.deepEqual(after, before);

    writeFileSync(join(root, '.env'), 'ignored secret\n', 'utf8');
    assert.deepEqual(await computeCanonicalGitWorktreeEvidence(root), before);
  });

  void it('separates content identity from repository substrate identity', async () => {
    const source = fixture();
    writeFileSync(join(source, 'tracked', 'payload.txt'), 'same dirty bytes\n', 'utf8');
    writeFileSync(join(source, 'untracked.txt'), 'same untracked bytes\n', 'utf8');
    const replica = `${source}-independent-replica`;
    fixtureRoots.push(replica);
    cpSync(source, replica, { recursive: true, preserveTimestamps: true });
    git(replica, 'config', 'remote.origin.url', 'https://example.invalid/different.git');
    git(replica, 'config', 'user.name', 'Different Inert User');
    git(replica, 'config', 'user.email', 'different@example.invalid');

    const sourceEvidence = await computeCanonicalGitWorktreeEvidence(source);
    const replicaEvidence = await computeCanonicalGitWorktreeEvidence(replica);
    assert.equal(replicaEvidence.headSha, sourceEvidence.headSha);
    assert.equal(replicaEvidence.statusSha256, sourceEvidence.statusSha256);
    assert.equal(replicaEvidence.contentSha256, sourceEvidence.contentSha256);
    assert.notEqual(
      replicaEvidence.substrateAttestationSha256,
      sourceEvidence.substrateAttestationSha256,
    );

    const sameBytes = readFileSync(join(source, 'tracked', 'payload.txt'));
    renameSync(join(source, 'tracked', 'payload.txt'), join(source, 'tracked', 'payload.old'));
    writeFileSync(join(source, 'tracked', 'payload.txt'), sameBytes);
    rmSync(join(source, 'tracked', 'payload.old'));
    const replacedEvidence = await computeCanonicalGitWorktreeEvidence(source);
    assert.equal(replacedEvidence.contentSha256, sourceEvidence.contentSha256);
    assert.notEqual(
      replacedEvidence.substrateAttestationSha256,
      sourceEvidence.substrateAttestationSha256,
    );
  });

  void it('refuses local include/filter/diff process authorities before executing them', async () => {
    const root = fixture();
    const sentinel = join(root, 'filter-ran');
    writeFileSync(join(root, '.gitattributes'), 'tracked/payload.txt filter=evil diff=evil\n');
    git(root, 'add', '.gitattributes');
    git(root, 'config', 'filter.evil.clean', `/bin/sh -c 'touch ${sentinel}'`);
    git(root, 'config', 'diff.evil.command', `/bin/sh -c 'touch ${sentinel}'`);
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root),
      /refuses ungoverned local config (?:filter|diff)\.evil/,
    );
    assert.throws(() => readFileSync(sentinel), /ENOENT/);
  });

  void it('rejects assume-unchanged, skip-worktree, and fsmonitor-valid index flags', async () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const root = fixture();
      git(root, 'update-index', flag, 'tracked/payload.txt');
      await assert.rejects(
        computeCanonicalGitWorktreeEvidence(root),
        /assume-unchanged, skip-worktree, fsmonitor-valid/,
      );
    }
    const fsmonitorRoot = fixture();
    injectPersistedFsmonitorIndexBit(fsmonitorRoot);
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(fsmonitorRoot),
      /Git index|unknown index entry|git .* failed/,
    );
  });

  void it('detects executable-mode drift even when local core.fileMode is false', async () => {
    const root = fixture();
    git(root, 'config', 'core.fileMode', 'false');
    const clean = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(clean.dirty, false);
    chmodSync(join(root, 'tracked', 'payload.txt'), 0o654);
    const changed = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(changed.dirty, true);
    assert.notEqual(changed.contentSha256, clean.contentSha256);
  });

  void it('proves HEAD-only blobs after a staged deletion', async () => {
    const root = fixture();
    const objectId = git(root, 'rev-parse', 'HEAD:tracked/payload.txt');
    git(root, 'rm', '--quiet', 'tracked/payload.txt');
    const looseObject = join(root, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2));
    writeFileSync(looseObject, 'corrupted HEAD-only object authority\n', 'utf8');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root),
      /git .* failed|blob proof|governed blobs/i,
    );
  });

  void it('rejects transient create-remove races for a tracked missing path', async () => {
    const root = fixture();
    const trackedPath = join(root, 'tracked', 'payload.txt');
    rmSync(trackedPath);
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root, {
        beforeSnapshotVerification: () => {
          writeFileSync(trackedPath, 'governed\n', 'utf8');
          rmSync(trackedPath);
        },
      }),
      /changed during hashing|evidence changed|generation changed|DIRTY_SNAPSHOT_MOVED|raw tracked bytes/i,
    );
  });

  void it('fails closed for gitlinks, partial/promisor config, replace refs, and alternates', async () => {
    const gitlinkRoot = fixture();
    git(
      gitlinkRoot,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${git(gitlinkRoot, 'rev-parse', 'HEAD')},vendor/submodule`,
    );
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(gitlinkRoot),
      /gitlink; submodule content is not recursively governed/,
    );

    const promisorRoot = fixture();
    git(promisorRoot, 'config', 'remote.origin.promisor', 'true');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(promisorRoot),
      /refuses partial\/promisor object authority/,
    );

    const replaceRoot = fixture();
    writeFileSync(join(replaceRoot, 'tracked', 'payload.txt'), 'replacement commit\n', 'utf8');
    git(replaceRoot, 'add', 'tracked/payload.txt');
    git(
      replaceRoot,
      '-c',
      'user.name=Hermetic Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'replacement fixture',
    );
    git(
      replaceRoot,
      'replace',
      git(replaceRoot, 'rev-parse', 'HEAD'),
      git(replaceRoot, 'rev-parse', 'HEAD~1'),
    );
    await assert.rejects(computeCanonicalGitWorktreeEvidence(replaceRoot), /replace refs/);

    const alternateRoot = fixture();
    const alternatePath = fixture();
    writeFileSync(
      join(alternateRoot, '.git', 'objects', 'info', 'alternates'),
      `${join(alternatePath, '.git', 'objects')}\n`,
      'utf8',
    );
    await assert.rejects(computeCanonicalGitWorktreeEvidence(alternateRoot), /object alternates/);
  });

  void it('rejects transient creation of an initially absent topology authority', async () => {
    const root = fixture();
    const alternatesPath = join(root, '.git', 'objects', 'info', 'alternates');
    let injected = false;
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root, {
        afterRepositoryTopologyRead: () => {
          if (injected) return;
          injected = true;
          writeFileSync(alternatesPath, '', 'utf8');
          rmSync(alternatesPath);
        },
      }),
      /parent.*changed|entry-generation|repository-topology observation/,
    );
  });

  void it('does not cache object proofs across independent full evidence generations', async () => {
    const root = fixture();
    await computeCanonicalGitWorktreeEvidence(root);
    const objectId = git(root, 'rev-parse', 'HEAD:tracked/payload.txt');
    const looseObject = join(root, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2));
    writeFileSync(looseObject, 'corrupted object authority\n', 'utf8');
    await assert.rejects(computeCanonicalGitWorktreeEvidence(root), /git .* failed|blob proof/i);
  });

  void it('captures self-hidden untracked .gitignore authority without capturing ignored payloads', async () => {
    const root = fixture();
    const hidden = join(root, 'hidden');
    mkdirSync(hidden);
    writeFileSync(join(hidden, '.gitignore'), '.gitignore\nsecret.txt\n', 'utf8');
    writeFileSync(join(hidden, 'secret.txt'), 'first secret\n', 'utf8');
    const first = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(first.dirty, true);

    writeFileSync(join(hidden, 'secret.txt'), 'second secret\n', 'utf8');
    const ignoredPayloadChanged = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(ignoredPayloadChanged.contentSha256, first.contentSha256);

    writeFileSync(join(hidden, '.gitignore'), '.gitignore\nsecret.txt\n# authority changed\n');
    const authorityChanged = await computeCanonicalGitWorktreeEvidence(root);
    assert.notEqual(authorityChanged.contentSha256, first.contentSha256);
  });

  void it('pins every parent directory descriptor and rejects a parent-to-symlink swap', async () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'hermetic-git-outside-'));
    fixtureRoots.push(outside);
    writeFileSync(join(outside, 'payload.txt'), 'governed\n', 'utf8');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root, {
        beforeSnapshotVerification: () => {
          renameSync(join(root, 'tracked'), join(root, 'tracked-original'));
          symlinkSync(outside, join(root, 'tracked'));
        },
      }),
      /symlink|ELOOP|changed/,
    );
  });

  void it('atomically attests linked-worktree redirect, commondir, and backlink bytes', async () => {
    const fixture = linkedFixture();
    const clean = await computeCanonicalGitWorktreeEvidence(fixture.linked);
    assert.equal(clean.dirty, false);

    const gitDir = git(fixture.linked, 'rev-parse', '--absolute-git-dir');
    writeFileSync(join(gitDir, 'gitdir'), `${fixture.root}/.git\n`, 'utf8');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(fixture.linked),
      /gitdir backlink does not name/,
    );
  });

  void it('rejects same-byte .git generation replacement and invalid UTF-8 metadata', async () => {
    const replaced = linkedFixture();
    const redirectPath = join(replaced.linked, '.git');
    const redirectBytes = readFileSync(redirectPath);
    let replacedOnce = false;
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(replaced.linked, {
        afterRepositoryTopologyRead: () => {
          if (replacedOnce) return;
          replacedOnce = true;
          renameSync(redirectPath, `${redirectPath}.previous`);
          writeFileSync(redirectPath, redirectBytes);
        },
      }),
      /repository-topology observation|generation|changed/,
    );

    const invalid = linkedFixture();
    writeFileSync(
      join(invalid.linked, '.git'),
      Buffer.concat([Buffer.from('gitdir: ', 'ascii'), Buffer.from([0xff]), Buffer.from('\n')]),
    );
    await assert.rejects(computeCanonicalGitWorktreeEvidence(invalid.linked), /not valid UTF-8/);
  });

  void it('rejects tracked paths that cannot cross the UTF-8 manifest boundary', async () => {
    const root = fixture();
    const invalidPath = Buffer.concat([
      Buffer.from(`${root}/`, 'utf8'),
      Buffer.from([0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0xff]),
    ]);
    writeFileSync(invalidPath, 'invalid path\n');
    git(root, 'add', '-A');
    await assert.rejects(computeCanonicalGitWorktreeEvidence(root), /not valid UTF-8/);
  });

  void it('rejects case/normalization collisions and unsupported SHA-256 repositories', async () => {
    const collisionRoot = fixture();
    writeFileSync(join(collisionRoot, 'Case.txt'), 'upper\n', 'utf8');
    writeFileSync(join(collisionRoot, 'case.txt'), 'lower\n', 'utf8');
    git(collisionRoot, 'add', 'Case.txt', 'case.txt');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(collisionRoot),
      /case\/normalization collision/,
    );

    const sha256Root = fixture('sha256');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(sha256Root),
      /repository format 0|governs only repository-format-0 SHA-1/,
    );
  });
});
