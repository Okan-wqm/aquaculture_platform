import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  REGISTERED_COMMON_DIR_LOCATOR_SCHEMA,
  RegisteredWorktreeSetMismatchError,
  compareRegisteredWorktreeSet,
  discoverRegisteredCommonDirs,
  parseWorktreeList,
  type RegisteredCommonDirLocatorV1,
} from './registered-common-dir-discovery';

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

function repository(name: string): {
  readonly root: string;
  readonly linked: string;
  readonly commonDir: string;
} {
  const container = mkdtempSync(join(tmpdir(), `registered-common-dir-${name}-`));
  fixtureRoots.push(container);
  const root = join(container, 'repository');
  const linked = join(container, 'linked-worktree');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', root]);
  writeFileSync(join(root, 'tracked.txt'), `${name}\n`, 'utf8');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Discovery Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  git(root, 'worktree', 'add', '--quiet', '-b', `${name}-linked`, linked);
  return { root, linked, commonDir: realpathSync(join(root, '.git')) };
}

function locator(id: string, fixture: ReturnType<typeof repository>): RegisteredCommonDirLocatorV1 {
  return Object.freeze({
    schema: REGISTERED_COMMON_DIR_LOCATOR_SCHEMA,
    locatorId: id,
    repositoryId: `${id}-repository`,
    queryWorktreePath: fixture.root,
    commonDirPath: fixture.commonDir,
    worktrees: Object.freeze([
      Object.freeze({ worktreePath: fixture.root, ownerClass: 'REPOSITORY_RUNNER' }),
      Object.freeze({ worktreePath: fixture.linked, ownerClass: 'CODEX' }),
    ]),
  });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

void describe('registered common-dir discovery', () => {
  void it('preserves one locked-state reason and rejects duplicate protocol authority', () => {
    const head = '1'.repeat(40);
    assert.deepEqual(
      parseWorktreeList(
        [
          'worktree /governed',
          `HEAD ${head}`,
          'branch refs/heads/main',
          'locked maintenance',
          '',
        ].join('\0'),
      ),
      [
        {
          path: '/governed',
          headSha: head,
          branchRef: 'refs/heads/main',
          lockReason: 'maintenance',
        },
      ],
    );
    assert.throws(
      () =>
        parseWorktreeList(
          [
            'worktree /governed',
            `HEAD ${head}`,
            'branch refs/heads/main',
            'locked first',
            'locked second',
            '',
          ].join('\0'),
        ),
      /duplicate locked state/,
    );
  });

  void it('observes every registered clean/dirty worktree with owner, HEAD, and exact digests', async () => {
    const fixture = repository('primary');
    writeFileSync(join(fixture.linked, 'dirty.txt'), 'preserve me\n', 'utf8');
    const [observation] = await discoverRegisteredCommonDirs([locator('primary', fixture)]);
    assert.ok(observation);
    assert.equal(observation.worktrees.length, 2);
    assert.equal(observation.repository.objectFormat, 'sha1');
    assert.equal(observation.commonDir.canonicalPath, fixture.commonDir);
    assert.match(observation.repository.sha256, /^[0-9a-f]{64}$/);
    assert.match(observation.commonDir.sha256, /^[0-9a-f]{64}$/);
    assert.match(observation.worktreeSetSha256, /^[0-9a-f]{64}$/);

    const clean = observation.worktrees.find((worktree) => worktree.worktreePath === fixture.root);
    const dirty = observation.worktrees.find(
      (worktree) => worktree.worktreePath === fixture.linked,
    );
    assert.ok(clean);
    assert.ok(dirty);
    assert.equal(clean.dirty, false);
    assert.equal(dirty.dirty, true);
    assert.equal(clean.ownerClass, 'REPOSITORY_RUNNER');
    assert.equal(dirty.ownerClass, 'CODEX');
    for (const worktree of observation.worktrees) {
      assert.match(worktree.headSha, /^[0-9a-f]{40}$/);
      assert.match(worktree.statusSha256, /^[0-9a-f]{64}$/);
      assert.match(worktree.contentSha256, /^[0-9a-f]{64}$/);
      assert.equal(worktree.automaticRetirementAllowed, false);
      assert.equal(worktree.requiredDisposition, 'PRESERVE');
    }
  });

  void it('queries independent registered common-dirs without a shared execution repository', async () => {
    const first = repository('first');
    const second = repository('second');
    const observations = await discoverRegisteredCommonDirs([
      locator('second', second),
      locator('first', first),
    ]);
    assert.deepEqual(
      observations.map((observation) => observation.locatorId),
      ['first', 'second'],
    );
    assert.notEqual(observations[0]?.commonDir.sha256, observations[1]?.commonDir.sha256);
  });

  void it('keeps logical source identity stable while independently attesting clone substrate', async () => {
    const source = repository('logical-source');
    git(source.root, 'worktree', 'remove', '--force', source.linked);

    const replicaContainer = mkdtempSync(join(tmpdir(), 'registered-common-dir-replica-'));
    fixtureRoots.push(replicaContainer);
    const replicaRoot = join(replicaContainer, 'repository');
    execFileSync('/usr/bin/git', ['clone', '--quiet', '--no-hardlinks', source.root, replicaRoot]);
    git(replicaRoot, 'config', 'user.name', 'Different Inert User');
    git(replicaRoot, 'config', 'user.email', 'different@example.invalid');
    const replica = {
      root: replicaRoot,
      linked: join(replicaContainer, 'unused-linked-worktree'),
      commonDir: realpathSync(join(replicaRoot, '.git')),
    };
    const logicalLocator = (
      locatorId: string,
      fixture: typeof source,
    ): RegisteredCommonDirLocatorV1 => ({
      schema: REGISTERED_COMMON_DIR_LOCATOR_SCHEMA,
      locatorId,
      repositoryId: 'governed-logical-repository',
      queryWorktreePath: fixture.root,
      commonDirPath: fixture.commonDir,
      worktrees: [{ worktreePath: fixture.root, ownerClass: 'REPOSITORY_RUNNER' }],
    });

    const [sourceObservation] = await discoverRegisteredCommonDirs([
      logicalLocator('logical-source', source),
    ]);
    const [replicaObservation] = await discoverRegisteredCommonDirs([
      logicalLocator('logical-replica', replica),
    ]);
    assert.ok(sourceObservation);
    assert.ok(replicaObservation);
    assert.equal(sourceObservation.repository.sha256, replicaObservation.repository.sha256);
    assert.equal(sourceObservation.worktreeSetSha256, replicaObservation.worktreeSetSha256);
    assert.equal(
      sourceObservation.worktrees[0]?.logicalIdentitySha256,
      replicaObservation.worktrees[0]?.logicalIdentitySha256,
    );
    assert.notEqual(
      sourceObservation.repository.substrateAttestationSha256,
      replicaObservation.repository.substrateAttestationSha256,
    );
    assert.notEqual(
      sourceObservation.substrateAttestationSha256,
      replicaObservation.substrateAttestationSha256,
    );
  });

  void it('enforces bidirectional set equality and never converts drift into retirement', async () => {
    const fixture = repository('drift');
    const incomplete = locator('drift', fixture);
    const missingLinked: RegisteredCommonDirLocatorV1 = {
      ...incomplete,
      worktrees: incomplete.worktrees.filter((binding) => binding.worktreePath !== fixture.linked),
    };
    await assert.rejects(discoverRegisteredCommonDirs([missingLinked]), (error: unknown) => {
      assert.ok(error instanceof RegisteredWorktreeSetMismatchError);
      assert.deepEqual(error.drifts, [
        {
          code: 'UNREGISTERED_LIVE_WORKTREE',
          worktreePath: fixture.linked,
          automaticRetirementAllowed: false,
          requiredDisposition: 'PRESERVE_AND_RECONCILE_REGISTRATION',
        },
      ]);
      return true;
    });
    assert.equal(existsSync(fixture.root), true);
    assert.equal(existsSync(fixture.linked), true);

    assert.deepEqual(compareRegisteredWorktreeSet(['/a', '/missing'], ['/a', '/extra']), [
      {
        code: 'REGISTERED_WORKTREE_MISSING',
        worktreePath: '/missing',
        automaticRetirementAllowed: false,
        requiredDisposition: 'PRESERVE_AND_RECONCILE_REGISTRATION',
      },
      {
        code: 'UNREGISTERED_LIVE_WORKTREE',
        worktreePath: '/extra',
        automaticRetirementAllowed: false,
        requiredDisposition: 'PRESERVE_AND_RECONCILE_REGISTRATION',
      },
    ]);
  });

  void it('requires explicit owner classes and unique repository/common-dir authorities', async () => {
    const fixture = repository('authority');
    const valid = locator('authority', fixture);
    const unknownOwner = {
      ...valid,
      worktrees: valid.worktrees.map((binding, index) =>
        index === 0 ? { ...binding, ownerClass: 'UNKNOWN' } : binding,
      ),
    } as unknown as RegisteredCommonDirLocatorV1;
    await assert.rejects(discoverRegisteredCommonDirs([unknownOwner]), /closed owner class/);
    await assert.rejects(
      discoverRegisteredCommonDirs([valid, { ...valid, locatorId: 'duplicate' }]),
      /duplicate repository identity authority|duplicate common-dir discovery authority/,
    );
  });

  void it('re-observes the exact worktree protocol after every per-worktree scan', async () => {
    const fixture = repository('torn-registration');
    const extra = join(dirname(fixture.root), 'late-worktree');
    fixtureRoots.push(extra);
    await assert.rejects(
      discoverRegisteredCommonDirs([locator('torn-registration', fixture)], {
        beforeFinalTopologyVerification: () => {
          git(fixture.root, 'worktree', 'add', '--quiet', '--detach', extra);
        },
      }),
      /exact registered worktree protocol changed during discovery/,
    );
  });

  void it('rejects a worktree path move after its canonical evidence scan', async () => {
    const fixture = repository('torn-move');
    const moved = `${fixture.linked}-moved`;
    fixtureRoots.push(moved);
    let movedOnce = false;
    await assert.rejects(
      discoverRegisteredCommonDirs([locator('torn-move', fixture)], {
        afterWorktreeEvidence: (_locatorId, worktreePath) => {
          if (!movedOnce && worktreePath === fixture.linked) {
            movedOnce = true;
            renameSync(fixture.linked, moved);
          }
        },
      }),
      /worktree|generation|ENOENT/,
    );
  });

  void it('re-observes common-dir and object-dir identities after all scans', async () => {
    const commonFixture = repository('torn-common-dir');
    await assert.rejects(
      discoverRegisteredCommonDirs([locator('torn-common-dir', commonFixture)], {
        beforeFinalTopologyVerification: () => {
          writeFileSync(join(commonFixture.commonDir, 'topology-race'), 'changed\n');
        },
      }),
      /common-dir, object-dir, or exact registered worktree protocol changed/,
    );

    const objectFixture = repository('torn-object-dir');
    await assert.rejects(
      discoverRegisteredCommonDirs([locator('torn-object-dir', objectFixture)], {
        beforeFinalTopologyVerification: () => {
          mkdirSync(join(objectFixture.commonDir, 'objects', 'topology-race'));
        },
      }),
      /common-dir, object-dir, or exact registered worktree protocol changed/,
    );
  });
});
