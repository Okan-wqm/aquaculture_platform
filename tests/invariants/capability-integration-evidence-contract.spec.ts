import {
  assertOriginMainStable,
  computeExecutionAttemptId,
  computeSourceSliceSelectorSha256,
  parseIntegrationEvidenceManifest,
  parseRequiredStatusContract,
  validateExecutionIdentityDefinitions,
  validateIntegrationEvidenceLive,
  validateIntegrationEvidenceStatic,
  type AcceptanceEvidence,
  type AcceptanceRequirement,
  type AuthorityBoundary,
  type DispatchIdentityCatalog,
  type ExecutionAttempt,
  type GateResult,
  type GitEvidenceReader,
  type GitHubActionsArtifactTrust,
  type GitHubActionsEvidenceReader,
  type GitHubArtifactRecord,
  type GitHubCheckRunRecord,
  type GitHubPullRequestRecord,
  type GitHubWorkflowRunRecord,
  type IntegrationEvidenceManifest,
  type IntegrationUnit,
  type LiveEvidenceTrustContext,
  type ManifestSource,
  type PathBlobSelectorEntry,
  type RequiredStatusContract,
  type SigstoreBundleTrust,
  type SigstoreEvidenceVerifier,
  type SigstoreVerificationResult,
  type SourceSlice,
} from '../../tools/gates/capability-integration-evidence';

const MAIN_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const MERGE_SHA = '3'.repeat(40);
const SOURCE_SHA = '4'.repeat(40);
const STACK_SHA = '5'.repeat(40);
const MAIN_PROOF_SHA = '6'.repeat(40);
const SOURCE_TREE_SHA = '7'.repeat(40);
const MAIN_TREE_SHA = SOURCE_TREE_SHA;
const SOURCE_BLOB_SHA = '8'.repeat(40);
const OTHER_SHA = '9'.repeat(40);
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const ARTIFACT_DIGEST = 'c'.repeat(64);
const PROTECTED_MAIN_ONE = 'd'.repeat(40);
const PROTECTED_MAIN_TWO = 'e'.repeat(40);
const REPOSITORY = 'example/aqua-saas';
const NOW = '2026-07-29T12:00:00.000Z';
const WORKFLOW_PATH = '.github/workflows/ci-full.yml';
const WORKFLOW_RUN_ID = 10_001;
const WORKFLOW_RUN_ATTEMPT = 2;
const ARTIFACT_ID = 20_001;

const REQUIRED_STATUS: RequiredStatusContract = {
  digestSha256: DIGEST,
  repository: REPOSITORY,
  contexts: ['merge-gate', 'build-status'],
};

const REQUIRED_GATE_IDS = [
  'duplicate-authority-absent',
  'root-cause-closed',
  'focused-tests-green',
  'affected-test-lint-build-green',
  'exact-head-actions-green',
];

function executionAttempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  const identity = {
    repository: REPOSITORY,
    pullRequestNumber: 42,
    headSha: HEAD_SHA,
    requiredStatusManifestSha256: DIGEST,
    workflowRunId: WORKFLOW_RUN_ID,
    workflowRunAttempt: WORKFLOW_RUN_ATTEMPT,
  };
  return {
    attemptId: computeExecutionAttemptId(identity),
    ...identity,
    startedAt: NOW,
    mergeEvidence: {
      kind: 'MERGE_COMMIT',
      mergeCommitSha: MERGE_SHA,
      baseRef: 'refs/heads/main',
      mergedAt: NOW,
    },
    ...overrides,
  };
}

function actionsTrust(
  artifactSha256 = ARTIFACT_DIGEST,
  overrides: Partial<GitHubActionsArtifactTrust> = {},
): GitHubActionsArtifactTrust {
  return {
    kind: 'GITHUB_ACTIONS_ARTIFACT',
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    workflowRunId: WORKFLOW_RUN_ID,
    workflowRunAttempt: WORKFLOW_RUN_ATTEMPT,
    workflowPath: WORKFLOW_PATH,
    artifactId: ARTIFACT_ID,
    artifactName: 'capability-integration-evidence',
    artifactSha256,
    ...overrides,
  };
}

function sigstoreTrust(
  subjectSha256 = ARTIFACT_DIGEST,
  overrides: Partial<SigstoreBundleTrust> = {},
): SigstoreBundleTrust {
  return {
    kind: 'SIGSTORE_BUNDLE',
    repository: REPOSITORY,
    headSha: HEAD_SHA,
    subjectSha256,
    bundleUri: 'artifact://capability-integration-evidence/signature.bundle',
    bundleSha256: OTHER_DIGEST,
    issuer: 'https://token.actions.githubusercontent.com',
    signerIdentity: `https://github.com/${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
    ...overrides,
  };
}

function commandGateResult(gateId: string): GateResult {
  return {
    gateId,
    status: 'PASS',
    headSha: HEAD_SHA,
    evidence: [
      {
        kind: 'COMMAND_RESULT',
        headSha: HEAD_SHA,
        command: `npm run ${gateId}`,
        exitCode: 0,
        artifactSha256: ARTIFACT_DIGEST,
        completedAt: NOW,
        trust: actionsTrust(),
      },
    ],
  };
}

function checkDetailsUrl(index: number): string {
  return `https://github.com/${REPOSITORY}/actions/runs/${String(
    WORKFLOW_RUN_ID,
  )}/job/${String(40_001 + index)}`;
}

function exactHeadGateResult(contexts = REQUIRED_STATUS.contexts): GateResult {
  return {
    gateId: 'exact-head-actions-green',
    status: 'PASS',
    headSha: HEAD_SHA,
    evidence: contexts.map((context, index) => ({
      kind: 'GITHUB_CHECK',
      headSha: HEAD_SHA,
      checkRunId: 30_001 + index,
      workflowRunId: WORKFLOW_RUN_ID,
      workflowRunAttempt: WORKFLOW_RUN_ATTEMPT,
      repository: REPOSITORY,
      context,
      conclusion: 'SUCCESS',
      detailsUrl: checkDetailsUrl(index),
      completedAt: NOW,
    })),
  };
}

function findingGateResult(): GateResult {
  return {
    gateId: 'root-cause-closed',
    status: 'PASS',
    headSha: HEAD_SHA,
    evidence: [
      {
        kind: 'FINDING_STATE',
        headSha: HEAD_SHA,
        findingIds: ['INFRA-HIGH-001'],
        state: 'RESOLVED',
        registryTipSha256: ARTIFACT_DIGEST,
        completedAt: NOW,
        trust: actionsTrust(),
      },
    ],
  };
}

function passingGateResults(): GateResult[] {
  return [
    ...REQUIRED_GATE_IDS.filter(
      (gateId) => gateId !== 'exact-head-actions-green' && gateId !== 'root-cause-closed',
    ).map(commandGateResult),
    findingGateResult(),
    exactHeadGateResult(),
  ];
}

function unit(id: string, overrides: Partial<IntegrationUnit> = {}): IntegrationUnit {
  return {
    id,
    state: 'ASSESSING',
    legacySourceIds: [],
    legacyDerivedFrom: [],
    dependsOn: [],
    authorityTargets: [],
    sourceSliceIds: [],
    executionAttempt: null,
    externalBlocker: null,
    acceptanceRequirements: [],
    acceptanceEvidence: [],
    findingIds: [],
    findingBindingStatus: 'NOT_REQUIRED',
    ownership: null,
    coClosureContract: null,
    mainEvidence: [],
    gateProfile: 'ATOMIC_PR_V1',
    gateResults: [],
    authorityBoundary: null,
    enhancedFieldPresence: {
      authorityTargets: false,
      sourceSliceIds: false,
      executionAttempt: false,
      externalBlocker: false,
      acceptanceRequirements: false,
      acceptanceEvidence: false,
      ownership: false,
      coClosureContract: false,
    },
    legacyOwnerPresent: false,
    ...overrides,
  };
}

function verifiedUnit(id: string, overrides: Partial<IntegrationUnit> = {}): IntegrationUnit {
  return unit(id, {
    state: 'VERIFIED',
    authorityTargets: [
      {
        kind: 'POLICY',
        policyId: `capability.${id.toLowerCase()}`,
        resolution: 'RESOLVED',
      },
    ],
    sourceSliceIds: [],
    executionAttempt: executionAttempt(),
    acceptanceRequirements: [],
    acceptanceEvidence: [],
    ownership: {
      accountableRegistryOwner: null,
      executionOwner: 'architectural-arbiter',
      mandatoryReviewers: [],
    },
    coClosureContract: null,
    gateResults: passingGateResults(),
    enhancedFieldPresence: {
      authorityTargets: true,
      sourceSliceIds: true,
      executionAttempt: true,
      externalBlocker: true,
      acceptanceRequirements: true,
      acceptanceEvidence: true,
      ownership: true,
      coClosureContract: true,
    },
    ...overrides,
  });
}

function manifest(
  units: IntegrationUnit[],
  overrides: Partial<IntegrationEvidenceManifest> = {},
): IntegrationEvidenceManifest {
  return {
    requiredStatusManifestPath: '.github/manifests/main-required-status-checks.json',
    integrationOrder: units.map((entry) => entry.id),
    units,
    sources: [],
    sourceSlices: [],
    gateProfiles: [
      {
        id: 'ATOMIC_PR_V1',
        requiredGateIds: REQUIRED_GATE_IDS,
        evidenceContracts: {
          'duplicate-authority-absent': 'COMMAND_RESULT',
          'root-cause-closed': 'FINDING_STATE',
          'focused-tests-green': 'COMMAND_RESULT',
          'affected-test-lint-build-green': 'COMMAND_RESULT',
          'exact-head-actions-green': 'GITHUB_CHECK',
        },
      },
    ],
    ...overrides,
  };
}

function issueCodes(evidenceManifest: IntegrationEvidenceManifest): string[] {
  return validateIntegrationEvidenceStatic(evidenceManifest, REQUIRED_STATUS).map(
    (issue) => issue.code,
  );
}

class FixtureGit implements GitEvidenceReader {
  public readonly commits = new Set<string>();
  public readonly trees = new Set<string>();
  public readonly blobs = new Set<string>();
  public readonly ancestry = new Set<string>();
  public readonly commitTrees = new Map<string, string>();
  public readonly pathBlobs = new Map<string, string>();
  public readonly changedPaths = new Set<string>();
  public mainSha = MAIN_SHA;

  public async resolveRef(_ref: string): Promise<string> {
    return this.mainSha;
  }

  public async objectExists(oid: string, kind: 'commit' | 'tree' | 'blob'): Promise<boolean> {
    if (kind === 'commit') {
      return this.commits.has(oid);
    }
    if (kind === 'tree') {
      return this.trees.has(oid);
    }
    return this.blobs.has(oid);
  }

  public async isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean> {
    return ancestorSha === descendantSha || this.ancestry.has(`${ancestorSha}:${descendantSha}`);
  }

  public async commitTree(commitSha: string): Promise<string | null> {
    return this.commitTrees.get(commitSha) ?? null;
  }

  public async pathBlob(commitSha: string, path: string): Promise<string | null> {
    return this.pathBlobs.get(`${commitSha}:${path}`) ?? null;
  }

  public async pathChangedBetween(
    baseSha: string,
    headSha: string,
    path: string,
  ): Promise<boolean> {
    return this.changedPaths.has(`${baseSha}:${headSha}:${path}`);
  }
}

function liveGit(): FixtureGit {
  const git = new FixtureGit();
  [
    MAIN_SHA,
    HEAD_SHA,
    MERGE_SHA,
    SOURCE_SHA,
    STACK_SHA,
    MAIN_PROOF_SHA,
    PROTECTED_MAIN_ONE,
    PROTECTED_MAIN_TWO,
  ].forEach((sha) => git.commits.add(sha));
  git.ancestry.add(`${HEAD_SHA}:${MERGE_SHA}`);
  git.ancestry.add(`${HEAD_SHA}:${MAIN_SHA}`);
  git.ancestry.add(`${MERGE_SHA}:${MAIN_SHA}`);
  git.ancestry.add(`${SOURCE_SHA}:${STACK_SHA}`);
  git.ancestry.add(`${MAIN_PROOF_SHA}:${MAIN_SHA}`);
  git.ancestry.add(`${PROTECTED_MAIN_ONE}:${MAIN_SHA}`);
  git.ancestry.add(`${PROTECTED_MAIN_TWO}:${MAIN_SHA}`);
  git.trees.add(SOURCE_TREE_SHA);
  git.blobs.add(SOURCE_BLOB_SHA);
  git.commitTrees.set(STACK_SHA, SOURCE_TREE_SHA);
  git.commitTrees.set(MAIN_PROOF_SHA, MAIN_TREE_SHA);
  git.pathBlobs.set(`${SOURCE_SHA}:src/capability.ts`, SOURCE_BLOB_SHA);
  git.pathBlobs.set(`${MAIN_PROOF_SHA}:src/capability.ts`, SOURCE_BLOB_SHA);
  return git;
}

class FixtureGitHub implements GitHubActionsEvidenceReader {
  public authenticated = true;
  public pullRequest: GitHubPullRequestRecord = {
    repository: REPOSITORY,
    number: 42,
    headRepository: REPOSITORY,
    headSha: HEAD_SHA,
    state: 'CLOSED',
    merged: true,
    mergeCommitSha: MERGE_SHA,
  };
  public readonly workflowRuns = new Map<number, GitHubWorkflowRunRecord>([
    [
      WORKFLOW_RUN_ID,
      {
        repository: REPOSITORY,
        id: WORKFLOW_RUN_ID,
        headRepository: REPOSITORY,
        headSha: HEAD_SHA,
        runAttempt: WORKFLOW_RUN_ATTEMPT,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        event: 'pull_request',
        path: WORKFLOW_PATH,
        detailsUrl: `https://github.com/${REPOSITORY}/actions/runs/${String(WORKFLOW_RUN_ID)}`,
        pullRequestNumbers: [42],
      },
    ],
  ]);
  public readonly checkRuns = new Map<number, GitHubCheckRunRecord>(
    REQUIRED_STATUS.contexts.map((context, index) => [
      30_001 + index,
      {
        repository: REPOSITORY,
        id: 30_001 + index,
        name: context,
        headSha: HEAD_SHA,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: checkDetailsUrl(index),
        appSlug: 'github-actions',
        workflowRunId: WORKFLOW_RUN_ID,
      },
    ]),
  );
  public artifact: GitHubArtifactRecord = {
    repository: REPOSITORY,
    id: ARTIFACT_ID,
    name: 'capability-integration-evidence',
    workflowRunId: WORKFLOW_RUN_ID,
    expired: false,
    digestSha256: ARTIFACT_DIGEST,
  };

  public async isAuthenticated(): Promise<boolean> {
    return this.authenticated;
  }

  public async getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestRecord> {
    if (
      repository !== this.pullRequest.repository ||
      pullRequestNumber !== this.pullRequest.number
    ) {
      throw new Error('unknown pull request');
    }
    return this.pullRequest;
  }

  public async getWorkflowRun(
    repository: string,
    workflowRunId: number,
  ): Promise<GitHubWorkflowRunRecord> {
    const run = this.workflowRuns.get(workflowRunId);
    if (repository !== REPOSITORY || run === undefined) {
      throw new Error('unknown workflow run');
    }
    return run;
  }

  public async getCheckRun(repository: string, checkRunId: number): Promise<GitHubCheckRunRecord> {
    const check = this.checkRuns.get(checkRunId);
    if (repository !== REPOSITORY || check === undefined) {
      throw new Error('unknown check run');
    }
    return check;
  }

  public async getArtifact(repository: string, artifactId: number): Promise<GitHubArtifactRecord> {
    if (repository !== REPOSITORY || artifactId !== this.artifact.id) {
      throw new Error('unknown artifact');
    }
    return this.artifact;
  }
}

function liveTrustContext(github = new FixtureGitHub()): LiveEvidenceTrustContext {
  return { github };
}

class FixtureSigstoreVerifier implements SigstoreEvidenceVerifier {
  public constructor(private readonly verified: boolean) {}

  public async verify(binding: SigstoreBundleTrust): Promise<SigstoreVerificationResult> {
    return {
      verified: this.verified,
      repository: binding.repository,
      headSha: binding.headSha,
      subjectSha256: binding.subjectSha256,
      bundleSha256: binding.bundleSha256,
      issuer: binding.issuer,
      signerIdentity: binding.signerIdentity,
    };
  }
}

describe('capability integration evidence state and topology', () => {
  it('allows missing enhanced fields only while ASSESSING and ignores derived_from for ordering', () => {
    const first = unit('IU-FIRST', {
      legacyDerivedFrom: ['IU-SECOND'],
    });
    const second = unit('IU-SECOND');
    const evidenceManifest = manifest([second, first], {
      integrationOrder: ['IU-FIRST', 'IU-SECOND'],
    });

    expect(issueCodes(evidenceManifest)).toEqual([]);
  });

  it('uses depends_on alone for topological ordering and rejects cycles', () => {
    const first = unit('IU-FIRST', { dependsOn: ['IU-SECOND'] });
    const second = unit('IU-SECOND', { dependsOn: ['IU-FIRST'] });
    const codes = issueCodes(
      manifest([first, second], {
        integrationOrder: ['IU-FIRST', 'IU-SECOND'],
      }),
    );

    expect(codes).toEqual(
      expect.arrayContaining(['DEPENDENCY_ORDER_VIOLATION', 'DEPENDENCY_CYCLE']),
    );
  });

  it('requires every enhanced field and resolved authority before READY', () => {
    const ready = unit('IU-READY', { state: 'READY' });
    const codes = issueCodes(manifest([ready]));

    expect(codes).toEqual(
      expect.arrayContaining(['ADVANCED_FIELD_MISSING', 'AUTHORITY_TARGETS_REQUIRED']),
    );
  });

  it('blocks legacy branch-level provenance and derived_from at READY', () => {
    const ready = verifiedUnit('IU-LEGACY', {
      state: 'READY',
      legacySourceIds: ['SRC-R-001'],
      legacyDerivedFrom: ['IU-HISTORICAL'],
      executionAttempt: null,
      gateResults: [],
    });

    expect(issueCodes(manifest([ready]))).toEqual(
      expect.arrayContaining(['LEGACY_SOURCE_IDS_FORBIDDEN', 'LEGACY_DERIVED_FROM_FORBIDDEN']),
    );
  });

  it('enforces the attempt state machine and exact evidence head binding', () => {
    const invalidAttempt = executionAttempt({
      attemptId: `attempt-sha256:${OTHER_DIGEST}`,
    });
    const integrating = verifiedUnit('IU-INTEGRATING', {
      state: 'INTEGRATING',
      executionAttempt: invalidAttempt,
      gateResults: [
        {
          ...commandGateResult('focused-tests-green'),
          headSha: OTHER_SHA,
          evidence: [
            {
              ...commandGateResult('focused-tests-green').evidence[0]!,
              headSha: OTHER_SHA,
            },
          ],
        },
      ],
    });
    const assessing = unit('IU-ASSESSING', {
      executionAttempt: executionAttempt(),
      enhancedFieldPresence: {
        authorityTargets: false,
        sourceSliceIds: false,
        executionAttempt: true,
        externalBlocker: false,
        acceptanceRequirements: false,
        acceptanceEvidence: false,
        ownership: false,
        coClosureContract: false,
      },
    });
    const codes = issueCodes(manifest([assessing, integrating]));

    expect(codes).toEqual(
      expect.arrayContaining([
        'EXECUTION_ATTEMPT_FORBIDDEN',
        'EXECUTION_ATTEMPT_ID_INVALID',
        'GATE_RESULT_HEAD_MISMATCH',
        'GATE_EVIDENCE_HEAD_MISMATCH',
      ]),
    );
  });

  it('requires BLOCKED_EXTERNAL to carry an attributable blocker', () => {
    const blocked = verifiedUnit('IU-BLOCKED', {
      state: 'BLOCKED_EXTERNAL',
      externalBlocker: null,
    });

    expect(issueCodes(manifest([blocked]))).toContain('EXTERNAL_BLOCKER_REQUIRED');
  });

  it('blocks multi-finding promotion unless one shared root cause proves the exact closure set', () => {
    const findingIds = ['INFRA-HIGH-001', 'INFRA-HIGH-002'];
    const ownership = {
      accountableRegistryOwner: 'test-expert',
      executionOwner: 'test-runner',
      mandatoryReviewers: ['infra-expert'],
    };
    const unproven = verifiedUnit('IU-MULTI', {
      findingIds,
      findingBindingStatus: 'BOUND',
      ownership,
    });
    expect(issueCodes(manifest([unproven]))).toContain('MULTI_FINDING_CO_CLOSURE_REQUIRED');

    const proven = verifiedUnit('IU-MULTI', {
      findingIds,
      findingBindingStatus: 'BOUND',
      ownership,
      coClosureContract: {
        kind: 'SAME_ROOT_CAUSE',
        rootCauseKey: 'ci.scheduler.duplicate-authority',
        evidenceRefs: ['artifact://same-root-cause/ci-scheduler'],
      },
    });
    expect(issueCodes(manifest([proven]))).not.toContain('MULTI_FINDING_CO_CLOSURE_REQUIRED');
  });

  it('binds promoted ownership and mandatory reviewers to unique dispatchable identities', () => {
    const owned = verifiedUnit('IU-OWNED', {
      ownership: {
        accountableRegistryOwner: null,
        executionOwner: 'infra-expert',
        mandatoryReviewers: ['performance-expert'],
      },
    });
    const catalog: DispatchIdentityCatalog = {
      definitions: () => [
        { name: 'infra-expert', path: '.claude/agents/infra-expert.md' },
        {
          name: 'performance-expert',
          path: '.claude/agents/performance-expert.md',
        },
      ],
    };

    expect(validateExecutionIdentityDefinitions(manifest([owned]), catalog)).toEqual([]);

    const missingCatalog: DispatchIdentityCatalog = { definitions: () => [] };
    expect(
      validateExecutionIdentityDefinitions(manifest([owned]), missingCatalog).map(
        (issue) => issue.code,
      ),
    ).toContain('EXECUTION_IDENTITY_NOT_UNIQUE');
  });
});

describe('capability integration evidence authority and source slices', () => {
  it('detects typed target overlap across whole paths, symbols, and globs', () => {
    const pathOwner = unit('IU-PATH', {
      authorityTargets: [
        {
          kind: 'FILE_GLOB',
          pattern: 'apps/billing/**',
          resolution: 'RESOLVED',
        },
      ],
    });
    const symbolOwner = unit('IU-SYMBOL', {
      authorityTargets: [
        {
          kind: 'SYMBOL',
          filePath: 'apps/billing/src/money.ts',
          symbol: 'Money',
          resolution: 'RESOLVED',
        },
      ],
    });

    expect(issueCodes(manifest([pathOwner, symbolOwner]))).toContain('AUTHORITY_TARGET_COLLISION');
  });

  it('never permits a source coordinate to become behavior authority', () => {
    const branchAsAuthority = unit('IU-BRANCH-AUTHORITY', {
      authorityTargets: [
        {
          kind: 'POLICY',
          policyId: 'SRC-R-001',
          resolution: 'RESOLVED',
        },
      ],
    });

    expect(issueCodes(manifest([branchAsAuthority]))).toContain(
      'SOURCE_CANNOT_BE_BEHAVIOR_AUTHORITY',
    );
  });

  it('gives each typed source slice exactly one authority and blocks unresolved provenance', () => {
    const source: ManifestSource = {
      id: 'SRC-001',
      kind: 'REMOTE_BRANCH',
      headSha: SOURCE_SHA,
      contentSha256: null,
      mainProof: null,
    };
    const selectorDocument = {
      kind: 'COMMIT_SET',
      commit_shas: [SOURCE_SHA],
    };
    const selectorSha256 = computeSourceSliceSelectorSha256(selectorDocument);
    const slice: SourceSlice = {
      id: 'SLICE-001',
      sourceId: source.id,
      purpose: 'IMPLEMENTATION_CANDIDATE',
      authorityRole: 'PROVENANCE_ONLY',
      resolution: 'UNRESOLVED',
      selectorSha256,
      computedSelectorSha256: selectorSha256,
      selector: { kind: 'COMMIT_SET', commitShas: [SOURCE_SHA] },
    };
    const owner = verifiedUnit('IU-OWNER', {
      state: 'READY',
      sourceSliceIds: [slice.id],
      executionAttempt: null,
      gateResults: [],
    });
    const duplicateOwner = unit('IU-DUPLICATE', {
      sourceSliceIds: [slice.id],
      enhancedFieldPresence: {
        authorityTargets: false,
        sourceSliceIds: true,
        executionAttempt: false,
        externalBlocker: false,
        acceptanceRequirements: false,
        acceptanceEvidence: false,
        ownership: false,
        coClosureContract: false,
      },
    });
    const codes = issueCodes(
      manifest([owner, duplicateOwner], {
        sources: [source],
        sourceSlices: [slice],
      }),
    );

    expect(codes).toEqual(
      expect.arrayContaining(['SOURCE_SLICE_AUTHORITY_COLLISION', 'SOURCE_SLICE_UNRESOLVED']),
    );
  });

  it('content-addresses selectors and requires every implementation candidate to have one unit', () => {
    const source: ManifestSource = {
      id: 'SRC-UNOWNED',
      kind: 'REMOTE_BRANCH',
      headSha: SOURCE_SHA,
      contentSha256: null,
      mainProof: null,
    };
    const selectorDocument = {
      kind: 'COMMIT_SET',
      commit_shas: [SOURCE_SHA],
    };
    const slice: SourceSlice = {
      id: 'SLICE-UNOWNED',
      sourceId: source.id,
      purpose: 'IMPLEMENTATION_CANDIDATE',
      authorityRole: 'PROVENANCE_ONLY',
      resolution: 'RESOLVED',
      selectorSha256: OTHER_DIGEST,
      computedSelectorSha256: computeSourceSliceSelectorSha256(selectorDocument),
      selector: { kind: 'COMMIT_SET', commitShas: [SOURCE_SHA] },
    };

    expect(
      issueCodes(
        manifest([unit('IU-NATIVE')], {
          sources: [source],
          sourceSlices: [slice],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'SOURCE_SLICE_SELECTOR_DIGEST_MISMATCH',
        'IMPLEMENTATION_SOURCE_SLICE_UNOWNED',
      ]),
    );
  });

  it('requires SLICE_BLOB_EQ to prove the entire path-aligned slice, not one shared blob', () => {
    const source: ManifestSource = {
      id: 'SRC-PATH-EQUALITY',
      kind: 'REMOTE_BRANCH',
      headSha: SOURCE_SHA,
      contentSha256: null,
      mainProof: null,
    };
    const slice = (entries: PathBlobSelectorEntry[]): SourceSlice => {
      const selectorDocument = {
        kind: 'PATH_BLOB_SET',
        entries: entries.map((entry) => ({
          lineage: entry.lineage,
          commit_sha: entry.commitSha,
          path: entry.path,
          blob_sha: entry.blobSha,
        })),
      };
      const selectorSha256 = computeSourceSliceSelectorSha256(selectorDocument);
      return {
        id: 'SLICE-PATH-EQUALITY',
        sourceId: source.id,
        purpose: 'MAIN_EQUIVALENCE',
        authorityRole: 'PROVENANCE_ONLY',
        resolution: 'RESOLVED',
        selectorSha256,
        computedSelectorSha256: selectorSha256,
        selector: { kind: 'PATH_BLOB_SET', entries },
      };
    };
    const owner = unit('IU-PATH-EQUALITY', {
      sourceSliceIds: ['SLICE-PATH-EQUALITY'],
      mainEvidence: [
        {
          kind: 'SLICE_BLOB_EQ',
          sourceSliceId: 'SLICE-PATH-EQUALITY',
        },
      ],
    });
    const incomplete = slice([
      {
        lineage: 'MAIN',
        commitSha: MAIN_PROOF_SHA,
        path: 'src/capability.ts',
        blobSha: SOURCE_BLOB_SHA,
      },
      {
        lineage: 'SOURCE',
        commitSha: SOURCE_SHA,
        path: 'src/capability.ts',
        blobSha: SOURCE_BLOB_SHA,
      },
      {
        lineage: 'SOURCE',
        commitSha: SOURCE_SHA,
        path: 'src/extra.ts',
        blobSha: OTHER_SHA,
      },
    ]);
    expect(
      issueCodes(
        manifest([owner], {
          sources: [source],
          sourceSlices: [incomplete],
        }),
      ),
    ).toContain('SLICE_BLOB_EQUIVALENCE_MISSING');

    const exact = slice([
      {
        lineage: 'MAIN',
        commitSha: MAIN_PROOF_SHA,
        path: 'src/capability.ts',
        blobSha: SOURCE_BLOB_SHA,
      },
      {
        lineage: 'MAIN',
        commitSha: MAIN_PROOF_SHA,
        path: 'src/extra.ts',
        blobSha: OTHER_SHA,
      },
      {
        lineage: 'SOURCE',
        commitSha: SOURCE_SHA,
        path: 'src/capability.ts',
        blobSha: SOURCE_BLOB_SHA,
      },
      {
        lineage: 'SOURCE',
        commitSha: SOURCE_SHA,
        path: 'src/extra.ts',
        blobSha: OTHER_SHA,
      },
    ]);
    expect(
      issueCodes(
        manifest([owner], {
          sources: [source],
          sourceSlices: [exact],
        }),
      ),
    ).not.toContain('SLICE_BLOB_EQUIVALENCE_MISSING');
  });

  it('binds WHOLE_TREE_PROOF to the exact attested source head', async () => {
    const source: ManifestSource = {
      id: 'SRC-WHOLE-TREE',
      kind: 'REMOTE_BRANCH',
      headSha: SOURCE_SHA,
      contentSha256: null,
      mainProof: null,
    };
    const selectorDocument = {
      kind: 'WHOLE_TREE_PROOF',
      source_commit_sha: STACK_SHA,
      source_tree_sha: SOURCE_TREE_SHA,
      main_commit_sha: MAIN_PROOF_SHA,
      main_tree_sha: MAIN_TREE_SHA,
    };
    const selectorSha256 = computeSourceSliceSelectorSha256(selectorDocument);
    const descendantSlice: SourceSlice = {
      id: 'SLICE-DESCENDANT',
      sourceId: source.id,
      purpose: 'MAIN_EQUIVALENCE',
      authorityRole: 'PROVENANCE_ONLY',
      resolution: 'RESOLVED',
      selectorSha256,
      computedSelectorSha256: selectorSha256,
      selector: {
        kind: 'WHOLE_TREE_PROOF',
        sourceCommitSha: STACK_SHA,
        sourceTreeSha: SOURCE_TREE_SHA,
        mainCommitSha: MAIN_PROOF_SHA,
        mainTreeSha: MAIN_TREE_SHA,
      },
    };
    const owner = unit('IU-WHOLE-TREE', {
      sourceSliceIds: [descendantSlice.id],
      mainEvidence: [
        {
          kind: 'SOURCE_MAIN_PROOF',
          sourceSliceId: descendantSlice.id,
          legacySourceId: null,
          legacyProofKind: null,
        },
      ],
    });
    const evidenceManifest = manifest([owner], {
      sources: [source],
      sourceSlices: [descendantSlice],
    });

    expect(issueCodes(evidenceManifest)).toContain('WHOLE_TREE_SOURCE_HEAD_MISMATCH');
    expect(
      (
        await validateIntegrationEvidenceLive(
          evidenceManifest,
          REQUIRED_STATUS,
          MAIN_SHA,
          liveGit(),
        )
      ).map((issue) => issue.code),
    ).toContain('SOURCE_SLICE_LIVE_PROOF_INVALID');
  });
});

describe('capability integration exact-head and live Git proof', () => {
  it('accepts exact required contexts bound to the status manifest and rejects invented checks', () => {
    const valid = verifiedUnit('IU-VALID');
    expect(issueCodes(manifest([valid]))).toEqual([]);

    const fabricated = verifiedUnit('IU-FABRICATED', {
      gateResults: [
        ...passingGateResults().filter((result) => result.gateId !== 'exact-head-actions-green'),
        exactHeadGateResult(['looks-green']),
      ],
    });
    expect(issueCodes(manifest([fabricated]))).toContain('REQUIRED_CHECK_CONTEXT_MISMATCH');
  });

  it('binds the immutable attempt to repository, PR, head, and current manifest digest', () => {
    const staleAttempt = executionAttempt({
      requiredStatusManifestSha256: OTHER_DIGEST,
    });
    const invalid = verifiedUnit('IU-STALE', {
      executionAttempt: staleAttempt,
    });
    const codes = issueCodes(manifest([invalid]));

    expect(codes).toEqual(
      expect.arrayContaining(['EXECUTION_ATTEMPT_ID_INVALID', 'REQUIRED_STATUS_DIGEST_MISMATCH']),
    );
  });

  it('fails closed when promoted evidence has no authenticated live GitHub reader', async () => {
    const issues = await validateIntegrationEvidenceLive(
      manifest([verifiedUnit('IU-NO-LIVE-TRUST')]),
      REQUIRED_STATUS,
      MAIN_SHA,
      liveGit(),
    );

    expect(issues.map((issue) => issue.code)).toContain('GITHUB_LIVE_AUTH_REQUIRED');
  });

  it('accepts promoted evidence only when PR, attempt, checks, runs, and artifacts match live API', async () => {
    const issues = await validateIntegrationEvidenceLive(
      manifest([verifiedUnit('IU-LIVE-TRUST')]),
      REQUIRED_STATUS,
      MAIN_SHA,
      liveGit(),
      liveTrustContext(),
    );

    expect(issues).toEqual([]);
  });

  it('rejects self-authored check JSON that disagrees with the authenticated check run', async () => {
    const github = new FixtureGitHub();
    const check = github.checkRuns.get(30_001);
    if (check === undefined) {
      throw new Error('fixture check is missing');
    }
    github.checkRuns.set(check.id, { ...check, headSha: OTHER_SHA });

    const issues = await validateIntegrationEvidenceLive(
      manifest([verifiedUnit('IU-FORGED-CHECK')]),
      REQUIRED_STATUS,
      MAIN_SHA,
      liveGit(),
      liveTrustContext(github),
    );

    expect(issues.map((issue) => issue.code)).toContain('GITHUB_CHECK_RUN_BINDING_INVALID');
  });

  it('rejects forged workflow attempt and artifact digest bindings from self-authored JSON', async () => {
    const github = new FixtureGitHub();
    const run = github.workflowRuns.get(WORKFLOW_RUN_ID);
    if (run === undefined) {
      throw new Error('fixture workflow run is missing');
    }
    github.workflowRuns.set(run.id, {
      ...run,
      runAttempt: WORKFLOW_RUN_ATTEMPT + 1,
    });
    github.artifact = {
      ...github.artifact,
      digestSha256: OTHER_DIGEST,
    };

    const codes = (
      await validateIntegrationEvidenceLive(
        manifest([verifiedUnit('IU-FORGED-ARTIFACT')]),
        REQUIRED_STATUS,
        MAIN_SHA,
        liveGit(),
        liveTrustContext(github),
      )
    ).map((issue) => issue.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'GITHUB_ATTEMPT_RUN_BINDING_INVALID',
        'GITHUB_CHECK_RUN_BINDING_INVALID',
        'GITHUB_ARTIFACT_RUN_BINDING_INVALID',
        'GITHUB_ARTIFACT_BINDING_INVALID',
      ]),
    );
  });

  it('requires an exact trusted GitHub OIDC/Sigstore verification result', async () => {
    let replaced = false;
    const sigstoreGateResults: GateResult[] = passingGateResults().map((result) => ({
      ...result,
      evidence: result.evidence.map((evidence) => {
        if (!replaced && evidence.kind === 'COMMAND_RESULT') {
          replaced = true;
          return { ...evidence, trust: sigstoreTrust(evidence.artifactSha256) };
        }
        return evidence;
      }),
    }));
    const evidenceManifest = manifest([
      verifiedUnit('IU-SIGSTORE', {
        gateResults: sigstoreGateResults,
      }),
    ]);
    const rejected = await validateIntegrationEvidenceLive(
      evidenceManifest,
      REQUIRED_STATUS,
      MAIN_SHA,
      liveGit(),
      {
        github: new FixtureGitHub(),
        sigstore: new FixtureSigstoreVerifier(false),
      },
    );
    expect(rejected.map((issue) => issue.code)).toContain('SIGSTORE_BUNDLE_VERIFICATION_INVALID');

    const accepted = await validateIntegrationEvidenceLive(
      evidenceManifest,
      REQUIRED_STATUS,
      MAIN_SHA,
      liveGit(),
      {
        github: new FixtureGitHub(),
        sigstore: new FixtureSigstoreVerifier(true),
      },
    );
    expect(accepted).toEqual([]);
  });

  it('live-validates commit, source proof, path/blob, and chained tree evidence', async () => {
    const sourceWithProof: ManifestSource = {
      id: 'SRC-PROOF',
      kind: 'REMOTE_BRANCH',
      headSha: SOURCE_SHA,
      contentSha256: null,
      mainProof: {
        kind: 'TREE_EQUIVALENT',
        sourceCommitSha: SOURCE_SHA,
        sourceTreeSha: SOURCE_TREE_SHA,
        mainCommitSha: MAIN_PROOF_SHA,
        mainTreeSha: MAIN_TREE_SHA,
      },
    };
    const pathSelectorDocument = {
      kind: 'PATH_BLOB_SET',
      entries: [
        {
          lineage: 'MAIN',
          commit_sha: MAIN_PROOF_SHA,
          path: 'src/capability.ts',
          blob_sha: SOURCE_BLOB_SHA,
        },
        {
          lineage: 'SOURCE',
          commit_sha: SOURCE_SHA,
          path: 'src/capability.ts',
          blob_sha: SOURCE_BLOB_SHA,
        },
      ],
    };
    const pathSelectorSha256 = computeSourceSliceSelectorSha256(pathSelectorDocument);
    const pathSlice: SourceSlice = {
      id: 'SLICE-PATH',
      sourceId: sourceWithProof.id,
      purpose: 'MAIN_EQUIVALENCE',
      authorityRole: 'PROVENANCE_ONLY',
      resolution: 'RESOLVED',
      selectorSha256: pathSelectorSha256,
      computedSelectorSha256: pathSelectorSha256,
      selector: {
        kind: 'PATH_BLOB_SET',
        entries: [
          {
            lineage: 'MAIN',
            commitSha: MAIN_PROOF_SHA,
            path: 'src/capability.ts',
            blobSha: SOURCE_BLOB_SHA,
          },
          {
            lineage: 'SOURCE',
            commitSha: SOURCE_SHA,
            path: 'src/capability.ts',
            blobSha: SOURCE_BLOB_SHA,
          },
        ],
      },
    };
    const proofSelectorDocument = {
      kind: 'WHOLE_TREE_PROOF',
      source_commit_sha: SOURCE_SHA,
      source_tree_sha: SOURCE_TREE_SHA,
      main_commit_sha: MAIN_PROOF_SHA,
      main_tree_sha: MAIN_TREE_SHA,
    };
    const proofSelectorSha256 = computeSourceSliceSelectorSha256(proofSelectorDocument);
    const proofSlice: SourceSlice = {
      id: 'SLICE-PROOF',
      sourceId: sourceWithProof.id,
      purpose: 'MAIN_EQUIVALENCE',
      authorityRole: 'PROVENANCE_ONLY',
      resolution: 'RESOLVED',
      selectorSha256: proofSelectorSha256,
      computedSelectorSha256: proofSelectorSha256,
      selector: {
        kind: 'WHOLE_TREE_PROOF',
        sourceCommitSha: SOURCE_SHA,
        sourceTreeSha: SOURCE_TREE_SHA,
        mainCommitSha: MAIN_PROOF_SHA,
        mainTreeSha: MAIN_TREE_SHA,
      },
    };
    const chainSelectorDocument = {
      kind: 'WHOLE_TREE_PROOF',
      source_commit_sha: SOURCE_SHA,
      source_tree_sha: SOURCE_TREE_SHA,
      main_commit_sha: MAIN_PROOF_SHA,
      main_tree_sha: MAIN_TREE_SHA,
    };
    const chainSelectorSha256 = computeSourceSliceSelectorSha256(chainSelectorDocument);
    const chainSlice: SourceSlice = {
      id: 'SLICE-CHAIN',
      sourceId: sourceWithProof.id,
      purpose: 'MAIN_EQUIVALENCE',
      authorityRole: 'PROVENANCE_ONLY',
      resolution: 'RESOLVED',
      selectorSha256: chainSelectorSha256,
      computedSelectorSha256: chainSelectorSha256,
      selector: {
        kind: 'WHOLE_TREE_PROOF',
        sourceCommitSha: SOURCE_SHA,
        sourceTreeSha: SOURCE_TREE_SHA,
        mainCommitSha: MAIN_PROOF_SHA,
        mainTreeSha: MAIN_TREE_SHA,
      },
    };
    const evidenceUnit = unit('IU-EVIDENCE', {
      sourceSliceIds: [chainSlice.id, pathSlice.id, proofSlice.id],
      mainEvidence: [
        { kind: 'MAIN_COMMIT', commitSha: MAIN_PROOF_SHA },
        {
          kind: 'SOURCE_MAIN_PROOF',
          sourceSliceId: proofSlice.id,
          legacySourceId: null,
          legacyProofKind: null,
        },
        { kind: 'SLICE_BLOB_EQ', sourceSliceId: pathSlice.id },
        {
          kind: 'CHAINED_TREE_EQUIVALENT',
          sourceSliceId: chainSlice.id,
          legacySourceId: null,
          legacyStackHeadSha: null,
          legacyStackTreeSha: null,
          legacyMainCommitSha: null,
          legacyMainTreeSha: null,
        },
      ],
      enhancedFieldPresence: {
        authorityTargets: false,
        sourceSliceIds: true,
        executionAttempt: false,
        externalBlocker: false,
        acceptanceRequirements: false,
        acceptanceEvidence: false,
        ownership: false,
        coClosureContract: false,
      },
    });
    const evidenceManifest = manifest([evidenceUnit], {
      sources: [sourceWithProof],
      sourceSlices: [chainSlice, pathSlice, proofSlice],
    });
    const git = liveGit();
    git.commitTrees.set(SOURCE_SHA, SOURCE_TREE_SHA);

    const issues = await validateIntegrationEvidenceLive(
      evidenceManifest,
      REQUIRED_STATUS,
      MAIN_SHA,
      git,
      liveTrustContext(),
    );
    expect(issues).toEqual([]);

    git.pathBlobs.set(`${SOURCE_SHA}:src/capability.ts`, OTHER_SHA);
    const invalidIssues = await validateIntegrationEvidenceLive(
      evidenceManifest,
      REQUIRED_STATUS,
      MAIN_SHA,
      git,
    );
    expect(invalidIssues.map((issue) => issue.code)).toContain('SOURCE_SLICE_LIVE_PROOF_INVALID');
  });

  it('requires a VERIFIED attempt head and merge commit to exist and remain main-reachable', async () => {
    const git = liveGit();
    git.ancestry.delete(`${HEAD_SHA}:${MAIN_SHA}`);
    const issues = await validateIntegrationEvidenceLive(
      manifest([verifiedUnit('IU-MERGE')]),
      REQUIRED_STATUS,
      MAIN_SHA,
      git,
      liveTrustContext(),
    );

    expect(issues.map((issue) => issue.code)).toContain('VERIFIED_MERGE_NOT_MAIN_REACHABLE');
  });
});

describe('capability-specific ledger acceptance', () => {
  function parityRequirement(): AcceptanceRequirement {
    return {
      id: 'ledger-parity',
      kind: 'TWO_PROTECTED_MAIN_PARITY_CYCLES',
      minimumCycles: 2,
      distinctProtectedMainShas: true,
    };
  }

  function parityEvidence(protectedMainSha: string): AcceptanceEvidence {
    return {
      requirementId: 'ledger-parity',
      kind: 'PROTECTED_MAIN_PARITY_CYCLE',
      headSha: HEAD_SHA,
      result: 'PASS',
      artifactUri: `artifact://parity/${protectedMainSha}`,
      artifactSha256: ARTIFACT_DIGEST,
      observedAt: NOW,
      trust: actionsTrust(),
      protectedMainSha,
      jsonlProjectionSha256: DIGEST,
      postgresProjectionSha256: DIGEST,
      commandLogSha256: ARTIFACT_DIGEST,
      zeroDiff: true,
      requiredChecksArtifactSha256: DIGEST,
    };
  }

  const SHADOW_BOUNDARY: AuthorityBoundary = {
    primaryAuthority: 'JSONL_PRIMARY',
    postgresRole: 'POSTGRES_SHADOW',
    postgresPrimaryPolicy: 'FORBIDDEN',
    productionCutover: false,
  };

  it('requires two retained cycles from distinct protected-main SHAs', () => {
    const ledger = verifiedUnit('IU-LEDGER-006', {
      acceptanceRequirements: [parityRequirement()],
      acceptanceEvidence: [parityEvidence(PROTECTED_MAIN_ONE), parityEvidence(PROTECTED_MAIN_TWO)],
      authorityBoundary: SHADOW_BOUNDARY,
    });
    expect(issueCodes(manifest([ledger]))).toEqual([]);

    const duplicateCycle = verifiedUnit('IU-LEDGER-006', {
      acceptanceRequirements: [parityRequirement()],
      acceptanceEvidence: [parityEvidence(PROTECTED_MAIN_ONE), parityEvidence(PROTECTED_MAIN_ONE)],
      authorityBoundary: SHADOW_BOUNDARY,
    });
    expect(issueCodes(manifest([duplicateCycle]))).toContain('LEDGER_PARITY_CYCLES_INCOMPLETE');
  });

  it('requires encrypted restore, parity, pre-production cutover, rollback, and no production cutover', () => {
    const requirement: AcceptanceRequirement = {
      id: 'ledger-cutover',
      kind: 'LEDGER_PREPRODUCTION_CUTOVER_ROLLBACK',
      environment: 'PRE_PRODUCTION_ONLY',
      productionCutover: 'FORBIDDEN',
      requiredEvidenceKinds: [
        'ENCRYPTED_RESTORE',
        'SHADOW_PARITY',
        'PRE_PRODUCTION_CUTOVER',
        'ROLLBACK',
      ],
    };
    const common = {
      requirementId: requirement.id,
      headSha: HEAD_SHA,
      result: 'PASS' as const,
      artifactUri: 'artifact://ledger/preproduction',
      artifactSha256: ARTIFACT_DIGEST,
      observedAt: NOW,
      trust: actionsTrust(),
    };
    const evidence: AcceptanceEvidence[] = [
      {
        ...common,
        kind: 'ENCRYPTED_RESTORE',
        ciphertextSha256: DIGEST,
        restoreLogSha256: ARTIFACT_DIGEST,
        schemaCheckSha256: DIGEST,
        rowCountCheckSha256: OTHER_DIGEST,
        isolatedRunner: true,
      },
      {
        ...common,
        kind: 'SHADOW_PARITY',
        protectedMainSha: PROTECTED_MAIN_ONE,
        jsonlProjectionSha256: DIGEST,
        postgresProjectionSha256: DIGEST,
        zeroDiff: true,
      },
      {
        ...common,
        kind: 'PRE_PRODUCTION_CUTOVER',
        environment: 'PRE_PRODUCTION',
        productionMutation: false,
        selectorBefore: 'JSONL_PRIMARY',
        selectorDuring: 'POSTGRES_PRIMARY',
      },
      {
        ...common,
        kind: 'ROLLBACK',
        environment: 'PRE_PRODUCTION',
        productionMutation: false,
        restoredAuthority: 'JSONL_PRIMARY',
      },
    ];
    const ledger = verifiedUnit('IU-LEDGER-007', {
      acceptanceRequirements: [requirement],
      acceptanceEvidence: evidence,
      authorityBoundary: {
        ...SHADOW_BOUNDARY,
        postgresPrimaryPolicy: 'PRE_PRODUCTION_ONLY',
      },
    });
    expect(issueCodes(manifest([ledger]))).toEqual([]);

    const unsafe = verifiedUnit('IU-LEDGER-007', {
      acceptanceRequirements: [requirement],
      acceptanceEvidence: evidence.slice(0, -1),
      authorityBoundary: {
        ...SHADOW_BOUNDARY,
        postgresPrimaryPolicy: 'PRE_PRODUCTION_ONLY',
        productionCutover: true,
      },
    });
    expect(issueCodes(manifest([unsafe]))).toEqual(
      expect.arrayContaining([
        'LEDGER_CUTOVER_BOUNDARY_INVALID',
        'LEDGER_CUTOVER_EVIDENCE_INCOMPLETE',
      ]),
    );
  });
});

describe('manifest parsing and main pinning', () => {
  it('parses the required status identity and content digest from exact bytes', () => {
    const raw = JSON.stringify({
      repository: REPOSITORY,
      required_status_checks: { contexts: ['merge-gate'] },
    });
    const contract = parseRequiredStatusContract(raw);

    expect(contract.repository).toBe(REPOSITORY);
    expect(contract.contexts).toEqual(['merge-gate']);
    expect(contract.digestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses ASSESSING units without promoted-state evidence fields', () => {
    const parsed = parseIntegrationEvidenceManifest({
      required_status_checks_manifest: '.github/manifests/main-required-status-checks.json',
      capability_reconciliation: {
        integration_order: ['IU-001'],
        integration_units: [
          {
            id: 'IU-001',
            state: 'ASSESSING',
            source_ids: [],
            derived_from: [],
            depends_on: [],
            finding_binding: { status: 'NOT_REQUIRED', finding_ids: [] },
            main_evidence: [],
            gate_profile: 'ATOMIC_PR_V1',
            gate_results: [],
          },
        ],
        sources: [],
        gate_profiles: {
          ATOMIC_PR_V1: {
            required_gate_ids: REQUIRED_GATE_IDS,
            evidence_contracts: {
              'duplicate-authority-absent': 'COMMAND_RESULT',
              'root-cause-closed': 'FINDING_STATE',
              'focused-tests-green': 'COMMAND_RESULT',
              'affected-test-lint-build-green': 'COMMAND_RESULT',
              'exact-head-actions-green': 'GITHUB_CHECK',
            },
          },
        },
      },
    });

    expect(parsed.units[0]?.executionAttempt).toBeNull();
    expect(parsed.units[0]?.enhancedFieldPresence.executionAttempt).toBe(false);
  });

  it('refuses promoted command evidence that omits a trusted artifact or Sigstore binding', () => {
    const identity = {
      repository: REPOSITORY,
      pullRequestNumber: 42,
      headSha: HEAD_SHA,
      requiredStatusManifestSha256: DIGEST,
      workflowRunId: WORKFLOW_RUN_ID,
      workflowRunAttempt: WORKFLOW_RUN_ATTEMPT,
    };

    expect(() =>
      parseIntegrationEvidenceManifest({
        required_status_checks_manifest: '.github/manifests/main-required-status-checks.json',
        capability_reconciliation: {
          integration_order: ['IU-UNTRUSTED'],
          integration_units: [
            {
              id: 'IU-UNTRUSTED',
              state: 'INTEGRATING',
              depends_on: [],
              authority_targets: [],
              source_slice_ids: [],
              execution_attempt: {
                attempt_id: computeExecutionAttemptId(identity),
                repository: identity.repository,
                pull_request_number: identity.pullRequestNumber,
                head_sha: identity.headSha,
                required_status_manifest_sha256: identity.requiredStatusManifestSha256,
                workflow_run_id: identity.workflowRunId,
                workflow_run_attempt: identity.workflowRunAttempt,
                started_at: NOW,
                merge_evidence: null,
              },
              external_blocker: null,
              acceptance_requirements: [],
              acceptance_evidence: [],
              ownership: {
                accountable_registry_owner: null,
                execution_owner: 'architectural-arbiter',
                mandatory_reviewers: [],
              },
              co_closure_contract: null,
              finding_binding: { status: 'NOT_REQUIRED', finding_ids: [] },
              main_evidence: [],
              gate_profile: 'ATOMIC_PR_V1',
              gate_results: [
                {
                  gate_id: 'focused-tests-green',
                  status: 'PASS',
                  head_sha: HEAD_SHA,
                  evidence: [
                    {
                      kind: 'COMMAND_RESULT',
                      head_sha: HEAD_SHA,
                      command: 'npm test -- focused',
                      exit_code: 0,
                      artifact_sha256: ARTIFACT_DIGEST,
                      completed_at: NOW,
                    },
                  ],
                },
              ],
              authority_boundary: null,
            },
          ],
          sources: [],
          source_slices: [],
          gate_profiles: {
            ATOMIC_PR_V1: {
              required_gate_ids: ['focused-tests-green'],
              evidence_contracts: {
                'focused-tests-green': 'COMMAND_RESULT',
              },
            },
          },
        },
      }),
    ).toThrow(/evidence\[0\]\.trust must be an object/);
  });

  it('parses a content-addressed provenance-only selector referenced through source_slice_ids', () => {
    const selector = {
      kind: 'COMMIT_SET',
      commit_shas: [SOURCE_SHA],
    };
    const selectorSha256 = computeSourceSliceSelectorSha256(selector);
    const parsed = parseIntegrationEvidenceManifest({
      required_status_checks_manifest: '.github/manifests/main-required-status-checks.json',
      capability_reconciliation: {
        integration_order: ['IU-001'],
        integration_units: [
          {
            id: 'IU-001',
            state: 'ASSESSING',
            source_slice_ids: ['SLICE-001'],
            depends_on: [],
            finding_binding: { status: 'NOT_REQUIRED', finding_ids: [] },
            main_evidence: [],
            gate_profile: 'ATOMIC_PR_V1',
            gate_results: [],
          },
        ],
        sources: [
          {
            id: 'SRC-001',
            kind: 'REMOTE_BRANCH',
            head_sha: SOURCE_SHA,
          },
        ],
        source_slices: [
          {
            id: 'SLICE-001',
            source_id: 'SRC-001',
            purpose: 'IMPLEMENTATION_CANDIDATE',
            authority_role: 'PROVENANCE_ONLY',
            resolution: 'RESOLVED',
            selector,
            selector_sha256: selectorSha256,
          },
        ],
        gate_profiles: {
          ATOMIC_PR_V1: {
            required_gate_ids: REQUIRED_GATE_IDS,
            evidence_contracts: {
              'duplicate-authority-absent': 'COMMAND_RESULT',
              'root-cause-closed': 'FINDING_STATE',
              'focused-tests-green': 'COMMAND_RESULT',
              'affected-test-lint-build-green': 'COMMAND_RESULT',
              'exact-head-actions-green': 'GITHUB_CHECK',
            },
          },
        },
      },
    });

    expect(parsed.units[0]?.sourceSliceIds).toEqual(['SLICE-001']);
    expect(parsed.sourceSlices[0]?.selectorSha256).toBe(selectorSha256);
    expect(validateIntegrationEvidenceStatic(parsed, REQUIRED_STATUS)).toEqual([]);
  });

  it('fails when origin/main changes during the validation snapshot', () => {
    expect(assertOriginMainStable(MAIN_SHA, OTHER_SHA)).toEqual([
      expect.objectContaining({ code: 'ORIGIN_MAIN_MOVED' }),
    ]);
    expect(assertOriginMainStable(MAIN_SHA, MAIN_SHA)).toEqual([]);
  });
});
