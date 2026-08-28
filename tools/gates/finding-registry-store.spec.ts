#!/usr/bin/env ts-node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import {
  appendAllocatedFinding,
  appendExplicitFinding,
  appendNarrativeFinding,
  checkCanonicalRegistryPrefix,
  type FindingAllocationAuthority,
  type Finding,
  parseRechainStartIndex,
  prepareRegistryRechain,
  resolveGitFindingAllocationAuthority,
  validateRegistrySuffixForRechain,
} from './finding-registry';
import {
  atomicWriteRegistryFile,
  claimedSequences,
  nextFindingId,
  orphanMarkdownReservedIds,
  readOrphanMarkdownStore,
  RegistryLockError,
  type FindingSeverity,
  withRegistryFileLock,
} from './finding-registry-store';

const childMode = process.argv[2];
let fixtureRoot: string;

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    env: HERMETIC_GIT_ENV,
  }).trim();
}

function runWorktreeAllocatorChild(): never {
  const repoRoot = process.argv[3];
  const registryPath = process.argv[4];
  const schemaPath = process.argv[5];
  const stubPath = process.argv[6];
  if (!repoRoot || !registryPath || !schemaPath || !stubPath) process.exit(64);

  const authority = resolveGitFindingAllocationAuthority(repoRoot);
  const exitCode = withRegistryFileLock(
    registryPath,
    (lease) =>
      appendAllocatedFinding('PROC', stubPath, lease, { registryPath, schemaPath }, authority),
    {
      lockPath: authority.lockPath,
      timeoutMs: 5_000,
      staleAfterMs: 3_000,
      pollIntervalMs: 10,
    },
  );
  if (exitCode !== 0) process.exit(exitCode);
  process.stdout.write('ok\n');
  process.exit(0);
}

if (childMode === '--worktree-allocator-child') {
  runWorktreeAllocatorChild();
} else {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'finding-registry-store-spec-'));
  void after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  void test('nextFindingId advances one domain-wide sequence across classifiers', () => {
    const id = nextFindingId('FARM', 'HIGH', [
      'FARM-LOW-004',
      'FARM-CRITICAL-012',
      'FARM-DATAMIG-019',
      'SENSOR-HIGH-099',
    ]);
    assert.equal(id, 'FARM-HIGH-020');
  });

  void test('rechain authority preserves the canonical main prefix', () => {
    const canonical = [{ id: 'FARM-HIGH-001' }, { id: 'FARM-HIGH-002' }];
    const branch = [...canonical, { id: 'FARM-HIGH-003' }];

    assert.deepEqual(checkCanonicalRegistryPrefix(branch, canonical, 2), {
      branchSuffixStartIndex: 2,
      violation: null,
    });
    assert.match(
      checkCanonicalRegistryPrefix(branch, canonical, 1).violation ?? '',
      /enters the canonical origin\/main prefix/,
    );
    assert.match(
      checkCanonicalRegistryPrefix(
        [{ id: 'FARM-HIGH-001' }, { id: 'FARM-HIGH-TAMPERED' }, branch[2]],
        canonical,
        2,
      ).violation ?? '',
      /entry 1 differs/,
    );
  });

  void test('rechain index parser rejects partial, signed, padded, and unsafe numbers', () => {
    assert.equal(parseRechainStartIndex('1296'), 1296);
    assert.equal(parseRechainStartIndex('0'), 0);
    for (const invalid of [
      undefined,
      '',
      '01',
      '+1',
      '-1',
      '1.0',
      '1296junk',
      '9007199254740992',
    ]) {
      assert.equal(parseRechainStartIndex(invalid), null);
    }
  });

  void test('nextFindingId rejects malformed domains and exhausted sequences', () => {
    assert.throws(() => nextFindingId('farm', 'LOW', []), /uppercase alphanumeric/);
    assert.throws(() => nextFindingId('INFRA', 'CRITICAL', ['INFRA-LOW-999']), /space exhausted/);
  });

  void test('readOrphanMarkdownStore sees every heading form the file uses', () => {
    const path = join(fixtureRoot, 'orphan-findings.md');
    writeFileSync(
      path,
      [
        '# Orphan findings',
        '',
        '## ORPHAN-001 — pre-severity era',
        '## ORPHAN-063 — pre-severity era',
        '## ORPHAN-MEDIUM-031 — canonical',
        '## ORPHAN-INFO-363 — severity the registry does not use',
        '## ORPHAN-LOW-337b — suffixed re-open',
        '### ORPHAN-HIGH-500 — H3, not a finding heading',
        '## ULTRA-HIGH-091 — different store',
        '',
      ].join('\n'),
      'utf8',
    );
    const store = readOrphanMarkdownStore(path);
    assert.deepEqual(
      [...store.ids].sort(),
      ['ORPHAN-001', 'ORPHAN-063', 'ORPHAN-INFO-363', 'ORPHAN-LOW-337b', 'ORPHAN-MEDIUM-031'],
      'a heading form the reader cannot see is a sequence the allocator reuses',
    );
    assert.deepEqual(
      [...store.sequences].sort((a, b) => a - b),
      [1, 31, 63, 337, 363],
    );
  });

  void test('readOrphanMarkdownStore treats a missing file as empty, not an error', () => {
    const store = readOrphanMarkdownStore(join(fixtureRoot, 'does-not-exist.md'));
    assert.equal(store.ids.size, 0);
    assert.equal(store.sequences.size, 0);
  });

  void test('nextFindingId skips sequences held only by the markdown store', () => {
    // The regression this pins: the registry's ORPHAN maximum was 332
    // while orphan-findings.md was already at 416, and the allocator
    // could not see the markdown. It handed out 333 — a live finding —
    // and the next eighteen after it.
    const path = join(fixtureRoot, 'orphan-collision.md');
    writeFileSync(path, '## ORPHAN-HIGH-416 — occupied\n', 'utf8');
    const registryIds = ['ORPHAN-CRITICAL-332'];
    assert.equal(
      nextFindingId('ORPHAN', 'HIGH', registryIds),
      'ORPHAN-HIGH-333',
      'registry-only view is the pre-fix behaviour',
    );
    assert.equal(
      nextFindingId('ORPHAN', 'HIGH', [...registryIds, ...orphanMarkdownReservedIds(path)]),
      'ORPHAN-HIGH-417',
    );
  });

  void test('claimedSequences matches by sequence, not by full id string', () => {
    // ORPHAN-HIGH-457 — the collision check on the explicit-append path
    // compared full id strings, and never matched. Two independent reasons:
    // the markdown store normalizes to ORPHAN-RESERVED-NNN because a heading
    // records no severity, and the classifier segment varies with severity
    // anyway. So `ORPHAN-MEDIUM-416` was accepted while `416` was a live
    // heading — the very collision that forced this branch to be retraced,
    // reachable through the other door.
    const claimed = claimedSequences('ORPHAN', ['ORPHAN-CRITICAL-332', 'ORPHAN-RESERVED-416']);
    assert.equal(claimed.has(332), true);
    assert.equal(
      claimed.has(416),
      true,
      'a RESERVED-form id must claim its sequence for every severity',
    );
    // The pre-fix comparison, shown failing, so this test cannot pass
    // vacuously if someone reverts to string matching.
    assert.equal(
      ['ORPHAN-CRITICAL-332', 'ORPHAN-RESERVED-416'].includes('ORPHAN-MEDIUM-416'),
      false,
      'string matching does not see the collision — that was the bug',
    );
  });

  void test('claimedSequences ignores other domains', () => {
    const claimed = claimedSequences('ORPHAN', [
      'ORPHAN-HIGH-005',
      'INFRA-CRITICAL-999',
      'SUPPLY-HIGH-005',
    ]);
    assert.deepEqual(
      [...claimed].sort((a, b) => a - b),
      [5],
    );
  });

  const narrativeImportSchemaPath = resolve(
    __dirname,
    '..',
    '..',
    'docs',
    'reviews',
    '_registry',
    'findings.jsonl.schema.json',
  );
  const narrativeReviewFile = 'docs/reviews/orphan-findings.md';

  function narrativeImportFixture(
    name: string,
    options: {
      id?: string;
      severity?: FindingSeverity;
      state?: Finding['state'];
      narrative?: string;
      reviewFile?: string;
      evidence?: string[];
    } = {},
  ): {
    registryPath: string;
    narrativePath: string;
    stubPath: string;
    paths: {
      registryPath: string;
      schemaPath: string;
      narrativePath: string;
      narrativeReviewFile: string;
    };
  } {
    const id = options.id ?? 'ORPHAN-HIGH-775';
    const registryPath = join(fixtureRoot, `${name}.jsonl`);
    const narrativePath = join(fixtureRoot, `${name}.md`);
    const stubPath = join(fixtureRoot, `${name}-stub.json`);
    writeFileSync(registryPath, '', 'utf8');
    writeFileSync(
      narrativePath,
      options.narrative ?? `## ${id} — historical narrative — RESOLVED\n`,
      'utf8',
    );
    writeFileSync(
      stubPath,
      JSON.stringify({
        id,
        severity: options.severity ?? 'HIGH',
        state: options.state ?? 'RESOLVED',
        title: 'Governed historical narrative import finding',
        evidence: options.evidence ?? [`${narrativeReviewFile}#${id}`],
        owner_agent: 'platform-autonomy',
        raised_in_cycle: '2026-08-22-aria-end-to-end-autonomy-closure',
        review_file: options.reviewFile ?? narrativeReviewFile,
        created_at: '2026-08-22T00:00:00.000Z',
      }),
      'utf8',
    );
    return {
      registryPath,
      narrativePath,
      stubPath,
      paths: {
        registryPath,
        schemaPath: narrativeImportSchemaPath,
        narrativePath,
        narrativeReviewFile,
      },
    };
  }

  void test('narrative import appends the exact anchored heading as a new OPEN row', () => {
    const fixture = narrativeImportFixture('narrative-import-success');
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 0);
    const imported = JSON.parse(readFileSync(fixture.registryPath, 'utf8').trim()) as Finding;
    assert.equal(imported.id, 'ORPHAN-HIGH-775');
    assert.equal(imported.state, 'OPEN');
    assert.equal(imported.closed_at, null);
    assert.deepEqual(imported.closing_commits, []);
    assert.match(imported.notes ?? '', /historical narrative.*RESOLVED/i);
  });

  void test('narrative import replay cannot append an already-imported row', () => {
    const fixture = narrativeImportFixture('narrative-import-replay');
    const firstExit = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );
    assert.equal(firstExit, 0);
    const afterFirst = readFileSync(fixture.registryPath, 'utf8');

    const replayExit = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );
    assert.equal(replayExit, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), afterFirst);
  });

  void test('narrative import refuses a sequence claimed by an unrelated heading', () => {
    const fixture = narrativeImportFixture('narrative-import-unrelated', {
      narrative: '## ORPHAN-MEDIUM-775 — a different finding\n',
    });
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
  });

  void test('narrative import refuses an ambiguous duplicate heading', () => {
    const heading = '## ORPHAN-HIGH-775 — duplicated historical finding\n';
    const fixture = narrativeImportFixture('narrative-import-ambiguous', {
      narrative: `${heading}${heading}`,
    });
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
  });

  void test('narrative import refuses an exact heading with a suffixed severity variant on the same sequence', () => {
    const fixture = narrativeImportFixture('narrative-import-conflicting-sequence', {
      narrative:
        '## ORPHAN-HIGH-775 — requested historical finding\n' +
        '## ORPHAN-LOW-775b — conflicting suffixed re-open\n',
    });
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
  });

  void test('narrative import refuses a missing heading', () => {
    const fixture = narrativeImportFixture('narrative-import-missing', {
      narrative: '## ORPHAN-HIGH-776 — another historical finding\n',
    });
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
  });

  void test('narrative import refuses severity drift from the heading id', () => {
    const fixture = narrativeImportFixture('narrative-import-severity', {
      severity: 'MEDIUM',
    });
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 2);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
  });

  void test('narrative import refuses a review file that does not own the heading', () => {
    const fixture = narrativeImportFixture('narrative-import-review-file', {
      reviewFile: 'docs/reviews/other.md',
    });
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
  });

  void test('narrative import refuses evidence that does not resolve to the exact heading', () => {
    const fixture = narrativeImportFixture('narrative-import-evidence', {
      evidence: [`${narrativeReviewFile}#ORPHAN-HIGH-776`],
    });
    const exitCode = withRegistryFileLock(fixture.registryPath, (lease) =>
      appendNarrativeFinding(fixture.stubPath, lease, fixture.paths),
    );

    assert.equal(exitCode, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
  });

  void test('narrative import refuses an id present only in a sibling registry', () => {
    const fixture = narrativeImportFixture('narrative-import-sibling');
    const siblingRegistryPath = join(fixtureRoot, 'narrative-import-sibling-other.jsonl');
    const lockPath = join(fixtureRoot, 'narrative-import-sibling.lock');
    const reservationPath = join(fixtureRoot, 'narrative-import-sibling-reservations.json');
    writeFileSync(siblingRegistryPath, '{"id":"ORPHAN-HIGH-775"}\n', 'utf8');
    const authority: FindingAllocationAuthority = {
      lockPath,
      reservationPath,
      activeRegistryPaths: () => [fixture.registryPath, siblingRegistryPath],
    };

    const exitCode = withRegistryFileLock(
      fixture.registryPath,
      (lease) => appendNarrativeFinding(fixture.stubPath, lease, fixture.paths, authority),
      { lockPath },
    );

    assert.equal(exitCode, 1);
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');
    assert.equal(existsSync(reservationPath), false);
  });

  void test('non-Error action failures remain observable with native cause semantics', () => {
    const resourcePath = join(fixtureRoot, 'non-error-action.jsonl');
    const nonErrorFailure: unknown = undefined;
    let captured: unknown;
    try {
      withRegistryFileLock(resourcePath, () => {
        throw nonErrorFailure;
      });
      assert.fail('throw undefined must not be treated as a successful action');
    } catch (error) {
      captured = error;
    }

    assert.ok(captured instanceof Error);
    assert.match(captured.message, /action threw a non-Error value/);
    assert.ok('cause' in captured);
    assert.equal((captured as Error & { cause: unknown }).cause, undefined);
    assert.equal(Object.prototype.propertyIsEnumerable.call(captured, 'cause'), false);
    assert.equal(existsSync(`${resourcePath}.lock`), false);
  });

  void test('Git common-dir authority serializes and reserves across active worktrees', async () => {
    const repoA = join(fixtureRoot, 'worktree-a');
    const repoB = join(fixtureRoot, 'worktree-b');
    const registryRelativePath = join('docs', 'reviews', '_registry', 'findings.jsonl');
    const schemaRelativePath = join('docs', 'reviews', '_registry', 'findings.jsonl.schema.json');
    const registryA = join(repoA, registryRelativePath);
    const registryB = join(repoB, registryRelativePath);
    const schemaA = join(repoA, schemaRelativePath);
    const schemaB = join(repoB, schemaRelativePath);
    mkdirSync(join(repoA, 'docs', 'reviews', '_registry'), { recursive: true });
    copyFileSync(resolve(__dirname, '..', '..', schemaRelativePath), schemaA);
    writeFileSync(registryA, '', 'utf8');

    git(repoA, ['init', '--quiet', '--initial-branch=main']);
    git(repoA, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(repoA, ['config', 'user.name', 'finding-registry-spec']);
    git(repoA, ['config', 'commit.gpgsign', 'false']);
    git(repoA, ['add', '.']);
    git(repoA, ['commit', '--quiet', '-m', 'fixture root']);
    git(repoA, ['worktree', 'add', '--quiet', '-b', 'worker-b', repoB]);

    const authorityA = resolveGitFindingAllocationAuthority(repoA);
    const authorityB = resolveGitFindingAllocationAuthority(repoB);
    assert.equal(authorityA.lockPath, authorityB.lockPath);
    assert.equal(authorityA.reservationPath, authorityB.reservationPath);
    assert.deepEqual(authorityA.activeRegistryPaths(), [registryA, registryB].sort());

    const makeStub = (
      path: string,
      severity: FindingSeverity,
      title: string,
      createdAt: string,
    ): void => {
      writeFileSync(
        path,
        JSON.stringify({
          severity,
          state: 'OPEN',
          title,
          layer: 1,
          evidence: ['tools/gates/finding-registry-store.spec.ts:worktree'],
          owner_agent: 'context-manager',
          raised_in_cycle: '2026-07-17-finding-id-allocator',
          created_at: createdAt,
        }),
        'utf8',
      );
    };

    const stubA = join(fixtureRoot, 'worktree-a-stub.json');
    const stubB = join(fixtureRoot, 'worktree-b-stub.json');
    makeStub(stubA, 'HIGH', 'Common-dir allocator finding from worktree A', '2026-07-17T01:00:00Z');
    makeStub(stubB, 'LOW', 'Common-dir allocator finding from worktree B', '2026-07-17T01:00:01Z');

    const registerPath = require.resolve('ts-node/register/transpile-only');
    const projectPath = resolve(__dirname, 'tsconfig.json');
    const launch = (
      repoRoot: string,
      registryPath: string,
      schemaPath: string,
      stubPath: string,
    ): Promise<void> =>
      new Promise((resolveChild, rejectChild) => {
        const child = spawn(
          process.execPath,
          [
            '-r',
            registerPath,
            __filename,
            '--worktree-allocator-child',
            repoRoot,
            registryPath,
            schemaPath,
            stubPath,
          ],
          {
            env: { ...process.env, TS_NODE_PROJECT: projectPath },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', rejectChild);
        child.on('exit', (code) => {
          if (code === 0) resolveChild();
          else rejectChild(new Error(`worktree allocator child exited ${code}: ${stderr}`));
        });
      });

    await Promise.all([
      launch(repoA, registryA, schemaA, stubA),
      launch(repoB, registryB, schemaB, stubB),
    ]);

    const worktreeEntries = [registryA, registryB].flatMap((registryPath) =>
      readFileSync(registryPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string }),
    );
    assert.deepEqual(
      worktreeEntries.map((entry) => Number.parseInt(entry.id.slice(-3), 10)).sort((a, b) => a - b),
      [1, 2],
    );
    const reservations = JSON.parse(readFileSync(authorityA.reservationPath, 'utf8')) as {
      domains: Record<string, { sequence: number }>;
    };
    assert.equal(reservations.domains['PROC']?.sequence, 2);

    // Prove active-worktree scanning independently of the reservation file:
    // allocate INFRA locally in B, then allocate via common authority in A.
    const localBStub = join(fixtureRoot, 'worktree-b-local-infra.json');
    makeStub(localBStub, 'LOW', 'Active worktree high-water finding', '2026-07-17T01:00:02Z');
    const localExit = withRegistryFileLock(registryB, (lease) =>
      appendAllocatedFinding('INFRA', localBStub, lease, {
        registryPath: registryB,
        schemaPath: schemaB,
      }),
    );
    assert.equal(localExit, 0);

    const authorityAStub = join(fixtureRoot, 'worktree-a-authority-infra.json');
    makeStub(
      authorityAStub,
      'HIGH',
      'Active worktree scanner advances the shared sequence',
      '2026-07-17T01:00:03Z',
    );
    const authorityExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendAllocatedFinding(
          'INFRA',
          authorityAStub,
          lease,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(authorityExit, 0);
    assert.match(readFileSync(registryA, 'utf8'), /"id":"INFRA-HIGH-002"/);

    const zeroStub = join(fixtureRoot, 'worktree-a-explicit-zero.json');
    makeStub(
      zeroStub,
      'HIGH',
      'Invalid zero suffix must not poison high water',
      '2026-07-17T01:00:03.500Z',
    );
    const zeroValue = JSON.parse(readFileSync(zeroStub, 'utf8')) as Record<string, unknown>;
    zeroValue['id'] = 'PROC-HIGH-000';
    writeFileSync(zeroStub, JSON.stringify(zeroValue), 'utf8');
    const registryBeforeZero = readFileSync(registryA, 'utf8');
    const reservationsBeforeZero = readFileSync(authorityA.reservationPath, 'utf8');
    const zeroExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendExplicitFinding(
          zeroStub,
          lease,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(zeroExit, 2);
    assert.equal(readFileSync(registryA, 'utf8'), registryBeforeZero);
    assert.equal(readFileSync(authorityA.reservationPath, 'utf8'), reservationsBeforeZero);

    // The governed fixed-id path must not provide a cross-worktree bypass.
    // Persist its high-water mark before the branch registry is replaced,
    // reject the same explicit id in another active worktree, then prove the
    // reservation survives removal of the worktree that carried the entry.
    const explicitStub = join(fixtureRoot, 'worktree-b-explicit-proc.json');
    makeStub(
      explicitStub,
      'MEDIUM',
      'Governed explicit import advances shared high water',
      '2026-07-17T01:00:04Z',
    );
    const explicitValue = JSON.parse(readFileSync(explicitStub, 'utf8')) as Record<string, unknown>;
    explicitValue['id'] = 'PROC-MEDIUM-010';
    writeFileSync(explicitStub, JSON.stringify(explicitValue), 'utf8');

    const explicitExit = withRegistryFileLock(
      registryB,
      (lease) =>
        appendExplicitFinding(
          explicitStub,
          lease,
          { registryPath: registryB, schemaPath: schemaB },
          authorityB,
        ),
      { lockPath: authorityB.lockPath },
    );
    assert.equal(explicitExit, 0);
    const duplicateExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendExplicitFinding(
          explicitStub,
          lease,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(duplicateExit, 1);

    const afterExplicit = JSON.parse(readFileSync(authorityA.reservationPath, 'utf8')) as {
      domains: Record<string, { sequence: number }>;
    };
    assert.equal(afterExplicit.domains['PROC']?.sequence, 10);
    git(repoA, ['worktree', 'remove', '--force', repoB]);

    const afterRemovalStub = join(fixtureRoot, 'worktree-a-after-removal.json');
    makeStub(
      afterRemovalStub,
      'LOW',
      'Durable reservation survives worktree removal',
      '2026-07-17T01:00:05Z',
    );
    const afterRemovalExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendAllocatedFinding(
          'PROC',
          afterRemovalStub,
          lease,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(afterRemovalExit, 0);
    assert.match(readFileSync(registryA, 'utf8'), /"id":"PROC-LOW-011"/);

    const cveStub = join(fixtureRoot, 'worktree-a-explicit-cve.json');
    makeStub(
      cveStub,
      'HIGH',
      'CVE classifier advances the domain reservation',
      '2026-07-17T01:00:06Z',
    );
    const cveValue = JSON.parse(readFileSync(cveStub, 'utf8')) as Record<string, unknown>;
    cveValue['id'] = 'RUST-CVE-020';
    writeFileSync(cveStub, JSON.stringify(cveValue), 'utf8');
    const cveExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendExplicitFinding(
          cveStub,
          lease,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(cveExit, 0);

    const afterCveStub = join(fixtureRoot, 'worktree-a-after-cve.json');
    makeStub(
      afterCveStub,
      'LOW',
      'Allocation follows an explicit CVE classifier',
      '2026-07-17T01:00:07Z',
    );
    const afterCveExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendAllocatedFinding(
          'RUST',
          afterCveStub,
          lease,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(afterCveExit, 0);
    assert.match(readFileSync(registryA, 'utf8'), /"id":"RUST-LOW-021"/);
  });

  void test('allocated append validates schema and writes under the held lease', () => {
    const resourcePath = join(fixtureRoot, 'schema-validated.jsonl');
    const schemaPath = resolve(
      __dirname,
      '..',
      '..',
      'docs',
      'reviews',
      '_registry',
      'findings.jsonl.schema.json',
    );
    const validStubPath = join(fixtureRoot, 'valid-stub.json');
    writeFileSync(resourcePath, '', 'utf8');
    writeFileSync(
      validStubPath,
      JSON.stringify({
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Schema-valid allocator test finding',
        evidence: ['tools/gates/finding-registry-store.spec.ts:allocator'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:00.000Z',
      }),
      'utf8',
    );

    const exitCode = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', validStubPath, lease, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(exitCode, 0);
    const afterValid = readFileSync(resourcePath, 'utf8');
    assert.match(afterValid, /"id":"PROC-HIGH-001"/);
    assert.doesNotMatch(afterValid, /"layer":/);

    const explicitWithoutLayerPath = join(fixtureRoot, 'explicit-without-layer.json');
    writeFileSync(
      explicitWithoutLayerPath,
      JSON.stringify({
        id: 'CLAUDE-LOW-001',
        severity: 'LOW',
        state: 'OPEN',
        title: 'Schema-valid explicit finding without a layer',
        evidence: ['tools/gates/finding-registry-store.spec.ts:explicit-no-layer'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:00.500Z',
      }),
      'utf8',
    );
    const explicitWithoutLayerExit = withRegistryFileLock(resourcePath, (lease) =>
      appendExplicitFinding(explicitWithoutLayerPath, lease, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(explicitWithoutLayerExit, 0);
    const afterExplicitWithoutLayer = readFileSync(resourcePath, 'utf8');
    assert.match(afterExplicitWithoutLayer, /"id":"CLAUDE-LOW-001"/);

    const mismatchedClassifierPath = join(fixtureRoot, 'explicit-mismatched-classifier.json');
    writeFileSync(
      mismatchedClassifierPath,
      JSON.stringify({
        id: 'CLAUDE-HIGH-002',
        severity: 'LOW',
        state: 'OPEN',
        title: 'Classifier and severity must remain consistent',
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:00.750Z',
      }),
      'utf8',
    );
    const mismatchedClassifierExit = withRegistryFileLock(resourcePath, (lease) =>
      appendExplicitFinding(mismatchedClassifierPath, lease, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(mismatchedClassifierExit, 2);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterExplicitWithoutLayer);

    const invalidStubPath = join(fixtureRoot, 'invalid-stub.json');
    writeFileSync(
      invalidStubPath,
      JSON.stringify({
        severity: 'LOW',
        state: 'OPEN',
        title: 'short',
        layer: 1,
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:01.000Z',
      }),
      'utf8',
    );
    const invalidExitCode = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', invalidStubPath, lease, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(invalidExitCode, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterExplicitWithoutLayer);

    const invalidEvidenceStubPath = join(fixtureRoot, 'invalid-evidence-stub.json');
    writeFileSync(
      invalidEvidenceStubPath,
      JSON.stringify({
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Canonical evidence writer validation test finding',
        evidence: ['GitHub Actions run 123456'],
        narrative: ['GitHub Actions run 123456 exposed the defect.'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:02.000Z',
      }),
      'utf8',
    );
    const invalidEvidenceExit = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', invalidEvidenceStubPath, lease, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(invalidEvidenceExit, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterExplicitWithoutLayer);

    const invalidExplicitEvidencePath = join(fixtureRoot, 'invalid-explicit-evidence.json');
    writeFileSync(
      invalidExplicitEvidencePath,
      JSON.stringify({
        id: 'CLAUDE-HIGH-003',
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Explicit imports share canonical evidence validation',
        evidence: ['GitHub Actions run 123456'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:02.250Z',
      }),
      'utf8',
    );
    const invalidExplicitEvidenceExit = withRegistryFileLock(resourcePath, (lease) =>
      appendExplicitFinding(invalidExplicitEvidencePath, lease, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(invalidExplicitEvidenceExit, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterExplicitWithoutLayer);

    const emptyHighEvidenceStubPath = join(fixtureRoot, 'empty-high-evidence-stub.json');
    writeFileSync(
      emptyHighEvidenceStubPath,
      JSON.stringify({
        severity: 'HIGH',
        state: 'OPEN',
        title: 'High-severity findings require resolvable evidence',
        evidence: [],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:02.500Z',
      }),
      'utf8',
    );
    const emptyHighEvidenceExit = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', emptyHighEvidenceStubPath, lease, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(emptyHighEvidenceExit, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterExplicitWithoutLayer);
  });

  void test('allocated append admits the governed ARIA finding domain', () => {
    const resourcePath = join(fixtureRoot, 'aria-domain.jsonl');
    const stubPath = join(fixtureRoot, 'aria-domain-stub.json');
    writeFileSync(resourcePath, '', 'utf8');
    writeFileSync(
      stubPath,
      JSON.stringify({
        severity: 'HIGH',
        state: 'OPEN',
        title: 'ARIA closure task has no executable proof',
        evidence: ['docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md#ARIA-HIGH-001'],
        owner_agent: 'platform-autonomy',
        raised_in_cycle: '2026-08-22-autonomy-closure-plan-audit',
        review_file: 'docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md',
        created_at: '2026-08-22T00:00:00.000Z',
      }),
      'utf8',
    );

    const exitCode = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('ARIA', stubPath, lease, {
        registryPath: resourcePath,
        schemaPath: narrativeImportSchemaPath,
      }),
    );

    assert.equal(exitCode, 0);
    assert.match(readFileSync(resourcePath, 'utf8'), /"id":"ARIA-HIGH-001"/);
  });

  void test('canonical evidence SSOT accepts every supported path shape', () => {
    const resourcePath = join(fixtureRoot, 'canonical-evidence.jsonl');
    const schemaPath = resolve(
      __dirname,
      '..',
      '..',
      'docs',
      'reviews',
      '_registry',
      'findings.jsonl.schema.json',
    );
    const stubPath = join(fixtureRoot, 'canonical-evidence-stub.json');
    writeFileSync(resourcePath, '', 'utf8');
    writeFileSync(
      stubPath,
      JSON.stringify({
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Every canonical evidence path shape remains accepted',
        evidence: [
          'file.ts',
          'file.ts:12',
          'file.ts:12-20',
          'file.ts (test)',
          'file.ts#anchor',
          'file.ts:12 (test)',
        ],
        narrative: ['Free-form diagnostic prose remains valid here.'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
        created_at: '2026-07-17T00:00:03.000Z',
      }),
      'utf8',
    );

    const exitCode = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', stubPath, lease, { registryPath: resourcePath, schemaPath }),
    );
    assert.equal(exitCode, 0);
    assert.match(
      readFileSync(resourcePath, 'utf8'),
      /"narrative":\["Free-form diagnostic prose remains valid here\."\]/,
    );

    const validEntry = JSON.parse(readFileSync(resourcePath, 'utf8').trim()) as Finding;
    const invalidRecentEntry = { ...validEntry, evidence: ['GitHub Actions run 123456'] };
    assert.match(
      validateRegistrySuffixForRechain([invalidRecentEntry], 0, schemaPath).join('\n'),
      /refusing|evidence\[0\]|GitHub Actions run 123456/,
    );
    const validBranchTail = { ...validEntry, id: 'PROC-HIGH-999' };
    assert.match(
      validateRegistrySuffixForRechain(
        [validEntry, invalidRecentEntry, validBranchTail],
        1,
        schemaPath,
      ).join('\n'),
      /entry 1.*evidence\[0\]/,
      'semantic validation must start at the canonical boundary even when rehashing starts later',
    );
    const historicalEntry = {
      ...invalidRecentEntry,
      created_at: '2026-05-09T23:59:59.999Z',
    };
    assert.deepEqual(validateRegistrySuffixForRechain([historicalEntry], 0, schemaPath), []);

    const unchained: Finding[] = [
      { ...validEntry, id: 'PROC-HIGH-101' },
      { ...validEntry, id: 'PROC-HIGH-102' },
      { ...validEntry, id: 'PROC-HIGH-103' },
    ];
    const initialized = prepareRegistryRechain(unchained, 0, 0, schemaPath);
    if (!initialized.ok) assert.fail(initialized.failures.join('\n'));
    assert.equal(initialized.ok, true);

    const brokenBeforeRequestedStart = structuredClone(initialized.entries);
    const brokenEntry = brokenBeforeRequestedStart[1];
    assert.ok(brokenEntry);
    brokenEntry.title = 'Semantically valid but hash-stale branch finding';
    const bytesBeforeWrongStart = JSON.stringify(brokenBeforeRequestedStart);
    const wrongStart = prepareRegistryRechain(brokenBeforeRequestedStart, 0, 2, schemaPath);

    assert.equal(wrongStart.ok, false);
    if (wrongStart.ok) assert.fail('a later rechain start must not bless an earlier hash break');
    assert.equal(wrongStart.stage, 'integrity');
    assert.match(wrongStart.failures.join('\n'), /hash mismatch at entry 1/);
    assert.equal(JSON.stringify(brokenBeforeRequestedStart), bytesBeforeWrongStart);
  });

  void test('dead same-host stale lock is quarantined before takeover', () => {
    const resourcePath = join(fixtureRoot, 'dead-owner.json');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'old\n', 'utf8');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        token: 'dead-owner',
        pid: 2_147_483_647,
        hostname: hostname(),
        acquired_at: '2026-01-01T00:00:00.000Z',
        resource_path: resourcePath,
      })}\n`,
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    withRegistryFileLock(
      resourcePath,
      (lease) => atomicWriteRegistryFile(resourcePath, 'new\n', lease),
      { timeoutMs: 200, staleAfterMs: 10, pollIntervalMs: 5 },
    );

    assert.equal(readFileSync(resourcePath, 'utf8'), 'new\n');
    assert.deepEqual(
      readdirSync(fixtureRoot).filter((name) => name.includes('dead-owner.json.lock')),
      [],
    );
  });

  void test('live same-host stale lock waits only to the configured bound', () => {
    const resourcePath = join(fixtureRoot, 'live-owner.json');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'unchanged\n', 'utf8');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        token: 'live-owner',
        pid: process.pid,
        hostname: hostname(),
        acquired_at: '2026-01-01T00:00:00.000Z',
        resource_path: resourcePath,
      })}\n`,
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const startedAt = Date.now();
    assert.throws(
      () =>
        withRegistryFileLock(resourcePath, () => assert.fail('live lock must not be taken over'), {
          timeoutMs: 80,
          staleAfterMs: 10,
          pollIntervalMs: 5,
        }),
      (error: unknown) => error instanceof RegistryLockError && error.code === 'LOCK_TIMEOUT',
    );
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(readFileSync(resourcePath, 'utf8'), 'unchanged\n');
    rmSync(lockPath);
  });

  void test('malformed and foreign-host stale locks fail closed', () => {
    for (const fixture of [
      { name: 'malformed', body: 'not-json\n', code: 'LOCK_MALFORMED' },
      {
        name: 'foreign',
        body: `${JSON.stringify({
          version: 1,
          token: 'foreign-owner',
          pid: 999_999,
          hostname: 'different-host.invalid',
          acquired_at: '2026-01-01T00:00:00.000Z',
          resource_path: 'foreign-resource',
        })}\n`,
        code: 'LOCK_FOREIGN_HOST',
      },
    ] as const) {
      const resourcePath = join(fixtureRoot, `${fixture.name}.json`);
      const lockPath = `${resourcePath}.lock`;
      writeFileSync(resourcePath, 'unchanged\n', 'utf8');
      writeFileSync(lockPath, fixture.body, 'utf8');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      assert.throws(
        () =>
          withRegistryFileLock(
            resourcePath,
            () => assert.fail('unsafe stale lock must not be taken over'),
            { timeoutMs: 100, staleAfterMs: 10, pollIntervalMs: 5 },
          ),
        (error: unknown) => error instanceof RegistryLockError && error.code === fixture.code,
      );
      assert.equal(readFileSync(resourcePath, 'utf8'), 'unchanged\n');
      rmSync(lockPath);
    }
  });

  void test('ownership token fences a writer after lock replacement', () => {
    const resourcePath = join(fixtureRoot, 'fenced.jsonl');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'before\n', 'utf8');

    assert.throws(
      () =>
        withRegistryFileLock(resourcePath, (lease) => {
          const successor = {
            ...JSON.parse(readFileSync(lockPath, 'utf8')),
            token: 'successor-token',
          } as Record<string, unknown>;
          writeFileSync(lockPath, `${JSON.stringify(successor)}\n`, 'utf8');
          atomicWriteRegistryFile(resourcePath, 'must-not-land\n', lease);
        }),
      (error: unknown) =>
        error instanceof RegistryLockError && error.code === 'LOCK_OWNERSHIP_LOST',
    );
    assert.equal(readFileSync(resourcePath, 'utf8'), 'before\n');
    assert.equal(
      (JSON.parse(readFileSync(lockPath, 'utf8')) as { token: string }).token,
      'successor-token',
    );
    rmSync(lockPath);
  });

  void test('atomic writer leaves no staging file after a successful replace', () => {
    const resourcePath = join(fixtureRoot, 'atomic.jsonl');
    writeFileSync(resourcePath, 'before\n', 'utf8');
    withRegistryFileLock(resourcePath, (lease) => {
      atomicWriteRegistryFile(resourcePath, 'after\n', lease);
    });
    assert.equal(readFileSync(resourcePath, 'utf8'), 'after\n');
    assert.deepEqual(
      readdirSync(fixtureRoot).filter((name) => name.endsWith('.new')),
      [],
    );
  });

  void test('historical registry scripts cannot directly rewrite the JSONL', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const governedScripts = [
      'tools/audit/migrate-schema-violations.ts',
      'tools/audit/seed-audit-findings.ts',
      'tools/scripts/patch-registry-phase2b.ts',
      'tools/scripts/seed-claude-audit-findings.ts',
      'tools/scripts/seed-finding-registry.ts',
    ];
    for (const relativePath of governedScripts) {
      const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
      assert.doesNotMatch(
        source,
        /\bwriteFileSync\s*\(\s*(?:REGISTRY|REGISTRY_PATH)\b/,
        `${relativePath} must mutate only through the common authority`,
      );
    }

    assert.match(
      readFileSync(resolve(repoRoot, 'tools/audit/migrate-schema-violations.ts'), 'utf8'),
      /mutating mode is retired/,
    );
    assert.match(
      readFileSync(resolve(repoRoot, 'tools/scripts/patch-registry-phase2b.ts'), 'utf8'),
      /atomicWriteRegistryFile/,
    );
  });
}
