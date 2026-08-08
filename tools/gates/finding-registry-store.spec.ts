#!/usr/bin/env ts-node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  writeAriaAuthorityHash,
} from './aria-authority-hash';
import {
  allocationFloorForDomain,
  appendAllocatedFinding,
  assertActiveWorktreeFindingWritersFenced,
  recoverRegistryMutationStaging,
  registryMutationStagingFiles,
  reservedDomainFloorsFromManifest,
  resolveGitFindingAllocationAuthority,
  type Finding,
  type FindingAllocationAuthority,
  type RedeemedFindingWriterFenceCapability,
} from './finding-registry';
import {
  testOnlyAtomicWriteFileWithRegistryLease,
  atomicWriteRegistryFile,
  bindSourceFindingPublicationStore,
  claimedSequences,
  listAtomicWriteStagingFiles,
  nextFindingId,
  orphanMarkdownReservedIds,
  readOrphanMarkdownStore,
  recoverAtomicWriteStagingFiles,
  RegistryLockError,
  type FindingSeverity,
  type RegistryLockLease,
  withRegistryFileLock,
  withRegistryFileLockAsync,
} from './finding-registry-store';
import {
  acquireRepositoryMutationAuthority,
  FINDING_WRITER_TRUSTED_WORKFLOW_POLICY,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from './github-actions-oidc-authority';
import { FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS } from './lib/finding-writer-cli-contract';
import { AnchoredFilesystemError } from './lib/anchored-filesystem';
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
import { assertFindingWriterFenceCurrent } from './lib/finding-writer-fence';
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
  git(repoRoot, ['init', '--quiet', '--initial-branch=main']);
  git(repoRoot, ['add', '.']);
  writeAriaAuthorityHash(repoRoot);
}

interface FindingWriterFixture {
  readonly repoRoot: string;
  readonly registryPath: string;
  readonly schemaPath: string;
  readonly authority: FindingAllocationAuthority;
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
  writeFindingWriterProtocolManifest(repoRoot);
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

function withFindingWriterMutation<T>(
  fixture: FindingWriterFixture,
  repositoryAuthority: RepositoryMutationAuthority,
  operation: RegistryMutationOperation,
  action: (lease: RegistryLockLease, writerFence: RedeemedFindingWriterFenceCapability) => T,
): T {
  return withRegistryFileLock(
    fixture.registryPath,
    (lease) => {
      const snapshot = fixture.authority.assertCompatibleWriters();
      const capability = fixture.authority.consumeCompatibleWriters(snapshot);
      const writerFence = fixture.authority.redeemCompatibleWriters(capability, lease, {
        kind: 'REGISTRY_MUTATION',
        operation,
        repositoryAuthority,
      });
      try {
        return action(lease, writerFence);
      } finally {
        fixture.authority.releaseCompatibleWriters(writerFence);
      }
    },
    { lockPath: fixture.authority.lockPath },
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
    prepare: async () => {
      assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest);
      assert.equal(readFileSync(oldArtifactPath, 'utf8'), oldArtifact);
    },
    publishArtifact: async () => {
      if (existsSync(newArtifactPath)) {
        if (readFileSync(newArtifactPath, 'utf8') !== newArtifact) {
          throw new Error('immutable artifact collision');
        }
        return;
      }
      writeFileSync(newArtifactPath, newArtifact, { encoding: 'utf8', flag: 'wx' });
    },
    verifyArtifact: async () => {
      assert.equal(readFileSync(newArtifactPath, 'utf8'), newArtifact);
      assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest);
    },
    publishManifestCommitMarker: async () => {
      const stagingPath = join(directory, '.manifest.next');
      writeFileSync(stagingPath, sourceManifest(newArtifactPath), {
        encoding: 'utf8',
        flag: 'wx',
      });
      renameSync(stagingPath, manifestPath);
    },
    cleanupSupersededArtifacts: async (checkpoint) => {
      if (existsSync(oldArtifactPath)) {
        unlinkSync(oldArtifactPath);
        checkpoint();
      }
    },
    verifyCommittedCut: async () => {
      assert.equal(readFileSync(manifestPath, 'utf8'), sourceManifest(newArtifactPath));
      assert.equal(readFileSync(newArtifactPath, 'utf8'), newArtifact);
      assert.equal(existsSync(oldArtifactPath), false);
    },
    rollback: async () => {
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
      readAndVerifyManifestCommitMarker: async () => {
        const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifact?: unknown };
        if (typeof value.artifact !== 'string') throw new Error('invalid commit marker');
        selectedPath = join(directory, value.artifact);
        superseded = readdirSync(directory)
          .filter((entry) => /^source-findings\.[0-9a-f]{64}\.jsonl$/.test(entry))
          .map((entry) => join(directory, entry))
          .filter((entry) => entry !== selectedPath)
          .sort();
      },
      verifySelectedArtifact: async () => {
        if (selectedPath === null) throw new Error('missing recovery selection');
        const selected = readFileSync(selectedPath, 'utf8');
        assert.equal(sourceArtifactPath(directory, selected), selectedPath);
      },
      removeOneSupersededArtifact: async () => {
        const candidate = superseded.shift();
        if (candidate === undefined) return false;
        unlinkSync(candidate);
        return true;
      },
      syncRecoveredCut: async () => {},
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
    (lease) => {
      const snapshot = authority.assertCompatibleWriters();
      const capability = authority.consumeCompatibleWriters(snapshot);
      const writerFence = authority.redeemCompatibleWriters(capability, lease, {
        kind: 'REGISTRY_MUTATION',
        operation: 'add',
        repositoryAuthority,
      });
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
    {
      lockPath: authority.lockPath,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    },
  );
  if (exitCode !== 0) process.exit(exitCode);
  process.stdout.write('ok\n');
  process.exit(0);
}

interface SpawnedStoreSpecChild {
  readonly process: ReturnType<typeof spawn>;
  readonly completion: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }>;
}

function spawnStoreSpecChild(mode: string, args: readonly string[]): SpawnedStoreSpecChild {
  const entrypoint = mode.startsWith('--kernel-lock-')
    ? resolve(__dirname, 'lib', 'finding-registry-lock.fixture.ts')
    : __filename;
  const child = spawn(
    process.execPath,
    ['-r', require.resolve('ts-node/register'), entrypoint, mode, ...args],
    {
      env: { ...process.env, TS_NODE_PROJECT: resolve(__dirname, 'tsconfig.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }>((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('exit', (code, signal) => resolveChild({ code, signal, stderr }));
  });
  return { process: child, completion };
}

async function terminateStoreSpecChild(child: SpawnedStoreSpecChild): Promise<void> {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGKILL');
  }
  await Promise.allSettled([child.completion]);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for child barrier: ${path}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
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

    withFindingWriterMutation(fixture, addAuthority, 'add', (lease, writerFence) =>
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
    assert.throws(
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
    assert.throws(
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
        withRegistryFileLock(registryPath, (lease) =>
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

    withRegistryFileLock(
      fixture.registryPath,
      (lease) => {
        const snapshot = fixture.authority.assertCompatibleWriters();
        const capability = fixture.authority.consumeCompatibleWriters(snapshot);
        git(fixture.repoRoot, ['commit', '--quiet', '--allow-empty', '-m', 'advance exact head']);
        assert.throws(
          () =>
            fixture.authority.redeemCompatibleWriters(capability, lease, {
              kind: 'REGISTRY_MUTATION',
              operation: 'add',
              repositoryAuthority,
            }),
          /generation changed|HEAD changed/,
        );
      },
      { lockPath: fixture.authority.lockPath },
    );
    assert.equal(readFileSync(fixture.registryPath, 'utf8'), '');

    withRegistryFileLock(
      fixture.registryPath,
      (lease) => {
        const snapshot = fixture.authority.assertCompatibleWriters();
        assert.throws(
          () => fixture.authority.consumeCompatibleWriters({ ...snapshot }),
          /foreign, fabricated, or already consumed/,
        );
        const capability = fixture.authority.consumeCompatibleWriters(snapshot);
        assert.throws(
          () => fixture.authority.consumeCompatibleWriters(snapshot),
          /foreign, fabricated, or already consumed/,
        );
        const profile = {
          kind: 'REGISTRY_MUTATION' as const,
          operation: 'add' as const,
          repositoryAuthority,
        };
        const writerFence = fixture.authority.redeemCompatibleWriters(capability, lease, profile);
        Reflect.set(profile, 'kind', 'SOURCE_INVENTORY');
        const sourceStore = Reflect.apply(bindSourceFindingPublicationStore, undefined, [
          lease,
          writerFence,
        ]);
        assert.throws(
          () =>
            sourceStore.commitManifest(
              join(fixture.repoRoot, CAPABILITY_PLAN_RELATIVE_PATH, 'manifest.json'),
              '{}\n',
            ),
          /registry profile cannot mutate source_manifest/,
        );
        assert.throws(
          () =>
            fixture.authority.redeemCompatibleWriters(capability, lease, {
              kind: 'REGISTRY_MUTATION',
              operation: 'add',
              repositoryAuthority,
            }),
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

  void test('allocation authority and captured worktree generations are runtime immutable', () => {
    const fixture = createFindingWriterFixture('writer-runtime-immutability');
    assert.equal(Object.isFrozen(fixture.authority), true);
    assert.equal(Reflect.set(fixture.authority, 'lockPath', 'forged.lock'), false);
    const snapshot = fixture.authority.assertCompatibleWriters();
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
    withRegistryFileLock(
      addedFixture.registryPath,
      (lease) => {
        const snapshot = addedFixture.authority.assertCompatibleWriters();
        git(addedFixture.repoRoot, ['worktree', 'add', '--quiet', '--detach', addedWorktree]);
        try {
          assert.throws(
            () => addedFixture.authority.consumeCompatibleWriters(snapshot),
            /active worktree set changed/,
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
    withRegistryFileLock(
      removedFixture.registryPath,
      (lease) => {
        const snapshot = removedFixture.authority.assertCompatibleWriters();
        const capability = removedFixture.authority.consumeCompatibleWriters(snapshot);
        const writerFence = removedFixture.authority.redeemCompatibleWriters(capability, lease, {
          kind: 'REGISTRY_MUTATION',
          operation: 'add',
          repositoryAuthority,
        });
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
            /active worktree set changed/,
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
      withRegistryFileLock(
        fixture.registryPath,
        (lease) => {
          const snapshot = fixture.authority.assertCompatibleWriters();
          const capability = fixture.authority.consumeCompatibleWriters(snapshot);
          const writerFence = fixture.authority.redeemCompatibleWriters(capability, lease, {
            kind: 'REGISTRY_MUTATION',
            operation: 'add',
            repositoryAuthority,
          });
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
    withFindingWriterMutation(first, repositoryAuthority, 'add', (lease, writerFence) => {
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

    withRegistryFileLock(
      manifestPath,
      (lease) => {
        const snapshot = fixture.authority.assertCompatibleWriters();
        const capability = fixture.authority.consumeCompatibleWriters(snapshot);
        assert.throws(
          () =>
            Reflect.apply(fixture.authority.redeemCompatibleWriters, fixture.authority, [
              capability,
              lease,
              { kind: 'SOURCE_INVENTORY' },
            ]),
          /accepts registry mutation profiles only/,
        );
      },
      { lockPath: fixture.authority.lockPath },
    );

    withRegistryFileLock(
      manifestPath,
      (lease) => {
        const snapshot = fixture.authority.assertCompatibleWriters();
        const capability = fixture.authority.consumeCompatibleWriters(snapshot);
        assert.throws(
          () =>
            fixture.authority.redeemCompatibleWriters(capability, lease, {
              kind: 'REGISTRY_MUTATION',
              operation: 'add',
              repositoryAuthority,
            }),
          /registry profile is bound to/,
        );
      },
      { lockPath: fixture.authority.lockPath },
    );
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
        withRegistryFileLock(aliasPath, (lease) =>
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

  void test('allocator-absent worktrees reject every retired mutation surface', () => {
    for (const [index, retiredSurface] of FINDING_WRITER_RETIRED_MUTATION_SURFACES.entries()) {
      const repoRoot = join(fixtureRoot, `retired-writer-${index}`);
      writeFindingAllocationSubstrateFixture(repoRoot);
      mkdirSync(dirname(join(repoRoot, retiredSurface)), { recursive: true });
      writeFileSync(join(repoRoot, retiredSurface), 'process.exitCode = 0;\n', 'utf8');
      git(repoRoot, ['init', '--quiet', '--initial-branch=main']);
      git(repoRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
      git(repoRoot, ['config', 'user.name', 'finding-registry-spec']);
      git(repoRoot, ['config', 'commit.gpgsign', 'false']);
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '--quiet', '-m', 'retired writer fixture']);
      assert.throws(
        () => assertActiveWorktreeFindingWritersFenced([repoRoot], repoRoot),
        new RegExp(retiredSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
  });

  void test('allocator-present worktrees reject committed and dirty retired-writer resurrection', () => {
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
      assert.throws(
        () => assertActiveWorktreeFindingWritersFenced([fixture.repoRoot], fixture.repoRoot),
        new RegExp(retiredSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
  });

  void test('writer compatibility is a committed content-digest protocol, not source-text heuristics', () => {
    const repoRoot = join(fixtureRoot, 'writer-protocol');
    writeWriterProtocolFixture(repoRoot);
    writeFindingInventoryFloorAuthority(repoRoot, [], {});
    const protocolPath = join(repoRoot, FINDING_WRITER_AUTHORITY_PATH);
    mkdirSync(resolve(protocolPath, '..'), { recursive: true });
    const protocol = buildFindingWriterProtocolManifest(repoRoot);
    assert.equal(writeFindingWriterProtocolManifest(repoRoot), true);
    const firstGeneratedBytes = readFileSync(protocolPath, 'utf8');
    assert.equal(firstGeneratedBytes, renderFindingWriterProtocolManifest(repoRoot));
    assert.equal(writeFindingWriterProtocolManifest(repoRoot), false);
    assert.equal(readFileSync(protocolPath, 'utf8'), firstGeneratedBytes);
    assert.doesNotThrow(() => checkFindingWriterProtocolManifest(repoRoot));
    git(repoRoot, ['config', 'user.email', 'finding-registry-spec@invalid.local']);
    git(repoRoot, ['config', 'user.name', 'finding-registry-spec']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'writer protocol fixture']);

    assert.doesNotThrow(() => assertActiveWorktreeFindingWritersFenced([repoRoot], repoRoot));

    const allocatorPath = join(repoRoot, 'tools/gates/finding-registry.ts');
    const committedAllocatorBytes = readFileSync(allocatorPath);
    writeFileSync(
      allocatorPath,
      Buffer.concat([committedAllocatorBytes, Buffer.from('\n', 'utf8')]),
    );
    assert.throws(
      () => assertActiveWorktreeFindingWritersFenced([repoRoot], repoRoot),
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
    assert.throws(
      () => assertActiveWorktreeFindingWritersFenced([repoRoot, noncanonicalRoot], repoRoot),
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
    assert.equal(writeFindingWriterProtocolManifest(actionDivergentRoot), true);
    git(actionDivergentRoot, ['add', '.']);
    git(actionDivergentRoot, ['commit', '--quiet', '-m', 'divergent local action helper']);
    assert.throws(
      () => assertActiveWorktreeFindingWritersFenced([repoRoot, actionDivergentRoot], repoRoot),
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
    assert.equal(writeFindingWriterProtocolManifest(divergentRoot), true);
    git(divergentRoot, ['add', '.']);
    git(divergentRoot, ['commit', '--quiet', '-m', 'divergent writer implementation']);
    assert.throws(
      () => assertActiveWorktreeFindingWritersFenced([repoRoot, divergentRoot], repoRoot),
      /protocol-incompatible finding writers/,
    );

    writeFileSync(
      join(repoRoot, 'tools/gates/finding-registry.ts'),
      'function cmdAdd() { return "uncommitted"; }\n',
      'utf8',
    );
    assert.throws(
      () => assertActiveWorktreeFindingWritersFenced([repoRoot], repoRoot),
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
      () => assertActiveWorktreeFindingWritersFenced([repoRoot], repoRoot),
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
    const allocated = withFindingWriterMutation(
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
    assert.equal(lstatSync(`${resourcePath}.lock`).size, 0);
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
        const releaseError = error.errors[1];
        assert.ok(releaseError instanceof RegistryLockError);
        assert.equal(releaseError.code, 'LOCK_OWNERSHIP_LOST');
        return true;
      },
    );
    rmSync(lockPath);
  });

  void test('async actions retain the lease until settlement and use the same failure contract', async () => {
    const resourcePath = join(fixtureRoot, 'async-action.jsonl');
    const result = await withRegistryFileLockAsync(resourcePath, async (lease) => {
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
    const localExit = withFindingWriterMutation(
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
    const authorityExit = withFindingWriterMutation(
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
    assert.throws(
      () => authorityA.assertCompatibleWriters(),
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
    assert.throws(
      () => authorityA.assertCompatibleWriters(),
      /protocol-incompatible finding writers/,
    );

    git(repoA, ['worktree', 'remove', '--force', repoB]);

    const afterRemovalStub = join(fixtureRoot, 'worktree-a-after-removal.json');
    makeStub(afterRemovalStub, 'LOW', 'Durable reservation survives worktree removal');
    const afterRemovalExit = withFindingWriterMutation(
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

  void test('active registries validate schema and bind every immutable creation field', () => {
    const fixture = createFindingWriterFixture('identity-worktree-a');
    const repoB = join(fixtureRoot, 'identity-worktree-b');
    git(fixture.repoRoot, ['worktree', 'add', '--quiet', '-b', 'identity-worker-b', repoB]);
    const registryB = join(repoB, 'docs', 'reviews', '_registry', 'findings.jsonl');
    const authority = resolveGitFindingAllocationAuthority(fixture.repoRoot);
    const base = findingFixture();
    writeFindingRegistryFixture(fixture.registryPath, [base]);
    writeFindingRegistryFixture(registryB, [findingFixture({ state: 'IN-PROGRESS' })]);
    assert.doesNotThrow(() => authority.assertCompatibleWriters());

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
      assert.throws(
        () => authority.assertCompatibleWriters(),
        new RegExp(
          `assign PROC-HIGH-015 to different immutable finding identities.*${field}|different immutable finding identities`,
        ),
      );
    }

    writeFileSync(registryB, '{"id":\n', 'utf8');
    assert.throws(
      () => authority.assertCompatibleWriters(),
      /Finding registry JSON is invalid: .*findings\.jsonl:1/,
    );

    const invalidIdEntry: Record<string, unknown> = { ...findingFixture(), id: 15 };
    const { content_hash: _invalidHash, ...invalidForHash } = invalidIdEntry;
    invalidIdEntry['content_hash'] = createHash('sha256')
      .update(canonicalFindingFixtureJson(invalidForHash), 'utf8')
      .digest('hex');
    writeFileSync(registryB, `${JSON.stringify(invalidIdEntry)}\n`, 'utf8');
    assert.throws(
      () => authority.assertCompatibleWriters(),
      /row violates its canonical schema: .*findings\.jsonl:1/,
    );

    writeFindingRegistryFixture(registryB, [base, base]);
    assert.throws(
      () => authority.assertCompatibleWriters(),
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
    const append = (domain: string, stubPath: string): number =>
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
    assert.equal(append('FE', feStub), 0);
    assert.equal(append('ORPHAN', orphanStub), 0);
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
      withFindingWriterMutation(
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
    const runAppend = (stubPath: string): number =>
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

    const exitCode = runAppend(validStubPath);
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
    const invalidExitCode = runAppend(invalidStubPath);
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
    const invalidEvidenceExit = runAppend(invalidEvidenceStubPath);
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
    const emptyHighEvidenceExit = runAppend(emptyHighEvidenceStubPath);
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

    const exitCode = withFindingWriterMutation(
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

  void test('kernel lock inode persists and opaque leases cannot be fabricated', () => {
    const resourcePath = join(fixtureRoot, 'persistent-lock.json');
    const lockPath = `${resourcePath}.lock`;
    writeFileSync(resourcePath, 'old\n', 'utf8');
    let firstInode = 0;
    withRegistryFileLock(resourcePath, (lease) => {
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
    withRegistryFileLock(resourcePath, (lease) => {
      assert.equal(lstatSync(lockPath).ino, firstInode);
      testOnlyAtomicWriteFileWithRegistryLease(resourcePath, 'new\n', lease);
    });

    assert.equal(readFileSync(resourcePath, 'utf8'), 'new\n');
    assert.equal(lstatSync(lockPath).ino, firstInode);
    assert.equal(lstatSync(lockPath).size, 0);
  });

  void test('two processes cross a release barrier without sharing the critical section', async () => {
    const resourcePath = join(fixtureRoot, 'release-barrier.json');
    const readyPath = join(fixtureRoot, 'release-barrier.ready');
    const releasePath = join(fixtureRoot, 'release-barrier.release');
    const blockedPath = join(fixtureRoot, 'release-barrier.blocked');
    const enteredPath = join(fixtureRoot, 'release-barrier.entered');
    writeFileSync(resourcePath, 'stable\n', 'utf8');
    const holder = spawnStoreSpecChild('--kernel-lock-holder', [
      resourcePath,
      readyPath,
      releasePath,
    ]);
    let contender: SpawnedStoreSpecChild | undefined;
    try {
      await waitForFile(readyPath);
      const lockInode = lstatSync(`${resourcePath}.lock`).ino;
      contender = spawnStoreSpecChild('--kernel-lock-contender', [
        resourcePath,
        blockedPath,
        enteredPath,
      ]);
      await waitForFile(blockedPath);
      assert.equal(existsSync(enteredPath), false);
      writeFileSync(releasePath, 'release\n', 'utf8');
      const [holderExit, contenderExit] = await Promise.all([
        holder.completion,
        contender.completion,
      ]);
      assert.deepEqual(holderExit, { code: 0, signal: null, stderr: '' });
      assert.deepEqual(contenderExit, { code: 0, signal: null, stderr: '' });
      assert.equal(existsSync(enteredPath), true);
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
    withFindingWriterMutation(writerFixture, repositoryAuthority, 'add', (lease, writerFence) =>
      recoverRegistryMutationStaging(authority, lease, writerFence, repositoryAuthority, 'add'),
    );
    assert.deepEqual(registryMutationStagingFiles(authority), []);
    assert.equal(readFileSync(registryPath, 'utf8'), '');
  });

  void test('kernel releases an abruptly killed owner without stale-time takeover', async () => {
    const resourcePath = join(fixtureRoot, 'killed-owner.json');
    const readyPath = join(fixtureRoot, 'killed-owner.ready');
    const releasePath = join(fixtureRoot, 'killed-owner.never-release');
    writeFileSync(resourcePath, 'unchanged\n', 'utf8');
    const holder = spawnStoreSpecChild('--kernel-lock-holder', [
      resourcePath,
      readyPath,
      releasePath,
    ]);
    try {
      await waitForFile(readyPath);
      const lockPath = `${resourcePath}.lock`;
      const lockInode = lstatSync(lockPath).ino;
      assert.throws(
        () =>
          withRegistryFileLock(
            resourcePath,
            () => assert.fail('live kernel lock must not be taken over'),
            { timeoutMs: 100, pollIntervalMs: 5 },
          ),
        (error: unknown) => error instanceof RegistryLockError && error.code === 'LOCK_TIMEOUT',
      );
      assert.equal(holder.process.kill('SIGKILL'), true);
      const holderExit = await holder.completion;
      assert.equal(holderExit.code, null);
      assert.equal(holderExit.signal, 'SIGKILL');

      withRegistryFileLock(resourcePath, (lease) =>
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
      () => withRegistryFileLock(resourcePath, () => assert.fail('forged record was admitted')),
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
        withRegistryFileLock(resourcePath, (lease) => {
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
    withRegistryFileLock(resourcePath, (lease) => {
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
