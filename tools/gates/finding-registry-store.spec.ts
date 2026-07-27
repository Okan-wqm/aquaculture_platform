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
  resolveGitFindingAllocationAuthority,
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
      [
        'ORPHAN-001',
        'ORPHAN-063',
        'ORPHAN-INFO-363',
        'ORPHAN-LOW-337b',
        'ORPHAN-MEDIUM-031',
      ],
      'a heading form the reader cannot see is a sequence the allocator reuses',
    );
    assert.deepEqual([...store.sequences].sort((a, b) => a - b), [1, 31, 63, 337, 363]);
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
      nextFindingId('ORPHAN', 'HIGH', [
        ...registryIds,
        ...orphanMarkdownReservedIds(path),
      ]),
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
    const claimed = claimedSequences('ORPHAN', [
      'ORPHAN-CRITICAL-332',
      'ORPHAN-RESERVED-416',
    ]);
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
    assert.deepEqual([...claimed].sort((a, b) => a - b), [5]);
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
