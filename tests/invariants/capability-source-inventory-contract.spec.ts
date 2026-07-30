import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InventoryInspectionError,
  TRUSTED_RETIREMENT_ISSUER,
  TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
  assertOriginMainStable,
  compareInventory,
  compareInventoryForCli,
  computeDirtyContentSha256,
  createTrustedRetirementAuthorizationVerifier,
  discoverInventory,
  parseInventoryCliArgs,
  parseInventoryCliOptions,
  parseInventoryManifest,
  parseRefList,
  parseWorktreeList,
  resolveGitHubActionsExecutionIdentity,
  serializeRetirementAuthorizationStatement,
  selectExecutionIdentity,
  validateMainProofs,
  type DiscoveryInput,
  type InventoryManifest,
  type ManifestSourceCoordinate,
  type RetirementApproval,
  type RetirementAuthorizationVerifier,
} from '../../tools/gates/capability-source-inventory';

const MAIN_SHA = '1111111111111111111111111111111111111111';
const MERGED_SHA = '2222222222222222222222222222222222222222';
const REMOTE_SHA = '3333333333333333333333333333333333333333';
const LOCAL_SHA = '4444444444444444444444444444444444444444';
const DIVERGED_LOCAL_SHA = '5555555555555555555555555555555555555555';
const DIRTY_SHA = '6666666666666666666666666666666666666666';
const BASE_SHA = '7777777777777777777777777777777777777777';
const OTHER_BASE_SHA = '8888888888888888888888888888888888888888';
const CURRENT_SHA = '9999999999999999999999999999999999999999';
const DIRTY_CONTENT_SHA = 'a'.repeat(64);
const CHANGED_DIRTY_CONTENT_SHA = 'b'.repeat(64);
const RETIREMENT_SNAPSHOT_SHA = 'c'.repeat(64);
const RETIREMENT_STATEMENT_SHA = 'e'.repeat(64);
const RETIREMENT_BUNDLE_SHA = 'f'.repeat(64);
const EQUIVALENT_TREE_SHA = 'd'.repeat(40);
const DIFFERENT_TREE_SHA = 'e'.repeat(40);
const CURRENT_BRANCH = 'chore/current-inventory';

const RETIREMENT: RetirementApproval = {
  status: 'RETIRE_APPROVED',
  approvedAt: '2026-07-29T12:00:00.000Z',
  approvedBy: 'release-engineering',
  snapshotSha256: RETIREMENT_SNAPSHOT_SHA,
  snapshotUri: `artifact://sha256/${RETIREMENT_SNAPSHOT_SHA}/snapshot.tar.zst`,
  evidence: [
    `artifact://sha256/${RETIREMENT_SNAPSHOT_SHA}/snapshot.tar.zst`,
    `artifact://sha256/${RETIREMENT_STATEMENT_SHA}/authorization-statement.json`,
    `artifact://sha256/${RETIREMENT_BUNDLE_SHA}/sigstore-bundle.json`,
  ],
  authorization: {
    kind: 'SIGSTORE_BUNDLE_V1',
    issuer: TRUSTED_RETIREMENT_ISSUER,
    signerIdentity: TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
    statementSha256: RETIREMENT_STATEMENT_SHA,
    statementUri: `artifact://sha256/${RETIREMENT_STATEMENT_SHA}/authorization-statement.json`,
    subjectSha256: RETIREMENT_STATEMENT_SHA,
    bundleSha256: RETIREMENT_BUNDLE_SHA,
    bundleUri: `artifact://sha256/${RETIREMENT_BUNDLE_SHA}/sigstore-bundle.json`,
  },
};

const DIRTY_RETIREMENT: RetirementApproval = {
  ...RETIREMENT,
  capturedContentSha256: DIRTY_CONTENT_SHA,
};

const AUTHORIZE_RETIREMENT: RetirementAuthorizationVerifier = ({ source, approval }) => ({
  authorized:
    approval.authorization.issuer === TRUSTED_RETIREMENT_ISSUER &&
    approval.authorization.signerIdentity === TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
  reason: 'trusted repository retirement workflow identity',
  verifiedSubjectSha256: approval.authorization.statementSha256,
  verifiedSnapshotSha256: approval.snapshotSha256,
  verifiedBundleSha256: approval.authorization.bundleSha256,
  verifiedIssuer: approval.authorization.issuer,
  verifiedSignerIdentity: approval.authorization.signerIdentity,
  verifiedSourceId: source.id,
  verifiedSourceKind: source.kind,
  verifiedSourceLocator: source.locator,
  verifiedSourceHeadSha: source.headSha,
  verifiedApprovedBy: approval.approvedBy,
  verifiedApprovedAt: approval.approvedAt,
  ...(source.kind === 'DIRTY_WORKTREE'
    ? { verifiedCapturedContentSha256: source.contentSha256 }
    : {}),
});

function input(overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  const ancestry = new Set([
    `${BASE_SHA}:${MAIN_SHA}`,
    `${MERGED_SHA}:${MAIN_SHA}`,
    `${REMOTE_SHA}:${REMOTE_SHA}`,
    `${LOCAL_SHA}:${LOCAL_SHA}`,
    `${CURRENT_SHA}:${CURRENT_SHA}`,
    `${MAIN_SHA}:${MAIN_SHA}`,
  ]);

  return {
    mainSha: MAIN_SHA,
    remoteRefs: [
      { locator: 'refs/remotes/origin/HEAD', headSha: MAIN_SHA },
      { locator: 'refs/remotes/origin/main', headSha: MAIN_SHA },
      { locator: 'refs/remotes/origin/already-merged', headSha: MERGED_SHA },
      { locator: 'refs/remotes/origin/feature/remote', headSha: REMOTE_SHA },
      {
        locator: `refs/remotes/origin/${CURRENT_BRANCH}`,
        headSha: CURRENT_SHA,
      },
    ],
    localRefs: [
      { locator: 'refs/heads/main', headSha: MAIN_SHA },
      { locator: 'refs/heads/already-merged', headSha: MERGED_SHA },
      { locator: 'refs/heads/feature/remote-copy', headSha: REMOTE_SHA },
      { locator: 'refs/heads/feature/local-only', headSha: LOCAL_SHA },
      { locator: 'refs/heads/feature/diverged', headSha: DIVERGED_LOCAL_SHA },
      {
        locator: `refs/heads/${CURRENT_BRANCH}`,
        headSha: CURRENT_SHA,
      },
    ],
    worktrees: [
      {
        path: '/repo',
        headSha: MAIN_SHA,
        branchRef: 'refs/heads/main',
        dirty: false,
      },
      {
        path: '/tmp/dirty',
        headSha: DIRTY_SHA,
        branchRef: 'refs/heads/feature/local-only',
        dirty: true,
        contentSha256: DIRTY_CONTENT_SHA,
      },
      {
        path: '/tmp/integration',
        headSha: CURRENT_SHA,
        branchRef: `refs/heads/${CURRENT_BRANCH}`,
        dirty: true,
      },
    ],
    executionIdentity: {
      worktreePath: '/tmp/integration',
      headSha: CURRENT_SHA,
      branchRef: `refs/heads/${CURRENT_BRANCH}`,
      originRef: `refs/remotes/origin/${CURRENT_BRANCH}`,
    },
    isAncestor: (ancestor, descendant) => ancestry.has(`${ancestor}:${descendant}`),
    ...overrides,
  };
}

function exactManifest(): InventoryManifest {
  const live = discoverInventory(input());
  return {
    reconciledBaseSha: BASE_SHA,
    sources: live.sources.map((source, index) => ({
      id: `SRC-${String(index + 1).padStart(3, '0')}`,
      state: 'ASSESSING',
      disposition: 'REIMPLEMENT',
      ...source,
    })),
  };
}

function writeContentAddressedArtifact(
  evidenceRoot: string,
  name: string,
  bytes: Buffer,
): { sha256: string; uri: string; path: string } {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = join(evidenceRoot, 'sha256', sha256);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return {
    sha256,
    uri: `artifact://sha256/${sha256}/${name}`,
    path,
  };
}

function createRetirementEvidence(
  evidenceRoot: string,
  source: ManifestSourceCoordinate,
): RetirementApproval {
  const snapshot = writeContentAddressedArtifact(
    evidenceRoot,
    'snapshot.tar.zst',
    Buffer.from('immutable source snapshot\n'),
  );
  const bundle = writeContentAddressedArtifact(
    evidenceRoot,
    'sigstore-bundle.json',
    Buffer.from('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n'),
  );
  const approval: RetirementApproval = {
    status: 'RETIRE_APPROVED',
    approvedAt: '2026-07-29T12:00:00.000Z',
    approvedBy: 'release-engineering',
    snapshotSha256: snapshot.sha256,
    snapshotUri: snapshot.uri,
    evidence: [],
    authorization: {
      kind: 'SIGSTORE_BUNDLE_V1',
      issuer: TRUSTED_RETIREMENT_ISSUER,
      signerIdentity: TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
      statementSha256: '0'.repeat(64),
      statementUri: `artifact://sha256/${'0'.repeat(64)}/authorization-statement.json`,
      subjectSha256: '0'.repeat(64),
      bundleSha256: bundle.sha256,
      bundleUri: bundle.uri,
    },
  };
  const statement = writeContentAddressedArtifact(
    evidenceRoot,
    'authorization-statement.json',
    Buffer.from(serializeRetirementAuthorizationStatement({ source, approval }), 'utf8'),
  );
  approval.authorization.statementSha256 = statement.sha256;
  approval.authorization.statementUri = statement.uri;
  approval.authorization.subjectSha256 = statement.sha256;
  approval.evidence = [snapshot.uri, statement.uri, bundle.uri];
  return approval;
}

function fixtureIsAncestor(ancestorSha: string, descendantSha: string): boolean {
  return input().isAncestor(ancestorSha, descendantSha);
}

describe('capability source inventory discovery', () => {
  it('excludes only the exact currently executing non-main branch, ref, and worktree', () => {
    const inventory = discoverInventory(input());

    expect(inventory.sources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locator: `refs/remotes/origin/${CURRENT_BRANCH}`,
        }),
        expect.objectContaining({ locator: `refs/heads/${CURRENT_BRANCH}` }),
        expect.objectContaining({ locator: '/tmp/integration' }),
      ]),
    );
    expect(inventory.sources.filter((source) => source.kind === 'REMOTE_BRANCH')).toEqual([
      {
        kind: 'REMOTE_BRANCH',
        locator: 'refs/remotes/origin/feature/remote',
        headSha: REMOTE_SHA,
      },
    ]);
  });

  it('does not exclude a historical branch name when execution is on main', () => {
    const historical = discoverInventory(
      input({
        executionIdentity: null,
        worktrees: input().worktrees.map((worktree) =>
          worktree.path === '/tmp/integration'
            ? { ...worktree, contentSha256: CHANGED_DIRTY_CONTENT_SHA }
            : worktree,
        ),
      }),
    );

    expect(historical.sources).toEqual(
      expect.arrayContaining([
        {
          kind: 'REMOTE_BRANCH',
          locator: `refs/remotes/origin/${CURRENT_BRANCH}`,
          headSha: CURRENT_SHA,
        },
        {
          kind: 'DIRTY_WORKTREE',
          locator: '/tmp/integration',
          headSha: CURRENT_SHA,
          contentSha256: CHANGED_DIRTY_CONTENT_SHA,
        },
      ]),
    );
  });

  it('finds locally unique tips and preserves dirty content identity separately', () => {
    const inventory = discoverInventory(input());

    expect(inventory.sources.filter((source) => source.kind === 'LOCAL_BRANCH')).toEqual([
      {
        kind: 'LOCAL_BRANCH',
        locator: 'refs/heads/feature/diverged',
        headSha: DIVERGED_LOCAL_SHA,
      },
      {
        kind: 'LOCAL_BRANCH',
        locator: 'refs/heads/feature/local-only',
        headSha: LOCAL_SHA,
      },
    ]);
    expect(inventory.sources.filter((source) => source.kind === 'DIRTY_WORKTREE')).toEqual([
      {
        kind: 'DIRTY_WORKTREE',
        locator: '/tmp/dirty',
        headSha: DIRTY_SHA,
        contentSha256: DIRTY_CONTENT_SHA,
      },
    ]);
  });

  it('parses machine-readable ref and worktree output without repository assumptions', () => {
    expect(
      parseRefList(
        [
          `refs/remotes/origin/main\t${MAIN_SHA}`,
          `refs/remotes/origin/feature/remote\t${REMOTE_SHA}`,
          '',
        ].join('\n'),
      ),
    ).toEqual([
      { locator: 'refs/remotes/origin/main', headSha: MAIN_SHA },
      { locator: 'refs/remotes/origin/feature/remote', headSha: REMOTE_SHA },
    ]);

    expect(
      parseWorktreeList(
        [
          'worktree /repo',
          `HEAD ${MAIN_SHA}`,
          'branch refs/heads/main',
          'worktree /tmp/detached evidence',
          `HEAD ${DIRTY_SHA}`,
          'detached',
          '',
        ].join('\0'),
      ),
    ).toEqual([
      {
        path: '/repo',
        headSha: MAIN_SHA,
        branchRef: 'refs/heads/main',
      },
      {
        path: '/tmp/detached evidence',
        headSha: DIRTY_SHA,
        branchRef: null,
      },
    ]);
  });
});

describe('remote-only inventory scope', () => {
  it('models a hosted runner without declaring host-local sources missing', () => {
    const manifest = exactManifest();
    const hostedRunnerLive = discoverInventory(
      input({
        localRefs: [],
        worktrees: [],
      }),
      'remote',
    );

    expect(hostedRunnerLive.sources.every((source) => source.kind === 'REMOTE_BRANCH')).toBe(true);
    expect(compareInventory(manifest, hostedRunnerLive, fixtureIsAncestor, 'remote')).toEqual([]);
  });

  it('still detects undeclared and moved remote refs', () => {
    const manifest = exactManifest();
    const movedRemoteInput = input({
      remoteRefs: input().remoteRefs.map((source) =>
        source.locator === 'refs/remotes/origin/feature/remote'
          ? { ...source, headSha: DIRTY_SHA }
          : source,
      ),
      localRefs: [],
      worktrees: [],
    });
    const movedRemote = discoverInventory(movedRemoteInput, 'remote');
    expect(
      compareInventory(manifest, movedRemote, fixtureIsAncestor, 'remote').map(
        (drift) => drift.code,
      ),
    ).toEqual(['SOURCE_HEAD_DRIFT']);

    const undeclaredRemote = discoverInventory(
      input({
        remoteRefs: [
          ...input().remoteRefs,
          {
            locator: 'refs/remotes/origin/feature/undeclared',
            headSha: DIRTY_SHA,
          },
        ],
        localRefs: [],
        worktrees: [],
      }),
      'remote',
    );
    expect(
      compareInventory(manifest, undeclaredRemote, fixtureIsAncestor, 'remote').map(
        (drift) => drift.code,
      ),
    ).toEqual(['SOURCE_UNDECLARED']);
  });

  it('keeps base ancestry and CLI scope selection fail-closed', () => {
    const manifest = exactManifest();
    manifest.reconciledBaseSha = OTHER_BASE_SHA;
    const hostedRunnerLive = discoverInventory(input({ localRefs: [], worktrees: [] }), 'remote');

    expect(
      compareInventory(manifest, hostedRunnerLive, fixtureIsAncestor, 'remote').map(
        (drift) => drift.code,
      ),
    ).toEqual(['RECONCILED_BASE_NOT_ANCESTOR']);
    expect(parseInventoryCliArgs(['--live'])).toBe('full');
    expect(parseInventoryCliArgs(['--scope=remote', '--live'])).toBe('remote');
    expect(
      parseInventoryCliOptions(['--live', '--retirement-evidence-root=/tmp/retirement-evidence']),
    ).toEqual({
      scope: 'full',
      retirementEvidenceRoot: '/tmp/retirement-evidence',
    });
    expect(() => parseInventoryCliArgs(['--live', '--scope=local'])).toThrow(
      'expected --live [--scope=remote]',
    );
    expect(() =>
      parseInventoryCliOptions(['--live', '--retirement-verifier-command=attacker-controlled']),
    ).toThrow('expected --live');
  });

  it('does not let remote scope bypass static host-local manifest validation', () => {
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              id: 'SRC-DIRTY',
              kind: 'DIRTY_WORKTREE',
              locator: '/tmp/dirty',
              head_sha: DIRTY_SHA,
              state: 'ASSESSING',
              disposition: 'REIMPLEMENT',
            },
          ],
        },
      }),
    ).toThrow('content_sha256');
  });
});

describe('remote inventory required-gate wiring', () => {
  it('pins the hosted-runner command, fetch, checkout, and trusted PR identity contract', () => {
    const repositoryRoot = join(__dirname, '..', '..');
    const packageJsonRaw: unknown = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
    );
    if (
      typeof packageJsonRaw !== 'object' ||
      packageJsonRaw === null ||
      !('scripts' in packageJsonRaw) ||
      typeof packageJsonRaw.scripts !== 'object' ||
      packageJsonRaw.scripts === null
    ) {
      throw new Error('package.json scripts contract is unavailable');
    }
    const scripts = packageJsonRaw.scripts as Record<string, unknown>;
    expect(scripts['gates:capability-source-inventory:live']).toBe(
      'ts-node --project tools/gates/tsconfig.json tools/gates/capability-source-inventory.ts --live',
    );
    expect(scripts['gates:capability-source-inventory:remote']).toBe(
      'ts-node --project tools/gates/tsconfig.json tools/gates/capability-source-inventory.ts --live --scope=remote',
    );

    const workflow = readFileSync(
      join(repositoryRoot, '.github', 'workflows', 'ci-full.yml'),
      'utf8',
    );
    const jobStart = workflow.indexOf('\n  deploy-ssot-gates:\n');
    const jobEnd = workflow.indexOf('\n  security-scan:\n', jobStart + 1);
    if (jobStart < 0 || jobEnd < 0) {
      throw new Error('deploy-ssot-gates job boundary is unavailable');
    }
    const job = workflow.slice(jobStart, jobEnd);
    const checkout = job.indexOf('- uses: actions/checkout@');
    const fetchDepth = job.indexOf('fetch-depth: 0', checkout);
    const setupNode = job.indexOf('- name: Setup Node.js', checkout);
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(fetchDepth).toBeGreaterThan(checkout);
    expect(setupNode).toBeGreaterThan(fetchDepth);

    const fetchCommand = "run: git fetch --no-tags origin '+refs/heads/*:refs/remotes/origin/*'";
    const remoteGateCommand = 'run: npm run gates:capability-source-inventory:remote';
    const fetchCommandIndex = job.indexOf(fetchCommand);
    const remoteGateIndex = job.indexOf(remoteGateCommand);
    expect(fetchCommandIndex).toBeGreaterThan(setupNode);
    expect(remoteGateIndex).toBeGreaterThan(fetchCommandIndex);

    const gateStepStart = job.lastIndexOf(
      '- name: Verify remote capability source inventory',
      remoteGateIndex,
    );
    const gateStepEnd = job.indexOf('\n      - name:', remoteGateIndex);
    if (gateStepStart < 0 || gateStepEnd < 0) {
      throw new Error('remote capability inventory step boundary is unavailable');
    }
    const gateStep = job.slice(gateStepStart, gateStepEnd);
    expect(gateStep).toContain(remoteGateCommand);
    expect(gateStep).toContain('CAPABILITY_INVENTORY_CURRENT_REF: ${{ github.head_ref }}');
    expect(gateStep).toContain(
      'CAPABILITY_INVENTORY_CURRENT_SHA: ${{ github.event.pull_request.head.sha }}',
    );
  });
});

describe('GitHub Actions detached execution identity', () => {
  const ciRemoteRef = {
    locator: 'refs/remotes/origin/feature/ci-head',
    headSha: REMOTE_SHA,
  };
  const validHeadRef = (headRef: string): boolean => headRef === 'feature/ci-head';

  it('always selects trusted event identity in Actions even when a symbolic local branch exists', () => {
    const actionsIdentity = {
      worktreePath: '/runner/work/repository',
      headSha: REMOTE_SHA,
      branchRef: null,
      originRef: ciRemoteRef.locator,
    };
    const resolveActions = jest.fn(() => actionsIdentity);
    const resolveSymbolicLocal = jest.fn(() => ({
      worktreePath: '/runner/work/repository',
      headSha: DIRTY_SHA,
      branchRef: 'refs/heads/colliding-fork-name',
      originRef: 'refs/remotes/origin/colliding-fork-name',
    }));

    expect(selectExecutionIdentity('true', resolveActions, resolveSymbolicLocal)).toEqual(
      actionsIdentity,
    );
    expect(resolveActions).toHaveBeenCalledTimes(1);
    expect(resolveSymbolicLocal).not.toHaveBeenCalled();
  });

  it('excludes the exact same-repository pull-request ref and resolved head', () => {
    const executionIdentity = resolveGitHubActionsExecutionIdentity({
      githubActions: 'true',
      eventName: 'pull_request',
      headRef: 'feature/ci-head',
      currentRef: 'feature/ci-head',
      currentSha: REMOTE_SHA,
      remoteRefs: [ciRemoteRef],
      worktreePath: '/runner/work/repository',
      isValidHeadRef: validHeadRef,
    });
    expect(executionIdentity).toEqual({
      worktreePath: '/runner/work/repository',
      headSha: REMOTE_SHA,
      branchRef: null,
      originRef: ciRemoteRef.locator,
    });

    const live = discoverInventory(
      input({
        remoteRefs: [{ locator: 'refs/remotes/origin/main', headSha: MAIN_SHA }, ciRemoteRef],
        localRefs: [],
        worktrees: [],
        executionIdentity,
      }),
      'remote',
    );
    expect(live.sources).toEqual([]);

    const movedAfterResolution = discoverInventory(
      input({
        remoteRefs: [
          { locator: 'refs/remotes/origin/main', headSha: MAIN_SHA },
          { ...ciRemoteRef, headSha: DIRTY_SHA },
        ],
        localRefs: [],
        worktrees: [],
        executionIdentity,
      }),
      'remote',
    );
    expect(movedAfterResolution.sources).toEqual([
      {
        kind: 'REMOTE_BRANCH',
        locator: ciRemoteRef.locator,
        headSha: DIRTY_SHA,
      },
    ]);
  });

  it('fails closed for malformed or event-mismatched trusted environment', () => {
    expect(() =>
      resolveGitHubActionsExecutionIdentity({
        githubActions: 'true',
        eventName: 'pull_request',
        headRef: 'refs/heads/feature/ci-head',
        currentRef: 'refs/heads/feature/ci-head',
        currentSha: REMOTE_SHA,
        remoteRefs: [ciRemoteRef],
        worktreePath: '/runner/work/repository',
        isValidHeadRef: () => false,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InventoryInspectionError>>({
        code: 'CI_EXECUTION_IDENTITY_INVALID',
      }),
    );

    expect(() =>
      resolveGitHubActionsExecutionIdentity({
        githubActions: 'true',
        eventName: 'push',
        headRef: 'feature/ci-head',
        currentRef: 'feature/ci-head',
        currentSha: REMOTE_SHA,
        remoteRefs: [ciRemoteRef],
        worktreePath: '/runner/work/repository',
        isValidHeadRef: validHeadRef,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InventoryInspectionError>>({
        code: 'CI_EXECUTION_IDENTITY_MISMATCH',
      }),
    );

    expect(() =>
      resolveGitHubActionsExecutionIdentity({
        githubActions: 'true',
        eventName: 'pull_request',
        headRef: 'feature/ci-head',
        currentRef: 'feature/ci-head',
        currentSha: DIRTY_SHA,
        remoteRefs: [ciRemoteRef],
        worktreePath: '/runner/work/repository',
        isValidHeadRef: validHeadRef,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InventoryInspectionError>>({
        code: 'CI_EXECUTION_IDENTITY_MISMATCH',
      }),
    );
  });

  it('does not exclude refs for main pushes, fork heads absent from origin, or non-Actions runs', () => {
    const common = {
      remoteRefs: [ciRemoteRef],
      worktreePath: '/runner/work/repository',
      isValidHeadRef: validHeadRef,
    };
    expect(
      resolveGitHubActionsExecutionIdentity({
        ...common,
        githubActions: 'true',
        eventName: 'push',
        headRef: '',
        currentRef: '',
        currentSha: '',
      }),
    ).toBeNull();
    expect(
      resolveGitHubActionsExecutionIdentity({
        ...common,
        githubActions: 'true',
        eventName: 'pull_request',
        headRef: 'feature/ci-head',
        currentRef: 'feature/ci-head',
        currentSha: REMOTE_SHA,
        remoteRefs: [],
      }),
    ).toBeNull();
    expect(
      resolveGitHubActionsExecutionIdentity({
        ...common,
        githubActions: 'false',
        eventName: 'pull_request',
        headRef: 'feature/ci-head',
        currentRef: 'feature/ci-head',
        currentSha: REMOTE_SHA,
      }),
    ).toBeNull();
  });
});

describe('dirty worktree content identity', () => {
  let repositoryPath: string;

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8',
    });
  }

  beforeEach(() => {
    repositoryPath = mkdtempSync(join(tmpdir(), 'capability-inventory-'));
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Inventory Contract');
    git('config', 'user.email', 'inventory-contract@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repositoryPath, '.gitignore'), ['.env', '*.key', 'ignored/', ''].join('\n'));
    writeFileSync(join(repositoryPath, 'tracked.bin'), Buffer.from([0x00, 0x01, 0x02]));
    git('add', '.gitignore', 'tracked.bin');
    git('commit', '--quiet', '-m', 'test: establish fixture');
  });

  afterEach(() => {
    rmSync(repositoryPath, { recursive: true, force: true });
  });

  it('changes for staged and unstaged tracked bytes without mutating repository state', async () => {
    const cleanDigest = await computeDirtyContentSha256(repositoryPath);
    writeFileSync(join(repositoryPath, 'tracked.bin'), Buffer.from([0x00, 0xff, 0x02]));
    const statusBefore = git('status', '--porcelain=v1', '-z');
    const unstagedDigest = await computeDirtyContentSha256(repositoryPath);
    const statusAfter = git('status', '--porcelain=v1', '-z');
    git('add', 'tracked.bin');
    const stagedDigest = await computeDirtyContentSha256(repositoryPath);

    expect(unstagedDigest).not.toBe(cleanDigest);
    expect(stagedDigest).not.toBe(unstagedDigest);
    expect(statusAfter).toBe(statusBefore);
  });

  it('changes for untracked path and byte mutations while excluded secrets stay outside evidence', async () => {
    const baselineDigest = await computeDirtyContentSha256(repositoryPath);
    const untrackedPath = join(repositoryPath, 'evidence.bin');
    writeFileSync(untrackedPath, Buffer.from([0x00, 0x10, 0x00]));
    const firstDigest = await computeDirtyContentSha256(repositoryPath);
    writeFileSync(untrackedPath, Buffer.from([0x00, 0x11, 0x00]));
    const mutatedDigest = await computeDirtyContentSha256(repositoryPath);
    writeFileSync(join(repositoryPath, '.env'), 'PRIVATE_TOKEN=must-not-enter-evidence\n');
    writeFileSync(join(repositoryPath, 'private.key'), 'must-not-enter-evidence\n');
    const ignoredSecretDigest = await computeDirtyContentSha256(repositoryPath);

    expect(firstDigest).not.toBe(baselineDigest);
    expect(mutatedDigest).not.toBe(firstDigest);
    expect(ignoredSecretDigest).toBe(mutatedDigest);
  });

  it('streams large binary evidence without whole-file buffering', async () => {
    const largeBinaryPath = join(repositoryPath, 'large-binary-evidence.bin');
    writeFileSync(largeBinaryPath, Buffer.alloc(0));
    truncateSync(largeBinaryPath, 8 * 1024 * 1024);
    const firstDigest = await computeDirtyContentSha256(repositoryPath);
    writeFileSync(largeBinaryPath, Buffer.from([0x00, 0xff, 0x80, 0x00]), {
      flag: 'r+',
    });

    expect(await computeDirtyContentSha256(repositoryPath)).not.toBe(firstDigest);
  }, 15_000);

  it('binds the canonical Git executable mode for untracked regular files', async () => {
    const executablePath = join(repositoryPath, 'mode-sensitive-evidence');
    writeFileSync(executablePath, Buffer.from([0x00, 0x01, 0x00]));
    chmodSync(executablePath, 0o644);
    const regularDigest = await computeDirtyContentSha256(repositoryPath);
    chmodSync(executablePath, 0o755);

    expect(await computeDirtyContentSha256(repositoryPath)).not.toBe(regularDigest);
  });

  it('hashes an untracked symlink target and canonical 120000 mode', async () => {
    const linkPath = join(repositoryPath, 'evidence-link');
    symlinkSync('first-target', linkPath);
    const firstDigest = await computeDirtyContentSha256(repositoryPath);
    unlinkSync(linkPath);
    symlinkSync('second-target', linkPath);

    expect(await computeDirtyContentSha256(repositoryPath)).not.toBe(firstDigest);
  });

  it('rejects a torn snapshot even when the path-level dirty status is unchanged', async () => {
    writeFileSync(join(repositoryPath, 'tracked.bin'), Buffer.from([0x00, 0x10, 0x02]));

    await expect(
      computeDirtyContentSha256(repositoryPath, {
        beforeSnapshotVerification: () => {
          writeFileSync(join(repositoryPath, 'tracked.bin'), Buffer.from([0x00, 0x11, 0x02]));
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InventoryInspectionError>>({
        code: 'DIRTY_SNAPSHOT_MOVED',
      }),
    );
  });
});

describe('capability source manifest reconciliation', () => {
  it('accepts an older reconciled base only when it is an ancestor of live origin/main', () => {
    const manifest = exactManifest();
    const live = discoverInventory(input());

    expect(compareInventory(manifest, live, fixtureIsAncestor)).toEqual([]);
    manifest.reconciledBaseSha = OTHER_BASE_SHA;
    expect(compareInventory(manifest, live, fixtureIsAncestor)).toEqual([
      {
        code: 'RECONCILED_BASE_NOT_ANCESTOR',
        message: expect.stringContaining(OTHER_BASE_SHA),
      },
    ]);
  });

  it('reports content, head, undeclared, missing, and duplicate drift deterministically', () => {
    const manifest = exactManifest();
    const remote = manifest.sources.find(
      (source) => source.locator === 'refs/remotes/origin/feature/remote',
    );
    const dirty = manifest.sources.find(
      (source): source is Extract<ManifestSourceCoordinate, { kind: 'DIRTY_WORKTREE' }> =>
        source.locator === '/tmp/dirty' && source.kind === 'DIRTY_WORKTREE',
    );
    if (!remote || !dirty) {
      throw new Error('fixture source missing');
    }
    remote.headSha = MERGED_SHA;
    dirty.contentSha256 = CHANGED_DIRTY_CONTENT_SHA;
    manifest.reconciledBaseSha = OTHER_BASE_SHA;
    manifest.sources.push({
      id: 'SRC-STALE',
      kind: 'LOCAL_BRANCH',
      locator: 'refs/heads/stale',
      headSha: MERGED_SHA,
      state: 'ASSESSING',
      disposition: 'REIMPLEMENT',
    });
    manifest.sources.push({
      id: 'SRC-DUPLICATE',
      kind: 'LOCAL_BRANCH',
      locator: 'refs/heads/stale',
      headSha: MERGED_SHA,
      state: 'ASSESSING',
      disposition: 'REIMPLEMENT',
    });

    const live = discoverInventory(
      input({
        localRefs: [...input().localRefs, { locator: 'refs/heads/new-source', headSha: DIRTY_SHA }],
      }),
    );
    const drifts = compareInventory(manifest, live, fixtureIsAncestor);

    expect(drifts.map((drift) => drift.code)).toEqual([
      'DUPLICATE_MANIFEST_LOCATOR',
      'RECONCILED_BASE_NOT_ANCESTOR',
      'SOURCE_CONTENT_DRIFT',
      'SOURCE_HEAD_DRIFT',
      'SOURCE_UNDECLARED',
      'SOURCE_NO_LONGER_LIVE',
    ]);
    expect(drifts[2]?.message).toContain(CHANGED_DIRTY_CONTENT_SHA);
    expect(drifts[3]?.message).toContain(REMOTE_SHA);
    expect(drifts[4]?.message).toContain('refs/heads/new-source');
    expect(drifts[5]?.message).toContain('refs/heads/stale');
  });

  it('allows a merged terminal remote only while its exact ref and head remain preserved', () => {
    const manifest = exactManifest();
    const remote = manifest.sources.find(
      (source) => source.locator === 'refs/remotes/origin/feature/remote',
    );
    if (!remote) {
      throw new Error('fixture remote source missing');
    }
    remote.state = 'INTEGRATED';
    const live = discoverInventory(
      input({
        isAncestor: (ancestor, descendant) =>
          (ancestor === REMOTE_SHA && descendant === MAIN_SHA) ||
          fixtureIsAncestor(ancestor, descendant),
      }),
    );

    expect(compareInventory(manifest, live, fixtureIsAncestor)).toEqual([]);
  });

  it('requires retirement approval when a terminal remote ref is deleted', () => {
    const manifest = exactManifest();
    const remote = manifest.sources.find(
      (source) => source.locator === 'refs/remotes/origin/feature/remote',
    );
    if (!remote) {
      throw new Error('fixture remote source missing');
    }
    remote.state = 'INTEGRATED';
    const live = discoverInventory(
      input({
        remoteRefs: input().remoteRefs.filter(
          (source) => source.locator !== 'refs/remotes/origin/feature/remote',
        ),
        localRefs: input().localRefs.filter(
          (source) => source.locator !== 'refs/heads/feature/remote-copy',
        ),
      }),
    );

    expect(compareInventory(manifest, live, fixtureIsAncestor).map((drift) => drift.code)).toEqual([
      'SOURCE_NO_LONGER_LIVE',
    ]);
    remote.retirement = RETIREMENT;
    expect(compareInventory(manifest, live, fixtureIsAncestor).map((drift) => drift.code)).toEqual([
      'SOURCE_RETIREMENT_INVALID',
    ]);
    expect(
      compareInventory(manifest, live, fixtureIsAncestor, 'full', (context) => ({
        ...AUTHORIZE_RETIREMENT(context),
        verifiedSourceHeadSha: DIRTY_SHA,
      })).map((drift) => drift.code),
    ).toEqual(['SOURCE_RETIREMENT_INVALID']);
    expect(
      compareInventory(manifest, live, fixtureIsAncestor, 'full', (context) => ({
        ...AUTHORIZE_RETIREMENT(context),
        verifiedSourceKind: 'LOCAL_BRANCH',
        verifiedSourceLocator: 'refs/heads/different',
        verifiedApprovedAt: '2026-07-29T12:00:01.000Z',
        verifiedSnapshotSha256: CHANGED_DIRTY_CONTENT_SHA,
      })).map((drift) => drift.code),
    ).toEqual(['SOURCE_RETIREMENT_INVALID']);
    expect(
      compareInventory(manifest, live, fixtureIsAncestor, 'full', AUTHORIZE_RETIREMENT),
    ).toEqual([]);
  });

  it('reports head drift when a terminal branch remains but its ref moves', () => {
    const manifest = exactManifest();
    const remote = manifest.sources.find(
      (source) => source.locator === 'refs/remotes/origin/feature/remote',
    );
    if (!remote) {
      throw new Error('fixture remote source missing');
    }
    remote.state = 'INTEGRATED';
    const live = discoverInventory(
      input({
        remoteRefs: input().remoteRefs.map((source) =>
          source.locator === 'refs/remotes/origin/feature/remote'
            ? { ...source, headSha: MERGED_SHA }
            : source,
        ),
        localRefs: input().localRefs.filter(
          (source) => source.locator !== 'refs/heads/feature/remote-copy',
        ),
      }),
    );

    expect(compareInventory(manifest, live, fixtureIsAncestor).map((drift) => drift.code)).toEqual([
      'SOURCE_HEAD_DRIFT',
    ]);
  });

  it('requires typed retirement approval before local-only or dirty evidence disappears', () => {
    const manifest = exactManifest();
    const historicalSources = manifest.sources.filter(
      (source) =>
        source.locator === 'refs/heads/feature/local-only' || source.locator === '/tmp/dirty',
    );
    if (historicalSources.length !== 2) {
      throw new Error('fixture historical sources missing');
    }
    for (const historical of historicalSources) {
      historical.state = 'INTEGRATED';
    }

    const live = discoverInventory(
      input({
        localRefs: input().localRefs.filter(
          (source) => source.locator !== 'refs/heads/feature/local-only',
        ),
        worktrees: input().worktrees.filter((worktree) => worktree.path !== '/tmp/dirty'),
      }),
    );
    expect(compareInventory(manifest, live, fixtureIsAncestor).map((drift) => drift.code)).toEqual([
      'SOURCE_NO_LONGER_LIVE',
      'SOURCE_NO_LONGER_LIVE',
    ]);

    for (const historical of historicalSources) {
      historical.retirement = historical.kind === 'DIRTY_WORKTREE' ? DIRTY_RETIREMENT : RETIREMENT;
    }
    expect(compareInventory(manifest, live, fixtureIsAncestor).map((drift) => drift.code)).toEqual([
      'SOURCE_RETIREMENT_INVALID',
      'SOURCE_RETIREMENT_INVALID',
    ]);
    expect(
      compareInventory(manifest, live, fixtureIsAncestor, 'full', AUTHORIZE_RETIREMENT),
    ).toEqual([]);
  });

  it('requires reconciled_base_sha, dirty content identity, and complete retirement evidence', () => {
    const source = {
      id: 'SRC-001',
      kind: 'DIRTY_WORKTREE',
      locator: '/tmp/dirty',
      head_sha: DIRTY_SHA,
      content_sha256: DIRTY_CONTENT_SHA,
      state: 'INTEGRATED',
      disposition: 'FORENSIC_ONLY',
      retirement: {
        status: 'RETIRE_APPROVED',
        approved_at: RETIREMENT.approvedAt,
        approved_by: RETIREMENT.approvedBy,
        snapshot_sha256: RETIREMENT.snapshotSha256,
        snapshot_uri: RETIREMENT.snapshotUri,
        captured_content_sha256: DIRTY_CONTENT_SHA,
        evidence: RETIREMENT.evidence,
        authorization: {
          kind: RETIREMENT.authorization.kind,
          issuer: RETIREMENT.authorization.issuer,
          signer_identity: RETIREMENT.authorization.signerIdentity,
          statement_sha256: RETIREMENT.authorization.statementSha256,
          statement_uri: RETIREMENT.authorization.statementUri,
          subject_sha256: RETIREMENT.authorization.subjectSha256,
          bundle_sha256: RETIREMENT.authorization.bundleSha256,
          bundle_uri: RETIREMENT.authorization.bundleUri,
        },
      },
    };

    expect(
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [source],
        },
      }),
    ).toEqual({
      reconciledBaseSha: BASE_SHA,
      sources: [
        {
          id: 'SRC-001',
          kind: 'DIRTY_WORKTREE',
          locator: '/tmp/dirty',
          headSha: DIRTY_SHA,
          contentSha256: DIRTY_CONTENT_SHA,
          state: 'INTEGRATED',
          disposition: 'FORENSIC_ONLY',
          retirement: DIRTY_RETIREMENT,
        },
      ],
    });

    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          main_sha: BASE_SHA,
          sources: [source],
        },
      }),
    ).toThrow('reconciled_base_sha');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [{ ...source, content_sha256: undefined }],
        },
      }),
    ).toThrow('content_sha256');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              ...source,
              retirement: {
                ...source.retirement,
                evidence: [],
              },
            },
          ],
        },
      }),
    ).toThrow('retirement.evidence');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              ...source,
              retirement: {
                ...source.retirement,
                captured_content_sha256: CHANGED_DIRTY_CONTENT_SHA,
              },
            },
          ],
        },
      }),
    ).toThrow('captured_content_sha256 must equal source content_sha256');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              ...source,
              retirement: {
                ...source.retirement,
                authorization: {
                  ...source.retirement.authorization,
                  subject_sha256: CHANGED_DIRTY_CONTENT_SHA,
                },
              },
            },
          ],
        },
      }),
    ).toThrow('authorization.subject_sha256 must equal statement_sha256');
  });
});

describe('trusted terminal source retirement verification', () => {
  let evidenceRoot: string;

  beforeEach(() => {
    evidenceRoot = mkdtempSync(join(tmpdir(), 'capability-retirement-evidence-'));
  });

  afterEach(() => {
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  function terminalRemoteFixture(): {
    manifest: InventoryManifest;
    live: ReturnType<typeof discoverInventory>;
    source: ManifestSourceCoordinate;
  } {
    const manifest = exactManifest();
    const source = manifest.sources.find(
      (candidate) => candidate.locator === 'refs/remotes/origin/feature/remote',
    );
    if (!source) {
      throw new Error('fixture remote source missing');
    }
    source.state = 'INTEGRATED';
    source.retirement = createRetirementEvidence(evidenceRoot, source);
    const live = discoverInventory(
      input({
        remoteRefs: input().remoteRefs.filter(
          (candidate) => candidate.locator !== 'refs/remotes/origin/feature/remote',
        ),
        localRefs: input().localRefs.filter(
          (candidate) => candidate.locator !== 'refs/heads/feature/remote-copy',
        ),
      }),
    );
    return { manifest, live, source };
  }

  it('uses the fixed cosign v3 command to verify exact workflow claims and artifacts', () => {
    const { manifest, live, source } = terminalRemoteFixture();
    const approval = source.retirement;
    if (!approval) {
      throw new Error('fixture retirement approval missing');
    }
    const invocations: string[][] = [];
    const invokeCosign = jest.fn((args: readonly string[]) => {
      invocations.push([...args]);
      if (args[0] === 'version') {
        return {
          status: 0,
          stdout: '{"gitVersion":"v3.0.4"}',
          stderr: '',
        };
      }

      const bundleFlag = args.indexOf('--bundle');
      const identityFlag = args.indexOf('--certificate-identity');
      const issuerFlag = args.indexOf('--certificate-oidc-issuer');
      const statementPath = args[args.length - 1];
      const bundlePath = args[bundleFlag + 1];
      if (!statementPath || !bundlePath) {
        throw new Error('cosign invocation lost its evidence paths');
      }
      expect(args[0]).toBe('verify-blob');
      expect(args[identityFlag + 1]).toBe(TRUSTED_RETIREMENT_WORKFLOW_IDENTITY);
      expect(args[issuerFlag + 1]).toBe(TRUSTED_RETIREMENT_ISSUER);
      const statement = readFileSync(statementPath, 'utf8');
      expect(statement).toBe(serializeRetirementAuthorizationStatement({ source, approval }));
      expect(JSON.parse(statement)).toMatchObject({
        issuer: TRUSTED_RETIREMENT_ISSUER,
        signer_identity: TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
        source: {
          id: source.id,
          kind: source.kind,
          locator: source.locator,
          head_sha: source.headSha,
          content_sha256: null,
        },
        approval: {
          approved_by: approval.approvedBy,
          approved_at: approval.approvedAt,
        },
        snapshot: {
          uri: approval.snapshotUri,
          sha256: approval.snapshotSha256,
        },
      });
      expect(createHash('sha256').update(readFileSync(bundlePath)).digest('hex')).toBe(
        approval.authorization.bundleSha256,
      );
      expect(args).not.toEqual(
        expect.arrayContaining([
          '--insecure-ignore-sct',
          '--insecure-ignore-tlog',
          '--certificate-identity-regexp',
        ]),
      );
      return { status: 0, stdout: 'Verified OK\n', stderr: '' };
    });

    expect(
      compareInventoryForCli(
        manifest,
        live,
        fixtureIsAncestor,
        { scope: 'full', retirementEvidenceRoot: evidenceRoot },
        { invokeCosign },
      ),
    ).toEqual([]);
    expect(invocations[0]).toEqual(['version', '--json']);
    expect(invocations[1]?.[0]).toBe('verify-blob');
    expect(invokeCosign).toHaveBeenCalledTimes(2);
  });

  it('loads no retirement evidence for live sources and fails closed only when it is needed', () => {
    const exact = exactManifest();
    const exactLive = discoverInventory(input());
    const invokeCosign = jest.fn(() => {
      throw new Error('cosign must not run for a live source');
    });

    expect(
      compareInventoryForCli(
        exact,
        exactLive,
        fixtureIsAncestor,
        { scope: 'full' },
        { invokeCosign },
      ),
    ).toEqual([]);
    expect(invokeCosign).not.toHaveBeenCalled();

    const { manifest, live } = terminalRemoteFixture();
    const drifts = compareInventoryForCli(
      manifest,
      live,
      fixtureIsAncestor,
      { scope: 'full' },
      { invokeCosign },
    );
    expect(drifts).toEqual([
      expect.objectContaining({
        code: 'SOURCE_RETIREMENT_INVALID',
        message: expect.stringContaining('absolute retirement evidence root is required'),
      }),
    ]);
    expect(invokeCosign).not.toHaveBeenCalled();
  });

  it('rejects old cosign versions, failed signatures, and non-main identities', () => {
    const oldVersionFixture = terminalRemoteFixture();
    expect(
      compareInventoryForCli(
        oldVersionFixture.manifest,
        oldVersionFixture.live,
        fixtureIsAncestor,
        { scope: 'full', retirementEvidenceRoot: evidenceRoot },
        {
          invokeCosign: (args) =>
            args[0] === 'version'
              ? {
                  status: 0,
                  stdout: '{"gitVersion":"v3.0.3"}',
                  stderr: '',
                }
              : { status: 0, stdout: '', stderr: '' },
        },
      )[0]?.message,
    ).toContain('below required v3.0.4');

    rmSync(evidenceRoot, { recursive: true, force: true });
    evidenceRoot = mkdtempSync(join(tmpdir(), 'capability-retirement-evidence-'));
    const failedSignatureFixture = terminalRemoteFixture();
    expect(
      compareInventoryForCli(
        failedSignatureFixture.manifest,
        failedSignatureFixture.live,
        fixtureIsAncestor,
        { scope: 'full', retirementEvidenceRoot: evidenceRoot },
        {
          invokeCosign: (args) =>
            args[0] === 'version'
              ? {
                  status: 0,
                  stdout: '{"gitVersion":"v3.1.0"}',
                  stderr: '',
                }
              : { status: 1, stdout: '', stderr: 'signature mismatch' },
        },
      )[0]?.message,
    ).toContain('signature mismatch');

    const approval = failedSignatureFixture.source.retirement;
    if (!approval) {
      throw new Error('fixture retirement approval missing');
    }
    approval.authorization.signerIdentity =
      'https://github.com/Okan-wqm/aquaculture_platform/.github/workflows/source-retirement.yml@refs/heads/feature';
    const untrustedInvocation = jest.fn(() => ({
      status: 0,
      stdout: '{"gitVersion":"v3.0.4"}',
      stderr: '',
    }));
    expect(
      compareInventoryForCli(
        failedSignatureFixture.manifest,
        failedSignatureFixture.live,
        fixtureIsAncestor,
        { scope: 'full', retirementEvidenceRoot: evidenceRoot },
        { invokeCosign: untrustedInvocation },
      )[0]?.message,
    ).toContain('trusted main workflow');
    expect(untrustedInvocation).not.toHaveBeenCalled();
  });

  it('rejects altered claims, snapshot bytes, traversal, and symlinked evidence', () => {
    const alteredClaimsFixture = terminalRemoteFixture();
    const approval = alteredClaimsFixture.source.retirement;
    if (!approval) {
      throw new Error('fixture retirement approval missing');
    }
    const alteredStatement = Buffer.from(
      serializeRetirementAuthorizationStatement({
        source: alteredClaimsFixture.source,
        approval,
      }).replace('"approved_by":"release-engineering"', '"approved_by":"untrusted-actor"'),
      'utf8',
    );
    const alteredCoordinate = writeContentAddressedArtifact(
      evidenceRoot,
      'altered-authorization-statement.json',
      alteredStatement,
    );
    approval.authorization.statementSha256 = alteredCoordinate.sha256;
    approval.authorization.statementUri = alteredCoordinate.uri;
    approval.authorization.subjectSha256 = alteredCoordinate.sha256;
    approval.evidence = [
      approval.snapshotUri,
      alteredCoordinate.uri,
      approval.authorization.bundleUri,
    ];
    const neverCosign = jest.fn(() => ({
      status: 0,
      stdout: '{"gitVersion":"v3.0.4"}',
      stderr: '',
    }));
    expect(
      compareInventoryForCli(
        alteredClaimsFixture.manifest,
        alteredClaimsFixture.live,
        fixtureIsAncestor,
        { scope: 'full', retirementEvidenceRoot: evidenceRoot },
        { invokeCosign: neverCosign },
      )[0]?.message,
    ).toContain('does not exactly bind');
    expect(neverCosign).not.toHaveBeenCalled();

    rmSync(evidenceRoot, { recursive: true, force: true });
    evidenceRoot = mkdtempSync(join(tmpdir(), 'capability-retirement-evidence-'));
    const alteredSnapshotFixture = terminalRemoteFixture();
    const alteredSnapshotApproval = alteredSnapshotFixture.source.retirement;
    if (!alteredSnapshotApproval) {
      throw new Error('fixture retirement approval missing');
    }
    const snapshotPath = join(
      evidenceRoot,
      'sha256',
      alteredSnapshotApproval.snapshotSha256,
      'snapshot.tar.zst',
    );
    writeFileSync(snapshotPath, 'altered snapshot\n');
    expect(
      compareInventoryForCli(
        alteredSnapshotFixture.manifest,
        alteredSnapshotFixture.live,
        fixtureIsAncestor,
        { scope: 'full', retirementEvidenceRoot: evidenceRoot },
        { invokeCosign: neverCosign },
      )[0]?.message,
    ).toContain('differs from');

    alteredSnapshotApproval.authorization.statementUri = `artifact://sha256/${alteredSnapshotApproval.authorization.statementSha256}/../outside.json`;
    expect(() =>
      createTrustedRetirementAuthorizationVerifier(evidenceRoot)({
        source: alteredSnapshotFixture.source,
        approval: alteredSnapshotApproval,
      }),
    ).toThrow('safe-relative-name');
  });

  it('refuses artifact symlinks even when the target has the declared bytes', () => {
    const fixture = terminalRemoteFixture();
    const approval = fixture.source.retirement;
    if (!approval) {
      throw new Error('fixture retirement approval missing');
    }
    const statementPath = join(
      evidenceRoot,
      'sha256',
      approval.authorization.statementSha256,
      'authorization-statement.json',
    );
    const externalDirectory = mkdtempSync(join(tmpdir(), 'capability-retirement-external-'));
    const externalPath = join(externalDirectory, 'authorization-statement.json');
    writeFileSync(externalPath, readFileSync(statementPath));
    unlinkSync(statementPath);
    symlinkSync(externalPath, statementPath);
    try {
      const invokeCosign = jest.fn(() => ({
        status: 0,
        stdout: '{"gitVersion":"v3.0.4"}',
        stderr: '',
      }));
      expect(
        compareInventoryForCli(
          fixture.manifest,
          fixture.live,
          fixtureIsAncestor,
          { scope: 'full', retirementEvidenceRoot: evidenceRoot },
          { invokeCosign },
        )[0]?.message,
      ).toContain('non-symlink regular file');
      expect(invokeCosign).not.toHaveBeenCalled();
    } finally {
      rmSync(externalDirectory, { recursive: true, force: true });
    }
  });
});

describe('already-main proof validation', () => {
  function ancestorProofManifest(): InventoryManifest {
    return {
      reconciledBaseSha: BASE_SHA,
      sources: [
        {
          id: 'SRC-PROOF',
          kind: 'REMOTE_BRANCH',
          locator: 'refs/remotes/origin/feature/proven',
          headSha: REMOTE_SHA,
          state: 'INTEGRATED',
          disposition: 'ALREADY_ON_MAIN',
          mainProof: {
            kind: 'ANCESTOR',
            sourceCommitSha: REMOTE_SHA,
          },
        },
      ],
    };
  }

  it('validates ancestor and exact tree-equivalent proofs against live Git facts', () => {
    const ancestorManifest = ancestorProofManifest();
    expect(
      validateMainProofs(
        ancestorManifest,
        MAIN_SHA,
        (ancestor, descendant) => ancestor === REMOTE_SHA && descendant === MAIN_SHA,
        () => null,
      ),
    ).toEqual([]);
    expect(
      validateMainProofs(
        ancestorManifest,
        MAIN_SHA,
        () => false,
        () => null,
      ).map((drift) => drift.code),
    ).toEqual(['SOURCE_MAIN_PROOF_INVALID']);

    const treeManifest = ancestorProofManifest();
    const proven = treeManifest.sources[0];
    if (!proven) {
      throw new Error('proof fixture source missing');
    }
    proven.mainProof = {
      kind: 'TREE_EQUIVALENT',
      sourceCommitSha: REMOTE_SHA,
      sourceTreeSha: EQUIVALENT_TREE_SHA,
      mainCommitSha: BASE_SHA,
      mainTreeSha: EQUIVALENT_TREE_SHA,
    };
    const trees = new Map([
      [REMOTE_SHA, EQUIVALENT_TREE_SHA],
      [BASE_SHA, EQUIVALENT_TREE_SHA],
    ]);
    expect(
      validateMainProofs(
        treeManifest,
        MAIN_SHA,
        (ancestor, descendant) => ancestor === BASE_SHA && descendant === MAIN_SHA,
        (commitSha) => trees.get(commitSha) ?? null,
      ),
    ).toEqual([]);

    trees.set(BASE_SHA, DIFFERENT_TREE_SHA);
    expect(
      validateMainProofs(
        treeManifest,
        MAIN_SHA,
        () => false,
        (commitSha) => trees.get(commitSha) ?? null,
      ).map((drift) => drift.code),
    ).toEqual(['SOURCE_MAIN_PROOF_INVALID']);
  });

  it('parses only typed proofs on ALREADY_ON_MAIN remote sources', () => {
    const proof = {
      kind: 'ANCESTOR',
      source_commit_sha: REMOTE_SHA,
    };
    const source = {
      id: 'SRC-PROOF',
      kind: 'REMOTE_BRANCH',
      locator: 'refs/remotes/origin/feature/proven',
      head_sha: REMOTE_SHA,
      state: 'INTEGRATED',
      disposition: 'ALREADY_ON_MAIN',
      main_proof: proof,
    };
    expect(
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [source],
        },
      }).sources[0],
    ).toEqual({
      id: 'SRC-PROOF',
      kind: 'REMOTE_BRANCH',
      locator: 'refs/remotes/origin/feature/proven',
      headSha: REMOTE_SHA,
      state: 'INTEGRATED',
      disposition: 'ALREADY_ON_MAIN',
      mainProof: {
        kind: 'ANCESTOR',
        sourceCommitSha: REMOTE_SHA,
      },
    });
    expect(
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              ...source,
              main_proof: {
                kind: 'TREE_EQUIVALENT',
                source_commit_sha: REMOTE_SHA,
                source_tree_sha: EQUIVALENT_TREE_SHA,
                main_commit_sha: BASE_SHA,
                main_tree_sha: EQUIVALENT_TREE_SHA,
              },
            },
          ],
        },
      }).sources[0]?.mainProof,
    ).toEqual({
      kind: 'TREE_EQUIVALENT',
      sourceCommitSha: REMOTE_SHA,
      sourceTreeSha: EQUIVALENT_TREE_SHA,
      mainCommitSha: BASE_SHA,
      mainTreeSha: EQUIVALENT_TREE_SHA,
    });

    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [{ ...source, main_proof: undefined }],
        },
      }),
    ).toThrow('main_proof is required');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [{ ...source, kind: 'LOCAL_BRANCH', locator: 'refs/heads/proven' }],
        },
      }),
    ).toThrow('only for a REMOTE_BRANCH');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              ...source,
              disposition: 'REIMPLEMENT',
            },
          ],
        },
      }),
    ).toThrow('allowed only for disposition ALREADY_ON_MAIN');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              ...source,
              main_proof: {
                ...proof,
                source_commit_sha: MERGED_SHA,
              },
            },
          ],
        },
      }),
    ).toThrow('must equal source head_sha');
  });
});

describe('origin/main snapshot stability', () => {
  it('fails closed with ORIGIN_MAIN_MOVED when origin/main changes during discovery', () => {
    expect(() => assertOriginMainStable(MAIN_SHA, REMOTE_SHA)).toThrow(
      expect.objectContaining<Partial<InventoryInspectionError>>({
        code: 'ORIGIN_MAIN_MOVED',
      }),
    );
    expect(() => assertOriginMainStable(MAIN_SHA, MAIN_SHA)).not.toThrow();
  });
});
