#!/usr/bin/env ts-node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
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
  allocationFloorForDomain,
  appendAllocatedFinding,
  assertActiveWorktreeFindingWritersFenced,
  recoverRegistryMutationStaging,
  registryMutationStagingFiles,
  reservedDomainFloorsFromManifest,
  resolveGitFindingAllocationAuthority,
} from './finding-registry';
import {
  atomicWriteFileWithRegistryLease,
  atomicWriteRegistryFile,
  claimedSequences,
  listAtomicWriteStagingFiles,
  nextFindingId,
  orphanMarkdownReservedIds,
  readOrphanMarkdownStore,
  recoverAtomicWriteStagingFiles,
  RegistryLockError,
  type FindingSeverity,
  withRegistryFileLock,
  withRegistryFileLockAsync,
} from './finding-registry-store';
import {
  acquireRepositoryMutationAuthority,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from './github-actions-oidc-authority';
import {
  FINDING_WRITER_AUTHORITY_PATH,
  FINDING_WRITER_GOVERNED_PATHS,
  buildFindingWriterProtocolManifest,
  checkFindingWriterProtocolManifest,
  renderFindingWriterProtocolManifest,
  writeFindingWriterProtocolManifest,
} from './lib/finding-registry-writer-authority';

const childMode = process.argv[2];
let fixtureRoot: string;

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
const CAPABILITY_PLAN_RELATIVE_PATH = join(
  'docs',
  'plans',
  '2026-06-18-enterprise-grade-debt-closure',
);
const CURRENT_BOOT_ID = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const OIDC_NOW_SECONDS = 1_785_283_200;
const OIDC_WORKFLOW_REF =
  'Okan-wqm/aquaculture_platform/.github/workflows/finding-registry-authority.yml@refs/heads/main';
const OIDC_SWEEP_WORKFLOW_REF =
  'Okan-wqm/aquaculture_platform/.github/workflows/finding-state-sweep.yml@refs/heads/main';
const OIDC_REPOSITORY_ID = '1132698735';
const OIDC_REPOSITORY_OWNER_ID = '77401788';
const OIDC_INPUT_SHA256 = 'a'.repeat(64);
const OIDC_EFFECTIVE_AT = '2026-07-29T00:00:00.000Z';

function processStartTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(')');
  assert.ok(commandEnd > 1);
  const fieldsFromState = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fieldsFromState[19];
  assert.match(startTicks ?? '', /^[1-9]\d*$/);
  return startTicks as string;
}

function signedOidcFixture(
  claimOverrides: Readonly<Record<string, unknown>> = {},
  envOverrides: NodeJS.ProcessEnv = {},
): {
  jwt: string;
  jwk: JsonWebKey;
  env: NodeJS.ProcessEnv;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = { alg: 'RS256', kid: 'fixture-key', typ: 'JWT' };
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'aqua-finding-registry-authority-v1',
    sub: 'repo:Okan-wqm/aquaculture_platform:ref:refs/heads/main',
    repository: 'Okan-wqm/aquaculture_platform',
    repository_id: OIDC_REPOSITORY_ID,
    repository_owner_id: OIDC_REPOSITORY_OWNER_ID,
    ref: 'refs/heads/main',
    ref_protected: true,
    sha: '1'.repeat(40),
    workflow_ref: OIDC_WORKFLOW_REF,
    workflow_sha: '1'.repeat(40),
    event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted',
    run_id: '8675309',
    run_attempt: '1',
    jti: 'oidc-fixture-token-id',
    iat: OIDC_NOW_SECONDS - 30,
    nbf: OIDC_NOW_SECONDS - 30,
    exp: OIDC_NOW_SECONDS + 300,
    ...claimOverrides,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), privateKey).toString(
    'base64url',
  );
  return {
    jwt: `${signingInput}.${signature}`,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig', alg: 'RS256' },
    env: {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'Okan-wqm/aquaculture_platform',
      GITHUB_REPOSITORY_ID: OIDC_REPOSITORY_ID,
      GITHUB_REPOSITORY_OWNER_ID: OIDC_REPOSITORY_OWNER_ID,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: '1'.repeat(40),
      GITHUB_RUN_ID: '8675309',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: OIDC_WORKFLOW_REF,
      GITHUB_WORKFLOW_SHA: '1'.repeat(40),
      RUNNER_ENVIRONMENT: 'github-hosted',
      FINDING_COMMAND_ID: 'finding-add:8675309',
      FINDING_INPUT_SHA256: OIDC_INPUT_SHA256,
      FINDING_EFFECTIVE_AT: OIDC_EFFECTIVE_AT,
      ACTIONS_ID_TOKEN_REQUEST_URL:
        'https://pipelines.actions.githubusercontent.com/fixture/oidc?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-scoped-request-token',
      ...envOverrides,
    },
  };
}

function oidcFixtureFetch(jwt: string, jwk: JsonWebKey) {
  return async (
    url: string,
    init?: { readonly headers?: Readonly<Record<string, string>> },
  ): Promise<unknown> => {
    if (url.startsWith('https://pipelines.actions.githubusercontent.com/fixture/oidc')) {
      assert.equal(init?.headers?.Authorization, 'bearer runner-scoped-request-token');
      assert.match(url, /audience=aqua-finding-registry-authority-v1/);
      return { value: jwt };
    }
    if (url.endsWith('/.well-known/openid-configuration')) {
      return {
        issuer: 'https://token.actions.githubusercontent.com',
        jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
      };
    }
    if (url.endsWith('/.well-known/jwks')) {
      return { keys: [jwk] };
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
}

function acquireFixtureAuthority(
  operation: RegistryMutationOperation,
  fixture: ReturnType<typeof signedOidcFixture>,
): Promise<RepositoryMutationAuthority> {
  return acquireRepositoryMutationAuthority(operation, {
    env: fixture.env,
    nowSeconds: () => OIDC_NOW_SECONDS,
    fetchJson: oidcFixtureFetch(fixture.jwt, fixture.jwk),
  });
}

async function issueRepositoryMutationAuthority(
  operation: RegistryMutationOperation,
  claimOverrides: Readonly<Record<string, unknown>> = {},
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<RepositoryMutationAuthority> {
  const workflowRef = operation === 'sweep' ? OIDC_SWEEP_WORKFLOW_REF : OIDC_WORKFLOW_REF;
  const eventName = operation === 'sweep' ? 'schedule' : 'workflow_dispatch';
  const fixture = signedOidcFixture(
    { workflow_ref: workflowRef, event_name: eventName, ...claimOverrides },
    {
      GITHUB_WORKFLOW_REF: workflowRef,
      GITHUB_EVENT_NAME: eventName,
      FINDING_COMMAND_ID: `finding-${operation}:8675309`,
      ...envOverrides,
    },
  );
  return acquireFixtureAuthority(operation, fixture);
}

function writeFindingInventoryFloorAuthority(
  repoRoot: string,
  rawIds: readonly string[],
  reservedDomainFloors: Readonly<Record<string, number>>,
): string {
  const planDirectory = join(repoRoot, CAPABILITY_PLAN_RELATIVE_PATH);
  const schemaDirectory = join(repoRoot, 'docs', 'reviews', '_registry');
  mkdirSync(planDirectory, { recursive: true });
  mkdirSync(schemaDirectory, { recursive: true });
  const schemaPath = join(schemaDirectory, 'findings.jsonl.schema.json');
  if (!existsSync(schemaPath)) {
    copyFileSync(
      resolve(__dirname, '..', '..', 'docs', 'reviews', '_registry', 'findings.jsonl.schema.json'),
      schemaPath,
    );
  }
  const artifactRaw =
    rawIds.length === 0
      ? ''
      : `${rawIds
          .map((rawId, index) =>
            JSON.stringify({
              source_ref: `SRC-FIXTURE#${rawId}-${index}`,
              raw_id: rawId,
            }),
          )
          .join('\n')}\n`;
  const artifactSha256 = createHash('sha256').update(artifactRaw).digest('hex');
  const artifactBasename = `source-findings.${artifactSha256}.jsonl`;
  writeFileSync(join(planDirectory, artifactBasename), artifactRaw, 'utf8');
  const manifestPath = join(planDirectory, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      capability_reconciliation: {
        finding_allocation_policy: {
          allocator: 'tools/gates/finding-registry.ts',
          reserved_domain_floors: reservedDomainFloors,
        },
        finding_inventory: {
          schema_version: 3,
          artifact_path: `docs/plans/2026-06-18-enterprise-grade-debt-closure/${artifactBasename}`,
          artifact_sha256: artifactSha256,
          occurrence_count: rawIds.length,
        },
      },
    }),
    'utf8',
  );
  return manifestPath;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    env: HERMETIC_GIT_ENV,
  }).trim();
}

async function runWorktreeAllocatorChild(): Promise<never> {
  const repoRoot = process.argv[3];
  const registryPath = process.argv[4];
  const schemaPath = process.argv[5];
  const stubPath = process.argv[6];
  if (!repoRoot || !registryPath || !schemaPath || !stubPath) process.exit(64);

  const authority = resolveGitFindingAllocationAuthority(repoRoot);
  const repositoryAuthority = await issueRepositoryMutationAuthority('add');
  const exitCode = withRegistryFileLock(
    registryPath,
    (lease) =>
      appendAllocatedFinding(
        'PROC',
        stubPath,
        lease,
        repositoryAuthority,
        { registryPath, schemaPath },
        authority,
      ),
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
  void runWorktreeAllocatorChild().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
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

  void test('canonical mutation authority verifies a protected-main GitHub Actions OIDC signature', async () => {
    const authority = await issueRepositoryMutationAuthority('add');

    assert.deepEqual(authority, {
      kind: 'GITHUB_ACTIONS_OIDC_V1',
      repository: 'Okan-wqm/aquaculture_platform',
      repositoryId: OIDC_REPOSITORY_ID,
      operation: 'add',
      commandId: 'finding-add:8675309',
      inputSha256: OIDC_INPUT_SHA256,
      effectiveAt: OIDC_EFFECTIVE_AT,
      workflowRef: OIDC_WORKFLOW_REF,
      workflowSha: '1'.repeat(40),
      runId: '8675309',
      runAttempt: '1',
      tokenId: 'oidc-fixture-token-id',
      expiresAt: new Date((OIDC_NOW_SECONDS + 300) * 1000).toISOString(),
    });
  });

  void test('canonical mutation authority accepts the immutable repository subject', async () => {
    const authority = await issueRepositoryMutationAuthority('add', {
      sub: `repo:Okan-wqm@${OIDC_REPOSITORY_OWNER_ID}/aquaculture_platform@${OIDC_REPOSITORY_ID}:ref:refs/heads/main`,
    });
    assert.equal(authority.repositoryId, OIDC_REPOSITORY_ID);
    assert.equal(authority.operation, 'add');
  });

  void test('canonical mutation authority rejects local flags and mutable identity drift', async () => {
    await assert.rejects(
      acquireRepositoryMutationAuthority('add', { env: {} }),
      /only to GitHub Actions OIDC authority/,
    );

    const unprotected = signedOidcFixture({ ref_protected: false });
    await assert.rejects(acquireFixtureAuthority('add', unprotected), /ref_protected/);

    const unprotectedRunner = signedOidcFixture({}, { GITHUB_REF_PROTECTED: 'false' });
    await assert.rejects(
      acquireFixtureAuthority('add', unprotectedRunner),
      /must execute from protected main/,
    );

    for (const [claim, value] of [
      ['repository_id', '9999999999'],
      ['repository_owner_id', '88888888'],
    ] as const) {
      const wrongImmutableIdentity = signedOidcFixture({ [claim]: value });
      await assert.rejects(
        acquireFixtureAuthority('add', wrongImmutableIdentity),
        new RegExp(`jwt\\.${claim}`),
      );
    }
    for (const [field, value] of [
      ['GITHUB_REPOSITORY_ID', '9999999999'],
      ['GITHUB_REPOSITORY_OWNER_ID', '88888888'],
    ] as const) {
      const wrongRunnerIdentity = signedOidcFixture({}, { [field]: value });
      await assert.rejects(
        acquireFixtureAuthority('add', wrongRunnerIdentity),
        /must execute from protected main/,
      );
    }

    const wrongWorkflowSha = signedOidcFixture(
      { workflow_sha: '2'.repeat(40) },
      { GITHUB_WORKFLOW_SHA: '1'.repeat(40) },
    );
    await assert.rejects(acquireFixtureAuthority('add', wrongWorkflowSha), /jwt\.workflow_sha/);
  });

  void test('canonical mutation authority binds operation, command, digest, and effective time', async () => {
    const sweepAuthority = await issueRepositoryMutationAuthority('sweep');
    assert.equal(sweepAuthority.operation, 'sweep');
    assert.equal(sweepAuthority.workflowRef, OIDC_SWEEP_WORKFLOW_REF);

    const sweepFixture = signedOidcFixture(
      { workflow_ref: OIDC_SWEEP_WORKFLOW_REF, event_name: 'schedule' },
      {
        GITHUB_WORKFLOW_REF: OIDC_SWEEP_WORKFLOW_REF,
        GITHUB_EVENT_NAME: 'schedule',
      },
    );
    await assert.rejects(
      acquireFixtureAuthority('add', sweepFixture),
      /not a trusted registry mutation authority/,
    );

    for (const [env, expected] of [
      [{ FINDING_COMMAND_ID: 'short' }, /FINDING_COMMAND_ID/],
      [{ FINDING_INPUT_SHA256: 'A'.repeat(64) }, /FINDING_INPUT_SHA256/],
      [{ FINDING_EFFECTIVE_AT: '2026-07-29T00:00:00Z' }, /FINDING_EFFECTIVE_AT/],
    ] as const) {
      const invalidCommandEnvelope = signedOidcFixture({}, env);
      await assert.rejects(acquireFixtureAuthority('add', invalidCommandEnvelope), expected);
    }
  });

  void test('canonical mutation authority rejects a forged signed-claim envelope', async () => {
    const forged = signedOidcFixture();
    const segments = forged.jwt.split('.');
    assert.equal(segments.length, 3);
    const forgedClaims = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(segments[1] as string, 'base64url').toString('utf8')),
        run_id: '9999999',
      }),
    ).toString('base64url');
    const forgedJwt = `${segments[0]}.${forgedClaims}.${segments[2]}`;
    await assert.rejects(
      acquireFixtureAuthority('add', { ...forged, jwt: forgedJwt }),
      /signature verification failed/,
    );
  });

  void test('registry write boundary rejects fabricated and operation-mismatched authority', async () => {
    const registryPath = join(
      fixtureRoot,
      'repository-authority-boundary',
      'docs',
      'reviews',
      '_registry',
      'findings.jsonl',
    );
    mkdirSync(resolve(registryPath, '..'), { recursive: true });
    writeFileSync(registryPath, 'before\n', 'utf8');
    const addAuthority = await issueRepositoryMutationAuthority('add');
    const sweepAuthority = await issueRepositoryMutationAuthority('sweep');

    withRegistryFileLock(registryPath, (lease) =>
      atomicWriteRegistryFile(registryPath, 'authorized\n', lease, addAuthority, 'add'),
    );
    assert.equal(readFileSync(registryPath, 'utf8'), 'authorized\n');

    const fabricatedAuthority: RepositoryMutationAuthority = { ...addAuthority };
    assert.throws(
      () =>
        withRegistryFileLock(registryPath, (lease) =>
          atomicWriteRegistryFile(registryPath, 'fabricated\n', lease, fabricatedAuthority, 'add'),
        ),
      /does not authorize add/,
    );
    assert.throws(
      () =>
        withRegistryFileLock(registryPath, (lease) =>
          atomicWriteRegistryFile(registryPath, 'wrong-operation\n', lease, sweepAuthority, 'add'),
        ),
      /does not authorize add/,
    );
    assert.throws(
      () =>
        withRegistryFileLock(registryPath, (lease) =>
          atomicWriteFileWithRegistryLease(registryPath, 'generic-bypass\n', lease),
        ),
      /require repository-global OIDC authority/,
    );
    assert.equal(readFileSync(registryPath, 'utf8'), 'authorized\n');
  });

  void test('writer compatibility is a committed content-digest protocol, not source-text heuristics', () => {
    const repoRoot = join(fixtureRoot, 'writer-protocol');
    const governedPaths = [...FINDING_WRITER_GOVERNED_PATHS];
    for (const relativePath of governedPaths) {
      const absolutePath = join(repoRoot, relativePath);
      mkdirSync(resolve(absolutePath, '..'), { recursive: true });
      writeFileSync(absolutePath, `${relativePath}\n`, 'utf8');
    }
    const protocolPath = join(repoRoot, FINDING_WRITER_AUTHORITY_PATH);
    mkdirSync(resolve(protocolPath, '..'), { recursive: true });
    const protocol = buildFindingWriterProtocolManifest(repoRoot);
    assert.equal(writeFindingWriterProtocolManifest(repoRoot), true);
    const firstGeneratedBytes = readFileSync(protocolPath, 'utf8');
    assert.equal(firstGeneratedBytes, renderFindingWriterProtocolManifest(repoRoot));
    assert.equal(writeFindingWriterProtocolManifest(repoRoot), false);
    assert.equal(readFileSync(protocolPath, 'utf8'), firstGeneratedBytes);
    assert.doesNotThrow(() => checkFindingWriterProtocolManifest(repoRoot));
    git(repoRoot, ['init', '--quiet', '--initial-branch=main']);
    git(repoRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(repoRoot, ['config', 'user.name', 'finding-registry-spec']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'writer protocol fixture']);

    assert.doesNotThrow(() => assertActiveWorktreeFindingWritersFenced([repoRoot]));
    writeFileSync(
      join(repoRoot, 'tools/gates/finding-registry.ts'),
      'function cmdAdd() { return "uncommitted"; }\n',
      'utf8',
    );
    assert.throws(
      () => assertActiveWorktreeFindingWritersFenced([repoRoot]),
      /protocol-incompatible finding writers/,
    );

    writeFileSync(
      join(repoRoot, 'tools/gates/finding-registry.ts'),
      'tools/gates/finding-registry.ts\n',
      'utf8',
    );
    writeFileSync(
      protocolPath,
      `${JSON.stringify({
        ...protocol,
        $schema: 'aqua/finding-registry-writer-authority/v2',
        schema_version: 2,
        protocol_id: 'aqua.finding-registry-writer/v3',
        repository_global_authority: {
          ...protocol.repository_global_authority,
          durable_branch_ref: 'refs/heads/automation/finding-registry-active',
          compare_and_swap: 'GITHUB_SHA_EXPECTED_HEAD_V1',
          idempotency: {
            kind: 'PROTECTED_MAIN_COMMIT_TRAILERS_V1',
            required_trailers: [
              'Automation-Command-ID',
              'Automation-Operation',
              'Automation-Input-SHA256',
              'Automation-Base-SHA',
            ],
          },
        },
      })}\n`,
      'utf8',
    );
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'stale fixed-branch authority']);
    assert.throws(
      () => assertActiveWorktreeFindingWritersFenced([repoRoot]),
      /protocol-incompatible finding writers/,
    );
  });

  void test('source-finding inventory floors are part of locked allocation authority', async () => {
    const floorRepoRoot = join(fixtureRoot, 'source-floor-authority');
    const sourceRawIds = [
      'FE-HIGH-064',
      'PLAT-LOW-902',
      'MOB-MEDIUM-018',
      'PROC-HIGH-016',
      'RUST-CVE-002',
      'DB-ADMIN-MEDIUM-007',
    ];
    const expectedFloors = {
      FE: 64,
      PLAT: 902,
      MOB: 18,
      PROC: 16,
      RUST: 2,
      'DB-ADMIN': 7,
    };
    const manifestPath = writeFindingInventoryFloorAuthority(
      floorRepoRoot,
      sourceRawIds,
      expectedFloors,
    );
    const floors = reservedDomainFloorsFromManifest(manifestPath);
    assert.equal(allocationFloorForDomain(floors, 'FE'), 64);
    assert.equal(allocationFloorForDomain(floors, 'PLAT'), 902);
    assert.equal(allocationFloorForDomain(floors, 'MOB'), 18);
    assert.equal(allocationFloorForDomain(floors, 'PROC'), 16);
    assert.equal(allocationFloorForDomain(floors, 'RUST'), 2);
    assert.equal(allocationFloorForDomain(floors, 'DB'), 7);
    assert.throws(
      () =>
        reservedDomainFloorsFromManifest(
          join(floorRepoRoot, CAPABILITY_PLAN_RELATIVE_PATH, 'missing-manifest.json'),
        ),
      /capability manifest is missing/,
    );
    writeFindingInventoryFloorAuthority(floorRepoRoot, sourceRawIds, { ...expectedFloors, FE: 63 });
    assert.throws(
      () => reservedDomainFloorsFromManifest(manifestPath),
      /differ from the content-addressed finding artifact/,
    );
    writeFindingInventoryFloorAuthority(floorRepoRoot, sourceRawIds, expectedFloors);

    const registryPath = join(fixtureRoot, 'source-floor-registry.jsonl');
    const schemaPath = resolve(
      __dirname,
      '..',
      '..',
      'docs',
      'reviews',
      '_registry',
      'findings.jsonl.schema.json',
    );
    const stubPath = join(fixtureRoot, 'source-floor-stub.json');
    const lockPath = `${registryPath}.authority.lock`;
    const reservationPath = `${registryPath}.reservations.json`;
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    writeFileSync(registryPath, '', 'utf8');
    writeFileSync(
      stubPath,
      JSON.stringify({
        severity: 'HIGH',
        title: 'Allocation above source inventory floor',
        evidence: ['tools/gates/finding-registry-store.spec.ts:source-floor'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-29-source-inventory',
      }),
      'utf8',
    );
    const authority = {
      lockPath,
      reservationPath,
      assertCompatibleWriters: () => undefined,
      activeRegistryPaths: () => [registryPath],
      reservedDomainFloors: () => floors,
    };
    const allocated = withRegistryFileLock(
      registryPath,
      (lease) =>
        appendAllocatedFinding(
          'FE',
          stubPath,
          lease,
          repositoryAuthority,
          { registryPath, schemaPath },
          authority,
        ),
      { lockPath },
    );
    assert.equal(allocated, 0);
    assert.match(readFileSync(registryPath, 'utf8'), /"id":"FE-HIGH-065"/);

    const registryBeforeMissingAuthority = readFileSync(registryPath, 'utf8');
    assert.throws(
      () =>
        withRegistryFileLock(
          registryPath,
          (lease) =>
            appendAllocatedFinding(
              'FE',
              stubPath,
              lease,
              repositoryAuthority,
              { registryPath, schemaPath },
              {
                ...authority,
                activeRegistryPaths: () => [
                  registryPath,
                  join(fixtureRoot, 'missing-active-registry.jsonl'),
                ],
              },
            ),
          { lockPath },
        ),
      /active worktree finding registry is missing/i,
    );
    assert.equal(readFileSync(registryPath, 'utf8'), registryBeforeMissingAuthority);
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

  void test('action and release failures are both preserved as fencing evidence', () => {
    const resourcePath = join(fixtureRoot, 'dual-failure.jsonl');
    const lockPath = `${resourcePath}.lock`;
    assert.throws(
      () =>
        withRegistryFileLock(resourcePath, (lease) => {
          writeFileSync(lease.lockPath, 'ownership-corrupted\n', 'utf8');
          throw new Error('business mutation failed');
        }),
      (error: unknown) => {
        if (!(error instanceof AggregateError)) return false;
        assert.match(error.message, /action and lock release both failed/);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /business mutation failed/);
        assert.match(String(error.errors[1]), /ownership was lost/);
        return true;
      },
    );
    rmSync(lockPath);
  });

  void test('async actions retain the lease until settlement and use the same failure contract', async () => {
    const resourcePath = join(fixtureRoot, 'async-action.jsonl');
    const result = await withRegistryFileLockAsync(resourcePath, async (lease) => {
      await Promise.resolve();
      atomicWriteFileWithRegistryLease(resourcePath, 'published\n', lease);
      return 17;
    });

    assert.equal(result, 17);
    assert.equal(readFileSync(resourcePath, 'utf8'), 'published\n');
    assert.equal(existsSync(`${resourcePath}.lock`), false);

    const nonErrorFailure: unknown = undefined;
    let captured: unknown;
    try {
      await withRegistryFileLockAsync(resourcePath, async () => {
        await Promise.resolve();
        throw nonErrorFailure;
      });
      assert.fail('async throw undefined must not be treated as a successful action');
    } catch (error) {
      captured = error;
    }

    assert.ok(captured instanceof Error);
    assert.match(captured.message, /action threw a non-Error value/);
    assert.ok('cause' in captured);
    assert.equal((captured as Error & { cause: unknown }).cause, undefined);
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
    writeFindingInventoryFloorAuthority(repoA, [], {});

    git(repoA, ['init', '--quiet', '--initial-branch=main']);
    git(repoA, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(repoA, ['config', 'user.name', 'finding-registry-spec']);
    git(repoA, ['config', 'commit.gpgsign', 'false']);
    git(repoA, ['add', '.']);
    git(repoA, ['commit', '--quiet', '-m', 'fixture root']);
    git(repoA, ['worktree', 'add', '--quiet', '-b', 'worker-b', repoB]);

    const authorityA = resolveGitFindingAllocationAuthority(repoA);
    const authorityB = resolveGitFindingAllocationAuthority(repoB);
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    assert.equal(authorityA.lockPath, authorityB.lockPath);
    assert.equal(authorityA.reservationPath, authorityB.reservationPath);
    assert.deepEqual(authorityA.activeRegistryPaths(), [registryA, registryB].sort());

    const makeStub = (path: string, severity: FindingSeverity, title: string): void => {
      writeFileSync(
        path,
        JSON.stringify({
          severity,
          title,
          layer: 1,
          evidence: ['tools/gates/finding-registry-store.spec.ts:worktree'],
          owner_agent: 'context-manager',
          raised_in_cycle: '2026-07-17-finding-id-allocator',
        }),
        'utf8',
      );
    };

    const stubA = join(fixtureRoot, 'worktree-a-stub.json');
    const stubB = join(fixtureRoot, 'worktree-b-stub.json');
    makeStub(stubA, 'HIGH', 'Common-dir allocator finding from worktree A');
    makeStub(stubB, 'LOW', 'Common-dir allocator finding from worktree B');

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
    makeStub(localBStub, 'LOW', 'Active worktree high-water finding');
    const localExit = withRegistryFileLock(registryB, (lease) =>
      appendAllocatedFinding('INFRA', localBStub, lease, repositoryAuthority, {
        registryPath: registryB,
        schemaPath: schemaB,
      }),
    );
    assert.equal(localExit, 0);

    const authorityAStub = join(fixtureRoot, 'worktree-a-authority-infra.json');
    makeStub(authorityAStub, 'HIGH', 'Active worktree scanner advances the shared sequence');
    const authorityExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendAllocatedFinding(
          'INFRA',
          authorityAStub,
          lease,
          repositoryAuthority,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(authorityExit, 0);
    assert.match(readFileSync(registryA, 'utf8'), /"id":"INFRA-HIGH-002"/);

    const legacyWorktreeManifest = join(repoB, CAPABILITY_PLAN_RELATIVE_PATH, 'manifest.json');
    writeFileSync(legacyWorktreeManifest, JSON.stringify({ legacy_plan: true }), 'utf8');
    assert.deepEqual(authorityA.reservedDomainFloors(), {});
    assert.throws(
      () => authorityB.reservedDomainFloors(),
      /capability reconciliation is absent or invalid/i,
    );

    const legacyAllocatorPath = join(repoB, 'tools', 'gates', 'finding-registry.ts');
    mkdirSync(join(repoB, 'tools', 'gates'), { recursive: true });
    writeFileSync(
      legacyAllocatorPath,
      "function cmdAdd() { /* legacy direct writer */ }\nif (sub === 'add') cmdAdd();\n",
      'utf8',
    );
    assert.throws(
      () => authorityA.assertCompatibleWriters(),
      /protocol-incompatible finding writers/,
    );

    git(repoA, ['worktree', 'remove', '--force', repoB]);

    const afterRemovalStub = join(fixtureRoot, 'worktree-a-after-removal.json');
    makeStub(afterRemovalStub, 'LOW', 'Durable reservation survives worktree removal');
    const afterRemovalExit = withRegistryFileLock(
      registryA,
      (lease) =>
        appendAllocatedFinding(
          'PROC',
          afterRemovalStub,
          lease,
          repositoryAuthority,
          { registryPath: registryA, schemaPath: schemaA },
          authorityA,
        ),
      { lockPath: authorityA.lockPath },
    );
    assert.equal(afterRemovalExit, 0);
    assert.match(readFileSync(registryA, 'utf8'), /"id":"PROC-LOW-003"/);
  });

  void test('allocated append validates schema and writes under the held lease', async () => {
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
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    writeFileSync(resourcePath, '', 'utf8');
    writeFileSync(
      validStubPath,
      JSON.stringify({
        severity: 'HIGH',
        title: 'Schema-valid allocator test finding',
        evidence: ['tools/gates/finding-registry-store.spec.ts:allocator'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
      }),
      'utf8',
    );

    const exitCode = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', validStubPath, lease, repositoryAuthority, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(exitCode, 0);
    const afterValid = readFileSync(resourcePath, 'utf8');
    assert.match(afterValid, /"id":"PROC-HIGH-001"/);
    assert.match(afterValid, /"state":"OPEN"/);
    assert.match(afterValid, new RegExp(`"created_at":"${OIDC_EFFECTIVE_AT}"`));
    assert.doesNotMatch(afterValid, /"layer":/);

    const invalidStubPath = join(fixtureRoot, 'invalid-stub.json');
    writeFileSync(
      invalidStubPath,
      JSON.stringify({
        severity: 'LOW',
        title: 'short',
        layer: 1,
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
      }),
      'utf8',
    );
    const invalidExitCode = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', invalidStubPath, lease, repositoryAuthority, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(invalidExitCode, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterValid);

    const callerOwnedAuditPath = join(fixtureRoot, 'caller-owned-audit-fields.json');
    writeFileSync(
      callerOwnedAuditPath,
      JSON.stringify({
        severity: 'HIGH',
        state: 'OPEN',
        title: 'Caller must not choose repository audit fields',
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-29-repository-authority',
      }),
      'utf8',
    );
    assert.throws(
      () =>
        withRegistryFileLock(resourcePath, (lease) =>
          appendAllocatedFinding('PROC', callerOwnedAuditPath, lease, repositoryAuthority, {
            registryPath: resourcePath,
            schemaPath,
          }),
        ),
      /authority-owned or unsupported fields: state/,
    );
    assert.equal(readFileSync(resourcePath, 'utf8'), afterValid);

    const invalidEvidenceStubPath = join(fixtureRoot, 'invalid-evidence-stub.json');
    writeFileSync(
      invalidEvidenceStubPath,
      JSON.stringify({
        severity: 'HIGH',
        title: 'Canonical evidence writer validation test finding',
        evidence: ['GitHub Actions run 123456'],
        narrative: ['GitHub Actions run 123456 exposed the defect.'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
      }),
      'utf8',
    );
    const invalidEvidenceExit = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', invalidEvidenceStubPath, lease, repositoryAuthority, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(invalidEvidenceExit, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterValid);

    const emptyHighEvidenceStubPath = join(fixtureRoot, 'empty-high-evidence-stub.json');
    writeFileSync(
      emptyHighEvidenceStubPath,
      JSON.stringify({
        severity: 'HIGH',
        title: 'High-severity findings require resolvable evidence',
        evidence: [],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-07-17-finding-id-allocator',
      }),
      'utf8',
    );
    const emptyHighEvidenceExit = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', emptyHighEvidenceStubPath, lease, repositoryAuthority, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(emptyHighEvidenceExit, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterValid);
  });

  void test('canonical evidence SSOT accepts every supported path shape', async () => {
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
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    writeFileSync(resourcePath, '', 'utf8');
    writeFileSync(
      stubPath,
      JSON.stringify({
        severity: 'HIGH',
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
      }),
      'utf8',
    );

    const exitCode = withRegistryFileLock(resourcePath, (lease) =>
      appendAllocatedFinding('PROC', stubPath, lease, repositoryAuthority, {
        registryPath: resourcePath,
        schemaPath,
      }),
    );
    assert.equal(exitCode, 0);
    assert.match(
      readFileSync(resourcePath, 'utf8'),
      /"narrative":\["Free-form diagnostic prose remains valid here\."\]/,
    );
  });

  void test('dead same-host stale lock is quarantined before takeover', () => {
    const resourcePath = join(fixtureRoot, 'dead-owner.json');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'old\n', 'utf8');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 2,
        token: 'dead-owner',
        pid: 2_147_483_647,
        hostname: hostname(),
        boot_id: CURRENT_BOOT_ID,
        process_start_ticks: '1',
        acquired_at: '2026-01-01T00:00:00.000Z',
        resource_path: resourcePath,
      })}\n`,
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    withRegistryFileLock(
      resourcePath,
      (lease) => atomicWriteFileWithRegistryLease(resourcePath, 'new\n', lease),
      { timeoutMs: 200, staleAfterMs: 10, pollIntervalMs: 5 },
    );

    assert.equal(readFileSync(resourcePath, 'utf8'), 'new\n');
    assert.deepEqual(
      readdirSync(fixtureRoot).filter((name) => name.includes('dead-owner.json.lock')),
      [],
    );
  });

  void test('PID reuse and a prior Linux boot cannot keep a stale lock alive', () => {
    for (const fixture of [
      {
        name: 'pid-reused',
        bootId: CURRENT_BOOT_ID,
        startTicks: `${BigInt(processStartTicks(process.pid)) + 1n}`,
      },
      {
        name: 'prior-boot',
        bootId: '00000000-0000-4000-8000-000000000001',
        startTicks: processStartTicks(process.pid),
      },
    ]) {
      const resourcePath = join(fixtureRoot, `${fixture.name}.json`);
      const lockPath = `${resourcePath}.lock`;
      writeFileSync(resourcePath, 'old\n', 'utf8');
      writeFileSync(
        lockPath,
        `${JSON.stringify({
          version: 2,
          token: fixture.name,
          pid: process.pid,
          hostname: hostname(),
          boot_id: fixture.bootId,
          process_start_ticks: fixture.startTicks,
          acquired_at: '2026-01-01T00:00:00.000Z',
          resource_path: resourcePath,
        })}\n`,
        'utf8',
      );
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      withRegistryFileLock(
        resourcePath,
        (lease) => atomicWriteFileWithRegistryLease(resourcePath, 'new\n', lease),
        { timeoutMs: 200, staleAfterMs: 10, pollIntervalMs: 5 },
      );

      assert.equal(readFileSync(resourcePath, 'utf8'), 'new\n');
      assert.equal(existsSync(lockPath), false);
    }
  });

  void test('proven dead-owner atomic staging files are recovered under the lease', () => {
    const resourcePath = join(fixtureRoot, 'staging-recovery.json');
    const stagingName =
      '.staging-recovery.json.2147483647.123e4567-e89b-42d3-a456-426614174000.new';
    const stagingPath = join(fixtureRoot, stagingName);
    writeFileSync(resourcePath, 'stable\n', 'utf8');
    writeFileSync(stagingPath, 'orphan\n', 'utf8');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(stagingPath, old, old);
    assert.deepEqual(
      listAtomicWriteStagingFiles(fixtureRoot, (basename) => basename === 'staging-recovery.json'),
      [stagingName],
    );

    const recovered = withRegistryFileLock(resourcePath, (lease) =>
      recoverAtomicWriteStagingFiles(
        fixtureRoot,
        (basename) => basename === 'staging-recovery.json',
        lease,
        5 * 60_000,
      ),
    );

    assert.deepEqual(recovered, [stagingName]);
    assert.deepEqual(
      listAtomicWriteStagingFiles(fixtureRoot, (basename) => basename === 'staging-recovery.json'),
      [],
    );
    assert.equal(existsSync(stagingPath), false);
    assert.equal(readFileSync(resourcePath, 'utf8'), 'stable\n');
  });

  void test('canonical registry mutation recovers registry and reservation staging together', () => {
    const registryPath = join(fixtureRoot, 'staging-registry.jsonl');
    const reservationPath = join(fixtureRoot, 'staging-reservations.json');
    const lockPath = join(fixtureRoot, 'staging-registry-authority.lock');
    const registryStagingName =
      '.staging-registry.jsonl.2147483647.123e4567-e89b-42d3-a456-426614174000.new';
    const reservationStagingName =
      '.staging-reservations.json.2147483647.223e4567-e89b-42d3-a456-426614174000.new';
    writeFileSync(registryPath, 'stable\n', 'utf8');
    writeFileSync(join(fixtureRoot, registryStagingName), 'orphan registry\n', 'utf8');
    writeFileSync(join(fixtureRoot, reservationStagingName), 'orphan reservation\n', 'utf8');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(fixtureRoot, registryStagingName), old, old);
    utimesSync(join(fixtureRoot, reservationStagingName), old, old);
    const authority = {
      lockPath,
      reservationPath,
      assertCompatibleWriters: () => undefined,
      activeRegistryPaths: () => [registryPath],
      reservedDomainFloors: () => ({}),
    };

    assert.equal(registryMutationStagingFiles(authority).length, 2);
    withRegistryFileLock(
      registryPath,
      (lease) => recoverRegistryMutationStaging(authority, lease),
      { lockPath },
    );
    assert.deepEqual(registryMutationStagingFiles(authority), []);
    assert.equal(readFileSync(registryPath, 'utf8'), 'stable\n');
  });

  void test('live same-host stale lock waits only to the configured bound', () => {
    const resourcePath = join(fixtureRoot, 'live-owner.json');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'unchanged\n', 'utf8');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 2,
        token: 'live-owner',
        pid: process.pid,
        hostname: hostname(),
        boot_id: CURRENT_BOOT_ID,
        process_start_ticks: processStartTicks(process.pid),
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
          version: 2,
          token: 'foreign-owner',
          pid: 999_999,
          hostname: 'different-host.invalid',
          boot_id: CURRENT_BOOT_ID,
          process_start_ticks: '1',
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
          atomicWriteFileWithRegistryLease(resourcePath, 'must-not-land\n', lease);
        }),
      (error: unknown) => {
        if (!(error instanceof AggregateError) || error.errors.length !== 2) {
          return false;
        }
        return error.errors.every(
          (failure) =>
            failure instanceof RegistryLockError && failure.code === 'LOCK_OWNERSHIP_LOST',
        );
      },
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
      atomicWriteFileWithRegistryLease(resourcePath, 'after\n', lease);
    });
    assert.equal(readFileSync(resourcePath, 'utf8'), 'after\n');
    assert.deepEqual(
      readdirSync(fixtureRoot).filter((name) => name.endsWith('.new')),
      [],
    );
  });

  void test('the repository has one finding-registry writer authority', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const retiredExecutables = [
      'tools/audit/migrate-schema-violations.ts',
      'tools/audit/registry-rechain-after-squash.ts',
      'tools/audit/seed-audit-findings.ts',
      'tools/scripts/patch-registry-phase2b.ts',
      'tools/scripts/seed-claude-audit-findings.ts',
      'tools/scripts/seed-finding-registry.ts',
    ];
    for (const relativePath of retiredExecutables) {
      assert.equal(
        existsSync(resolve(repoRoot, relativePath)),
        false,
        `${relativePath} is retired and must not be recreated`,
      );
    }

    const retiredPostgresAuthority = resolve(
      repoRoot,
      'libs',
      'backend-common',
      'src',
      'finding-registry',
    );
    assert.equal(
      existsSync(retiredPostgresAuthority),
      false,
      'the unused PostgreSQL finding-registry authority must remain absent',
    );

    const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, 'tsconfig.base.json'), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, readonly string[]> };
    };
    assert.equal(
      tsconfig.compilerOptions?.paths?.['@aquaculture/backend-common/finding-registry'],
      undefined,
      'the retired PostgreSQL authority must not remain publicly importable',
    );

    const sourceFiles = execFileSync(
      'git',
      ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
      .split('\n')
      .filter(
        (relativePath) =>
          relativePath.length > 0 &&
          existsSync(resolve(repoRoot, relativePath)) &&
          relativePath !== 'tools/gates/finding-registry-store.ts' &&
          !relativePath.endsWith('.spec.ts'),
      );
    const authorityConsumers = sourceFiles.filter((relativePath) =>
      /\batomicWriteRegistryFile\b/.test(readFileSync(resolve(repoRoot, relativePath), 'utf8')),
    );
    assert.deepEqual(authorityConsumers, ['tools/gates/finding-registry.ts']);

    const canonicalWriter = readFileSync(
      resolve(repoRoot, 'tools/gates/finding-registry.ts'),
      'utf8',
    );
    assert.match(
      canonicalWriter,
      /import\s*\{[\s\S]*\batomicWriteRegistryFile\b[\s\S]*\}\s*from\s*['"]\.\/finding-registry-store['"]/,
    );
    assert.match(canonicalWriter, /\batomicWriteRegistryFile\s*\(/);
  });
}
