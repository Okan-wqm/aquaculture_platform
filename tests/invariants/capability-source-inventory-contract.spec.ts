import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SOURCE_INVENTORY_SCHEMA_V2,
  SOURCE_INVENTORY_RUNNER_PROFILE,
  TRUSTED_REMOTE_INVENTORY_JOB,
  TRUSTED_REMOTE_INVENTORY_WORKFLOW,
  admitExecutionExclusionProof,
  assertOriginMainStable,
  classifySourceRole,
  compareInventory,
  compileRegisteredCommonDirLocators,
  discoverInventory,
  isManifestWorktreeSource,
  parseInventoryCliArgs,
  parseInventoryCliOptions,
  parseInventoryManifest,
  parseRefList,
  resolveGitHubActionsExecutionIdentity,
  selectExecutionIdentity,
  validateMainProofs,
  type DiscoveryInput,
  type InventoryManifest,
  type ManifestSourceCoordinate,
} from '../../tools/gates/capability-source-inventory';
import {
  computeCanonicalGitWorktreeEvidence,
  InventoryInspectionError,
} from '../../tools/gates/lib/hermetic-git-runtime';
import {
  discoverRegisteredCommonDirs,
  parseWorktreeList,
} from '../../tools/gates/lib/registered-common-dir-discovery';

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
const CLEAN_CONTENT_SHA = '1'.repeat(64);
const CLEAN_STATUS_SHA = '2'.repeat(64);
const DIRTY_STATUS_SHA = '3'.repeat(64);
const EQUIVALENT_TREE_SHA = 'd'.repeat(40);
const DIFFERENT_TREE_SHA = 'e'.repeat(40);
const CURRENT_BRANCH = 'chore/current-inventory';

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
        lockReason: null,
        dirty: false,
        repositoryId: 'aquaculture-platform',
        ownerClass: 'USER',
        statusSha256: CLEAN_STATUS_SHA,
        contentSha256: CLEAN_CONTENT_SHA,
      },
      {
        path: '/tmp/dirty',
        headSha: DIRTY_SHA,
        branchRef: 'refs/heads/feature/local-only',
        lockReason: null,
        dirty: true,
        repositoryId: 'aquaculture-platform',
        ownerClass: 'CODEX',
        statusSha256: DIRTY_STATUS_SHA,
        contentSha256: DIRTY_CONTENT_SHA,
      },
    ],
    executionIdentity: {
      worktreePath: '/tmp/integration',
      headSha: CURRENT_SHA,
      branchRef: `refs/heads/${CURRENT_BRANCH}`,
      originRef: `refs/remotes/origin/${CURRENT_BRANCH}`,
      exclusionProof: {
        kind: 'INDEPENDENT_CLEAN_INVENTORY_RUNNER_V1',
        committed: true,
        clean: true,
      },
    },
    isAncestor: (ancestor, descendant) => ancestry.has(`${ancestor}:${descendant}`),
    classifyBranchSourceRole: (source) =>
      source.headSha === CURRENT_SHA ? 'INVENTORY_GOVERNANCE' : 'CAPABILITY_CANDIDATE',
    ...overrides,
  };
}

function exactManifest(): InventoryManifest {
  const live = discoverInventory(input());
  return {
    schemaVersion: 2,
    reconciledBaseSha: BASE_SHA,
    sources: live.sources.map((source, index) => ({
      id: `SRC-${String(index + 1).padStart(3, '0')}`,
      state: 'ASSESSING',
      disposition: 'REIMPLEMENT',
      ...source,
    })),
  };
}

function fixtureIsAncestor(ancestorSha: string, descendantSha: string): boolean {
  return input().isAncestor(ancestorSha, descendantSha);
}

describe('capability source inventory discovery', () => {
  it('classifies governance only from a closed path surface plus commit ancestry', () => {
    const INVENTORY_HEAD = 'a'.repeat(40);
    const PLAN_HEAD = 'b'.repeat(40);
    const COMMON_BASE = 'c'.repeat(40);
    const classify = (
      sourceHeadSha: string,
      paths: readonly string[],
      executionHeadSha: string | null = CURRENT_SHA,
    ) =>
      classifySourceRole({
        mainSha: MAIN_SHA,
        sourceHeadSha,
        executionHeadSha,
        isAncestor: (ancestor, descendant) =>
          (ancestor === CURRENT_SHA && descendant === INVENTORY_HEAD) ||
          (ancestor === COMMON_BASE && (descendant === MAIN_SHA || descendant === sourceHeadSha)),
        mergeBase: () => COMMON_BASE,
        changedPaths: (base, head) => {
          expect(head).toBe(sourceHeadSha);
          expect([CURRENT_SHA, COMMON_BASE]).toContain(base);
          return paths;
        },
      });

    expect(
      classify(INVENTORY_HEAD, [
        'docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json',
        `docs/plans/2026-06-18-enterprise-grade-debt-closure/source-findings.${'d'.repeat(64)}.jsonl`,
        'tools/gates/source-finding-inventory.ts',
      ]),
    ).toBe('INVENTORY_GOVERNANCE');
    expect(
      classify(
        PLAN_HEAD,
        [
          '.github/workflows/ci-affected.yml',
          'docs/plans/2026-07-30-enterprise-backup-restore-architecture/PLAN.md',
          'scripts/ci/markdownlint-changed.mjs',
          'tools/quality/format-scope.json',
        ],
        null,
      ),
    ).toBe('PLAN_GOVERNANCE');
    expect(classify(PLAN_HEAD, ['apps/farm-service/src/main.ts'], null)).toBe(
      'CAPABILITY_CANDIDATE',
    );
    expect(classify(INVENTORY_HEAD, ['apps/farm-service/src/main.ts'])).toBe(
      'CAPABILITY_CANDIDATE',
    );
    expect(
      classify(INVENTORY_HEAD, [
        'tools/gates/source-finding-inventory.ts',
        'apps/farm-service/src/main.ts',
      ]),
    ).toBe('CAPABILITY_CANDIDATE');
    expect(
      classify(
        PLAN_HEAD,
        [
          'docs/plans/2026-07-30-enterprise-backup-restore-architecture/PLAN.md',
          'infrastructure/docker-compose.yml',
        ],
        null,
      ),
    ).toBe('CAPABILITY_CANDIDATE');
  });

  it('retains typed governance refs outside the finding lane and rejects an UNKNOWN role', () => {
    const governance = discoverInventory(
      input({
        classifyBranchSourceRole: (source) =>
          source.locator === 'refs/remotes/origin/feature/remote'
            ? 'INVENTORY_GOVERNANCE'
            : 'CAPABILITY_CANDIDATE',
      }),
    );
    expect(governance.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locator: 'refs/remotes/origin/feature/remote',
          role: 'INVENTORY_GOVERNANCE',
        }),
      ]),
    );

    expect(() =>
      discoverInventory(
        input({
          classifyBranchSourceRole: (source) =>
            source.locator === 'refs/remotes/origin/feature/remote'
              ? 'UNKNOWN'
              : 'CAPABILITY_CANDIDATE',
        }),
      ),
    ).toThrow(/could not safely classify refs\/remotes\/origin\/feature\/remote/);
  });

  it('excludes only an exact independently proven inventory-governance runner ref', () => {
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
        role: 'CAPABILITY_CANDIDATE',
      },
    ]);
  });

  it('retains an exact execution ref when it is a capability branch or lacks runner proof', () => {
    const historical = discoverInventory(
      input({
        classifyBranchSourceRole: () => 'CAPABILITY_CANDIDATE',
      }),
    );

    expect(historical.sources).toEqual(
      expect.arrayContaining([
        {
          kind: 'REMOTE_BRANCH',
          locator: `refs/remotes/origin/${CURRENT_BRANCH}`,
          headSha: CURRENT_SHA,
          role: 'CAPABILITY_CANDIDATE',
        },
      ]),
    );

    const defaultExecutionIdentity = input().executionIdentity;
    if (defaultExecutionIdentity === null) {
      throw new Error('execution identity fixture is absent');
    }
    const unproven = discoverInventory(
      input({
        executionIdentity: {
          ...defaultExecutionIdentity,
          exclusionProof: null,
        },
      }),
    );
    expect(unproven.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locator: `refs/remotes/origin/${CURRENT_BRANCH}`,
          role: 'INVENTORY_GOVERNANCE',
        }),
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
        role: 'CAPABILITY_CANDIDATE',
      },
      {
        kind: 'LOCAL_BRANCH',
        locator: 'refs/heads/feature/local-only',
        headSha: LOCAL_SHA,
        role: 'CAPABILITY_CANDIDATE',
      },
    ]);
    expect(inventory.sources.filter((source) => source.kind === 'DIRTY_WORKTREE')).toEqual([
      {
        kind: 'DIRTY_WORKTREE',
        locator: '/tmp/dirty',
        headSha: DIRTY_SHA,
        role: 'CAPABILITY_CANDIDATE',
        repositoryId: 'aquaculture-platform',
        ownerClass: 'CODEX',
        statusSha256: DIRTY_STATUS_SHA,
        contentSha256: DIRTY_CONTENT_SHA,
      },
    ]);
    expect(inventory.sources.filter((source) => source.kind === 'CLEAN_WORKTREE')).toEqual([
      {
        kind: 'CLEAN_WORKTREE',
        locator: '/repo',
        headSha: MAIN_SHA,
        role: 'WORKTREE_PRESERVATION',
        repositoryId: 'aquaculture-platform',
        ownerClass: 'USER',
        statusSha256: CLEAN_STATUS_SHA,
        contentSha256: CLEAN_CONTENT_SHA,
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
        lockReason: null,
      },
      {
        path: '/tmp/detached evidence',
        headSha: DIRTY_SHA,
        branchRef: null,
        lockReason: null,
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
    expect(parseInventoryCliOptions(['--static'])).toEqual({ mode: 'static', scope: 'full' });
    expect(parseInventoryCliOptions(['--live'])).toEqual({ mode: 'live', scope: 'full' });
    expect(() => parseInventoryCliArgs(['--live', '--scope=local'])).toThrow(
      'expected --static or --live [--scope=remote]',
    );
    expect(() =>
      parseInventoryCliOptions(['--live', '--retirement-evidence-root=/tmp/evidence']),
    ).toThrow('expected --static or --live [--scope=remote]');
  });

  it('does not let remote scope bypass static host-local manifest validation', () => {
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              id: 'SRC-DIRTY',
              kind: 'DIRTY_WORKTREE',
              locator: '/tmp/dirty',
              head_sha: DIRTY_SHA,
              role: 'CAPABILITY_CANDIDATE',
              repository_id: 'aquaculture-platform',
              owner_class: 'CODEX',
              status_sha256: DIRTY_STATUS_SHA,
              state: 'ASSESSING',
              disposition: 'REIMPLEMENT',
            },
          ],
        },
      }),
    ).toThrow('content_sha256');
  });

  it('reads legacy v1 without inventing authority and blocks full discovery until v2', () => {
    const legacy = parseInventoryManifest({
      capability_reconciliation: {
        reconciled_base_sha: BASE_SHA,
        sources: [
          {
            id: 'SRC-LEGACY-WORKTREE',
            kind: 'DIRTY_WORKTREE',
            locator: '/historical/worktree',
            head_sha: DIRTY_SHA,
            content_sha256: DIRTY_CONTENT_SHA,
            state: 'ASSESSING',
            disposition: 'PRESERVE_PENDING',
          },
        ],
      },
    });
    expect(legacy).toEqual({
      schemaVersion: 1,
      reconciledBaseSha: BASE_SHA,
      sources: [
        {
          id: 'SRC-LEGACY-WORKTREE',
          kind: 'DIRTY_WORKTREE',
          locator: '/historical/worktree',
          headSha: DIRTY_SHA,
          role: null,
          repositoryId: null,
          ownerClass: null,
          statusSha256: null,
          contentSha256: DIRTY_CONTENT_SHA,
          state: 'ASSESSING',
          disposition: 'PRESERVE_PENDING',
        },
      ],
    });
    expect(() => compileRegisteredCommonDirLocators(legacy)).toThrow(
      expect.objectContaining<Partial<InventoryInspectionError>>({
        code: 'WORKTREE_AUTHORITY_MIGRATION_REQUIRED',
      }),
    );
  });
});

describe('source inventory CI authority separation', () => {
  it('keeps generic CI deterministic while retaining explicit live generation commands', () => {
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
    expect(scripts['gates:capability-source-inventory:static']).toBe(
      'ts-node --project tools/gates/tsconfig.json tools/gates/capability-source-inventory.ts --static',
    );
    expect(scripts['gates:capability-source-inventory:live']).toBe(
      'ts-node --project tools/gates/tsconfig.json tools/gates/source-inventory-runner.ts --live',
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
    const checkoutRef = job.indexOf(
      'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
      checkout,
    );
    const fetchDepth = job.indexOf('fetch-depth: 0', checkout);
    const setupNode = job.indexOf('- name: Setup Node.js', checkout);
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(checkoutRef).toBeGreaterThan(checkout);
    expect(fetchDepth).toBeGreaterThan(checkoutRef);
    expect(setupNode).toBeGreaterThan(fetchDepth);

    const staticCapabilityCommand = 'run: npm run gates:capability-source-inventory:static';
    const staticFindingCommand = 'run: npm run gates:source-finding-inventory:static';
    expect(job.indexOf(staticCapabilityCommand)).toBeGreaterThan(setupNode);
    expect(job.indexOf(staticFindingCommand)).toBeGreaterThan(job.indexOf(staticCapabilityCommand));
    expect(job).not.toContain('git fetch --no-tags origin');
    expect(job).not.toContain('gates:capability-source-inventory:remote');
    expect(job).not.toContain('gates:source-finding-inventory:remote');
    expect(job).not.toContain('CAPABILITY_INVENTORY_CURRENT_');
    expect(job).not.toContain('SOURCE_FINDING_EVENT_');
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
      exclusionProof: null,
    };
    const resolveActions = jest.fn(() => actionsIdentity);
    const resolveSymbolicLocal = jest.fn(() => ({
      worktreePath: '/runner/work/repository',
      headSha: DIRTY_SHA,
      branchRef: 'refs/heads/colliding-fork-name',
      originRef: 'refs/remotes/origin/colliding-fork-name',
      exclusionProof: null,
    }));

    expect(selectExecutionIdentity('true', resolveActions, resolveSymbolicLocal)).toEqual(
      actionsIdentity,
    );
    expect(resolveActions).toHaveBeenCalledTimes(1);
    expect(resolveSymbolicLocal).not.toHaveBeenCalled();
  });

  it('admits exclusion only for an exact clean runner profile and independent full common-dir', () => {
    const identity = {
      worktreePath: '/runner/repository',
      headSha: REMOTE_SHA,
      branchRef: null,
      originRef: ciRemoteRef.locator,
      exclusionProof: null,
    } as const;
    const common = {
      identity,
      checkoutHeadSha: REMOTE_SHA,
      checkoutDirty: false,
      executionCommonDir: '/runner/repository/.git',
      governedCommonDirs: [] as string[],
      localRunnerProfile: undefined,
    };
    expect(
      admitExecutionExclusionProof({
        ...common,
        scope: 'remote',
        githubActions: 'true',
        workflowRef: `${TRUSTED_REMOTE_INVENTORY_WORKFLOW}@refs/pull/1040/merge`,
        jobId: TRUSTED_REMOTE_INVENTORY_JOB,
      }).exclusionProof,
    ).toEqual({
      kind: 'INDEPENDENT_CLEAN_INVENTORY_RUNNER_V1',
      committed: true,
      clean: true,
    });
    expect(() =>
      admitExecutionExclusionProof({
        ...common,
        checkoutHeadSha: CURRENT_SHA,
        scope: 'remote',
        githubActions: 'true',
        workflowRef: `${TRUSTED_REMOTE_INVENTORY_WORKFLOW}@refs/pull/1040/merge`,
        jobId: TRUSTED_REMOTE_INVENTORY_JOB,
      }),
    ).toThrow(/checkout HEAD .* differs from execution identity/);
    expect(
      admitExecutionExclusionProof({
        ...common,
        scope: 'remote',
        githubActions: 'true',
        workflowRef: `${TRUSTED_REMOTE_INVENTORY_WORKFLOW}@refs/pull/1040/merge`,
        jobId: 'another-job',
      }).exclusionProof,
    ).toBeNull();
    expect(
      admitExecutionExclusionProof({
        ...common,
        scope: 'full',
        githubActions: undefined,
        workflowRef: undefined,
        jobId: undefined,
        localRunnerProfile: SOURCE_INVENTORY_RUNNER_PROFILE,
        governedCommonDirs: ['/governed/repository/.git'],
      }).exclusionProof,
    ).not.toBeNull();
    expect(() =>
      admitExecutionExclusionProof({
        ...common,
        scope: 'full',
        githubActions: undefined,
        workflowRef: undefined,
        jobId: undefined,
        localRunnerProfile: SOURCE_INVENTORY_RUNNER_PROFILE,
        governedCommonDirs: ['/runner/repository/.git'],
      }),
    ).toThrow(/independent Git common-dir/);
  });

  it('does not treat generic Actions identity as inventory-runner exclusion proof', () => {
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
      exclusionProof: null,
    });
    if (executionIdentity === null) {
      throw new Error('trusted Actions fixture lost its execution identity');
    }

    const live = discoverInventory(
      input({
        remoteRefs: [{ locator: 'refs/remotes/origin/main', headSha: MAIN_SHA }, ciRemoteRef],
        localRefs: [],
        worktrees: [],
        executionIdentity,
      }),
      'remote',
    );
    expect(live.sources).toEqual([
      {
        kind: 'REMOTE_BRANCH',
        locator: ciRemoteRef.locator,
        headSha: REMOTE_SHA,
        role: 'CAPABILITY_CANDIDATE',
      },
    ]);

    const provenGovernanceRunner = discoverInventory(
      input({
        remoteRefs: [{ locator: 'refs/remotes/origin/main', headSha: MAIN_SHA }, ciRemoteRef],
        localRefs: [],
        worktrees: [],
        executionIdentity: {
          ...executionIdentity,
          exclusionProof: {
            kind: 'INDEPENDENT_CLEAN_INVENTORY_RUNNER_V1',
            committed: true,
            clean: true,
          },
        },
        classifyBranchSourceRole: () => 'INVENTORY_GOVERNANCE',
      }),
      'remote',
    );
    expect(provenGovernanceRunner.sources).toEqual([]);

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
        role: 'CAPABILITY_CANDIDATE',
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

  it('compiles production common-dir discovery only from strict v2 source rows', async () => {
    const evidence = await computeCanonicalGitWorktreeEvidence(repositoryPath);
    const manifest: InventoryManifest = {
      schemaVersion: 2,
      reconciledBaseSha: BASE_SHA,
      sources: [
        {
          id: 'SRC-WORKTREE',
          kind: 'CLEAN_WORKTREE',
          locator: repositoryPath,
          headSha: evidence.headSha,
          role: 'WORKTREE_PRESERVATION',
          repositoryId: 'fixture-repository',
          ownerClass: 'REPOSITORY_RUNNER',
          statusSha256: evidence.statusSha256,
          contentSha256: evidence.contentSha256,
          state: 'ASSESSING',
          disposition: 'PRESERVE_PENDING',
        },
      ],
    };
    const locators = compileRegisteredCommonDirLocators(manifest);
    expect(locators).toHaveLength(1);
    expect(locators[0]).toEqual(
      expect.objectContaining({
        locatorId: 'fixture-repository',
        repositoryId: 'fixture-repository',
        queryWorktreePath: repositoryPath,
        worktrees: [{ worktreePath: repositoryPath, ownerClass: 'REPOSITORY_RUNNER' }],
      }),
    );
    const [observation] = await discoverRegisteredCommonDirs(locators);
    expect(observation?.worktrees).toEqual([
      expect.objectContaining({
        worktreePath: repositoryPath,
        ownerClass: 'REPOSITORY_RUNNER',
        dirty: false,
        statusSha256: evidence.statusSha256,
        contentSha256: evidence.contentSha256,
      }),
    ]);
    const declaredSource = manifest.sources[0];
    if (!declaredSource || !isManifestWorktreeSource(declaredSource)) {
      throw new Error('strict worktree fixture lost its declared source');
    }
    expect(() =>
      compileRegisteredCommonDirLocators({
        ...manifest,
        sources: [
          ...manifest.sources,
          {
            ...declaredSource,
            id: 'SRC-SECOND-REPOSITORY',
            repositoryId: 'second-repository',
          },
        ],
      }),
    ).toThrow(/exactly one governed repository\/common-dir authority/);
  }, 20_000);
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
    const dirty = manifest.sources.find((source) => source.locator === '/tmp/dirty');
    if (!remote || !dirty || !isManifestWorktreeSource(dirty) || dirty.kind !== 'DIRTY_WORKTREE') {
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
      role: 'CAPABILITY_CANDIDATE',
      state: 'ASSESSING',
      disposition: 'REIMPLEMENT',
    });
    manifest.sources.push({
      id: 'SRC-DUPLICATE',
      kind: 'LOCAL_BRANCH',
      locator: 'refs/heads/stale',
      headSha: MERGED_SHA,
      role: 'CAPABILITY_CANDIDATE',
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

  it('fails closed when a terminal remote ref is deleted', () => {
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

  it('fails closed when local-only or dirty evidence disappears', () => {
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
  });

  it('requires reconciled_base_sha and dirty content identity while rejecting retirement authority', () => {
    const source = {
      id: 'SRC-001',
      kind: 'DIRTY_WORKTREE',
      locator: '/tmp/dirty',
      head_sha: DIRTY_SHA,
      role: 'CAPABILITY_CANDIDATE',
      repository_id: 'aquaculture-platform',
      owner_class: 'CODEX',
      status_sha256: DIRTY_STATUS_SHA,
      content_sha256: DIRTY_CONTENT_SHA,
      state: 'INTEGRATED',
      disposition: 'PRESERVE',
    };

    expect(
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [source],
        },
      }),
    ).toEqual({
      schemaVersion: 2,
      reconciledBaseSha: BASE_SHA,
      sources: [
        {
          id: 'SRC-001',
          kind: 'DIRTY_WORKTREE',
          locator: '/tmp/dirty',
          headSha: DIRTY_SHA,
          role: 'CAPABILITY_CANDIDATE',
          repositoryId: 'aquaculture-platform',
          ownerClass: 'CODEX',
          statusSha256: DIRTY_STATUS_SHA,
          contentSha256: DIRTY_CONTENT_SHA,
          state: 'INTEGRATED',
          disposition: 'PRESERVE',
        },
      ],
    });

    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          main_sha: BASE_SHA,
          sources: [source],
        },
      }),
    ).toThrow('reconciled_base_sha');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [{ ...source, owner_class: 'INTRUDER' }],
        },
      }),
    ).toThrow('closed worktree owner class');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [{ ...source, content_sha256: undefined }],
        },
      }),
    ).toThrow('content_sha256');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [
            {
              ...source,
              retirement: {
                status: 'RETIRE_APPROVED',
              },
            },
          ],
        },
      }),
    ).toThrow('retirement is forbidden');
  });
});

describe('already-main proof validation', () => {
  function ancestorProofManifest(): InventoryManifest {
    return {
      schemaVersion: 2,
      reconciledBaseSha: BASE_SHA,
      sources: [
        {
          id: 'SRC-PROOF',
          kind: 'REMOTE_BRANCH',
          locator: 'refs/remotes/origin/feature/proven',
          headSha: REMOTE_SHA,
          role: 'CAPABILITY_CANDIDATE',
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
      role: 'CAPABILITY_CANDIDATE',
      state: 'INTEGRATED',
      disposition: 'ALREADY_ON_MAIN',
      main_proof: proof,
    };
    expect(
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [source],
        },
      }).sources[0],
    ).toEqual({
      id: 'SRC-PROOF',
      kind: 'REMOTE_BRANCH',
      locator: 'refs/remotes/origin/feature/proven',
      headSha: REMOTE_SHA,
      role: 'CAPABILITY_CANDIDATE',
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
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
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
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [{ ...source, main_proof: undefined }],
        },
      }),
    ).toThrow('main_proof is required');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
          reconciled_base_sha: BASE_SHA,
          sources: [{ ...source, kind: 'LOCAL_BRANCH', locator: 'refs/heads/proven' }],
        },
      }),
    ).toThrow('only for a REMOTE_BRANCH');
    expect(() =>
      parseInventoryManifest({
        capability_reconciliation: {
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
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
          source_inventory_schema: SOURCE_INVENTORY_SCHEMA_V2,
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
