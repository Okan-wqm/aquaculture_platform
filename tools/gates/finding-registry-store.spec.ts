#!/usr/bin/env ts-node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign, type JsonWebKey } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';

import {
  ARIA_AUTHORITY_HASH_SENTINEL,
  CURRENT_STATE_PATH,
  selectAriaAuthorityFiles,
  writeAriaAuthorityHash,
} from './aria-authority-hash';
import {
  allocationFloorForDomain,
  appendAllocatedFinding,
  assertActiveWorktreeFindingWritersFenced,
  FindingWriterFenceAdmissionDeadlineError,
  recoverRegistryMutationStaging,
  registryMutationStagingFiles,
  reservedDomainFloorsFromManifest,
  resolveGitFindingAllocationAuthority,
  runWithPreparedFindingWriterFenceAdmission,
  testOnlyRunWithPreparedFindingWriterFenceAdmission,
  type Finding,
  type FindingAllocationAuthority,
  type FindingWriterFenceCapability,
  type RedeemedFindingWriterFenceCapability,
} from './finding-registry';
import {
  atomicWriteFindingReservationFile,
  atomicWriteRegistryFile,
  assertRegistryLockOwned,
  bindSourceFindingPublicationStore,
  claimedSequences,
  FINDING_WRITER_FLOCK_EXECUTION_POLICY_V1,
  FINDING_WRITER_REGISTRY_LOCK_POLICY_V1,
  listAtomicWriteStagingFiles,
  nextFindingId,
  orphanMarkdownReservedIds,
  readOrphanMarkdownStore,
  recoverAtomicWriteStagingFiles,
  RegistryLockError,
  RegistryTransitionRollbackConflictError,
  SourceFindingTransitionRollbackConflictError,
  testOnlyAtomicWriteFileWithRegistryLease,
  type FindingSeverity,
  type RegistryLockLease,
  testOnlyWithRegistryFileLock,
  testOnlyWithRegistryFileLockAsync,
} from './finding-registry-store';
import {
  acquireRepositoryMutationAuthority,
  FINDING_WRITER_TRUSTED_WORKFLOW_POLICY,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from './github-actions-oidc-authority';
import {
  AnchoredFilesystemError,
  HermeticExecutableExecutionTimeoutError,
  assertStableRegularFileCurrent,
  observeStableRegularFile,
} from './lib/anchored-filesystem';
import {
  assertStoreSpecEntrypointDispatchSetEqualityV1,
  assertStoreSpecProtocolTerminalV1,
  bootstrapStoreSpecChildProcess,
  compileStoreSpecChildArgvV1,
  createStoreSpecBoundedOutputCollectorV1,
  createStoreSpecChildLifecycleStateV1,
  createStoreSpecChildTransitionV1,
  createStoreSpecParentProtocolSessionV1,
  createStoreSpecProtocolStateV1,
  expectedStoreSpecProtocolStepV1,
  isStoreSpecChildModeForEntrypointV1,
  issueStoreSpecProcessSignalV1,
  parseStoreSpecChildMessageV1,
  parseStoreSpecParentMessageV1,
  reduceStoreSpecChildLifecycleV1,
  reduceStoreSpecProtocolV1,
  sendStoreSpecIpcMessageV1,
  storeSpecChildModesForEntrypointV1,
  STORE_SPEC_CHILD_SESSION_ENV,
  STORE_SPEC_TRANSPORT_CONTRACT_V1,
  StoreSpecOutputViolationV1,
  StoreSpecProtocolViolationV1,
  StoreSpecTerminationViolationV1,
  type StoreSpecChildLifecycleStateV1,
  type StoreSpecChildMessageV1,
  type StoreSpecChildModeV1,
  type StoreSpecChildModeForEntrypointV1,
  type StoreSpecChildPhaseKindV1,
  type StoreSpecParentCommandKindV1,
} from './lib/finding-registry-store-child.fixture-protocol';
import {
  FINDING_WRITER_AUTHORITY_PATH,
  FINDING_WRITER_DECLARED_ASSET_EDGES,
  FINDING_WRITER_ENTRYPOINT_PATHS,
  FINDING_WRITER_RETIRED_MUTATION_SURFACES,
  FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY,
  buildFindingWriterProtocolManifest,
  checkFindingWriterProtocolManifest,
  renderFindingWriterProtocolManifest,
  writeFindingWriterProtocolManifest,
} from './lib/finding-registry-writer-authority';
import { writeFindingWriterSensitiveAuthorityFixture } from './lib/finding-registry-writer-authority.fixture';
import { FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS } from './lib/finding-writer-cli-contract';
import {
  assertFindingWriterFenceCurrent,
  assertPendingSourceFindingWriterFenceSessionTransitionBeforeCurrent,
  assertSourceFindingWriterFenceSessionCurrent,
  closeSourceFindingWriterFenceSession,
  consumeFindingWriterFenceSnapshot,
  createFindingWriterFenceSnapshot,
  defineFindingWriterWorktreeTopologyV1,
  FindingWriterFenceGenerationMismatchError,
  FindingWriterFenceStaleError,
  openSourceFindingWriterFenceSession,
  prepareFindingWriterFenceSnapshot,
  prepareSourceFindingWriterFenceSessionTransition,
  redeemRegistryFindingWriterFence,
  releaseFindingWriterFence,
  type FindingWriterAllocationSourceTransition,
  type FindingWriterFenceAuthority,
  type FindingWriterFenceSnapshot,
  type FindingWriterSourceTransitionV1,
  type FindingWriterWorktreeGeneration,
  type FindingWriterWorktreeTopologyV1,
} from './lib/finding-writer-fence';
import { HermeticGitExecutionTimeoutError } from './lib/hermetic-git-runtime';
import {
  executeSourceFindingPublicationTransaction,
  executeSourceFindingRestartRecovery,
  SourceFindingPublicationCrash,
  type SourceFindingPublicationFaultPoint,
  type SourceFindingPublicationTransaction,
} from './lib/source-finding-publication-kernel';

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
const OIDC_NOW_SECONDS = 1_785_283_200;
const OIDC_WORKFLOW_REF =
  'Okan-wqm/aquaculture_platform/.github/workflows/finding-registry-authority.yml@refs/heads/main';
const OIDC_SWEEP_WORKFLOW_REF =
  'Okan-wqm/aquaculture_platform/.github/workflows/finding-state-sweep.yml@refs/heads/main';
const OIDC_REPOSITORY_ID = '1132698735';
const OIDC_REPOSITORY_OWNER_ID = '77401788';
const OIDC_INPUT_SHA256 = 'a'.repeat(64);
const OIDC_EFFECTIVE_AT = '2026-07-29T00:00:00.000Z';

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
  return (
    url: string,
    init?: { readonly headers?: Readonly<Record<string, string>> },
  ): Promise<unknown> => {
    if (url.startsWith('https://pipelines.actions.githubusercontent.com/fixture/oidc')) {
      assert.equal(init?.headers?.Authorization, 'bearer runner-scoped-request-token');
      assert.match(url, /audience=aqua-finding-registry-authority-v1/);
      return Promise.resolve({ value: jwt });
    }
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve({
        issuer: 'https://token.actions.githubusercontent.com',
        jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
      });
    }
    if (url.endsWith('/.well-known/jwks')) {
      return Promise.resolve({ keys: [jwk] });
    }
    return Promise.reject(new Error(`unexpected fixture URL: ${url}`));
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

function initializeQuiescentGitFixture(repoRoot: string): void {
  git(repoRoot, ['init', '--quiet', '--initial-branch=main']);
  git(repoRoot, ['config', 'maintenance.auto', 'false']);
  git(repoRoot, ['config', 'gc.auto', '0']);
}

function symbolicHeadRefPath(repoRoot: string): string {
  const gitDirectory = join(repoRoot, '.git');
  const head = readFileSync(join(gitDirectory, 'HEAD'), 'utf8');
  const match = /^ref: (?<ref>refs\/heads\/[A-Za-z0-9._/-]+)\n$/.exec(head);
  if (match === null || match.groups === undefined || match.groups.ref === undefined) {
    throw new Error('Finding writer deadline fixture requires one symbolic local-branch HEAD');
  }
  const refPath = resolve(gitDirectory, match.groups.ref);
  const localHeadRoot = `${resolve(gitDirectory, 'refs', 'heads')}/`;
  if (!refPath.startsWith(localHeadRoot)) {
    throw new Error('Finding writer deadline fixture HEAD escapes refs/heads');
  }
  return refPath;
}

function fixtureAriaAuthorityFiles(repoRoot: string): string[] {
  return selectAriaAuthorityFiles(
    git(repoRoot, [
      'ls-files',
      'docs/aria',
      'aria-kernel',
      'tools/aria-poc',
      '.github/workflows',
    ]).split(/\r?\n/),
  );
}

function writeFindingAllocationSubstrateFixture(repoRoot: string): {
  readonly registryPath: string;
  readonly schemaPath: string;
} {
  const registryPath = join(repoRoot, 'docs', 'reviews', '_registry', 'findings.jsonl');
  const schemaPath = `${registryPath}.schema.json`;
  mkdirSync(dirname(registryPath), { recursive: true });
  if (!existsSync(registryPath)) writeFileSync(registryPath, '', 'utf8');
  copyFileSync(
    resolve(__dirname, '..', '..', 'docs', 'reviews', '_registry', 'findings.jsonl.schema.json'),
    schemaPath,
  );
  const orphanPath = join(repoRoot, 'docs', 'reviews', 'orphan-findings.md');
  mkdirSync(dirname(orphanPath), { recursive: true });
  if (!existsSync(orphanPath)) writeFileSync(orphanPath, '# Orphan findings\n', 'utf8');
  return { registryPath, schemaPath };
}

function writeWriterProtocolFixture(repoRoot: string): void {
  const writeFixtureFile = (path: string): void => {
    const absolutePath = join(repoRoot, path);
    if (existsSync(absolutePath)) return;
    mkdirSync(dirname(absolutePath), { recursive: true });
    const content = path.endsWith('.json')
      ? '{}\n'
      : /\.(?:[cm]?[jt]sx?)$/.test(path)
        ? 'export {};\n'
        : `${path}\n`;
    writeFileSync(absolutePath, content, 'utf8');
  };

  for (const path of FINDING_WRITER_ENTRYPOINT_PATHS) writeFixtureFile(path);
  writeFindingAllocationSubstrateFixture(repoRoot);
  for (const packageAuthorityPath of ['package.json', 'package-lock.json']) {
    writeFileSync(
      join(repoRoot, packageAuthorityPath),
      readFileSync(resolve(__dirname, '..', '..', packageAuthorityPath)),
    );
  }
  writeFileSync(
    join(repoRoot, 'tools/scripts/automation/tsconfig.json'),
    '{"extends":"../../../tsconfig.base.json"}\n',
    'utf8',
  );
  writeFixtureFile('tsconfig.base.json');

  const actionDirectories = new Set<string>();
  for (const edge of FINDING_WRITER_DECLARED_ASSET_EDGES) {
    writeFixtureFile(edge.from);
    if ('to' in edge) writeFixtureFile(edge.to);
    if (edge.from.startsWith('.github/actions/')) {
      actionDirectories.add(edge.from.split('/').slice(0, 3).join('/'));
    }
  }
  for (const actionDirectory of actionDirectories) {
    const manifestPath = join(repoRoot, actionDirectory, 'action.yml');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      'runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: "true"\n',
      'utf8',
    );
  }
  writeFileSync(
    join(repoRoot, '.github/workflows/ci-full.yml'),
    `jobs:\n  authority:\n    steps:\n      - run: npm run gates:source-finding-inventory:remote\n${[
      ...actionDirectories,
    ]
      .sort()
      .map((path) => `      - uses: ./${path}`)
      .join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    join(repoRoot, '.github/workflows/finding-registry-authority.yml'),
    'jobs:\n  mutate:\n    steps:\n      - run: npm run findings:add\n      - run: npm run findings:close\n',
    'utf8',
  );
  writeFileSync(
    join(repoRoot, '.github/workflows/finding-state-sweep.yml'),
    'jobs:\n  mutate:\n    steps:\n      - run: npm run findings:sweep\n',
    'utf8',
  );
  writeFixtureFile('tools/gates/source-finding-inventory.ts');
  writeFindingWriterSensitiveAuthorityFixture(repoRoot);
  writeFixtureFile('aria-kernel/aria_kernel/preflight.py');
  const currentStatePath = join(repoRoot, CURRENT_STATE_PATH);
  mkdirSync(dirname(currentStatePath), { recursive: true });
  writeFileSync(currentStatePath, `${ARIA_AUTHORITY_HASH_SENTINEL}\n`, 'utf8');
  initializeQuiescentGitFixture(repoRoot);
  git(repoRoot, ['add', '.']);
  writeAriaAuthorityHash(repoRoot, fixtureAriaAuthorityFiles(repoRoot));
}

interface FindingWriterFixture {
  readonly repoRoot: string;
  readonly registryPath: string;
  readonly schemaPath: string;
  readonly authority: FindingAllocationAuthority;
}

function findingWriterTestSignal(): AbortSignal {
  return new AbortController().signal;
}

async function openFindingWriterFifoAfterReader(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      return openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENXIO') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the finding-writer Git FIFO reader: ${path}`);
      }
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
  }
}

type FindingWriterFifoPhase =
  | 'EXECUTION_RESOLVED_BEFORE_FIFO_READY'
  | 'EXECUTION_REJECTED_BEFORE_FIFO_READY'
  | 'FIFO_READY_PATH_IS_NOT_FIFO';

class FindingWriterFifoPhaseError extends Error {
  public readonly code = 'FINDING_WRITER_FIFO_PHASE' as const;

  public constructor(
    public readonly phase: FindingWriterFifoPhase,
    public readonly phaseCause?: unknown,
  ) {
    super(`Finding writer FIFO test failed in phase ${phase}`);
    this.name = 'FindingWriterFifoPhaseError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function awaitFindingWriterFifoReady(
  path: string,
  ready: Promise<void>,
  execution: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    ready,
    execution.then(
      () => {
        throw new FindingWriterFifoPhaseError('EXECUTION_RESOLVED_BEFORE_FIFO_READY');
      },
      (error: unknown) => {
        throw new FindingWriterFifoPhaseError('EXECUTION_REJECTED_BEFORE_FIFO_READY', error);
      },
    ),
  ]);
  if (!lstatSync(path).isFIFO()) {
    throw new FindingWriterFifoPhaseError('FIFO_READY_PATH_IS_NOT_FIFO');
  }
}

function findingWriterTopology(worktreePaths: readonly string[]): FindingWriterWorktreeTopologyV1 {
  return defineFindingWriterWorktreeTopologyV1(
    worktreePaths.map((path) => ({
      path,
      headOid: git(path, ['rev-parse', 'HEAD']),
    })),
  );
}

function assertFindingWriterWorktreesFenced(
  worktreePaths: readonly string[],
  authorityWorktreePath: string,
): Promise<FindingWriterFenceSnapshot> {
  return assertActiveWorktreeFindingWritersFenced(
    findingWriterTopology(worktreePaths),
    authorityWorktreePath,
    findingWriterTestSignal(),
  );
}

function prepareCompatibleWriters(
  authority: FindingAllocationAuthority,
): Promise<FindingWriterFenceSnapshot> {
  return authority.assertCompatibleWriters(findingWriterTestSignal());
}

function consumeSyntheticFindingWriterFence(
  authority: FindingWriterFenceAuthority,
  snapshot: FindingWriterFenceSnapshot,
): Promise<FindingWriterFenceCapability> {
  return consumeFindingWriterFenceSnapshot(authority, snapshot, findingWriterTestSignal());
}

function createFindingWriterFixture(
  name: string,
  reservedDomainFloors: Readonly<Record<string, number>> = {},
  sourceRawIds: readonly string[] = [],
): FindingWriterFixture {
  const repoRoot = join(fixtureRoot, name);
  writeWriterProtocolFixture(repoRoot);
  const { registryPath, schemaPath } = writeFindingAllocationSubstrateFixture(repoRoot);
  writeFindingInventoryFloorAuthority(repoRoot, sourceRawIds, reservedDomainFloors);
  writeFindingWriterProtocolManifest(repoRoot, fixtureAriaAuthorityFiles(repoRoot));
  git(repoRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
  git(repoRoot, ['config', 'user.name', 'finding-registry-spec']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '--quiet', '-m', 'finding writer fixture']);
  return {
    repoRoot,
    registryPath,
    schemaPath,
    authority: resolveGitFindingAllocationAuthority(repoRoot),
  };
}

function canonicalFindingFixtureJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const rendered = JSON.stringify(value);
    if (rendered === undefined) throw new Error('Finding fixture contains undefined JSON');
    return rendered;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalFindingFixtureJson).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalFindingFixtureJson(record[key])}`)
    .join(',')}}`;
}

function findingFixture(overrides: Partial<Finding> = {}): Finding {
  const entry: Finding = {
    id: 'PROC-HIGH-015',
    severity: 'HIGH',
    state: 'OPEN',
    title: 'Immutable allocation identity fixture',
    layer: 1,
    evidence: ['tools/gates/finding-registry-store.spec.ts:identity'],
    rule_violated: 'Finding allocation identity authority',
    owner_agent: 'context-manager',
    raised_in_cycle: '2026-08-08-writer-authority',
    review_file: 'docs/reviews/context-manager/2026-08-08-writer-authority.md',
    created_at: '2026-08-08T00:00:00.000Z',
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes: 'creation note',
    narrative: ['creation narrative'],
    prev_hash: '0'.repeat(64),
    content_hash: '0'.repeat(64),
    ...overrides,
  };
  return entry;
}

function writeFindingRegistryFixture(path: string, entries: readonly Finding[]): Finding[] {
  let previousHash = '0'.repeat(64);
  const chained = entries.map((entry): Finding => {
    const candidate: Finding = {
      ...entry,
      prev_hash: previousHash,
      content_hash: '0'.repeat(64),
    };
    const { content_hash: _contentHash, ...forHash } = candidate;
    candidate.content_hash = createHash('sha256')
      .update(canonicalFindingFixtureJson(forHash), 'utf8')
      .digest('hex');
    previousHash = candidate.content_hash;
    return candidate;
  });
  writeFileSync(path, `${chained.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return chained;
}

async function withFindingWriterMutation<T>(
  fixture: FindingWriterFixture,
  repositoryAuthority: RepositoryMutationAuthority,
  operation: RegistryMutationOperation,
  action: (lease: RegistryLockLease, writerFence: RedeemedFindingWriterFenceCapability) => T,
): Promise<T> {
  const signal = new AbortController().signal;
  const snapshot = await fixture.authority.assertCompatibleWriters(signal);
  return testOnlyWithRegistryFileLockAsync(
    fixture.registryPath,
    async (lease) => {
      const capability = await fixture.authority.consumeCompatibleWriters(snapshot, signal);
      const writerFence = await fixture.authority.redeemCompatibleWriters(
        capability,
        lease,
        {
          kind: 'REGISTRY_MUTATION',
          operation,
          repositoryAuthority,
        },
        signal,
      );
      try {
        return action(lease, writerFence);
      } finally {
        fixture.authority.releaseCompatibleWriters(writerFence);
      }
    },
    { lockPath: fixture.authority.lockPath },
  );
}

function prepareSyntheticFindingWriterFenceSnapshot(
  authority: FindingWriterFenceAuthority,
  worktrees: readonly FindingWriterWorktreeGeneration[],
  callbacks: {
    readonly assertWorktreeGeneration?: (generation: FindingWriterWorktreeGeneration) => void;
    readonly assertCurrent?: () => void;
    readonly assertRegistryTransition?: (registryPath: string, contentSha256: string) => void;
    readonly prepareSourceTransition?: (
      transition: FindingWriterSourceTransitionV1,
    ) => FindingWriterAllocationSourceTransition;
  } = {},
): FindingWriterFenceSnapshot {
  const topology = defineFindingWriterWorktreeTopologyV1(
    worktrees.map((worktree) => ({
      path: worktree.worktree_path,
      headOid: worktree.head_oid,
    })),
  );
  const snapshot = createFindingWriterFenceSnapshot(
    'synthetic-finding-writer-generation',
    worktrees,
    [],
  );
  prepareFindingWriterFenceSnapshot(
    authority,
    snapshot,
    () => {
      for (const worktree of worktrees) callbacks.assertWorktreeGeneration?.(worktree);
      return topology;
    },
    () => {
      for (const worktree of worktrees) callbacks.assertWorktreeGeneration?.(worktree);
      return Promise.resolve(topology);
    },
    {
      snapshot: {
        registryPaths: [],
        claimedIds: [],
        orphanReservedIds: [],
        reservedDomainFloors: {},
      },
      assertCurrent: callbacks.assertCurrent ?? (() => undefined),
      assertRegistryTransition: callbacks.assertRegistryTransition ?? (() => undefined),
      prepareSourceTransition:
        callbacks.prepareSourceTransition ??
        (() => ({
          assertBeforeCurrent: () => undefined,
          prepareAfterCurrent: () => ({ commit: () => undefined }),
          cancelBeforeCurrent: () => undefined,
        })),
    },
  );
  return snapshot;
}

function hasSourceCompensationCapture(value: unknown): value is {
  readonly captureCompensation: (targetPaths: readonly string[]) => unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'captureCompensation' in value &&
    typeof value.captureCompensation === 'function'
  );
}

interface PublicationKernelFixture {
  readonly directory: string;
  readonly manifestPath: string;
  readonly oldArtifactPath: string;
  readonly newArtifactPath: string;
  readonly oldArtifact: string;
  readonly newArtifact: string;
  readonly transaction: SourceFindingPublicationTransaction;
  readonly rollbackCount: () => number;
  readonly recover: () => Promise<void>;
}

function sourceArtifactPath(directory: string, content: string): string {
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  return join(directory, `source-findings.${digest}.jsonl`);
}

function sourceManifest(artifactPath: string): string {
  return `${JSON.stringify({ artifact: basename(artifactPath) })}\n`;
}

function createPublicationKernelFixture(
  name: string,
  collidingNewArtifact?: string,
): PublicationKernelFixture {
  const directory = join(fixtureRoot, name);
  mkdirSync(directory, { recursive: true });
  const manifestPath = join(directory, 'manifest.json');
  const oldArtifact = 'old-cut\n';
  const newArtifact = 'new-cut\n';
  const oldArtifactPath = sourceArtifactPath(directory, oldArtifact);
  const newArtifactPath = sourceArtifactPath(directory, newArtifact);
  writeFileSync(oldArtifactPath, oldArtifact, 'utf8');
  writeFileSync(manifestPath, sourceManifest(oldArtifactPath), 'utf8');
  if (collidingNewArtifact !== undefined) {
    writeFileSync(newArtifactPath, collidingNewArtifact, 'utf8');
  }
  const beforeManifest = readFileSync(manifestPath, 'utf8');
  const beforeNewArtifact = existsSync(newArtifactPath)
    ? readFileSync(newArtifactPath, 'utf8')
    : null;
  let rollbacks = 0;
  let released = false;
  const transaction: SourceFindingPublicationTransaction = {
    prepare: () => {
      assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest);
      assert.equal(readFileSync(oldArtifactPath, 'utf8'), oldArtifact);
    },
    publishArtifact: () => {
      if (existsSync(newArtifactPath)) {
        if (readFileSync(newArtifactPath, 'utf8') !== newArtifact) {
          throw new Error('immutable artifact collision');
        }
        return;
      }
      writeFileSync(newArtifactPath, newArtifact, { encoding: 'utf8', flag: 'wx' });
    },
    verifyArtifact: () => {
      assert.equal(readFileSync(newArtifactPath, 'utf8'), newArtifact);
      assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest);
    },
    publishManifestCommitMarker: () => {
      const stagingPath = join(directory, '.manifest.next');
      writeFileSync(stagingPath, sourceManifest(newArtifactPath), {
        encoding: 'utf8',
        flag: 'wx',
      });
      renameSync(stagingPath, manifestPath);
    },
    cleanupSupersededArtifacts: (checkpoint) => {
      if (existsSync(oldArtifactPath)) {
        unlinkSync(oldArtifactPath);
        checkpoint();
      }
    },
    verifyCommittedCut: () => {
      assert.equal(readFileSync(manifestPath, 'utf8'), sourceManifest(newArtifactPath));
      assert.equal(readFileSync(newArtifactPath, 'utf8'), newArtifact);
      assert.equal(existsSync(oldArtifactPath), false);
    },
    rollback: () => {
      rollbacks += 1;
      writeFileSync(oldArtifactPath, oldArtifact, 'utf8');
      writeFileSync(manifestPath, beforeManifest, 'utf8');
      if (beforeNewArtifact === null) {
        if (existsSync(newArtifactPath)) unlinkSync(newArtifactPath);
      } else {
        writeFileSync(newArtifactPath, beforeNewArtifact, 'utf8');
      }
    },
    release: () => {
      if (released) throw new Error('publication transaction released twice');
      released = true;
    },
  };
  const recover = async (): Promise<void> => {
    let selectedPath: string | null = null;
    let superseded: string[] = [];
    await executeSourceFindingRestartRecovery({
      readAndVerifyManifestCommitMarker: () => {
        const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifact?: unknown };
        if (typeof value.artifact !== 'string') throw new Error('invalid commit marker');
        selectedPath = join(directory, value.artifact);
        superseded = readdirSync(directory)
          .filter((entry) => /^source-findings\.[0-9a-f]{64}\.jsonl$/.test(entry))
          .map((entry) => join(directory, entry))
          .filter((entry) => entry !== selectedPath)
          .sort();
      },
      verifySelectedArtifact: () => {
        if (selectedPath === null) throw new Error('missing recovery selection');
        const selected = readFileSync(selectedPath, 'utf8');
        assert.equal(sourceArtifactPath(directory, selected), selectedPath);
      },
      removeOneSupersededArtifact: () => {
        const candidate = superseded.shift();
        if (candidate === undefined) return false;
        unlinkSync(candidate);
        return true;
      },
      syncRecoveredCut: () => undefined,
    });
  };
  return {
    directory,
    manifestPath,
    oldArtifactPath,
    newArtifactPath,
    oldArtifact,
    newArtifact,
    transaction,
    rollbackCount: () => rollbacks,
    recover,
  };
}

async function runWorktreeAllocatorChild(): Promise<void> {
  const repoRoot = process.argv[3];
  const registryPath = process.argv[4];
  const schemaPath = process.argv[5];
  const stubPath = process.argv[6];
  if (!repoRoot || !registryPath || !schemaPath || !stubPath) {
    throw new Error('Worktree allocator child requires repo, registry, schema, and stub paths');
  }
  const session = await bootstrapStoreSpecChildProcess('--worktree-allocator-child');

  const authority = resolveGitFindingAllocationAuthority(repoRoot);
  const repositoryAuthority = await issueRepositoryMutationAuthority('add');
  let preparationAttempts = 0;
  const exitCode = await runWithPreparedFindingWriterFenceAdmission({
    resourcePath: registryPath,
    lockPath: authority.lockPath,
    prepareSnapshot: async (signal) => {
      preparationAttempts += 1;
      const snapshot = await authority.assertCompatibleWriters(signal);
      if (preparationAttempts === 1) {
        await session.emitPhase('PREPARED_SNAPSHOT', signal);
      }
      return snapshot;
    },
    admit: async (snapshot, lease, signal) => {
      const capability = await authority.consumeCompatibleWriters(snapshot, signal);
      return authority.redeemCompatibleWriters(
        capability,
        lease,
        {
          kind: 'REGISTRY_MUTATION',
          operation: 'add',
          repositoryAuthority,
        },
        signal,
      );
    },
    run: (writerFence, lease) => {
      try {
        return appendAllocatedFinding(
          'PROC',
          stubPath,
          lease,
          repositoryAuthority,
          writerFence,
          authority,
          { registryPath, schemaPath },
        );
      } finally {
        authority.releaseCompatibleWriters(writerFence);
      }
    },
  });
  if (exitCode !== 0) {
    throw new Error(`Worktree allocator exited with ${String(exitCode)}`);
  }
  await session.emitPhase('ALLOCATION_COMMITTED', { preparationAttempts });
  session.assertTerminal();
  process.exitCode = 0;
  if (process.connected) process.disconnect();
}

class StoreSpecAdversarialFixtureViolationV1 extends Error {
  readonly code = 'STORE_SPEC_ADVERSARIAL_FIXTURE_VIOLATION_V1' as const;

  constructor(message: string) {
    super(message);
    this.name = 'StoreSpecAdversarialFixtureViolationV1';
  }
}

async function runStoreSpecOutputOverflowChild(): Promise<void> {
  await bootstrapStoreSpecChildProcess('--transport-output-overflow-child');
  const outputLimit = STORE_SPEC_TRANSPORT_CONTRACT_V1.output.stdout.maxBytes;
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(Buffer.alloc(outputLimit + 1, 0x61), (error) => {
      if (error === null || error === undefined) resolveWrite();
      else rejectWrite(error);
    });
  });
  await new Promise<void>((_resolveWait, rejectWait) => {
    setTimeout(
      () =>
        rejectWait(
          new StoreSpecAdversarialFixtureViolationV1(
            'Output-overflow child was not fenced by the parent transport',
          ),
        ),
      STORE_SPEC_TRANSPORT_CONTRACT_V1.progressDeadlineMs * 2,
    );
  });
}

async function runStoreSpecCloseStallChild(): Promise<void> {
  const session = await bootstrapStoreSpecChildProcess('--transport-close-stall-child');
  const retainedPipeLifetimeMs =
    STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.closeAfterExitDeadlineMs + 1_000;
  const retainedPipeOwner = spawn(
    process.execPath,
    ['-e', `setTimeout(() => undefined, ${String(retainedPipeLifetimeMs)})`],
    {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  retainedPipeOwner.unref();
  await session.emitPhase('LOCK_ACQUIRED');
  session.assertTerminal();
  process.exitCode = 0;
  if (process.connected) process.disconnect();
}

interface StoreSpecChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface SpawnedStoreSpecChild {
  readonly completion: Promise<StoreSpecChildResult>;
  readonly mode: StoreSpecChildModeV1;
  readonly process: ReturnType<typeof spawn>;
  readonly sessionId: string;
  readonly termination: Promise<StoreSpecChildResult>;
  sendCommand(kind: StoreSpecParentCommandKindV1): Promise<void>;
  terminateForCleanup(): void;
  terminateExpected(signal: NodeJS.Signals): Promise<StoreSpecChildResult>;
  waitForPhase(kind: StoreSpecChildPhaseKindV1): Promise<StoreSpecChildMessageV1>;
}

function spawnStoreSpecChild(
  mode: StoreSpecChildModeV1,
  args: readonly string[],
): SpawnedStoreSpecChild {
  const contract = STORE_SPEC_TRANSPORT_CONTRACT_V1.modes[mode];
  const sessionId = randomUUID();
  const child = spawn(process.execPath, compileStoreSpecChildArgvV1(__dirname, mode, args), {
    env: {
      ...process.env,
      [STORE_SPEC_CHILD_SESSION_ENV]: sessionId,
      [STORE_SPEC_TRANSPORT_CONTRACT_V1.environment.tsNodeProject]: resolve(
        __dirname,
        'tsconfig.json',
      ),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdout === null || childStderr === null) {
    if (!child.kill(STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.failureSignal)) {
      throw new StoreSpecTerminationViolationV1(
        'SIGNAL_REJECTED',
        `Finding registry store child exposed no output pipes and rejected its failure signal: ${mode}`,
      );
    }
    throw new StoreSpecProtocolViolationV1(
      `Finding registry store child exposed no output pipes: ${mode}`,
    );
  }

  const stdout = createStoreSpecBoundedOutputCollectorV1('stdout');
  const stderr = createStoreSpecBoundedOutputCollectorV1('stderr');
  let lifecycle: StoreSpecChildLifecycleStateV1 = createStoreSpecChildLifecycleStateV1();
  let signalAttempted = false;
  let expectedTerminationWasRequested = false;
  let closeObserved = false;
  const observedPhases = new Map<StoreSpecChildPhaseKindV1, StoreSpecChildMessageV1>();
  const phaseWaiters = new Map<
    StoreSpecChildPhaseKindV1,
    Set<{
      readonly reject: (error: Error) => void;
      readonly resolve: (message: StoreSpecChildMessageV1) => void;
    }>
  >();
  const protocol = createStoreSpecParentProtocolSessionV1(mode, sessionId);
  let progressDeadline: NodeJS.Timeout | undefined;
  let exitDeadline: NodeJS.Timeout | undefined;
  let closeDeadline: NodeJS.Timeout | undefined;
  let terminationSettled = false;
  let resolveTermination!: (result: StoreSpecChildResult) => void;
  let rejectTermination!: (error: Error) => void;
  const termination = new Promise<StoreSpecChildResult>((resolveChild, rejectChild) => {
    resolveTermination = resolveChild;
    rejectTermination = rejectChild;
  });
  void termination.catch(() => undefined);

  const rejectPhaseWaiters = (error: Error): void => {
    for (const waiters of phaseWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    phaseWaiters.clear();
  };

  const publishLifecycle = (next: StoreSpecChildLifecycleStateV1): void => {
    lifecycle = next;
    if (lifecycle.status !== 'FAILED') return;
    if (progressDeadline !== undefined) clearTimeout(progressDeadline);
    rejectPhaseWaiters(lifecycle.failure);
  };

  const registerLifecycleFailure = (error: Error): void => {
    publishLifecycle(
      reduceStoreSpecChildLifecycleV1(lifecycle, {
        failure: error,
        type: 'TRANSPORT_FAILED',
      }),
    );
  };

  const releaseExpiredTransport = (): void => {
    childStdout.destroy();
    childStderr.destroy();
    if (child.connected) {
      try {
        child.disconnect();
      } catch (error) {
        registerLifecycleFailure(error instanceof Error ? error : new Error(String(error)));
      }
    }
    child.unref();
  };

  const rejectBoundedTermination = (error: StoreSpecTerminationViolationV1): void => {
    registerLifecycleFailure(error);
    if (!terminationSettled) {
      terminationSettled = true;
      rejectTermination(lifecycle.status === 'FAILED' ? lifecycle.failure : error);
    }
    releaseExpiredTransport();
  };

  const armExitDeadline = (): void => {
    if (closeObserved) return;
    if (exitDeadline !== undefined) clearTimeout(exitDeadline);
    exitDeadline = setTimeout(() => {
      rejectBoundedTermination(
        new StoreSpecTerminationViolationV1(
          'EXIT_DEADLINE_EXCEEDED',
          `Finding registry store child did not exit within ${String(STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.exitAfterSignalDeadlineMs)}ms after signal: ${mode}`,
        ),
      );
    }, STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.exitAfterSignalDeadlineMs);
  };

  const armCloseDeadline = (): void => {
    if (closeObserved) return;
    if (closeDeadline !== undefined) clearTimeout(closeDeadline);
    closeDeadline = setTimeout(() => {
      rejectBoundedTermination(
        new StoreSpecTerminationViolationV1(
          'CLOSE_DEADLINE_EXCEEDED',
          `Finding registry store child did not close within ${String(STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.closeAfterExitDeadlineMs)}ms after exit: ${mode}`,
        ),
      );
    }, STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.closeAfterExitDeadlineMs);
  };

  const requestFailureSignal = (): void => {
    if (lifecycle.exit !== null) {
      armCloseDeadline();
      return;
    }
    if (signalAttempted) return;
    signalAttempted = true;
    const signalResult = issueStoreSpecProcessSignalV1(
      lifecycle,
      STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.failureSignal,
      (signal) => child.kill(signal),
    );
    publishLifecycle(signalResult.lifecycle);
    armExitDeadline();
  };

  const failLifecycle = (error: Error): void => {
    registerLifecycleFailure(error);
    requestFailureSignal();
  };

  const armProgressDeadline = (): void => {
    if (progressDeadline !== undefined) clearTimeout(progressDeadline);
    if (lifecycle.status !== 'RUNNING') return;
    progressDeadline = setTimeout(() => {
      failLifecycle(
        new StoreSpecProtocolViolationV1(
          `Finding registry store child made no protocol progress for ${String(STORE_SPEC_TRANSPORT_CONTRACT_V1.progressDeadlineMs)}ms: ${mode}`,
        ),
      );
    }, STORE_SPEC_TRANSPORT_CONTRACT_V1.progressDeadlineMs);
  };
  armProgressDeadline();

  childStdout.on('data', (chunk: Buffer) => {
    try {
      stdout.append(chunk);
    } catch (error) {
      failLifecycle(error instanceof Error ? error : new Error(String(error)));
    }
  });
  childStderr.on('data', (chunk: Buffer) => {
    try {
      stderr.append(chunk);
    } catch (error) {
      failLifecycle(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const onStdoutError = (error: Error): void => {
    failLifecycle(error);
  };
  const onStderrError = (error: Error): void => {
    failLifecycle(error);
  };
  childStdout.on('error', onStdoutError);
  childStderr.on('error', onStderrError);

  child.on('message', (message: unknown) => {
    publishLifecycle(
      reduceStoreSpecChildLifecycleV1(lifecycle, {
        type: 'CHILD_MESSAGE',
      }),
    );
    if (lifecycle.status === 'FAILED') return;
    try {
      const parsed = protocol.observeChild(message);
      if (observedPhases.has(parsed.kind)) {
        throw new StoreSpecProtocolViolationV1(
          `Finding registry store child duplicated ${parsed.kind}: ${mode}`,
        );
      }
      observedPhases.set(parsed.kind, parsed);
      const waiters = phaseWaiters.get(parsed.kind);
      if (waiters !== undefined) {
        phaseWaiters.delete(parsed.kind);
        for (const waiter of waiters) waiter.resolve(parsed);
      }
      armProgressDeadline();
    } catch (error) {
      failLifecycle(error instanceof Error ? error : new Error(String(error)));
    }
  });

  child.once('error', (error) => {
    failLifecycle(error);
  });
  child.once('disconnect', () => {
    publishLifecycle(
      reduceStoreSpecChildLifecycleV1(lifecycle, {
        type: 'IPC_DISCONNECTED',
      }),
    );
    if (lifecycle.status === 'RUNNING') {
      try {
        protocol.assertTerminal();
      } catch (error) {
        failLifecycle(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  child.once('exit', (code, signal) => {
    if (progressDeadline !== undefined) clearTimeout(progressDeadline);
    if (exitDeadline !== undefined) clearTimeout(exitDeadline);
    publishLifecycle(
      reduceStoreSpecChildLifecycleV1(lifecycle, {
        result: { code, signal },
        type: 'EXITED',
      }),
    );
    armCloseDeadline();
  });
  child.once('close', (code, signal) => {
    closeObserved = true;
    childStdout.off('error', onStdoutError);
    childStderr.off('error', onStderrError);
    if (progressDeadline !== undefined) clearTimeout(progressDeadline);
    if (exitDeadline !== undefined) clearTimeout(exitDeadline);
    if (closeDeadline !== undefined) clearTimeout(closeDeadline);
    let capturedStdout = '';
    let capturedStderr = '';
    try {
      capturedStdout = stdout.readUtf8();
      capturedStderr = stderr.readUtf8();
    } catch (error) {
      failLifecycle(error instanceof Error ? error : new Error(String(error)));
    }
    const result = { code, signal, stderr: capturedStderr, stdout: capturedStdout };
    let protocolTerminal = true;
    try {
      protocol.assertTerminal();
    } catch {
      protocolTerminal = false;
    }
    publishLifecycle(
      reduceStoreSpecChildLifecycleV1(lifecycle, {
        protocolTerminal,
        result,
        type: 'CLOSED',
      }),
    );
    if (!terminationSettled) {
      terminationSettled = true;
      resolveTermination(result);
    }
  });
  const completion = termination.then((result) => {
    if (lifecycle.status === 'FAILED') throw lifecycle.failure;
    if (expectedTerminationWasRequested) {
      rejectPhaseWaiters(
        new StoreSpecProtocolViolationV1(
          `Finding registry store child ended at its explicit ${String(result.signal)} test boundary: ${mode}`,
        ),
      );
    }
    return result;
  });
  void completion.catch(() => undefined);

  const sendCommand = (kind: StoreSpecParentCommandKindV1): Promise<void> => {
    if (lifecycle.status === 'FAILED') return Promise.reject(lifecycle.failure);
    if (lifecycle.status !== 'RUNNING') {
      return Promise.reject(
        new StoreSpecProtocolViolationV1(
          `Finding registry store child cannot receive ${kind} after termination began: ${mode}`,
        ),
      );
    }
    let message;
    try {
      message = protocol.command(kind);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failLifecycle(failure);
      return Promise.reject(failure);
    }
    return sendStoreSpecIpcMessageV1(child.connected, (callback) => {
      child.send(message, callback);
    }).then(
      () => {
        armProgressDeadline();
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        failLifecycle(failure);
        throw failure;
      },
    );
  };

  const waitForPhase = (kind: StoreSpecChildPhaseKindV1): Promise<StoreSpecChildMessageV1> => {
    const declared = contract.transcript.some(
      (step) => step.actor === 'CHILD' && step.kind === kind,
    );
    if (!declared) {
      return Promise.reject(
        new StoreSpecProtocolViolationV1(
          `Finding registry store mode ${mode} does not declare child phase ${kind}`,
        ),
      );
    }
    const observed = observedPhases.get(kind);
    if (observed !== undefined) return Promise.resolve(observed);
    if (lifecycle.status === 'FAILED') return Promise.reject(lifecycle.failure);
    if (lifecycle.status !== 'RUNNING') {
      return Promise.reject(
        new StoreSpecProtocolViolationV1(
          `Finding registry store child cannot await ${kind} after termination began: ${mode}`,
        ),
      );
    }
    return new Promise<StoreSpecChildMessageV1>((resolveWait, rejectWait) => {
      const waiters = phaseWaiters.get(kind) ?? new Set();
      waiters.add({ reject: rejectWait, resolve: resolveWait });
      phaseWaiters.set(kind, waiters);
    });
  };

  return {
    completion,
    mode,
    process: child,
    sendCommand,
    sessionId,
    terminateExpected: async (signal) => {
      const expected = contract.expectedTestTermination;
      if (
        expected === null ||
        expected.signal !== signal ||
        protocol.state.sequence !== expected.atSequence ||
        lifecycle.status !== 'RUNNING'
      ) {
        throw new StoreSpecProtocolViolationV1(
          `Finding registry store expected termination is out of phase: ${mode}`,
        );
      }
      const requestedLifecycle = reduceStoreSpecChildLifecycleV1(lifecycle, {
        signal,
        type: 'EXPECTED_TERMINATION_REQUESTED',
      });
      if (requestedLifecycle.status !== 'EXPECTED_TERMINATION_REQUESTED') {
        throw requestedLifecycle.status === 'FAILED'
          ? requestedLifecycle.failure
          : new StoreSpecProtocolViolationV1(
              `Finding registry store expected termination did not enter its governed phase: ${mode}`,
            );
      }
      publishLifecycle(requestedLifecycle);
      expectedTerminationWasRequested = true;
      if (progressDeadline !== undefined) clearTimeout(progressDeadline);
      signalAttempted = true;
      const signalResult = issueStoreSpecProcessSignalV1(lifecycle, signal, (requestedSignal) =>
        child.kill(requestedSignal),
      );
      publishLifecycle(signalResult.lifecycle);
      armExitDeadline();
      if (!signalResult.signalIssued) {
        if (signalResult.lifecycle.status === 'FAILED') throw signalResult.lifecycle.failure;
        throw new StoreSpecTerminationViolationV1(
          'SIGNAL_REJECTED',
          `Finding registry store child rejected expected ${signal}: ${mode}`,
        );
      }
      return completion;
    },
    terminateForCleanup: () => {
      if (closeObserved || lifecycle.exit !== null) return;
      failLifecycle(
        new StoreSpecProtocolViolationV1(
          `Finding registry store child required bounded cleanup before completion: ${mode}`,
        ),
      );
    },
    termination,
    waitForPhase,
  };
}

async function terminateStoreSpecChild(child: SpawnedStoreSpecChild): Promise<void> {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.terminateForCleanup();
  }
  await Promise.allSettled([child.completion, child.termination]);
}

type StoreSpecLocalChildModeV1 = StoreSpecChildModeForEntrypointV1<'STORE_SPEC'>;

const STORE_SPEC_LOCAL_CHILD_DISPATCH_V1 = Object.freeze({
  '--transport-close-stall-child': runStoreSpecCloseStallChild,
  '--transport-output-overflow-child': runStoreSpecOutputOverflowChild,
  '--worktree-allocator-child': runWorktreeAllocatorChild,
} satisfies Record<StoreSpecLocalChildModeV1, () => Promise<void>>);

assertStoreSpecEntrypointDispatchSetEqualityV1('STORE_SPEC', STORE_SPEC_LOCAL_CHILD_DISPATCH_V1);

const storeSpecChildEntrypoint = isStoreSpecChildModeForEntrypointV1('STORE_SPEC', childMode)
  ? STORE_SPEC_LOCAL_CHILD_DISPATCH_V1[childMode]
  : null;

if (storeSpecChildEntrypoint !== null) {
  void storeSpecChildEntrypoint().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
} else {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'finding-registry-store-spec-'));
  void after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  void test('child IPC envelopes are session-bound, sequenced, and closed to extra fields', () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const bootstrap = {
      kind: 'BOOTSTRAPPED',
      mode: '--kernel-lock-holder',
      payload: {},
      protocolVersion: 1,
      sequence: 0,
      sessionId,
    } as const;
    assert.deepEqual(
      parseStoreSpecChildMessageV1(bootstrap, {
        mode: '--kernel-lock-holder',
        sessionId,
      }),
      bootstrap,
    );
    const start = {
      kind: 'START',
      mode: '--worktree-allocator-child',
      payload: {},
      protocolVersion: 1,
      sequence: 1,
      sessionId,
    } as const;
    assert.deepEqual(
      parseStoreSpecParentMessageV1(start, {
        mode: '--worktree-allocator-child',
        sessionId,
      }),
      start,
    );

    for (const invalid of [
      { ...bootstrap, extra: true },
      { ...bootstrap, mode: '--kernel-lock-contender' },
      { ...bootstrap, payload: { extra: true } },
      { ...bootstrap, protocolVersion: 2 },
      { ...bootstrap, sequence: -1 },
      { ...bootstrap, sessionId: '223e4567-e89b-42d3-a456-426614174000' },
      { ...bootstrap, mode: 'toString' },
    ]) {
      assert.throws(
        () =>
          parseStoreSpecChildMessageV1(invalid, {
            mode: '--kernel-lock-holder',
            sessionId,
          }),
        StoreSpecProtocolViolationV1,
      );
    }
    assert.throws(
      () =>
        parseStoreSpecChildMessageV1(
          {
            ...bootstrap,
            kind: 'ALLOCATION_COMMITTED',
            mode: '--worktree-allocator-child',
            payload: { preparationAttempts: 0 },
            sequence: 4,
          },
          { mode: '--worktree-allocator-child', sessionId },
        ),
      StoreSpecProtocolViolationV1,
    );
  });

  void test('one exhaustive mode descriptor drives every legal protocol transcript', () => {
    assert.equal(Object.isFrozen(STORE_SPEC_TRANSPORT_CONTRACT_V1), true);
    assert.equal(Object.isFrozen(STORE_SPEC_TRANSPORT_CONTRACT_V1.entrypoints), true);
    assert.equal(Object.isFrozen(STORE_SPEC_TRANSPORT_CONTRACT_V1.loaderProfiles), true);
    assert.equal(Object.isFrozen(STORE_SPEC_TRANSPORT_CONTRACT_V1.termination), true);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(STORE_SPEC_TRANSPORT_CONTRACT_V1.loaderProfiles).map(
          ([profileId, profile]) => [profileId, profile.module],
        ),
      ),
      {
        TS_NODE_REGISTER: 'ts-node/register',
        TS_NODE_TRANSPILE_ONLY: 'ts-node/register/transpile-only',
      },
    );
    assert.equal(STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.failureSignal, 'SIGKILL');
    for (const deadline of [
      STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.exitAfterSignalDeadlineMs,
      STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.closeAfterExitDeadlineMs,
    ]) {
      assert.equal(Number.isSafeInteger(deadline) && deadline > 0, true);
    }
    for (const [mode, contract] of Object.entries(STORE_SPEC_TRANSPORT_CONTRACT_V1.modes) as Array<
      [StoreSpecChildModeV1, (typeof STORE_SPEC_TRANSPORT_CONTRACT_V1.modes)[StoreSpecChildModeV1]]
    >) {
      let state = createStoreSpecProtocolStateV1(mode);
      const entrypoint = STORE_SPEC_TRANSPORT_CONTRACT_V1.entrypoints[contract.entrypoint];
      const loaderProfile =
        STORE_SPEC_TRANSPORT_CONTRACT_V1.loaderProfiles[entrypoint.loaderProfile];
      assert.equal(Object.isFrozen(contract), true);
      assert.equal(Object.isFrozen(entrypoint), true);
      assert.equal(Object.isFrozen(loaderProfile), true);
      assert.equal(Object.isFrozen(contract.transcript), true);
      assert.equal(Object.hasOwn(entrypoint, 'loaderModule'), false);
      assert.equal(resolve(loaderProfile.coordinate), loaderProfile.coordinate);
      const argv = compileStoreSpecChildArgvV1('/governed/gates', mode, ['fixture-argument']);
      assert.deepEqual(argv, [
        '-r',
        loaderProfile.coordinate,
        resolve('/governed/gates', entrypoint.entrypointRelativeToGates),
        mode,
        'fixture-argument',
      ]);
      for (const step of contract.transcript) {
        assert.deepEqual(expectedStoreSpecProtocolStepV1(state), step);
        assert.throws(() => assertStoreSpecProtocolTerminalV1(state), StoreSpecProtocolViolationV1);
        state = reduceStoreSpecProtocolV1(state, {
          actor: step.actor,
          kind: step.kind,
          sequence: state.sequence,
        } as Parameters<typeof reduceStoreSpecProtocolV1>[1]);
      }
      assert.equal(expectedStoreSpecProtocolStepV1(state), null);
      assert.doesNotThrow(() => assertStoreSpecProtocolTerminalV1(state));
    }
    const catalogModes = Object.keys(STORE_SPEC_TRANSPORT_CONTRACT_V1.modes).sort();
    const entrypointModes = (['LOCK_FIXTURE', 'STORE_SPEC'] as const)
      .flatMap((entrypoint) => storeSpecChildModesForEntrypointV1(entrypoint))
      .sort();
    assert.deepEqual(entrypointModes, catalogModes);
    assert.deepEqual(storeSpecChildModesForEntrypointV1('LOCK_FIXTURE'), [
      '--kernel-lock-holder',
      '--kernel-lock-contender',
    ]);
    assert.deepEqual(storeSpecChildModesForEntrypointV1('STORE_SPEC'), [
      '--worktree-allocator-child',
      '--transport-output-overflow-child',
      '--transport-close-stall-child',
    ]);
    assert.doesNotThrow(() =>
      assertStoreSpecEntrypointDispatchSetEqualityV1(
        'STORE_SPEC',
        STORE_SPEC_LOCAL_CHILD_DISPATCH_V1,
      ),
    );
    assert.throws(
      () =>
        assertStoreSpecEntrypointDispatchSetEqualityV1('STORE_SPEC', {
          '--worktree-allocator-child': runWorktreeAllocatorChild,
        }),
      StoreSpecProtocolViolationV1,
    );
  });

  void test('bounded output collectors enforce byte-exact limits and strict UTF-8', () => {
    for (const channel of ['stdout', 'stderr'] as const) {
      const limit = STORE_SPEC_TRANSPORT_CONTRACT_V1.output[channel].maxBytes;
      const belowLimit = createStoreSpecBoundedOutputCollectorV1(channel);
      belowLimit.append(Buffer.alloc(limit - 1, 0x61));
      assert.equal(belowLimit.byteLength, limit - 1);
      assert.equal(Buffer.byteLength(belowLimit.readUtf8(), 'utf8'), limit - 1);

      const atLimit = createStoreSpecBoundedOutputCollectorV1(channel);
      atLimit.append(Buffer.alloc(limit, 0x62));
      assert.equal(atLimit.byteLength, limit);
      assert.equal(Buffer.byteLength(atLimit.readUtf8(), 'utf8'), limit);

      const aboveLimit = createStoreSpecBoundedOutputCollectorV1(channel);
      aboveLimit.append(Buffer.alloc(limit, 0x63));
      assert.throws(
        () => aboveLimit.append(Buffer.from('d')),
        (error: unknown) =>
          error instanceof StoreSpecOutputViolationV1 &&
          error.channel === channel &&
          error.limitBytes === limit &&
          error.observedBytes === limit + 1,
      );
      assert.equal(aboveLimit.byteLength, limit);
    }

    const multibyte = createStoreSpecBoundedOutputCollectorV1('stdout');
    const multibyteLimit = STORE_SPEC_TRANSPORT_CONTRACT_V1.output.stdout.maxBytes;
    const fish = Buffer.from('🐟', 'utf8');
    const exactMultibyte = Buffer.alloc(multibyteLimit);
    for (let offset = 0; offset < exactMultibyte.byteLength; offset += fish.byteLength) {
      fish.copy(exactMultibyte, offset);
    }
    multibyte.append(exactMultibyte.subarray(0, 1));
    multibyte.append(exactMultibyte.subarray(1));
    assert.equal(Buffer.byteLength(multibyte.readUtf8(), 'utf8'), multibyteLimit);
    assert.throws(() => multibyte.append(fish), StoreSpecOutputViolationV1);

    const invalidUtf8 = createStoreSpecBoundedOutputCollectorV1('stderr');
    invalidUtf8.append(Buffer.from([0xc3, 0x28]));
    assert.throws(() => invalidUtf8.readUtf8(), StoreSpecOutputViolationV1);
  });

  void test('output overflow fails the event handler and rejects pending phase waiters', async () => {
    const overflowChild = spawnStoreSpecChild('--transport-output-overflow-child', []);
    let waiterFailure: StoreSpecOutputViolationV1 | undefined;
    try {
      await overflowChild.waitForPhase('BOOTSTRAPPED');
      const pendingPhase = overflowChild.waitForPhase('LOCK_ACQUIRED');
      await overflowChild.sendCommand('START');
      await assert.rejects(pendingPhase, (error: unknown) => {
        if (!(error instanceof StoreSpecOutputViolationV1)) return false;
        waiterFailure = error;
        return (
          error.channel === 'stdout' &&
          error.limitBytes === STORE_SPEC_TRANSPORT_CONTRACT_V1.output.stdout.maxBytes &&
          error.observedBytes > error.limitBytes
        );
      });
      await assert.rejects(overflowChild.completion, (error: unknown) => error === waiterFailure);
      const closure = await overflowChild.termination;
      assert.equal(closure.code, null);
      assert.equal(closure.signal, 'SIGKILL');
    } finally {
      await terminateStoreSpecChild(overflowChild);
    }
  });

  void test('stdout and stderr stream errors enter the same first-failure lifecycle', async () => {
    for (const channel of ['stdout', 'stderr'] as const) {
      const child = spawnStoreSpecChild('--transport-output-overflow-child', []);
      const streamFailure = new Error(`injected ${channel} stream failure`);
      try {
        await child.waitForPhase('BOOTSTRAPPED');
        const pendingPhase = child.waitForPhase('LOCK_ACQUIRED');
        const stream = child.process[channel];
        if (stream === null) assert.fail(`${channel} stream is unavailable`);
        stream.emit('error', streamFailure);
        await assert.rejects(pendingPhase, (error: unknown) => error === streamFailure);
        await assert.rejects(child.completion, (error: unknown) => error === streamFailure);
        const closure = await child.termination;
        assert.equal(closure.code, null);
        assert.equal(closure.signal, STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.failureSignal);
      } finally {
        await terminateStoreSpecChild(child);
      }
    }
  });

  void test('exit without close is bounded by the versioned termination contract', async () => {
    const closeStallChild = spawnStoreSpecChild('--transport-close-stall-child', []);
    let deadlineFailure: StoreSpecTerminationViolationV1 | undefined;
    const startedAt = Date.now();
    try {
      await closeStallChild.waitForPhase('BOOTSTRAPPED');
      await closeStallChild.sendCommand('START');
      await closeStallChild.waitForPhase('LOCK_ACQUIRED');
      await assert.rejects(closeStallChild.termination, (error: unknown) => {
        if (!(error instanceof StoreSpecTerminationViolationV1)) return false;
        deadlineFailure = error;
        return error.reason === 'CLOSE_DEADLINE_EXCEEDED';
      });
      await assert.rejects(
        closeStallChild.completion,
        (error: unknown) => error === deadlineFailure,
      );
      assert.equal(closeStallChild.process.exitCode, 0);
      assert.equal(closeStallChild.process.signalCode, null);
      assert.equal(
        Date.now() - startedAt >=
          STORE_SPEC_TRANSPORT_CONTRACT_V1.termination.closeAfterExitDeadlineMs,
        true,
      );
    } finally {
      await terminateStoreSpecChild(closeStallChild);
    }
  });

  void test('lifecycle rejects a child message after expected termination begins', () => {
    const requested = reduceStoreSpecChildLifecycleV1(createStoreSpecChildLifecycleStateV1(), {
      signal: 'SIGKILL',
      type: 'EXPECTED_TERMINATION_REQUESTED',
    });
    const lateMessage = reduceStoreSpecChildLifecycleV1(requested, {
      type: 'CHILD_MESSAGE',
    });
    if (lateMessage.status !== 'FAILED') {
      assert.fail('late child message did not fail the lifecycle');
    }
    assert.match(lateMessage.failure.message, /after termination began/);
  });

  void test('lifecycle rejects close-before-disconnect', () => {
    const exited = reduceStoreSpecChildLifecycleV1(createStoreSpecChildLifecycleStateV1(), {
      result: { code: 0, signal: null },
      type: 'EXITED',
    });
    const closed = reduceStoreSpecChildLifecycleV1(exited, {
      protocolTerminal: true,
      result: { code: 0, signal: null },
      type: 'CLOSED',
    });
    if (closed.status !== 'FAILED') {
      assert.fail('close-before-disconnect did not fail the lifecycle');
    }
    assert.match(closed.failure.message, /before its IPC channel disconnected/);
  });

  void test('IPC send callback errors preserve their typed failure', async () => {
    const callbackFailure = new Error('injected child.send callback failure');
    await assert.rejects(
      sendStoreSpecIpcMessageV1(true, (callback) => callback(callbackFailure)),
      (error: unknown) => error === callbackFailure,
    );
  });

  void test('operation-local child transitions own every rejection race', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const sendFailure = new Error('injected send rejection');
      const sendRejected = createStoreSpecChildTransitionV1(Promise.reject(sendFailure), true);
      await assert.rejects(sendRejected.completion, (error: unknown) => error === sendFailure);

      for (const label of ['abort', 'disconnect', 'parse'] as const) {
        const transitionFailure = new Error(`injected ${label} transition failure`);
        const transition = createStoreSpecChildTransitionV1(
          new Promise<void>(() => undefined),
          true,
        );
        transition.fail(transitionFailure);
        await assert.rejects(
          transition.completion,
          (error: unknown) => error === transitionFailure,
        );
      }

      const combinedSendFailure = new Error('injected combined send failure');
      const combinedAbortFailure = new Error('injected combined abort failure');
      const combined = createStoreSpecChildTransitionV1(Promise.reject(combinedSendFailure), true);
      combined.fail(combinedAbortFailure);
      await assert.rejects(
        combined.completion,
        (error: unknown) => error === combinedSendFailure || error === combinedAbortFailure,
      );

      const successful = createStoreSpecChildTransitionV1(Promise.resolve(), true);
      successful.acceptParentCommand();
      await successful.completion;
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  void test('signal rejection and deadline races preserve the first lifecycle failure', () => {
    const primaryFailure = new Error('injected primary transport failure');
    const failed = reduceStoreSpecChildLifecycleV1(createStoreSpecChildLifecycleStateV1(), {
      failure: primaryFailure,
      type: 'TRANSPORT_FAILED',
    });
    const signalResult = issueStoreSpecProcessSignalV1(failed, 'SIGKILL', () => false);
    assert.equal(signalResult.signalIssued, false);
    if (signalResult.lifecycle.status !== 'FAILED') {
      assert.fail('signal rejection did not retain failed lifecycle state');
    }
    assert.equal(signalResult.lifecycle.failure, primaryFailure);
    assert.equal(signalResult.lifecycle.secondaryFailures.length, 1);
    assert.equal(
      signalResult.lifecycle.secondaryFailures[0] instanceof StoreSpecTerminationViolationV1,
      true,
    );

    const deadlineFailure = new StoreSpecTerminationViolationV1(
      'EXIT_DEADLINE_EXCEEDED',
      'injected exit deadline',
    );
    const deadlineFailed = reduceStoreSpecChildLifecycleV1(signalResult.lifecycle, {
      failure: deadlineFailure,
      type: 'TRANSPORT_FAILED',
    });
    const disconnected = reduceStoreSpecChildLifecycleV1(deadlineFailed, {
      type: 'IPC_DISCONNECTED',
    });
    const exited = reduceStoreSpecChildLifecycleV1(disconnected, {
      result: { code: null, signal: 'SIGKILL' },
      type: 'EXITED',
    });
    const closed = reduceStoreSpecChildLifecycleV1(exited, {
      protocolTerminal: false,
      result: { code: null, signal: 'SIGKILL' },
      type: 'CLOSED',
    });
    if (closed.status !== 'FAILED') {
      assert.fail('deadline race did not retain failed lifecycle state');
    }
    assert.equal(closed.failure, primaryFailure);
    assert.equal(closed.secondaryFailures.includes(deadlineFailure), true);
  });

  void test('expected SIGKILL cannot mask an earlier lifecycle failure', () => {
    const requested = reduceStoreSpecChildLifecycleV1(createStoreSpecChildLifecycleStateV1(), {
      signal: 'SIGKILL',
      type: 'EXPECTED_TERMINATION_REQUESTED',
    });
    const priorFailure = new Error('injected failure before expected process close');
    const failed = reduceStoreSpecChildLifecycleV1(requested, {
      failure: priorFailure,
      type: 'TRANSPORT_FAILED',
    });
    const disconnected = reduceStoreSpecChildLifecycleV1(failed, {
      type: 'IPC_DISCONNECTED',
    });
    const exited = reduceStoreSpecChildLifecycleV1(disconnected, {
      result: { code: null, signal: 'SIGKILL' },
      type: 'EXITED',
    });
    const closed = reduceStoreSpecChildLifecycleV1(exited, {
      protocolTerminal: false,
      result: { code: null, signal: 'SIGKILL' },
      type: 'CLOSED',
    });
    if (closed.status !== 'FAILED') {
      assert.fail('expected SIGKILL replaced the prior lifecycle failure');
    }
    assert.equal(closed.failure, priorFailure);
    assert.deepEqual(closed.closure, { code: null, signal: 'SIGKILL' });
  });

  void test('expected termination follows its complete typed lifecycle', () => {
    const requested = reduceStoreSpecChildLifecycleV1(createStoreSpecChildLifecycleStateV1(), {
      signal: 'SIGKILL',
      type: 'EXPECTED_TERMINATION_REQUESTED',
    });
    assert.equal(requested.status, 'EXPECTED_TERMINATION_REQUESTED');
    const disconnected = reduceStoreSpecChildLifecycleV1(requested, {
      type: 'IPC_DISCONNECTED',
    });
    assert.equal(disconnected.status, 'EXPECTED_TERMINATION_REQUESTED');
    assert.equal(disconnected.ipc, 'DISCONNECTED');
    const exited = reduceStoreSpecChildLifecycleV1(disconnected, {
      result: { code: null, signal: 'SIGKILL' },
      type: 'EXITED',
    });
    assert.equal(exited.status, 'EXPECTED_TERMINATION_REQUESTED');
    const closed = reduceStoreSpecChildLifecycleV1(exited, {
      protocolTerminal: false,
      result: { code: null, signal: 'SIGKILL' },
      type: 'CLOSED',
    });
    assert.deepEqual(closed, {
      exit: { code: null, signal: 'SIGKILL' },
      ipc: 'DISCONNECTED',
      result: { code: null, signal: 'SIGKILL' },
      status: 'CLOSED',
    });
  });

  void test('protocol reducer rejects duplicate, skipped, stale, and wrong-actor transitions', () => {
    const initial = createStoreSpecProtocolStateV1('--kernel-lock-holder');
    const bootstrapped = reduceStoreSpecProtocolV1(initial, {
      actor: 'CHILD',
      kind: 'BOOTSTRAPPED',
      sequence: 0,
    });
    for (const invalid of [
      { actor: 'CHILD', kind: 'BOOTSTRAPPED', sequence: 0 },
      { actor: 'PARENT', kind: 'START', sequence: 0 },
      { actor: 'CHILD', kind: 'LOCK_ACQUIRED', sequence: 1 },
      { actor: 'PARENT', kind: 'RELEASE_LOCK', sequence: 1 },
    ] as const) {
      assert.throws(
        () => reduceStoreSpecProtocolV1(bootstrapped, invalid),
        StoreSpecProtocolViolationV1,
      );
    }
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

  void test('trusted workflow policy is deeply immutable and covers the CLI mutation universe', () => {
    assert.equal(Object.isFrozen(FINDING_WRITER_TRUSTED_WORKFLOW_POLICY), true);
    for (const policy of FINDING_WRITER_TRUSTED_WORKFLOW_POLICY) {
      assert.equal(Object.isFrozen(policy), true);
      assert.equal(Object.isFrozen(policy.events), true);
      assert.equal(Object.isFrozen(policy.operations), true);
      assert.throws(
        () => Reflect.apply(Array.prototype.push, policy.operations, ['forged-operation']),
        TypeError,
      );
    }
    assert.deepEqual(
      [
        ...new Set(FINDING_WRITER_TRUSTED_WORKFLOW_POLICY.flatMap((policy) => policy.operations)),
      ].sort(),
      [...FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS].sort(),
    );
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
    const fixture = createFindingWriterFixture('repository-authority-boundary');
    const { registryPath } = fixture;
    const addAuthority = await issueRepositoryMutationAuthority('add');
    const sweepAuthority = await issueRepositoryMutationAuthority('sweep');
    const authorizedFixturePath = join(fixtureRoot, 'repository-authority-boundary.jsonl');
    writeFindingRegistryFixture(authorizedFixturePath, [findingFixture()]);
    const authorizedRegistry = readFileSync(authorizedFixturePath, 'utf8');

    await withFindingWriterMutation(fixture, addAuthority, 'add', (lease, writerFence) =>
      atomicWriteRegistryFile(
        registryPath,
        authorizedRegistry,
        lease,
        addAuthority,
        'add',
        writerFence,
      ),
    );
    assert.equal(readFileSync(registryPath, 'utf8'), authorizedRegistry);

    const fabricatedAuthority: RepositoryMutationAuthority = { ...addAuthority };
    await assert.rejects(
      () =>
        withFindingWriterMutation(fixture, fabricatedAuthority, 'add', (lease, writerFence) =>
          atomicWriteRegistryFile(
            registryPath,
            authorizedRegistry,
            lease,
            fabricatedAuthority,
            'add',
            writerFence,
          ),
        ),
      /does not authorize add/,
    );
    await assert.rejects(
      () =>
        withFindingWriterMutation(fixture, sweepAuthority, 'add', (lease, writerFence) =>
          atomicWriteRegistryFile(
            registryPath,
            authorizedRegistry,
            lease,
            sweepAuthority,
            'add',
            writerFence,
          ),
        ),
      /does not authorize add/,
    );
    assert.throws(
      () =>
        testOnlyWithRegistryFileLock(registryPath, (lease) =>
          testOnlyAtomicWriteFileWithRegistryLease(registryPath, 'generic-bypass\n', lease),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'Test lock adapter refuses governed finding authority targets.',
    );
    assert.equal(readFileSync(registryPath, 'utf8'), authorizedRegistry);
  });

  void test('writer fence capabilities are one-shot, exact-HEAD bound, and profile confined', async () => {
    const fixture = createFindingWriterFixture('writer-fence-lifecycle');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    const headDriftSnapshot = await prepareCompatibleWriters(fixture.authority);

    await testOnlyWithRegistryFileLockAsync(
      fixture.registryPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await fixture.authority.consumeCompatibleWriters(
          headDriftSnapshot,
          signal,
        );
        git(fixture.repoRoot, ['commit', '--quiet', '--allow-empty', '-m', 'advance exact head']);
        await assert.rejects(
          () =>
            fixture.authority.redeemCompatibleWriters(
              capability,
              lease,
              {
                kind: 'REGISTRY_MUTATION',
                operation: 'add',
                repositoryAuthority,
              },
              signal,
            ),
          (error: unknown) =>
            error instanceof FindingWriterFenceStaleError &&
            error.admissionPhase === 'REDEEM' &&
            error.cause instanceof FindingWriterFenceGenerationMismatchError &&
            /worktree topology changed/.test(error.cause.message),
        );
      },
      { lockPath: fixture.authority.lockPath },
    );
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');

    const lifecycleSnapshot = await prepareCompatibleWriters(fixture.authority);
    await testOnlyWithRegistryFileLockAsync(
      fixture.registryPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        await assert.rejects(
          () => fixture.authority.consumeCompatibleWriters({ ...lifecycleSnapshot }, signal),
          /foreign, fabricated, or already consumed/,
        );
        const capability = await fixture.authority.consumeCompatibleWriters(
          lifecycleSnapshot,
          signal,
        );
        await assert.rejects(
          () => fixture.authority.consumeCompatibleWriters(lifecycleSnapshot, signal),
          /foreign, fabricated, or already consumed/,
        );
        const profile = {
          kind: 'REGISTRY_MUTATION' as const,
          operation: 'add' as const,
          repositoryAuthority,
        };
        const writerFence = await fixture.authority.redeemCompatibleWriters(
          capability,
          lease,
          profile,
          signal,
        );
        Reflect.set(profile, 'kind', 'SOURCE_INVENTORY');
        const sourceStore: unknown = Reflect.apply(bindSourceFindingPublicationStore, undefined, [
          lease,
          writerFence,
        ]);
        assert.ok(hasSourceCompensationCapture(sourceStore));
        assert.throws(
          () =>
            sourceStore.captureCompensation([
              join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH, 'manifest.json'),
            ]),
          /registry profile cannot mutate source_manifest/,
        );
        await assert.rejects(
          () =>
            fixture.authority.redeemCompatibleWriters(
              capability,
              lease,
              {
                kind: 'REGISTRY_MUTATION',
                operation: 'add',
                repositoryAuthority,
              },
              signal,
            ),
          /foreign, fabricated, already redeemed/,
        );
        fixture.authority.releaseCompatibleWriters(writerFence);
        assert.throws(
          () => fixture.authority.releaseCompatibleWriters(writerFence),
          /foreign, fabricated, or already released/,
        );
        assert.throws(
          () =>
            atomicWriteRegistryFile(
              fixture.registryPath,
              'forbidden\n',
              lease,
              repositoryAuthority,
              'add',
              writerFence,
            ),
          /live redeemed capability/,
        );
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('allocation authority and captured worktree generations are runtime immutable', async () => {
    const fixture = createFindingWriterFixture('writer-runtime-immutability');
    assert.equal(Object.isFrozen(fixture.authority), true);
    assert.equal(Reflect.set(fixture.authority, 'lockPath', 'forged.lock'), false);
    const snapshot = await prepareCompatibleWriters(fixture.authority);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.worktrees), true);
    const worktree = snapshot.worktrees[0];
    assert.ok(worktree);
    assert.equal(Object.isFrozen(worktree), true);
    assert.equal(Reflect.set(worktree, 'head_oid', 'f'.repeat(40)), false);
    assert.equal(snapshot.worktrees[0]?.head_oid, git(fixture.repoRoot, ['rev-parse', 'HEAD']));
  });

  void test('writer final CAS rejects active-set add/remove, dirty bytes, topology drift, and wrong lease', async () => {
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    const addedFixture = createFindingWriterFixture('writer-active-set-add');
    const addedWorktree = join(fixtureRoot, 'writer-active-set-added-peer');
    const addedSnapshot = await prepareCompatibleWriters(addedFixture.authority);
    await testOnlyWithRegistryFileLockAsync(
      addedFixture.registryPath,
      async (_lease) => {
        git(addedFixture.repoRoot, ['worktree', 'add', '--quiet', '--detach', addedWorktree]);
        try {
          await assert.rejects(
            () =>
              addedFixture.authority.consumeCompatibleWriters(
                addedSnapshot,
                findingWriterTestSignal(),
              ),
            (error: unknown) =>
              error instanceof FindingWriterFenceStaleError &&
              error.code === 'FINDING_WRITER_FENCE_STALE' &&
              error.admissionPhase === 'CONSUME' &&
              error.cause instanceof Error &&
              /worktree topology changed/.test(error.cause.message),
          );
        } finally {
          git(addedFixture.repoRoot, ['worktree', 'remove', '--force', addedWorktree]);
        }
      },
      { lockPath: addedFixture.authority.lockPath },
    );

    const removedFixture = createFindingWriterFixture('writer-active-set-remove');
    const removedWorktree = join(fixtureRoot, 'writer-active-set-removed-peer');
    git(removedFixture.repoRoot, ['worktree', 'add', '--quiet', '--detach', removedWorktree]);
    const removedSnapshot = await prepareCompatibleWriters(removedFixture.authority);
    await testOnlyWithRegistryFileLockAsync(
      removedFixture.registryPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await removedFixture.authority.consumeCompatibleWriters(
          removedSnapshot,
          signal,
        );
        const writerFence = await removedFixture.authority.redeemCompatibleWriters(
          capability,
          lease,
          {
            kind: 'REGISTRY_MUTATION',
            operation: 'add',
            repositoryAuthority,
          },
          signal,
        );
        git(removedFixture.repoRoot, ['worktree', 'remove', '--force', removedWorktree]);
        try {
          assert.throws(
            () =>
              atomicWriteRegistryFile(
                removedFixture.registryPath,
                'forbidden\n',
                lease,
                repositoryAuthority,
                'add',
                writerFence,
              ),
            /worktree topology changed/,
          );
          const wrongLease: RegistryLockLease = { ...lease, token: 'wrong-lease-token' };
          assert.throws(
            () => assertFindingWriterFenceCurrent(writerFence, wrongLease),
            /live redeemed capability/,
          );
        } finally {
          removedFixture.authority.releaseCompatibleWriters(writerFence);
        }
      },
      { lockPath: removedFixture.authority.lockPath },
    );

    for (const drift of ['BYTES', 'TOPOLOGY'] as const) {
      const fixture = createFindingWriterFixture(`writer-final-cas-${drift.toLowerCase()}`);
      const snapshot = await prepareCompatibleWriters(fixture.authority);
      await testOnlyWithRegistryFileLockAsync(
        fixture.registryPath,
        async (lease) => {
          const signal = findingWriterTestSignal();
          const capability = await fixture.authority.consumeCompatibleWriters(snapshot, signal);
          const writerFence = await fixture.authority.redeemCompatibleWriters(
            capability,
            lease,
            {
              kind: 'REGISTRY_MUTATION',
              operation: 'add',
              repositoryAuthority,
            },
            signal,
          );
          const driftPath =
            drift === 'BYTES'
              ? join(fixture.repoRoot, 'package.json')
              : join(fixture.repoRoot, '.github', 'workflows', 'late-mutator.yml');
          const before = drift === 'BYTES' ? readFileSync(driftPath) : null;
          writeFileSync(
            driftPath,
            drift === 'BYTES'
              ? Buffer.concat([before ?? Buffer.alloc(0), Buffer.from('\n')])
              : 'jobs: {}\n',
          );
          try {
            assert.throws(
              () =>
                atomicWriteRegistryFile(
                  fixture.registryPath,
                  'forbidden\n',
                  lease,
                  repositoryAuthority,
                  'add',
                  writerFence,
                ),
              (error: unknown) => {
                if (!(error instanceof AnchoredFilesystemError)) return false;
                assert.equal(error.code, 'STABLE_PATH_KIND_CHANGED');
                assert.equal(error.path, drift === 'BYTES' ? driftPath : dirname(driftPath));
                return true;
              },
            );
          } finally {
            if (before === null) rmSync(driftPath);
            else writeFileSync(driftPath, before);
            fixture.authority.releaseCompatibleWriters(writerFence);
          }
        },
        { lockPath: fixture.authority.lockPath },
      );
    }
  });

  void test('writer fence rejects a foreign allocation authority at the operation boundary', async () => {
    const first = createFindingWriterFixture('writer-foreign-authority-a');
    const second = createFindingWriterFixture('writer-foreign-authority-b');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    await withFindingWriterMutation(first, repositoryAuthority, 'add', (lease, writerFence) => {
      assert.throws(
        () =>
          recoverRegistryMutationStaging(
            second.authority,
            lease,
            writerFence,
            repositoryAuthority,
            'add',
          ),
        /foreign finding writer fence/,
      );
    });
  });

  void test('source profile requires the governed entrypoint and exact lease resource', async () => {
    const fixture = createFindingWriterFixture('writer-profile-boundary');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    const manifestPath = join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH, 'manifest.json');
    const sourceProfileSnapshot = await prepareCompatibleWriters(fixture.authority);

    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await fixture.authority.consumeCompatibleWriters(
          sourceProfileSnapshot,
          signal,
        );
        assert.throws(
          () =>
            Reflect.apply(fixture.authority.redeemCompatibleWriters, fixture.authority, [
              capability,
              lease,
              { kind: 'SOURCE_INVENTORY' },
              signal,
            ]),
          /accepts registry mutation profiles only/,
        );
      },
      { lockPath: fixture.authority.lockPath },
    );

    const registryProfileSnapshot = await prepareCompatibleWriters(fixture.authority);
    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await fixture.authority.consumeCompatibleWriters(
          registryProfileSnapshot,
          signal,
        );
        await assert.rejects(
          () =>
            fixture.authority.redeemCompatibleWriters(
              capability,
              lease,
              {
                kind: 'REGISTRY_MUTATION',
                operation: 'add',
                repositoryAuthority,
              },
              signal,
            ),
          /registry profile is bound to/,
        );
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('a source session revalidates repository generation before every publication side effect', async () => {
    const fixture = createFindingWriterFixture('source-session-generation-drift');
    const planDirectory = join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH);
    const manifestPath = join(planDirectory, 'manifest.json');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const artifactContent = 'new source cut\n';
    const artifactPath = sourceArtifactPath(planDirectory, artifactContent);
    const snapshot = await prepareCompatibleWriters(fixture.authority);

    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await fixture.authority.consumeCompatibleWriters(snapshot, signal);
        const sourceSession = await openSourceFindingWriterFenceSession(
          fixture.authority,
          capability,
          lease,
          signal,
        );
        try {
          const sourceStore = bindSourceFindingPublicationStore(lease, sourceSession);
          const compensation = sourceStore.captureCompensation([manifestPath, artifactPath]);
          try {
            sourceStore.publishImmutableArtifact(compensation, artifactPath, artifactContent);
            assert.equal(readFileSync(artifactPath, 'utf8'), artifactContent);
            git(fixture.repoRoot, [
              'commit',
              '--quiet',
              '--allow-empty',
              '-m',
              'advance after artifact publication',
            ]);
            assert.throws(
              () =>
                sourceStore.commitManifest(
                  compensation,
                  manifestPath,
                  sourceManifest(artifactPath),
                ),
              (error: unknown) =>
                error instanceof FindingWriterFenceGenerationMismatchError &&
                /worktree topology changed/.test(error.message),
            );
            assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore);
          } finally {
            sourceStore.releaseCompensation(compensation);
          }
        } finally {
          closeSourceFindingWriterFenceSession(fixture.authority, sourceSession);
        }
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('foreign authority cannot close a source session or consume its pending transition', async () => {
    const fixture = createFindingWriterFixture('source-session-foreign-close');
    const foreignFixture = createFindingWriterFixture('source-session-foreign-close-authority');
    const planDirectory = join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH);
    const manifestPath = join(planDirectory, 'manifest.json');
    const manifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    let beforeAssertions = 0;
    const snapshot = prepareSyntheticFindingWriterFenceSnapshot(fixture.authority, [], {
      prepareSourceTransition: () => ({
        assertBeforeCurrent: () => {
          beforeAssertions += 1;
        },
        prepareAfterCurrent: () => ({ commit: () => undefined }),
        cancelBeforeCurrent: () => undefined,
      }),
    });

    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await consumeFindingWriterFenceSnapshot(
          fixture.authority,
          snapshot,
          signal,
        );
        const sourceSession = await openSourceFindingWriterFenceSession(
          fixture.authority,
          capability,
          lease,
          signal,
        );
        const transition = prepareSourceFindingWriterFenceSessionTransition(sourceSession, lease, {
          planDirectoryPath: planDirectory,
          targetPath: manifestPath,
          beforeSha256: manifestSha256,
          afterSha256: manifestSha256,
        });
        assert.throws(
          () => closeSourceFindingWriterFenceSession(foreignFixture.authority, sourceSession),
          /foreign, fabricated, or already released/,
        );
        assertSourceFindingWriterFenceSessionCurrent(sourceSession, lease);
        assertPendingSourceFindingWriterFenceSessionTransitionBeforeCurrent(
          transition,
          sourceSession,
          lease,
        );
        assert.equal(beforeAssertions, 1);
        closeSourceFindingWriterFenceSession(fixture.authority, sourceSession);
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('typed file deletion and symlink drift retry through the prepared admission coordinator', async () => {
    const fixture = createFindingWriterFixture('source-session-typed-path-drift-retry');
    for (const driftKind of ['DELETE', 'SYMLINK'] as const) {
      const target = join(fixture.repoRoot, `admission-${driftKind.toLowerCase()}.txt`);
      const symlinkTarget = join(
        fixture.repoRoot,
        `admission-${driftKind.toLowerCase()}-original.txt`,
      );
      writeFileSync(target, 'governed admission input\n', 'utf8');
      if (driftKind === 'SYMLINK') {
        writeFileSync(symlinkTarget, 'foreign symlink target\n', 'utf8');
      }
      let preparationAttempts = 0;

      const completedAttempt = await testOnlyRunWithPreparedFindingWriterFenceAdmission(
        {
          resourcePath: join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH, 'manifest.json'),
          lockPath: fixture.authority.lockPath,
          prepareSnapshot: () => {
            preparationAttempts += 1;
            if (preparationAttempts > 1) {
              rmSync(target, { force: true, recursive: true });
              writeFileSync(target, 'governed admission input\n', 'utf8');
            }
            const observed = observeStableRegularFile(
              target,
              1024,
              `${driftKind} admission fixture`,
            );
            const snapshot = prepareSyntheticFindingWriterFenceSnapshot(fixture.authority, [], {
              assertCurrent: () =>
                assertStableRegularFileCurrent(observed, 1024, `${driftKind} admission fixture`),
            });
            if (preparationAttempts === 1) {
              rmSync(target);
              if (driftKind === 'SYMLINK') symlinkSync(symlinkTarget, target);
            }
            return snapshot;
          },
          admit: async (snapshot, lease, signal) =>
            openSourceFindingWriterFenceSession(
              fixture.authority,
              await consumeFindingWriterFenceSnapshot(fixture.authority, snapshot, signal),
              lease,
              signal,
            ),
          run: (session) => {
            closeSourceFindingWriterFenceSession(fixture.authority, session);
            return preparationAttempts;
          },
        },
        2_000,
      );
      assert.equal(completedAttempt, 2);
    }
  });

  void test('source precommit CAS preserves a foreign target introduced after staging', async () => {
    const fixture = createFindingWriterFixture('source-session-precommit-foreign-target');
    const planDirectory = join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH);
    const manifestPath = join(planDirectory, 'manifest.json');
    const artifact = 'candidate source artifact\n';
    const artifactPath = sourceArtifactPath(planDirectory, artifact);
    const foreignArtifact = 'foreign source artifact created during precommit\n';
    let beforeChecks = 0;
    const snapshot = prepareSyntheticFindingWriterFenceSnapshot(fixture.authority, [], {
      assertCurrent: () => {
        if (existsSync(artifactPath)) {
          throw new FindingWriterFenceGenerationMismatchError(
            'synthetic allocation currentness observed a foreign source target',
          );
        }
      },
      prepareSourceTransition: (transition) => {
        assert.equal(transition.targetPath, artifactPath);
        assert.equal(transition.beforeSha256, null);
        return {
          assertBeforeCurrent: () => {
            beforeChecks += 1;
            if (beforeChecks === 2) {
              writeFileSync(artifactPath, foreignArtifact, 'utf8');
              throw new FindingWriterFenceGenerationMismatchError(
                'synthetic precommit CAS observed a foreign source target',
              );
            }
            assert.equal(existsSync(artifactPath), false);
          },
          prepareAfterCurrent: () => {
            throw new FindingWriterFenceGenerationMismatchError(
              'foreign source target is not the candidate after-image',
            );
          },
          cancelBeforeCurrent: () => assert.fail('foreign target cancelled as a before-image'),
        };
      },
    });

    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await consumeFindingWriterFenceSnapshot(
          fixture.authority,
          snapshot,
          signal,
        );
        const sourceSession = await openSourceFindingWriterFenceSession(
          fixture.authority,
          capability,
          lease,
          signal,
        );
        try {
          const sourceStore = bindSourceFindingPublicationStore(lease, sourceSession);
          const compensation = sourceStore.captureCompensation([manifestPath, artifactPath]);
          try {
            assert.throws(
              () => sourceStore.publishImmutableArtifact(compensation, artifactPath, artifact),
              (error: unknown) => error instanceof AggregateError,
            );
            assert.equal(beforeChecks, 2);
            assert.equal(readFileSync(artifactPath, 'utf8'), foreignArtifact);
            assert.deepEqual(
              listAtomicWriteStagingFiles(
                planDirectory,
                (candidate) => candidate === basename(artifactPath),
              ),
              [],
            );
          } finally {
            sourceStore.releaseCompensation(compensation);
          }
        } finally {
          closeSourceFindingWriterFenceSession(fixture.authority, sourceSession);
        }
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('source candidate validation failure rolls back bytes without committing allocation state', async () => {
    const fixture = createFindingWriterFixture('source-session-candidate-validation-failure');
    const planDirectory = join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH);
    const manifestPath = join(planDirectory, 'manifest.json');
    const artifact = 'candidate rejected after participant preparation\n';
    const artifactPath = sourceArtifactPath(planDirectory, artifact);
    const downstreamValidationFailure = new Error(
      'synthetic downstream source participant validation failed',
    );
    let preparedCandidates = 0;
    let candidateCommits = 0;
    let cancellations = 0;
    const snapshot = prepareSyntheticFindingWriterFenceSnapshot(fixture.authority, [], {
      assertCurrent: () => {
        if (existsSync(artifactPath)) {
          throw new FindingWriterFenceGenerationMismatchError(
            'synthetic allocation remains on its before-image until commit',
          );
        }
      },
      prepareSourceTransition: (transition) => {
        assert.equal(transition.targetPath, artifactPath);
        return {
          assertBeforeCurrent: () => assert.equal(existsSync(artifactPath), false),
          prepareAfterCurrent: () => {
            preparedCandidates += 1;
            assert.equal(readFileSync(artifactPath, 'utf8'), artifact);
            if (preparedCandidates === 1) throw downstreamValidationFailure;
            return {
              commit: () => {
                candidateCommits += 1;
              },
            };
          },
          cancelBeforeCurrent: () => {
            assert.equal(existsSync(artifactPath), false);
            cancellations += 1;
          },
        };
      },
    });

    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await consumeFindingWriterFenceSnapshot(
          fixture.authority,
          snapshot,
          signal,
        );
        const sourceSession = await openSourceFindingWriterFenceSession(
          fixture.authority,
          capability,
          lease,
          signal,
        );
        try {
          const sourceStore = bindSourceFindingPublicationStore(lease, sourceSession);
          const compensation = sourceStore.captureCompensation([manifestPath, artifactPath]);
          try {
            assert.throws(
              () => sourceStore.publishImmutableArtifact(compensation, artifactPath, artifact),
              (error: unknown) => error === downstreamValidationFailure,
            );
            assert.equal(preparedCandidates, 3);
            assert.equal(candidateCommits, 0);
            assert.equal(cancellations, 1);
            assert.equal(existsSync(artifactPath), false);
            assertSourceFindingWriterFenceSessionCurrent(sourceSession, lease);
          } finally {
            sourceStore.releaseCompensation(compensation);
          }
        } finally {
          closeSourceFindingWriterFenceSession(fixture.authority, sourceSession);
        }
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('a source session advances artifact, manifest, cleanup, and reverse compensation as one exact cut', async () => {
    const fixture = createFindingWriterFixture('source-session-transition-cut');
    const planDirectory = join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH);
    const manifestPath = join(planDirectory, 'manifest.json');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const manifestDocument = JSON.parse(manifestBefore) as {
      capability_reconciliation: {
        finding_inventory: {
          artifact_path: string;
          artifact_sha256: string;
          occurrence_count: number;
        };
      };
    };
    const oldArtifactPath = join(
      fixture.repoRoot,
      manifestDocument.capability_reconciliation.finding_inventory.artifact_path,
    );
    const oldArtifact = readFileSync(oldArtifactPath, 'utf8');
    const nextArtifact = '{"source_ref":"SRC-TRANSITION","raw_id":"PROC-HIGH-900"}\n';
    const nextArtifactPath = sourceArtifactPath(planDirectory, nextArtifact);
    const nextArtifactSha256 = createHash('sha256').update(nextArtifact, 'utf8').digest('hex');
    manifestDocument.capability_reconciliation.finding_inventory.artifact_path = join(
      CAPABILITY_PLAN_RELATIVE_PATH,
      basename(nextArtifactPath),
    ).replaceAll('\\', '/');
    manifestDocument.capability_reconciliation.finding_inventory.artifact_sha256 =
      nextArtifactSha256;
    manifestDocument.capability_reconciliation.finding_inventory.occurrence_count = 1;
    const nextManifest = JSON.stringify(manifestDocument);
    const snapshot = await prepareCompatibleWriters(fixture.authority);

    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await fixture.authority.consumeCompatibleWriters(snapshot, signal);
        const sourceSession = await openSourceFindingWriterFenceSession(
          fixture.authority,
          capability,
          lease,
          signal,
        );
        try {
          const sourceStore = bindSourceFindingPublicationStore(lease, sourceSession);
          const compensation = sourceStore.captureCompensation([
            manifestPath,
            oldArtifactPath,
            nextArtifactPath,
          ]);
          try {
            sourceStore.publishImmutableArtifact(compensation, nextArtifactPath, nextArtifact);
            assertSourceFindingWriterFenceSessionCurrent(sourceSession, lease);
            sourceStore.commitManifest(compensation, manifestPath, nextManifest);
            assertSourceFindingWriterFenceSessionCurrent(sourceSession, lease);
            sourceStore.removeArtifact(compensation, oldArtifactPath);
            assertSourceFindingWriterFenceSessionCurrent(sourceSession, lease);
            assert.equal(readFileSync(manifestPath, 'utf8'), nextManifest);
            assert.equal(readFileSync(nextArtifactPath, 'utf8'), nextArtifact);
            assert.equal(existsSync(oldArtifactPath), false);

            sourceStore.restoreCompensation(compensation);
            assertSourceFindingWriterFenceSessionCurrent(sourceSession, lease);
            assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore);
            assert.equal(readFileSync(oldArtifactPath, 'utf8'), oldArtifact);
            assert.equal(existsSync(nextArtifactPath), false);
          } finally {
            sourceStore.releaseCompensation(compensation);
          }
        } finally {
          closeSourceFindingWriterFenceSession(fixture.authority, sourceSession);
        }
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('source compensation preserves a foreign after-image and reports a typed conflict', async () => {
    const fixture = createFindingWriterFixture('source-session-foreign-compensation');
    const planDirectory = join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH);
    const manifestPath = join(planDirectory, 'manifest.json');
    const artifact = 'governed source artifact\n';
    const artifactPath = sourceArtifactPath(planDirectory, artifact);
    const foreignArtifact = 'foreign source artifact\n';
    const snapshot = await prepareCompatibleWriters(fixture.authority);

    await testOnlyWithRegistryFileLockAsync(
      manifestPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await fixture.authority.consumeCompatibleWriters(snapshot, signal);
        const sourceSession = await openSourceFindingWriterFenceSession(
          fixture.authority,
          capability,
          lease,
          signal,
        );
        try {
          const sourceStore = bindSourceFindingPublicationStore(lease, sourceSession);
          const compensation = sourceStore.captureCompensation([manifestPath, artifactPath]);
          try {
            sourceStore.publishImmutableArtifact(compensation, artifactPath, artifact);
            writeFileSync(artifactPath, foreignArtifact, 'utf8');
            assert.throws(
              () => sourceStore.restoreCompensation(compensation),
              (error: unknown) =>
                error instanceof SourceFindingTransitionRollbackConflictError &&
                error.targetPath === artifactPath,
            );
            assert.equal(readFileSync(artifactPath, 'utf8'), foreignArtifact);
          } finally {
            sourceStore.releaseCompensation(compensation);
          }
        } finally {
          closeSourceFindingWriterFenceSession(fixture.authority, sourceSession);
        }
      },
      { lockPath: fixture.authority.lockPath },
    );
  });

  void test('registry rollback preserves a foreign concurrent image and emits a typed conflict', async () => {
    const fixture = createFindingWriterFixture('registry-rollback-foreign-image');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    const foreignImage = 'foreign concurrent registry image\n';
    const attemptedImage = 'attempted registry image\n';
    const authority = Object.freeze({
      repoRoot: fixture.repoRoot,
      lockPath: fixture.authority.lockPath,
      reservationPath: join(fixture.repoRoot, 'finding-id-reservations-v1.json'),
    });
    const snapshot = prepareSyntheticFindingWriterFenceSnapshot(authority, [], {
      assertRegistryTransition: () => {
        writeFileSync(fixture.registryPath, foreignImage, 'utf8');
        throw new Error('forced final registry transition rejection');
      },
    });

    await testOnlyWithRegistryFileLockAsync(
      fixture.registryPath,
      async (lease) => {
        const signal = findingWriterTestSignal();
        const capability = await consumeFindingWriterFenceSnapshot(authority, snapshot, signal);
        const writerFence = await redeemRegistryFindingWriterFence(
          authority,
          capability,
          lease,
          {
            kind: 'REGISTRY_MUTATION',
            operation: 'add',
            repositoryAuthority,
          },
          signal,
        );
        try {
          assert.throws(
            () =>
              atomicWriteRegistryFile(
                fixture.registryPath,
                attemptedImage,
                lease,
                repositoryAuthority,
                'add',
                writerFence,
              ),
            (error: unknown) => {
              if (!(error instanceof AggregateError)) return false;
              const failures = error.errors as readonly unknown[];
              const rollbackConflict = failures.find(
                (failure) => failure instanceof RegistryTransitionRollbackConflictError,
              );
              return (
                rollbackConflict instanceof RegistryTransitionRollbackConflictError &&
                rollbackConflict.targetPath === fixture.registryPath &&
                rollbackConflict.observedSha256 ===
                  createHash('sha256').update(foreignImage, 'utf8').digest('hex')
              );
            },
          );
        } finally {
          releaseFindingWriterFence(authority, writerFence);
        }
      },
      { lockPath: authority.lockPath },
    );
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), foreignImage);
  });

  void test('generic mutation rejects parent-symlink aliases before opening a staging path', () => {
    const realParent = join(fixtureRoot, 'symlink-target', 'docs', 'reviews', '_registry');
    const aliasParent = join(fixtureRoot, 'registry-alias');
    mkdirSync(realParent, { recursive: true });
    writeFileSync(join(realParent, 'findings.jsonl'), 'stable\n', 'utf8');
    symlinkSync(realParent, aliasParent, 'dir');
    const aliasPath = join(aliasParent, 'findings.jsonl');
    assert.throws(
      () =>
        testOnlyWithRegistryFileLock(aliasPath, (lease) =>
          testOnlyAtomicWriteFileWithRegistryLease(aliasPath, 'bypass\n', lease),
        ),
      (error: unknown) => {
        if (!(error instanceof AnchoredFilesystemError)) return false;
        assert.equal(error.code, 'SYMLINK_COMPONENT');
        assert.equal(error.path, aliasParent);
        return true;
      },
    );
    assert.equal(readFileSync(join(realParent, 'findings.jsonl'), 'utf8'), 'stable\n');
  });

  void test('source publication crash points roll forward from the manifest commit marker', async () => {
    for (const point of [
      'ARTIFACT_DURABLE',
      'MANIFEST_COMMITTED',
      'CLEANUP_PROGRESS',
    ] as const satisfies readonly SourceFindingPublicationFaultPoint[]) {
      const fixture = createPublicationKernelFixture(`source-crash-${point.toLowerCase()}`);
      await assert.rejects(
        executeSourceFindingPublicationTransaction(fixture.transaction, {
          checkpoint: (observed) => {
            if (observed === point) throw new SourceFindingPublicationCrash(observed);
          },
        }),
        (error: unknown) => error instanceof SourceFindingPublicationCrash && error.point === point,
      );
      assert.equal(fixture.rollbackCount(), 0);
      await fixture.recover();
      const selectedPath =
        point === 'ARTIFACT_DURABLE' ? fixture.oldArtifactPath : fixture.newArtifactPath;
      const supersededPath =
        point === 'ARTIFACT_DURABLE' ? fixture.newArtifactPath : fixture.oldArtifactPath;
      assert.equal(existsSync(selectedPath), true);
      assert.equal(existsSync(supersededPath), false);
      assert.equal(readFileSync(fixture.manifestPath, 'utf8'), sourceManifest(selectedPath));
    }
  });

  void test('source publication ordinary phase failures restore the exact before-image', async () => {
    for (const point of [
      'ARTIFACT_DURABLE',
      'MANIFEST_COMMITTED',
      'CLEANUP_PROGRESS',
    ] as const satisfies readonly SourceFindingPublicationFaultPoint[]) {
      const fixture = createPublicationKernelFixture(`source-rollback-${point.toLowerCase()}`);
      await assert.rejects(
        executeSourceFindingPublicationTransaction(fixture.transaction, {
          checkpoint: (observed) => {
            if (observed === point) throw new Error(`forced failure at ${observed}`);
          },
        }),
        new RegExp(`forced failure at ${point}`),
      );
      assert.equal(fixture.rollbackCount(), 1);
      assert.equal(readFileSync(fixture.oldArtifactPath, 'utf8'), fixture.oldArtifact);
      assert.equal(existsSync(fixture.newArtifactPath), false);
      assert.equal(
        readFileSync(fixture.manifestPath, 'utf8'),
        sourceManifest(fixture.oldArtifactPath),
      );
    }
  });

  void test('source publication refuses immutable artifact collision without overwriting bytes', async () => {
    const collision = 'attacker-controlled-collision\n';
    const fixture = createPublicationKernelFixture('source-artifact-collision', collision);
    await assert.rejects(
      executeSourceFindingPublicationTransaction(fixture.transaction),
      /immutable artifact collision/,
    );
    assert.equal(fixture.rollbackCount(), 1);
    assert.equal(readFileSync(fixture.newArtifactPath, 'utf8'), collision);
    assert.equal(readFileSync(fixture.oldArtifactPath, 'utf8'), fixture.oldArtifact);
    assert.equal(
      readFileSync(fixture.manifestPath, 'utf8'),
      sourceManifest(fixture.oldArtifactPath),
    );
  });

  void test('allocator-absent worktrees reject every retired mutation surface', async () => {
    for (const [index, retiredSurface] of FINDING_WRITER_RETIRED_MUTATION_SURFACES.entries()) {
      const repoRoot = join(fixtureRoot, `retired-writer-${index}`);
      writeFindingAllocationSubstrateFixture(repoRoot);
      mkdirSync(dirname(join(repoRoot, retiredSurface)), { recursive: true });
      writeFileSync(join(repoRoot, retiredSurface), 'process.exitCode = 0;\n', 'utf8');
      initializeQuiescentGitFixture(repoRoot);
      git(repoRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
      git(repoRoot, ['config', 'user.name', 'finding-registry-spec']);
      git(repoRoot, ['config', 'commit.gpgsign', 'false']);
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '--quiet', '-m', 'retired writer fixture']);
      await assert.rejects(
        () => assertFindingWriterWorktreesFenced([repoRoot], repoRoot),
        new RegExp(retiredSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
  });

  void test('allocator-present worktrees reject committed and dirty retired-writer resurrection', async () => {
    for (const resurrection of ['COMMITTED', 'DIRTY'] as const) {
      const fixture = createFindingWriterFixture(
        `retired-writer-resurrection-${resurrection.toLowerCase()}`,
      );
      const retiredSurface =
        resurrection === 'COMMITTED'
          ? FINDING_WRITER_RETIRED_MUTATION_SURFACES[0]
          : FINDING_WRITER_RETIRED_MUTATION_SURFACES[1];
      const retiredPath = join(fixture.repoRoot, retiredSurface);
      mkdirSync(dirname(retiredPath), { recursive: true });
      writeFileSync(retiredPath, 'process.exitCode = 0;\n', 'utf8');
      if (resurrection === 'COMMITTED') {
        git(fixture.repoRoot, ['add', retiredSurface]);
        git(fixture.repoRoot, ['commit', '--quiet', '-m', 'resurrect retired writer']);
      }
      await assert.rejects(
        () => assertFindingWriterWorktreesFenced([fixture.repoRoot], fixture.repoRoot),
        new RegExp(retiredSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
  });

  void test('writer compatibility is a committed content-digest protocol, not source-text heuristics', async () => {
    const repoRoot = join(fixtureRoot, 'writer-protocol');
    writeWriterProtocolFixture(repoRoot);
    writeFindingInventoryFloorAuthority(repoRoot, [], {});
    const protocolPath = join(repoRoot, FINDING_WRITER_AUTHORITY_PATH);
    mkdirSync(resolve(protocolPath, '..'), { recursive: true });
    const ariaAuthorityFiles = fixtureAriaAuthorityFiles(repoRoot);
    const protocol = buildFindingWriterProtocolManifest(repoRoot, ariaAuthorityFiles);
    assert.equal(writeFindingWriterProtocolManifest(repoRoot, ariaAuthorityFiles), true);
    const firstGeneratedBytes = readFileSync(protocolPath, 'utf8');
    assert.equal(
      firstGeneratedBytes,
      renderFindingWriterProtocolManifest(repoRoot, ariaAuthorityFiles),
    );
    assert.equal(writeFindingWriterProtocolManifest(repoRoot, ariaAuthorityFiles), false);
    assert.equal(readFileSync(protocolPath, 'utf8'), firstGeneratedBytes);
    assert.doesNotThrow(() => checkFindingWriterProtocolManifest(repoRoot, ariaAuthorityFiles));
    git(repoRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(repoRoot, ['config', 'user.name', 'finding-registry-spec']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'writer protocol fixture']);

    await assert.doesNotReject(() => assertFindingWriterWorktreesFenced([repoRoot], repoRoot));

    const allocatorPath = join(repoRoot, 'tools/gates/finding-registry.ts');
    const committedAllocatorBytes = readFileSync(allocatorPath);
    writeFileSync(
      allocatorPath,
      Buffer.concat([committedAllocatorBytes, Buffer.from('\n', 'utf8')]),
    );
    await assert.rejects(
      () => assertFindingWriterWorktreesFenced([repoRoot], repoRoot),
      /protocol-incompatible finding writers/,
    );
    writeFileSync(allocatorPath, committedAllocatorBytes);

    const noncanonicalRoot = join(fixtureRoot, 'writer-protocol-noncanonical');
    git(fixtureRoot, ['clone', '--quiet', repoRoot, noncanonicalRoot]);
    git(noncanonicalRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(noncanonicalRoot, ['config', 'user.name', 'Finding Registry Spec']);
    git(noncanonicalRoot, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(
      join(noncanonicalRoot, FINDING_WRITER_AUTHORITY_PATH),
      `${firstGeneratedBytes}\n`,
      'utf8',
    );
    git(noncanonicalRoot, ['add', '.']);
    git(noncanonicalRoot, ['commit', '--quiet', '-m', 'noncanonical writer manifest bytes']);
    await assert.rejects(
      () => assertFindingWriterWorktreesFenced([repoRoot, noncanonicalRoot], repoRoot),
      /protocol-incompatible finding writers/,
    );

    const actionDivergentRoot = join(fixtureRoot, 'writer-protocol-action-divergent');
    git(fixtureRoot, ['clone', '--quiet', repoRoot, actionDivergentRoot]);
    git(actionDivergentRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(actionDivergentRoot, ['config', 'user.name', 'Finding Registry Spec']);
    git(actionDivergentRoot, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(
      join(actionDivergentRoot, '.github/actions/setup-rust-workspace/resolve-toolchain.mjs'),
      'export const divergentActionHelper = true;\n',
      'utf8',
    );
    assert.equal(
      writeFindingWriterProtocolManifest(
        actionDivergentRoot,
        fixtureAriaAuthorityFiles(actionDivergentRoot),
      ),
      true,
    );
    git(actionDivergentRoot, ['add', '.']);
    git(actionDivergentRoot, ['commit', '--quiet', '-m', 'divergent local action helper']);
    await assert.rejects(
      () => assertFindingWriterWorktreesFenced([repoRoot, actionDivergentRoot], repoRoot),
      /protocol-incompatible finding writers/,
    );

    const divergentRoot = join(fixtureRoot, 'writer-protocol-divergent');
    git(fixtureRoot, ['clone', '--quiet', repoRoot, divergentRoot]);
    git(divergentRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(divergentRoot, ['config', 'user.name', 'Finding Registry Spec']);
    git(divergentRoot, ['config', 'commit.gpgsign', 'false']);
    const divergentWriterPath = join(divergentRoot, 'tools/gates/finding-registry.ts');
    const canonicalWriterBytes = readFileSync(divergentWriterPath, 'utf8');
    const divergentWriterBytes = canonicalWriterBytes.replace(
      'export const allocationFloorForDomain = true;',
      'export const allocationFloorForDomain = false;',
    );
    assert.notEqual(divergentWriterBytes, canonicalWriterBytes);
    writeFileSync(divergentWriterPath, divergentWriterBytes, 'utf8');
    assert.equal(
      writeFindingWriterProtocolManifest(divergentRoot, fixtureAriaAuthorityFiles(divergentRoot)),
      true,
    );
    git(divergentRoot, ['add', '.']);
    git(divergentRoot, ['commit', '--quiet', '-m', 'divergent writer implementation']);
    await assert.rejects(
      () => assertFindingWriterWorktreesFenced([repoRoot, divergentRoot], repoRoot),
      /protocol-incompatible finding writers/,
    );

    writeFileSync(
      join(repoRoot, 'tools/gates/finding-registry.ts'),
      'function cmdAdd() { return "uncommitted"; }\n',
      'utf8',
    );
    await assert.rejects(
      () => assertFindingWriterWorktreesFenced([repoRoot], repoRoot),
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
    await assert.rejects(
      () => assertFindingWriterWorktreesFenced([repoRoot], repoRoot),
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

    const writerFixture = createFindingWriterFixture(
      'source-floor-registry',
      expectedFloors,
      sourceRawIds,
    );
    const { registryPath, schemaPath } = writerFixture;
    const stubPath = join(fixtureRoot, 'source-floor-stub.json');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
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
    const allocated = await withFindingWriterMutation(
      writerFixture,
      repositoryAuthority,
      'add',
      (lease, writerFence) =>
        appendAllocatedFinding(
          'FE',
          stubPath,
          lease,
          repositoryAuthority,
          writerFence,
          writerFixture.authority,
          { registryPath, schemaPath },
        ),
    );
    assert.equal(allocated, 0);
    assert.match(readFileSync(registryPath, 'utf8'), /"id":"FE-HIGH-065"/);
  });

  void test('non-Error action failures remain observable with native cause semantics', () => {
    const resourcePath = join(fixtureRoot, 'non-error-action.jsonl');
    const nonErrorFailure: unknown = undefined;
    let captured: unknown;
    try {
      testOnlyWithRegistryFileLock(resourcePath, () => {
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
    assert.equal(lstatSync(`${resourcePath}.lock`).size, 0);
  });

  void test('action and release failures are both preserved as fencing evidence', () => {
    const resourcePath = join(fixtureRoot, 'dual-failure.jsonl');
    const lockPath = `${resourcePath}.lock`;
    assert.throws(
      () =>
        testOnlyWithRegistryFileLock(resourcePath, (lease) => {
          writeFileSync(lease.lockPath, 'ownership-corrupted\n', 'utf8');
          throw new Error('business mutation failed');
        }),
      (error: unknown) => {
        if (!(error instanceof AggregateError)) return false;
        assert.match(error.message, /action and lock release both failed/);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /business mutation failed/);
        const releaseError: unknown = error.errors[1];
        assert.ok(releaseError instanceof RegistryLockError);
        assert.equal(releaseError.code, 'LOCK_OWNERSHIP_LOST');
        return true;
      },
    );
    rmSync(lockPath);
  });

  void test('async actions retain the lease until settlement and use the same failure contract', async () => {
    const resourcePath = join(fixtureRoot, 'async-action.jsonl');
    const result = await testOnlyWithRegistryFileLockAsync(resourcePath, async (lease) => {
      await Promise.resolve();
      testOnlyAtomicWriteFileWithRegistryLease(resourcePath, 'published\n', lease);
      return 17;
    });

    assert.equal(result, 17);
    assert.equal(readFileSync(resourcePath, 'utf8'), 'published\n');
    assert.equal(lstatSync(`${resourcePath}.lock`).size, 0);

    const nonErrorFailure: unknown = undefined;
    let captured: unknown;
    try {
      await testOnlyWithRegistryFileLockAsync(resourcePath, async () => {
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
    assert.equal(lstatSync(`${resourcePath}.lock`).size, 0);
  });

  void test('Git common-dir authority serializes and reserves across active worktrees', async () => {
    const rootFixture = createFindingWriterFixture('worktree-a');
    const repoA = rootFixture.repoRoot;
    const repoB = join(fixtureRoot, 'worktree-b');
    const registryRelativePath = join('docs', 'reviews', '_registry', 'findings.jsonl');
    const schemaRelativePath = join('docs', 'reviews', '_registry', 'findings.jsonl.schema.json');
    const registryA = join(repoA, registryRelativePath);
    const registryB = join(repoB, registryRelativePath);
    const schemaA = join(repoA, schemaRelativePath);
    const schemaB = join(repoB, schemaRelativePath);
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

    const allocatorA = spawnStoreSpecChild('--worktree-allocator-child', [
      repoA,
      registryA,
      schemaA,
      stubA,
    ]);
    const allocatorB = spawnStoreSpecChild('--worktree-allocator-child', [
      repoB,
      registryB,
      schemaB,
      stubB,
    ]);
    let allocatorResults: readonly StoreSpecChildResult[] = [];
    let allocationMessages: readonly StoreSpecChildMessageV1[] = [];
    try {
      await Promise.all([
        allocatorA.waitForPhase('BOOTSTRAPPED'),
        allocatorB.waitForPhase('BOOTSTRAPPED'),
      ]);
      await Promise.all([allocatorA.sendCommand('START'), allocatorB.sendCommand('START')]);
      await Promise.all([
        allocatorA.waitForPhase('PREPARED_SNAPSHOT'),
        allocatorB.waitForPhase('PREPARED_SNAPSHOT'),
      ]);

      // Both children hold the same stale generation before either admission.
      // Commit A first, then release B so B deterministically exercises the
      // generation retry without coupling correctness to scheduler latency.
      await allocatorA.sendCommand('RELEASE_PREPARED_SNAPSHOT');
      const allocationA = await allocatorA.waitForPhase('ALLOCATION_COMMITTED');
      const resultA = await allocatorA.completion;
      await allocatorB.sendCommand('RELEASE_PREPARED_SNAPSHOT');
      const allocationB = await allocatorB.waitForPhase('ALLOCATION_COMMITTED');
      const resultB = await allocatorB.completion;
      allocationMessages = [allocationA, allocationB];
      allocatorResults = [resultA, resultB];
    } finally {
      await Promise.all([terminateStoreSpecChild(allocatorA), terminateStoreSpecChild(allocatorB)]);
    }
    for (const result of allocatorResults) {
      assert.deepEqual(
        { code: result.code, signal: result.signal, stderr: result.stderr },
        { code: 0, signal: null, stderr: '' },
      );
    }
    const admissionAttempts = allocationMessages
      .map((message) =>
        message.kind === 'ALLOCATION_COMMITTED' ? message.payload.preparationAttempts : Number.NaN,
      )
      .sort((left, right) => left - right);
    assert.deepEqual(admissionAttempts, [1, 2]);

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
    const localExit = await withFindingWriterMutation(
      { repoRoot: repoB, registryPath: registryB, schemaPath: schemaB, authority: authorityB },
      repositoryAuthority,
      'add',
      (lease, writerFence) =>
        appendAllocatedFinding(
          'INFRA',
          localBStub,
          lease,
          repositoryAuthority,
          writerFence,
          authorityB,
          { registryPath: registryB, schemaPath: schemaB },
        ),
    );
    assert.equal(localExit, 0);

    const authorityAStub = join(fixtureRoot, 'worktree-a-authority-infra.json');
    makeStub(authorityAStub, 'HIGH', 'Active worktree scanner advances the shared sequence');
    const authorityExit = await withFindingWriterMutation(
      { ...rootFixture, authority: authorityA },
      repositoryAuthority,
      'add',
      (lease, writerFence) =>
        appendAllocatedFinding(
          'INFRA',
          authorityAStub,
          lease,
          repositoryAuthority,
          writerFence,
          authorityA,
          { registryPath: registryA, schemaPath: schemaA },
        ),
    );
    assert.equal(authorityExit, 0);
    assert.match(readFileSync(registryA, 'utf8'), /"id":"INFRA-HIGH-002"/);

    const legacyWorktreeManifest = join(repoB, CAPABILITY_PLAN_RELATIVE_PATH, 'manifest.json');
    const compatibleManifest = readFileSync(legacyWorktreeManifest, 'utf8');
    writeFileSync(legacyWorktreeManifest, JSON.stringify({ legacy_plan: true }), 'utf8');
    await assert.rejects(
      () => prepareCompatibleWriters(authorityA),
      /capability reconciliation is absent or invalid/i,
    );
    writeFileSync(legacyWorktreeManifest, compatibleManifest, 'utf8');

    const legacyAllocatorPath = join(repoB, 'tools', 'gates', 'finding-registry.ts');
    mkdirSync(join(repoB, 'tools', 'gates'), { recursive: true });
    writeFileSync(
      legacyAllocatorPath,
      "function cmdAdd() { /* legacy direct writer */ }\nif (sub === 'add') cmdAdd();\n",
      'utf8',
    );
    await assert.rejects(
      () => prepareCompatibleWriters(authorityA),
      /protocol-incompatible finding writers/,
    );

    git(repoA, ['worktree', 'remove', '--force', repoB]);

    const afterRemovalStub = join(fixtureRoot, 'worktree-a-after-removal.json');
    makeStub(afterRemovalStub, 'LOW', 'Durable reservation survives worktree removal');
    const afterRemovalExit = await withFindingWriterMutation(
      { ...rootFixture, authority: authorityA },
      repositoryAuthority,
      'add',
      (lease, writerFence) =>
        appendAllocatedFinding(
          'PROC',
          afterRemovalStub,
          lease,
          repositoryAuthority,
          writerFence,
          authorityA,
          { registryPath: registryA, schemaPath: schemaA },
        ),
    );
    assert.equal(afterRemovalExit, 0);
    assert.match(readFileSync(registryA, 'utf8'), /"id":"PROC-LOW-003"/);
  });

  void test('active registries validate schema and bind every immutable creation field', async () => {
    const fixture = createFindingWriterFixture('identity-worktree-a');
    const repoB = join(fixtureRoot, 'identity-worktree-b');
    git(fixture.repoRoot, ['worktree', 'add', '--quiet', '-b', 'identity-worker-b', repoB]);
    const registryB = join(repoB, 'docs', 'reviews', '_registry', 'findings.jsonl');
    const authority = resolveGitFindingAllocationAuthority(fixture.repoRoot);
    const base = findingFixture();
    writeFindingRegistryFixture(fixture.registryPath, [base]);
    writeFindingRegistryFixture(registryB, [findingFixture({ state: 'IN-PROGRESS' })]);
    await assert.doesNotReject(() => prepareCompatibleWriters(authority));

    const immutableVariants: readonly (readonly [string, Partial<Finding>])[] = [
      ['severity', { severity: 'LOW' }],
      ['title', { title: 'Different immutable allocation title' }],
      ['layer', { layer: 2 }],
      ['evidence', { evidence: ['tools/gates/finding-registry.ts:identity'] }],
      ['rule_violated', { rule_violated: 'Different immutable rule' }],
      ['owner_agent', { owner_agent: 'architecture-arbiter' }],
      ['raised_in_cycle', { raised_in_cycle: '2026-08-08-different-cycle' }],
      ['review_file', { review_file: 'docs/reviews/architecture/2026-08-08-different-cycle.md' }],
      ['created_at', { created_at: '2026-08-08T00:00:01.000Z' }],
      ['deadline', { deadline: '2026-08-31' }],
      ['owner_user', { owner_user: 'owner-handle' }],
      ['override_of', { override_of: 'PROC-HIGH-014' }],
      ['notes', { notes: 'different immutable note' }],
      ['narrative', { narrative: ['different immutable narrative'] }],
    ];
    for (const [field, override] of immutableVariants) {
      writeFindingRegistryFixture(registryB, [
        findingFixture({ state: 'IN-PROGRESS', ...override }),
      ]);
      await assert.rejects(
        () => prepareCompatibleWriters(authority),
        new RegExp(
          `assign PROC-HIGH-015 to different immutable finding identities.*${field}|different immutable finding identities`,
        ),
      );
    }

    writeFileSync(registryB, '{"id":\n', 'utf8');
    await assert.rejects(
      () => prepareCompatibleWriters(authority),
      /Finding registry JSON is invalid: .*findings\.jsonl:1/,
    );

    const invalidIdEntry: Record<string, unknown> = { ...findingFixture(), id: 15 };
    const { content_hash: _invalidHash, ...invalidForHash } = invalidIdEntry;
    invalidIdEntry['content_hash'] = createHash('sha256')
      .update(canonicalFindingFixtureJson(invalidForHash), 'utf8')
      .digest('hex');
    writeFileSync(registryB, `${JSON.stringify(invalidIdEntry)}\n`, 'utf8');
    await assert.rejects(
      () => prepareCompatibleWriters(authority),
      /row violates its canonical schema: .*findings\.jsonl:1/,
    );

    writeFindingRegistryFixture(registryB, [base, base]);
    await assert.rejects(
      () => prepareCompatibleWriters(authority),
      /repeats id PROC-HIGH-015: .*findings\.jsonl:2/,
    );
    git(fixture.repoRoot, ['worktree', 'remove', '--force', repoB]);
  });

  void test('allocation snapshot unions sibling floors and orphan headings', async () => {
    const fixture = createFindingWriterFixture('allocation-union-a');
    const repoB = join(fixtureRoot, 'allocation-union-b');
    git(fixture.repoRoot, ['worktree', 'add', '--quiet', '-b', 'allocation-union-worker-b', repoB]);
    writeFindingInventoryFloorAuthority(fixture.repoRoot, ['FE-HIGH-064'], { FE: 64 });
    writeFindingInventoryFloorAuthority(repoB, ['FE-HIGH-080'], { FE: 80 });
    writeFileSync(
      join(fixture.repoRoot, 'docs', 'reviews', 'orphan-findings.md'),
      '# Orphan findings\n\n## ORPHAN-HIGH-416 — occupied\n',
      'utf8',
    );
    writeFileSync(
      join(repoB, 'docs', 'reviews', 'orphan-findings.md'),
      '# Orphan findings\n\n## ORPHAN-LOW-450 — occupied\n',
      'utf8',
    );
    const authority = resolveGitFindingAllocationAuthority(fixture.repoRoot);
    const governedFixture = { ...fixture, authority };
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    const feStub = join(fixtureRoot, 'allocation-union-fe.json');
    const orphanStub = join(fixtureRoot, 'allocation-union-orphan.json');
    for (const [path, title] of [
      [feStub, 'Allocate beyond every active source inventory floor'],
      [orphanStub, 'Allocate beyond every active orphan markdown heading'],
    ] as const) {
      writeFileSync(
        path,
        JSON.stringify({
          severity: 'HIGH',
          title,
          evidence: ['tools/gates/finding-registry-store.spec.ts:allocation-union'],
          owner_agent: 'context-manager',
          raised_in_cycle: '2026-08-08-writer-authority',
        }),
        'utf8',
      );
    }
    const append = (domain: string, stubPath: string): Promise<number> =>
      withFindingWriterMutation(governedFixture, repositoryAuthority, 'add', (lease, writerFence) =>
        appendAllocatedFinding(
          domain,
          stubPath,
          lease,
          repositoryAuthority,
          writerFence,
          authority,
          { registryPath: fixture.registryPath, schemaPath: fixture.schemaPath },
        ),
      );
    assert.equal(await append('FE', feStub), 0);
    assert.equal(await append('ORPHAN', orphanStub), 0);
    const registryRaw = readFileSync(fixture.registryPath, 'utf8');
    assert.match(registryRaw, /"id":"FE-HIGH-081"/);
    assert.match(registryRaw, /"id":"ORPHAN-HIGH-451"/);
    git(fixture.repoRoot, ['worktree', 'remove', '--force', repoB]);
  });

  void test('allocation snapshot fences sibling registry and markdown mutations after capture', async () => {
    const fixture = createFindingWriterFixture('allocation-barrier-a');
    const repoB = join(fixtureRoot, 'allocation-barrier-b');
    git(fixture.repoRoot, [
      'worktree',
      'add',
      '--quiet',
      '-b',
      'allocation-barrier-worker-b',
      repoB,
    ]);
    const registryB = join(repoB, 'docs', 'reviews', '_registry', 'findings.jsonl');
    const orphanB = join(repoB, 'docs', 'reviews', 'orphan-findings.md');
    const authority = resolveGitFindingAllocationAuthority(fixture.repoRoot);
    const governedFixture = { ...fixture, authority };
    const stubPath = join(fixtureRoot, 'allocation-barrier-stub.json');
    writeFileSync(
      stubPath,
      JSON.stringify({
        severity: 'HIGH',
        title: 'Allocation snapshot race barrier fixture',
        evidence: ['tools/gates/finding-registry-store.spec.ts:allocation-barrier'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-08-08-writer-authority',
      }),
      'utf8',
    );

    for (const mutation of [
      {
        path: registryB,
        apply: () => writeFindingRegistryFixture(registryB, [findingFixture()]),
      },
      {
        path: orphanB,
        apply: () =>
          writeFileSync(orphanB, '# Orphan findings\n\n## ORPHAN-HIGH-500 — occupied\n', 'utf8'),
      },
    ]) {
      const beforeRegistry = readFileSync(fixture.registryPath, 'utf8');
      const repositoryAuthority = await issueRepositoryMutationAuthority('add');
      await withFindingWriterMutation(
        governedFixture,
        repositoryAuthority,
        'add',
        (lease, writerFence) => {
          mutation.apply();
          assert.throws(
            () =>
              appendAllocatedFinding(
                'PROC',
                stubPath,
                lease,
                repositoryAuthority,
                writerFence,
                authority,
                { registryPath: fixture.registryPath, schemaPath: fixture.schemaPath },
              ),
            (error: unknown) => {
              if (!(error instanceof AnchoredFilesystemError)) return false;
              assert.equal(error.code, 'STABLE_REGULAR_FILE_CHANGED');
              assert.equal(error.path, mutation.path);
              return true;
            },
          );
          return 0;
        },
      );
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), beforeRegistry);
      writeFileSync(registryB, '', 'utf8');
      writeFileSync(orphanB, '# Orphan findings\n', 'utf8');
    }
    git(fixture.repoRoot, ['worktree', 'remove', '--force', repoB]);
  });

  void test('allocated append validates schema and writes under the held lease', async () => {
    const writerFixture = createFindingWriterFixture('schema-validated');
    const resourcePath = writerFixture.registryPath;
    const { schemaPath } = writerFixture;
    const validStubPath = join(fixtureRoot, 'valid-stub.json');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    const runAppend = (stubPath: string): Promise<number> =>
      withFindingWriterMutation(writerFixture, repositoryAuthority, 'add', (lease, writerFence) =>
        appendAllocatedFinding(
          'PROC',
          stubPath,
          lease,
          repositoryAuthority,
          writerFence,
          writerFixture.authority,
          { registryPath: resourcePath, schemaPath },
        ),
      );
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

    const exitCode = await runAppend(validStubPath);
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
    const invalidExitCode = await runAppend(invalidStubPath);
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
    await assert.rejects(
      () => runAppend(callerOwnedAuditPath),
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
    const invalidEvidenceExit = await runAppend(invalidEvidenceStubPath);
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
    const emptyHighEvidenceExit = await runAppend(emptyHighEvidenceStubPath);
    assert.equal(emptyHighEvidenceExit, 1);
    assert.equal(readFileSync(resourcePath, 'utf8'), afterValid);
  });

  void test('canonical evidence SSOT accepts every supported path shape', async () => {
    const writerFixture = createFindingWriterFixture('canonical-evidence');
    const resourcePath = writerFixture.registryPath;
    const { schemaPath } = writerFixture;
    const stubPath = join(fixtureRoot, 'canonical-evidence-stub.json');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
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

    const exitCode = await withFindingWriterMutation(
      writerFixture,
      repositoryAuthority,
      'add',
      (lease, writerFence) =>
        appendAllocatedFinding(
          'PROC',
          stubPath,
          lease,
          repositoryAuthority,
          writerFence,
          writerFixture.authority,
          { registryPath: resourcePath, schemaPath },
        ),
    );
    assert.equal(exitCode, 0);
    assert.match(
      readFileSync(resourcePath, 'utf8'),
      /"narrative":\["Free-form diagnostic prose remains valid here\."\]/,
    );
  });

  void test('flock version and acquisition share one immutable execution policy', () => {
    assert.equal(Object.isFrozen(FINDING_WRITER_FLOCK_EXECUTION_POLICY_V1), true);
    assert.deepEqual(FINDING_WRITER_FLOCK_EXECUTION_POLICY_V1, {
      schemaVersion: 1,
      commandDeadlineMs: 5_000,
      timeoutSignal: 'SIGKILL',
    });
    assert.deepEqual(FINDING_WRITER_REGISTRY_LOCK_POLICY_V1, {
      schemaVersion: 1,
      contentionDeadlineMs: FINDING_WRITER_FLOCK_EXECUTION_POLICY_V1.commandDeadlineMs,
      pollIntervalMs: 25,
    });

    const remainingFlockDeadlineMs = 37;
    const timeout = Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
    assert.throws(
      () => {
        throw RegistryLockError.fromFlockExecutionFailure(
          {
            error: timeout,
            signal: FINDING_WRITER_FLOCK_EXECUTION_POLICY_V1.timeoutSignal,
          },
          remainingFlockDeadlineMs,
        );
      },
      (error: unknown) =>
        error instanceof RegistryLockError &&
        error.code === 'LOCK_MALFORMED' &&
        error.cause instanceof HermeticExecutableExecutionTimeoutError &&
        error.cause.code === 'HERMETIC_EXECUTABLE_EXECUTION_TIMEOUT' &&
        error.cause.executableLabel === 'Finding writer flock runtime' &&
        error.cause.phase === 'COMMAND' &&
        error.cause.commandDeadlineMs === remainingFlockDeadlineMs &&
        error.cause.timeoutSignal === FINDING_WRITER_FLOCK_EXECUTION_POLICY_V1.timeoutSignal,
    );

    const resourcePath = join(fixtureRoot, 'absolute-flock-deadline.json');
    writeFileSync(resourcePath, '{}\n', 'utf8');
    const observedChildDeadlines: number[] = [];
    assert.throws(
      () =>
        testOnlyWithRegistryFileLock(
          resourcePath,
          () => assert.fail('expired ownership proof admitted a registry lease'),
          {
            timeoutMs: 300,
            pollIntervalMs: 25,
            testOnlyBeforeFlockChild: () => {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 170);
            },
            testOnlyObserveFlockChildDeadline: (deadlineMs) => {
              observedChildDeadlines.push(deadlineMs);
            },
          },
        ),
      (error: unknown) => error instanceof RegistryLockError && error.code === 'LOCK_TIMEOUT',
    );
    assert.equal(observedChildDeadlines.length, 2);
    assert.ok((observedChildDeadlines[0] ?? 0) > 0);
    assert.ok((observedChildDeadlines[0] ?? 300) < 300);
    assert.ok((observedChildDeadlines[1] ?? 1) < 1);
  });

  void test('Git timeout and permission failures remain operational errors, never stale admission', async () => {
    const fixture = createFindingWriterFixture('operational-currentness-failure');
    const authority = Object.freeze({
      repoRoot: fixture.repoRoot,
      lockPath: fixture.authority.lockPath,
      reservationPath: join(fixture.repoRoot, 'finding-id-reservations-v1.json'),
    });
    const worktree = Object.freeze({
      worktree_path: fixture.repoRoot,
      head_oid: git(fixture.repoRoot, ['rev-parse', 'HEAD']),
      allocator_present: true,
    });
    const operationalFailures = [
      new HermeticGitExecutionTimeoutError(
        'BUFFERED',
        fixture.repoRoot,
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        37,
        'SIGKILL',
      ),
      Object.assign(new Error('Git repository access denied'), { code: 'EACCES' }),
    ];

    for (const operationalFailure of operationalFailures) {
      const snapshot = prepareSyntheticFindingWriterFenceSnapshot(authority, [worktree], {
        assertWorktreeGeneration: () => {
          throw operationalFailure;
        },
      });
      await assert.rejects(
        () => consumeSyntheticFindingWriterFence(authority, snapshot),
        (error: unknown) =>
          error === operationalFailure && !(error instanceof FindingWriterFenceStaleError),
      );
    }
  });

  void test('prepared admission aborts an unfinished proof at one exact deadline before lock acquisition', async () => {
    const directory = join(fixtureRoot, 'prepared-admission-deadline');
    mkdirSync(directory, { recursive: true });
    const resourcePath = join(directory, 'manifest.json');
    const lockPath = join(directory, 'finding-writer.lock');
    const testDeadlineMs = 50;
    let abortReason: unknown;
    let admissionAttempts = 0;
    let actionAttempts = 0;

    await assert.rejects(
      testOnlyRunWithPreparedFindingWriterFenceAdmission(
        {
          resourcePath,
          lockPath,
          prepareSnapshot: (signal) => {
            signal.addEventListener(
              'abort',
              () => {
                abortReason = signal.reason;
              },
              { once: true },
            );
            return new Promise<FindingWriterFenceSnapshot>(() => undefined);
          },
          admit: () => {
            admissionAttempts += 1;
            throw new Error('expired proof reached admission');
          },
          run: () => {
            actionAttempts += 1;
            throw new Error('expired proof reached its action');
          },
        },
        testDeadlineMs,
      ),
      (error: unknown) =>
        error instanceof FindingWriterFenceAdmissionDeadlineError &&
        error.admissionDeadlineMs === testDeadlineMs,
    );
    assert.ok(abortReason instanceof FindingWriterFenceAdmissionDeadlineError);
    assert.equal(abortReason.admissionDeadlineMs, testDeadlineMs);
    assert.equal(admissionAttempts, 0);
    assert.equal(actionAttempts, 0);
    assert.equal(existsSync(lockPath), false);
  });

  void test('prepared admission preserves its exact deadline through a blocked governed Git proof and reaps before returning', async () => {
    const fixture = createFindingWriterFixture('prepared-admission-git-deadline');
    const headRefPath = symbolicHeadRefPath(fixture.repoRoot);
    rmSync(headRefPath);
    execFileSync('/usr/bin/mkfifo', [headRefPath]);
    const testDeadlineMs = 1_000;
    const execution = testOnlyRunWithPreparedFindingWriterFenceAdmission(
      {
        resourcePath: fixture.registryPath,
        lockPath: fixture.authority.lockPath,
        prepareSnapshot: (signal) => fixture.authority.assertCompatibleWriters(signal),
        admit: () => assert.fail('blocked Git proof reached admission'),
        run: () => assert.fail('blocked Git proof reached its action'),
      },
      testDeadlineMs,
    );
    const rejection = assert.rejects(
      execution,
      (error: unknown) =>
        error instanceof FindingWriterFenceAdmissionDeadlineError &&
        error.admissionDeadlineMs === testDeadlineMs,
    );
    const writer = await openFindingWriterFifoAfterReader(headRefPath);
    await rejection;
    closeSync(writer);
    assert.throws(
      () => openSync(headRefPath, constants.O_WRONLY | constants.O_NONBLOCK),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
    );
    assert.equal(existsSync(fixture.authority.lockPath), false);
  });

  void test(
    'admission deadline kills and reaps blocked topology currentness before releasing its lock',
    { timeout: 30_000 },
    async () => {
      const fixture = createFindingWriterFixture('prepared-admission-topology-deadline');
      const headRefPath = symbolicHeadRefPath(fixture.repoRoot);
      const testDeadlineMs = 10_000;
      let resolveFifoReady!: () => void;
      const fifoReady = new Promise<void>((resolveReady) => {
        resolveFifoReady = resolveReady;
      });
      const execution = testOnlyRunWithPreparedFindingWriterFenceAdmission(
        {
          resourcePath: fixture.registryPath,
          lockPath: fixture.authority.lockPath,
          prepareSnapshot: async (signal) => {
            const snapshot = await fixture.authority.assertCompatibleWriters(signal);
            rmSync(headRefPath);
            execFileSync('/usr/bin/mkfifo', [headRefPath]);
            resolveFifoReady();
            return snapshot;
          },
          admit: async (snapshot, _lease, signal) =>
            fixture.authority.consumeCompatibleWriters(snapshot, signal),
          run: () => assert.fail('blocked topology admission reached its action'),
        },
        testDeadlineMs,
      );
      const rejection = assert.rejects(
        execution,
        (error: unknown) =>
          error instanceof FindingWriterFenceAdmissionDeadlineError &&
          error.admissionDeadlineMs === testDeadlineMs,
      );
      await awaitFindingWriterFifoReady(headRefPath, fifoReady, execution);
      const writer = await openFindingWriterFifoAfterReader(headRefPath);
      await rejection;
      closeSync(writer);
      assert.throws(
        () => openSync(headRefPath, constants.O_WRONLY | constants.O_NONBLOCK),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
      );
      assert.equal(existsSync(fixture.authority.lockPath), true);
      await testOnlyWithRegistryFileLockAsync(
        fixture.registryPath,
        (lease) => Promise.resolve(assertRegistryLockOwned(lease)),
        { lockPath: fixture.authority.lockPath, timeoutMs: 500 },
      );
    },
  );

  void test('prepared admission runs proof before lock and never retries non-stale failures', async () => {
    const fixture = createFindingWriterFixture('prepared-admission-order');
    const events: string[] = [];
    const nonStaleFailure = new Error('non-stale admission failure');

    await assert.rejects(
      runWithPreparedFindingWriterFenceAdmission({
        resourcePath: fixture.registryPath,
        lockPath: fixture.authority.lockPath,
        prepareSnapshot: (signal) => {
          events.push('PREPARE_WITHOUT_LOCK');
          return fixture.authority.assertCompatibleWriters(signal);
        },
        admit: (_snapshot, lease) => {
          assertRegistryLockOwned(lease);
          events.push('ADMIT_UNDER_LOCK');
          throw nonStaleFailure;
        },
        run: () => assert.fail('non-stale admission failure reached the action phase'),
      }),
      (error: unknown) => error === nonStaleFailure,
    );
    assert.deepEqual(events, ['PREPARE_WITHOUT_LOCK', 'ADMIT_UNDER_LOCK']);
  });

  void test('an action-side forged stale failure cannot re-enter admission or repeat a side effect', async () => {
    const fixture = createFindingWriterFixture('prepared-admission-action-failure');
    const sideEffectPath = join(fixture.repoRoot, 'action-side-effect.marker');
    const forgedStaleFailure = Object.assign(new Error('forged stale after side effect'), {
      code: 'FINDING_WRITER_FENCE_STALE',
      name: 'FindingWriterFenceStaleError',
    });
    let preparationAttempts = 0;
    let sideEffectAttempts = 0;

    await assert.rejects(
      runWithPreparedFindingWriterFenceAdmission({
        resourcePath: fixture.registryPath,
        lockPath: fixture.authority.lockPath,
        prepareSnapshot: (signal) => {
          preparationAttempts += 1;
          return fixture.authority.assertCompatibleWriters(signal);
        },
        admit: (snapshot) => snapshot,
        run: () => {
          sideEffectAttempts += 1;
          writeFileSync(sideEffectPath, `${String(sideEffectAttempts)}\n`, 'utf8');
          throw forgedStaleFailure;
        },
      }),
      (error: unknown) => error === forgedStaleFailure,
    );
    assert.equal(preparationAttempts, 1);
    assert.equal(sideEffectAttempts, 1);
    assert.equal(readFileSync(sideEffectPath, 'utf8'), '1\n');
  });

  void test('an authentic action-side stale capability cannot retry or repeat a side effect', async () => {
    const fixture = createFindingWriterFixture('prepared-admission-authentic-action-stale');
    const worktree = Object.freeze({
      worktree_path: fixture.repoRoot,
      head_oid: git(fixture.repoRoot, ['rev-parse', 'HEAD']),
      allocator_present: true,
    });
    const staleSnapshot = prepareSyntheticFindingWriterFenceSnapshot(
      fixture.authority,
      [worktree],
      {
        assertWorktreeGeneration: () => {
          throw new FindingWriterFenceGenerationMismatchError('synthetic authentic drift');
        },
      },
    );
    let authenticStale: FindingWriterFenceStaleError | undefined;
    try {
      await consumeSyntheticFindingWriterFence(fixture.authority, staleSnapshot);
      assert.fail('synthetic drift unexpectedly consumed its snapshot');
    } catch (error) {
      assert.ok(error instanceof FindingWriterFenceStaleError);
      authenticStale = error;
    }
    assert.ok(authenticStale !== undefined);

    let preparationAttempts = 0;
    let sideEffectAttempts = 0;
    await assert.rejects(
      runWithPreparedFindingWriterFenceAdmission({
        resourcePath: fixture.registryPath,
        lockPath: fixture.authority.lockPath,
        prepareSnapshot: (signal) => {
          preparationAttempts += 1;
          return fixture.authority.assertCompatibleWriters(signal);
        },
        admit: (snapshot) => snapshot,
        run: () => {
          sideEffectAttempts += 1;
          throw authenticStale;
        },
      }),
      (error: unknown) => error === authenticStale,
    );
    assert.equal(preparationAttempts, 1);
    assert.equal(sideEffectAttempts, 1);
  });

  void test('a durable reservation gap remains a monotonic floor after registry failure', async () => {
    const fixture = createFindingWriterFixture('durable-reservation-gap');
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');
    const registryFailure = new Error('registry publication failed after durable reservation');

    await assert.rejects(
      () =>
        withFindingWriterMutation(fixture, repositoryAuthority, 'add', (lease, writerFence) => {
          atomicWriteFindingReservationFile(
            fixture.authority.reservationPath,
            `${JSON.stringify({
              version: 1,
              domains: {
                PROC: {
                  sequence: 1,
                  finding_id: 'PROC-HIGH-001',
                  reserved_at: repositoryAuthority.effectiveAt,
                  registry_path: fixture.registryPath,
                },
              },
            })}\n`,
            lease,
            writerFence,
          );
          throw registryFailure;
        }),
      (error: unknown) => error === registryFailure,
    );
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');

    const stubPath = join(fixtureRoot, 'durable-reservation-gap-stub.json');
    writeFileSync(
      stubPath,
      JSON.stringify({
        severity: 'HIGH',
        title: 'Durable reservation gap advances the next allocation',
        evidence: ['tools/gates/finding-registry-store.spec.ts:reservation-gap'],
        owner_agent: 'context-manager',
        raised_in_cycle: '2026-08-08-prepared-admission',
      }),
      'utf8',
    );
    const exitCode = await withFindingWriterMutation(
      fixture,
      repositoryAuthority,
      'add',
      (lease, writerFence) =>
        appendAllocatedFinding(
          'PROC',
          stubPath,
          lease,
          repositoryAuthority,
          writerFence,
          fixture.authority,
          { registryPath: fixture.registryPath, schemaPath: fixture.schemaPath },
        ),
    );
    assert.equal(exitCode, 0);
    assert.match(readFileSync(fixture.registryPath, 'utf8'), /"id":"PROC-HIGH-002"/);
  });

  void test('kernel lock inode persists and opaque leases cannot be fabricated', () => {
    const resourcePath = join(fixtureRoot, 'persistent-lock.json');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'old\n', 'utf8');
    let firstInode = 0;
    testOnlyWithRegistryFileLock(resourcePath, (lease) => {
      const lock = lstatSync(lockPath);
      firstInode = lock.ino;
      assert.equal(lock.size, 0);
      assert.equal(lock.mode & 0o777, 0o600);
      const forgedLease: RegistryLockLease = { ...lease };
      assert.throws(
        () => testOnlyAtomicWriteFileWithRegistryLease(resourcePath, 'forged\n', forgedLease),
        (error: unknown) =>
          error instanceof RegistryLockError && error.code === 'LOCK_OWNERSHIP_LOST',
      );
    });
    assert.equal(existsSync(lockPath), true);
    assert.equal(lstatSync(lockPath).ino, firstInode);
    testOnlyWithRegistryFileLock(resourcePath, (lease) => {
      assert.equal(lstatSync(lockPath).ino, firstInode);
      testOnlyAtomicWriteFileWithRegistryLease(resourcePath, 'new\n', lease);
    });

    assert.equal(readFileSync(resourcePath, 'utf8'), 'new\n');
    assert.equal(lstatSync(lockPath).ino, firstInode);
    assert.equal(lstatSync(lockPath).size, 0);
  });

  void test('two processes cross a release barrier without sharing the critical section', async () => {
    const resourcePath = join(fixtureRoot, 'release-barrier.json');
    writeFileSync(resourcePath, 'stable\n', 'utf8');
    const holder = spawnStoreSpecChild('--kernel-lock-holder', [resourcePath]);
    let contender: SpawnedStoreSpecChild | undefined;
    try {
      await holder.waitForPhase('BOOTSTRAPPED');
      await holder.sendCommand('START');
      await holder.waitForPhase('LOCK_ACQUIRED');
      const lockInode = lstatSync(`${resourcePath}.lock`).ino;
      contender = spawnStoreSpecChild('--kernel-lock-contender', [resourcePath]);
      await contender.waitForPhase('BOOTSTRAPPED');
      await contender.sendCommand('START');
      await contender.waitForPhase('CONTENTION_CONFIRMED');
      await contender.sendCommand('BEGIN_BLOCKING_ACQUIRE');
      await contender.waitForPhase('BLOCKING_ACQUIRE_STARTED');
      await holder.sendCommand('RELEASE_LOCK');
      await Promise.all([
        holder.waitForPhase('LOCK_RELEASED'),
        contender.waitForPhase('LOCK_ACQUIRED'),
      ]);
      await contender.waitForPhase('LOCK_RELEASED');
      const [holderExit, contenderExit] = await Promise.all([
        holder.completion,
        contender.completion,
      ]);
      assert.deepEqual(holderExit, { code: 0, signal: null, stderr: '', stdout: '' });
      assert.deepEqual(contenderExit, { code: 0, signal: null, stderr: '', stdout: '' });
      assert.equal(lstatSync(`${resourcePath}.lock`).ino, lockInode);
    } finally {
      await Promise.all([
        terminateStoreSpecChild(holder),
        ...(contender === undefined ? [] : [terminateStoreSpecChild(contender)]),
      ]);
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

    const recovered = testOnlyWithRegistryFileLock(resourcePath, (lease) =>
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

  void test('canonical registry mutation recovers registry and reservation staging together', async () => {
    const writerFixture = createFindingWriterFixture('staging-registry');
    const { authority, registryPath } = writerFixture;
    const reservationPath = authority.reservationPath;
    const registryStagingName = `.${basename(registryPath)}.2147483647.123e4567-e89b-42d3-a456-426614174000.new`;
    const reservationStagingName = `.${basename(reservationPath)}.2147483647.223e4567-e89b-42d3-a456-426614174000.new`;
    const registryStagingPath = join(dirname(registryPath), registryStagingName);
    const reservationStagingPath = join(dirname(reservationPath), reservationStagingName);
    writeFileSync(registryStagingPath, 'orphan registry\n', 'utf8');
    writeFileSync(reservationStagingPath, 'orphan reservation\n', 'utf8');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(registryStagingPath, old, old);
    utimesSync(reservationStagingPath, old, old);
    const repositoryAuthority = await issueRepositoryMutationAuthority('add');

    assert.equal(registryMutationStagingFiles(authority).length, 2);
    await withFindingWriterMutation(
      writerFixture,
      repositoryAuthority,
      'add',
      (lease, writerFence) =>
        recoverRegistryMutationStaging(authority, lease, writerFence, repositoryAuthority, 'add'),
    );
    assert.deepEqual(registryMutationStagingFiles(authority), []);
    assert.equal(readFileSync(registryPath, 'utf8'), '');
  });

  void test('kernel releases an abruptly killed owner without stale-time takeover', async () => {
    const resourcePath = join(fixtureRoot, 'killed-owner.json');
    writeFileSync(resourcePath, 'unchanged\n', 'utf8');
    const holder = spawnStoreSpecChild('--kernel-lock-holder', [resourcePath]);
    try {
      await holder.waitForPhase('BOOTSTRAPPED');
      await holder.sendCommand('START');
      await holder.waitForPhase('LOCK_ACQUIRED');
      const lockPath = `${resourcePath}.lock`;
      const lockInode = lstatSync(lockPath).ino;
      assert.throws(
        () =>
          testOnlyWithRegistryFileLock(
            resourcePath,
            () => assert.fail('live kernel lock must not be taken over'),
            { timeoutMs: 100, pollIntervalMs: 5 },
          ),
        (error: unknown) => error instanceof RegistryLockError && error.code === 'LOCK_TIMEOUT',
      );
      const holderExit = await holder.terminateExpected('SIGKILL');
      assert.equal(holderExit.code, null);
      assert.equal(holderExit.signal, 'SIGKILL');

      testOnlyWithRegistryFileLock(resourcePath, (lease) =>
        testOnlyAtomicWriteFileWithRegistryLease(resourcePath, 'recovered\n', lease),
      );
      assert.equal(readFileSync(resourcePath, 'utf8'), 'recovered\n');
      assert.equal(lstatSync(lockPath).ino, lockInode);
    } finally {
      await terminateStoreSpecChild(holder);
    }
  });

  void test('non-empty forged lock records fail closed', () => {
    const resourcePath = join(fixtureRoot, 'forged-lock-record.json');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'unchanged\n', 'utf8');
    writeFileSync(lockPath, 'forged owner record\n', { encoding: 'utf8', mode: 0o600 });

    assert.throws(
      () =>
        testOnlyWithRegistryFileLock(resourcePath, () => assert.fail('forged record was admitted')),
      (error: unknown) =>
        error instanceof RegistryLockError && error.code === 'LOCK_OWNERSHIP_LOST',
    );
    assert.equal(readFileSync(resourcePath, 'utf8'), 'unchanged\n');
    assert.equal(readFileSync(lockPath, 'utf8'), 'forged owner record\n');
  });

  void test('inode replacement fences a writer before publication', () => {
    const resourcePath = join(fixtureRoot, 'fenced.jsonl');
    const lockPath = `${resourcePath}.lock`;
    const displacedLockPath = `${lockPath}.displaced`;
    writeFileSync(resourcePath, 'before\n', 'utf8');

    assert.throws(
      () =>
        testOnlyWithRegistryFileLock(resourcePath, (lease) => {
          renameSync(lockPath, displacedLockPath);
          writeFileSync(lockPath, '', { encoding: 'utf8', mode: 0o600 });
          testOnlyAtomicWriteFileWithRegistryLease(resourcePath, 'must-not-land\n', lease);
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
    assert.notEqual(lstatSync(lockPath).ino, lstatSync(displacedLockPath).ino);
  });

  void test('atomic writer leaves no staging file after a successful replace', () => {
    const resourcePath = join(fixtureRoot, 'atomic.jsonl');
    writeFileSync(resourcePath, 'before\n', 'utf8');
    testOnlyWithRegistryFileLock(resourcePath, (lease) => {
      testOnlyAtomicWriteFileWithRegistryLease(resourcePath, 'after\n', lease);
    });
    assert.equal(readFileSync(resourcePath, 'utf8'), 'after\n');
    assert.deepEqual(
      readdirSync(fixtureRoot).filter((name) => name.endsWith('.new')),
      [],
    );
  });

  void test('the repository has one finding-registry writer authority', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const retiredExecutables = FINDING_WRITER_RETIRED_MUTATION_SURFACES;
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

    const atomicWriterAuthorities = FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY.filter(
      (authority) =>
        authority.target === 'tools/gates/finding-registry-store.ts' &&
        authority.symbol === 'atomicWriteRegistryFile',
    );
    assert.equal(atomicWriterAuthorities.length, 1);
    assert.deepEqual(atomicWriterAuthorities[0]?.importers, [
      'tools/gates/finding-registry-store.spec.ts',
      'tools/gates/finding-registry.ts',
    ]);

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
