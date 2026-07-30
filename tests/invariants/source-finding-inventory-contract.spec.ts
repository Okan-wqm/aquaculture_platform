import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import yaml from 'js-yaml';

import { parseFindingRegistrySchemaContract } from '../../tools/gates/lib/finding-registry-schema-contract';
import {
  assertCanonicalRebindsRetiredByRemoteDiscovery,
  assertDiscoveryCandidateStable,
  assertExecutionSafety,
  assertFindingInventoryClosedSchema,
  assertFormattedManifestSemantics,
  assertGitHubMainTransition,
  assertLegacyFindingRefsResolvable,
  assertLiveMainCompatible,
  assertOccurrenceAssignments,
  assertPendingAdjudicationStates,
  assertPrettierVersionAuthority,
  assertRefreshAssignmentTransition,
  assertStoredFindingInventoryIntegrity,
  deriveReservedDomainFloors,
  extractAddedReviewEvidence,
  extractRawFindingIds,
  formatSourceFindingManifest,
  lockedPrettierVersion,
  materializeOccurrences,
  occurrenceId,
  parseCliOptions,
  parseSourceFindingPrettierConfig,
  registryRecordChanged,
  semanticRegistryValue,
  sourceAttestationsForRefresh,
  sourceRefDigest,
  type DiscoveredFinding,
  type FullExecutionSafetyEvidence,
  type GitHubMainTransitionEvidence,
  type IntegrationUnit,
  type SourceAdjudication,
  type SourceAttestation,
} from '../../tools/gates/source-finding-inventory';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PLAN_DIRECTORY = resolve(REPO_ROOT, 'docs/plans/2026-06-18-enterprise-grade-debt-closure');
const MANIFEST_PATH = resolve(PLAN_DIRECTORY, 'manifest.json');
const PACKAGE_PATH = resolve(REPO_ROOT, 'package.json');
const PACKAGE_LOCK_PATH = resolve(REPO_ROOT, 'package-lock.json');
const CI_FULL_PATH = resolve(REPO_ROOT, '.github/workflows/ci-full.yml');
const EXPECTED_OCCURRENCE_COUNT = 964;
const EXPECTED_OCCURRENCE_DIGEST =
  'dd4c57f30de688a6c640862b8c1e50ddd44226f8adbe033d5a8a9dd773054cd2';
const PRELIMINARY_OCCURRENCE_DIGEST =
  '3426306d2cd36f6b74f84303030777de1c81613c4e554c8b75888448501676ac';
const INTERMEDIATE_OCCURRENCE_DIGEST =
  '8631e019aefbfe44e57c8a812a87923758ee99f5de5af4b642f927670e2e494a';
const INVALID_LEGACY_REFS = new Set([
  'SRC-R-002#ADMIN-CRITICAL-001',
  'SRC-R-002#ADMIN-CRITICAL-002',
  'SRC-R-002#ADMIN-CRITICAL-003',
  'SRC-R-002#ADMIN-CRITICAL-004',
  'SRC-R-002#ADMIN-HIGH-001',
  'SRC-R-004#ORPHAN-CRITICAL-420',
  'SRC-R-008#FARM-HIGH-306',
  'SRC-R-019#EDGE-CRITICAL-001',
  'SRC-R-022#INFRA-HIGH-099',
  'SRC-W-033#BILLING-HIGH-005',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function objectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${field} must be an object array`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value as number;
}

function readJsonRecord(path: string): Record<string, unknown> {
  return recordValue(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

const ARTIFACT_PATH = resolve(
  REPO_ROOT,
  stringValue(
    recordValue(
      recordValue(
        readJsonRecord(MANIFEST_PATH).capability_reconciliation,
        'capability_reconciliation',
      ).finding_inventory,
      'finding_inventory',
    ).artifact_path,
    'finding_inventory.artifact_path',
  ),
);

function readArtifact(): Record<string, unknown>[] {
  return readFileSync(ARTIFACT_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) =>
      recordValue(JSON.parse(line) as unknown, `${basename(ARTIFACT_PATH)}:${index + 1}`),
    );
}

function fixtureUnit(
  id: string,
  legacyFindingRefs: string[] = [],
  findingBindingStatus: string = 'CREATE_REQUIRED',
  findingIds: string[] = [],
  canonicalPromotion: IntegrationUnit['canonicalPromotion'] = null,
): IntegrationUnit {
  return {
    id,
    state: 'ASSESSING',
    executionOwner: 'context-manager',
    findingBindingStatus,
    findingIds,
    legacyFindingRefs,
    canonicalPromotion,
  };
}

function fixtureSourceAdjudication(
  sourceId: string,
  status: string = 'ASSESSING',
): SourceAdjudication {
  return {
    id: `SA-${sourceId}`,
    sourceId,
    status,
    executionOwner: 'context-manager',
    deadline: '2026-08-01',
    plan: `Adjudicate ${sourceId}.`,
  };
}

function fixtureSourceAttestation(
  sourceId: string,
  sourceKind: SourceAttestation['source_kind'] = 'REMOTE_BRANCH',
): SourceAttestation {
  return {
    source_id: sourceId,
    source_kind: sourceKind,
    source_head_sha: 'a'.repeat(40),
    source_content_sha256: sourceKind === 'DIRTY_WORKTREE' ? 'b'.repeat(64) : null,
    merge_base_sha: 'c'.repeat(40),
    source_adjudication_id: `SA-${sourceId}`,
    occurrence_count: 0,
    untargeted_occurrence_count: 0,
    registry_backed_count: 0,
    registry_reference_count: 0,
    review_only_count: 0,
    collision_count: 0,
    occurrence_sha256: createHash('sha256').update('').digest('hex'),
  };
}

function fixtureRefreshSource(
  id: string,
  kind: SourceAttestation['source_kind'] = 'REMOTE_BRANCH',
): {
  id: string;
  kind: SourceAttestation['source_kind'];
  headSha: string;
  contentSha256: string | null;
} {
  return {
    id,
    kind,
    headSha: 'a'.repeat(40),
    contentSha256: kind === 'DIRTY_WORKTREE' ? 'b'.repeat(64) : null,
  };
}

function fixtureFinding(
  sourceRef: string,
  evidenceKind: 'REGISTRY_RECORD' | 'REVIEW_MENTION',
): DiscoveredFinding {
  const separator = sourceRef.indexOf('#');
  return {
    sourceId: sourceRef.slice(0, separator),
    sourceRef,
    rawId: sourceRef.slice(separator + 1),
    evidenceKind,
    evidencePaths:
      evidenceKind === 'REGISTRY_RECORD'
        ? ['docs/reviews/_registry/findings.jsonl']
        : ['docs/reviews/example.md'],
    evidenceSha256: 'a'.repeat(64),
    semanticSha256: 'b'.repeat(64),
    classification:
      evidenceKind === 'REGISTRY_RECORD' ? 'LEGACY_UNREGISTERED' : 'PENDING_ADJUDICATION',
    mainRecordSha256: null,
  };
}

const ISOLATED_EXECUTION_EVIDENCE: FullExecutionSafetyEvidence = {
  executionClass: 'isolated-evidence-runner',
  githubActions: 'true',
  githubEventName: 'workflow_dispatch',
  githubRepository: 'Okan-wqm/aquaculture_platform',
  runnerEnvironment: 'github-hosted',
  cgroupVersion: 2,
  cgroupPath: '/actions_job/123',
  memoryMax: String(4 * 1024 * 1024 * 1024),
  memorySwapMax: '0',
  cpuMax: '200000 100000',
  cpuWeight: '100',
  exclusiveCpus: '2-3',
  cpusetPartition: 'isolated',
  pidsMax: '512',
};

const BOUNDED_HOST_EXECUTION_EVIDENCE: FullExecutionSafetyEvidence = {
  executionClass: 'bounded-production-evidence',
  githubActions: undefined,
  githubEventName: undefined,
  githubRepository: undefined,
  runnerEnvironment: undefined,
  cgroupVersion: 2,
  cgroupPath: '/system.slice/aqua-source-finding-inventory-test.service',
  memoryMax: String(1024 * 1024 * 1024),
  memorySwapMax: '0',
  cpuMax: '25000 100000',
  cpuWeight: '1',
  exclusiveCpus: '',
  cpusetPartition: 'member',
  pidsMax: '128',
};

function githubTransitionFixture(
  overrides: Partial<GitHubMainTransitionEvidence> = {},
): GitHubMainTransitionEvidence {
  return {
    githubActions: 'true',
    eventName: 'pull_request',
    githubRef: 'refs/pull/42/merge',
    githubBaseRef: 'main',
    githubSha: 'c'.repeat(40),
    pullRequestBaseSha: 'b'.repeat(40),
    pushBeforeSha: '',
    pushAfterSha: '',
    checkoutSha: 'c'.repeat(40),
    headSha: 'c'.repeat(40),
    originMainSha: 'd'.repeat(40),
    reconciledBaseSha: 'a'.repeat(40),
    reconciledRegistryBlobSha: 'e'.repeat(40),
    discoveryRegistryBlobSha: 'e'.repeat(40),
    reconciledRegistrySchemaBlobSha: '6'.repeat(40),
    discoveryRegistrySchemaBlobSha: '6'.repeat(40),
    ...overrides,
  };
}

describe('source finding inventory pure contract', () => {
  it('fails closed when the schema ID authority is not a bounded token grammar', () => {
    expect(() =>
      parseFindingRegistrySchemaContract({
        'x-source-finding-semantic-fields': ['id'],
        properties: {
          id: {
            oneOf: [{ pattern: '^(EDGE)-(HIGH|.*)-[0-9]{3}$' }],
          },
        },
      }),
    ).toThrow(/uppercase token alternation/);
  });

  it('rejects duplicate or unknown authority fields instead of projecting them away', () => {
    const manifest = readJsonRecord(MANIFEST_PATH);
    const reconciliation = recordValue(
      manifest.capability_reconciliation,
      'capability_reconciliation',
    );
    const inventory = recordValue(reconciliation.finding_inventory, 'finding_inventory');
    expect(() =>
      assertFindingInventoryClosedSchema({
        ...inventory,
        main_registry: { blob_sha: 'f'.repeat(40) },
      }),
    ).toThrow(/extra=main_registry/);

    const authority = recordValue(inventory.registry_authority, 'registry_authority');
    expect(() =>
      assertFindingInventoryClosedSchema({
        ...inventory,
        registry_authority: {
          ...authority,
          discovery_blob_sha: 'f'.repeat(40),
        },
      }),
    ).toThrow(/extra=discovery_blob_sha/);
  });

  it('preserves source-local raw IDs, including noncanonical suffixes', () => {
    expect(
      extractRawFindingIds(
        'EDGE-CRITICAL-001-R1, DATA-HIGH-010, RUST-CVE-002, FARM-DATAMIG-001, and HIGH-057',
      ),
    ).toEqual([
      'EDGE-CRITICAL-001-R1',
      'DATA-HIGH-010',
      'RUST-CVE-002',
      'FARM-DATAMIG-001',
      'HIGH-057',
    ]);
  });

  it('parses review additions by hunk counts so header-shaped content cannot hide evidence', () => {
    const findings = extractAddedReviewEvidence(
      [
        'diff --git a/docs/reviews/example.md b/docs/reviews/example.md',
        '--- a/docs/reviews/example.md',
        '+++ b/docs/reviews/example.md',
        '@@ -0,0 +1,3 @@',
        '+++ /dev/null',
        '+++ b/docs/reviews/_registry/findings.jsonl',
        '+EDGE-HIGH-091',
      ].join('\n'),
      'docs/reviews/example.md',
    );

    expect([...findings.keys()]).toEqual(['EDGE-HIGH-091']);
    expect(findings.get('EDGE-HIGH-091')?.paths).toEqual(new Set(['docs/reviews/example.md']));
    expect(() =>
      extractAddedReviewEvidence(
        ['@@ -0,0 +1,2 @@', '+EDGE-HIGH-091'].join('\n'),
        'docs/reviews/example.md',
      ),
    ).toThrow(/ended before its declared hunk completed/);
  });

  it('does not turn immutable-ledger re-chaining into a semantic finding delta', () => {
    const baseline = {
      id: 'INFRA-HIGH-001',
      severity: 'HIGH',
      state: 'OPEN',
      title: 'Stable finding',
      layer: 2,
      evidence: ['path:1'],
      rule_violated: 'One authority',
      narrative: ['Stable capability context.'],
      owner_agent: 'context-manager',
      review_file: 'docs/reviews/source.md',
      created_at: '2026-07-01T00:00:00Z',
      prev_hash: '1'.repeat(64),
      content_hash: '2'.repeat(64),
    };
    const rechained = {
      ...baseline,
      state: 'RESOLVED',
      owner_agent: 'data-expert',
      review_file: 'docs/reviews/closure.md',
      created_at: '2026-07-02T00:00:00Z',
      closed_at: '2026-07-03T00:00:00Z',
      closing_commits: ['abc123'],
      deadline: '2026-08-01',
      prev_hash: '3'.repeat(64),
      content_hash: '4'.repeat(64),
    };
    const semanticChange = { ...rechained, narrative: ['Different capability context.'] };

    expect(registryRecordChanged(baseline, rechained)).toBe(false);
    expect(registryRecordChanged(baseline, semanticChange)).toBe(true);
    expect(Object.keys(semanticRegistryValue(rechained)).sort()).toEqual(
      ['evidence', 'id', 'layer', 'narrative', 'rule_violated', 'severity', 'title'].sort(),
    );
  });

  it('separates source adjudication from evidence-backed capability targeting', () => {
    const sourceAdjudication = fixtureSourceAdjudication('SRC-R-001');
    const targetUnit = fixtureUnit('IU-TARGET', ['SRC-R-001#ADMIN-HIGH-091']);
    const occurrences = materializeOccurrences(
      [
        fixtureFinding('SRC-R-001#ADMIN-HIGH-090', 'REGISTRY_RECORD'),
        fixtureFinding('SRC-R-001#ADMIN-HIGH-091', 'REGISTRY_RECORD'),
      ],
      [sourceAdjudication],
      [targetUnit],
    );

    expect(occurrences[0]?.adjudication).toMatchObject({
      status: 'PENDING',
      source_adjudication_id: 'SA-SRC-R-001',
      target_integration_unit_id: null,
    });
    expect(occurrences[1]?.adjudication.target_integration_unit_id).toBe('IU-TARGET');
    expect(occurrences[0]?.occurrence_id).toBe(occurrenceId('SRC-R-001#ADMIN-HIGH-090'));
  });

  it('requires collision allocation before a capability target can be claimed', () => {
    const sourceRef = 'SRC-R-001#ADMIN-HIGH-091';
    const collision: DiscoveredFinding = {
      ...fixtureFinding(sourceRef, 'REGISTRY_RECORD'),
      classification: 'ID_COLLISION',
      mainRecordSha256: 'c'.repeat(64),
    };
    expect(() =>
      materializeOccurrences(
        [collision],
        [fixtureSourceAdjudication('SRC-R-001')],
        [fixtureUnit('IU-TARGET', [sourceRef])],
      ),
    ).toThrow(/unresolved ID collision/);
  });

  it('fails closed instead of pruning a provenance binding that discovery cannot resolve', () => {
    expect(() =>
      assertLegacyFindingRefsResolvable(
        [fixtureUnit('IU-TARGET', ['SRC-R-001#ADMIN-HIGH-091'])],
        new Set(),
      ),
    ).toThrow(/cannot be pruned automatically/);
    expect(() =>
      assertLegacyFindingRefsResolvable(
        [fixtureUnit('IU-TARGET', ['SRC-R-001#ADMIN-HIGH-091'])],
        new Set(['SRC-R-001#ADMIN-HIGH-091']),
      ),
    ).not.toThrow();
  });

  it('allows host-safe refresh to attest a newly declared remote source', () => {
    const prior = fixtureSourceAttestation('SRC-R-001');
    expect(
      sourceAttestationsForRefresh(
        [prior],
        [fixtureRefreshSource('SRC-R-001'), fixtureRefreshSource('SRC-R-002')],
      ),
    ).toEqual(new Map([['SRC-R-001', prior]]));
  });

  it('rejects source removal and undiscoverable host-source additions during refresh', () => {
    const prior = fixtureSourceAttestation('SRC-R-001');
    expect(() =>
      sourceAttestationsForRefresh([prior], [fixtureRefreshSource('SRC-R-002')]),
    ).toThrow(/removed=SRC-R-001/);
    expect(() =>
      sourceAttestationsForRefresh(
        [prior],
        [fixtureRefreshSource('SRC-R-001'), fixtureRefreshSource('SRC-W-001', 'DIRTY_WORKTREE')],
      ),
    ).toThrow(/new_non_remote=SRC-W-001/);
  });

  it('rejects both directions of source-kind replacement during host-safe refresh', () => {
    expect(() =>
      sourceAttestationsForRefresh(
        [fixtureSourceAttestation('SRC-W-001', 'DIRTY_WORKTREE')],
        [fixtureRefreshSource('SRC-W-001', 'REMOTE_BRANCH')],
      ),
    ).toThrow(/kind_changed=SRC-W-001/);
    expect(() =>
      sourceAttestationsForRefresh(
        [fixtureSourceAttestation('SRC-R-001', 'REMOTE_BRANCH')],
        [fixtureRefreshSource('SRC-R-001', 'LOCAL_BRANCH')],
      ),
    ).toThrow(/kind_changed=SRC-R-001/);
  });

  it('rejects retained local or dirty source pin mutation during host-safe refresh', () => {
    const local = fixtureRefreshSource('SRC-L-001', 'LOCAL_BRANCH');
    const dirty = fixtureRefreshSource('SRC-W-001', 'DIRTY_WORKTREE');
    expect(() =>
      sourceAttestationsForRefresh(
        [fixtureSourceAttestation(local.id, local.kind)],
        [{ ...local, headSha: 'd'.repeat(40) }],
      ),
    ).toThrow(/host_pin_changed=SRC-L-001/);
    expect(() =>
      sourceAttestationsForRefresh(
        [fixtureSourceAttestation(dirty.id, dirty.kind)],
        [{ ...dirty, contentSha256: 'e'.repeat(64) }],
      ),
    ).toThrow(/host_pin_changed=SRC-W-001/);
  });

  it('allows only an exact semantic legacy-to-canonical refresh transition', () => {
    const sourceRef = 'SRC-R-001#ADMIN-HIGH-091';
    const priorOccurrence = materializeOccurrences(
      [fixtureFinding(sourceRef, 'REGISTRY_RECORD')],
      [fixtureSourceAdjudication('SRC-R-001')],
      [fixtureUnit('IU-TARGET', [sourceRef])],
    );
    const transitionContext = {
      priorArtifactSha256: 'a'.repeat(64),
      priorSourceHeadShaById: new Map([['SRC-R-001', 'd'.repeat(40)]]),
      candidateRegistryBlobSha: 'e'.repeat(40),
    };
    const promotion = {
      schemaVersion: 1 as const,
      priorArtifactSha256: transitionContext.priorArtifactSha256,
      priorOccurrenceId: priorOccurrence[0]!.occurrence_id,
      priorSourceHeadSha: 'd'.repeat(40),
      sourceRef,
      integrationUnitId: 'IU-TARGET',
      canonicalFindingId: 'ADMIN-HIGH-091',
      candidateRegistryBlobSha: transitionContext.candidateRegistryBlobSha,
      semanticSha256: 'b'.repeat(64),
      recordedAt: '2026-07-30T09:32:43Z',
      recordedBy: 'context-manager',
    };
    const reboundUnits = [fixtureUnit('IU-TARGET', [], 'BOUND', ['ADMIN-HIGH-091'], promotion)];
    const canonicalEvidence = new Map([
      [
        'ADMIN-HIGH-091',
        {
          semanticSha256: 'b'.repeat(64),
          state: 'OPEN',
        },
      ],
    ]);

    expect(() => assertOccurrenceAssignments(priorOccurrence, reboundUnits)).toThrow(
      /without an evidence-backed legacy ref/,
    );
    expect(
      assertRefreshAssignmentTransition(
        priorOccurrence,
        reboundUnits,
        canonicalEvidence,
        transitionContext,
      ),
    ).toEqual([sourceRef]);
    expect(() =>
      assertRefreshAssignmentTransition(
        priorOccurrence,
        reboundUnits,
        new Map(),
        transitionContext,
      ),
    ).toThrow(/without an exact canonical semantic rebind/);
    expect(() =>
      assertRefreshAssignmentTransition(
        priorOccurrence,
        [fixtureUnit('IU-TARGET', [], 'BOUND', ['ADMIN-HIGH-092'])],
        canonicalEvidence,
        transitionContext,
      ),
    ).toThrow(/without an exact canonical semantic rebind/);
    expect(() =>
      assertRefreshAssignmentTransition(
        [
          {
            ...priorOccurrence[0]!,
            classification: 'ID_COLLISION',
            main_record_sha256: 'c'.repeat(64),
          },
        ],
        reboundUnits,
        canonicalEvidence,
        transitionContext,
      ),
    ).toThrow(/without an exact canonical semantic rebind/);
    expect(() =>
      assertRefreshAssignmentTransition(
        priorOccurrence,
        reboundUnits,
        new Map([
          [
            'ADMIN-HIGH-091',
            {
              semanticSha256: 'b'.repeat(64),
              state: 'RESOLVED',
            },
          ],
        ]),
        transitionContext,
      ),
    ).toThrow(/without an exact canonical semantic rebind/);
    expect(() =>
      assertRefreshAssignmentTransition(
        priorOccurrence,
        [
          fixtureUnit('IU-TARGET', [], 'BOUND', ['ADMIN-HIGH-091'], {
            ...promotion,
            priorArtifactSha256: 'f'.repeat(64),
          }),
        ],
        canonicalEvidence,
        transitionContext,
      ),
    ).toThrow(/without an exact canonical semantic rebind/);
    expect(() =>
      assertCanonicalRebindsRetiredByRemoteDiscovery([sourceRef], [], new Set(['SRC-R-001'])),
    ).not.toThrow();
    expect(() =>
      assertCanonicalRebindsRetiredByRemoteDiscovery(
        [sourceRef],
        priorOccurrence,
        new Set(['SRC-R-001']),
      ),
    ).toThrow(/remains in remote discovery/);
    expect(() =>
      assertCanonicalRebindsRetiredByRemoteDiscovery([sourceRef], [], new Set()),
    ).toThrow(/requires isolated full regeneration/);
  });

  it('blocks only the source queue and an evidence-backed target while pending', () => {
    const sourceAdjudication = fixtureSourceAdjudication('SRC-R-001');
    const targetUnit = fixtureUnit('IU-TARGET', ['SRC-R-001#ADMIN-HIGH-091']);
    const unrelatedUnit = { ...fixtureUnit('IU-UNRELATED'), state: 'VERIFIED' };
    const occurrences = materializeOccurrences(
      [fixtureFinding('SRC-R-001#ADMIN-HIGH-091', 'REGISTRY_RECORD')],
      [sourceAdjudication],
      [targetUnit, unrelatedUnit],
    );

    expect(() =>
      assertPendingAdjudicationStates(
        occurrences,
        [sourceAdjudication],
        [targetUnit, unrelatedUnit],
      ),
    ).not.toThrow();
    expect(() =>
      assertPendingAdjudicationStates(
        occurrences,
        [{ ...sourceAdjudication, status: 'READY' }],
        [targetUnit, unrelatedUnit],
      ),
    ).toThrow(/cannot be READY/);
    expect(() =>
      assertPendingAdjudicationStates(
        occurrences,
        [sourceAdjudication],
        [{ id: targetUnit.id, state: 'INTEGRATING' }, unrelatedUnit],
      ),
    ).toThrow(/cannot be INTEGRATING/);
  });

  it('requires a fresh-main candidate while allowing main to advance from reconciliation', () => {
    expect(() =>
      assertLiveMainCompatible(
        {
          commitSha: 'b'.repeat(40),
          registryBlobSha: 'c'.repeat(40),
          registrySchemaBlobSha: 'd'.repeat(40),
        },
        'a'.repeat(40),
        'c'.repeat(40),
        (ancestor, descendant) => ['ab', 'bc', 'ac'].includes(`${ancestor[0]}${descendant[0]}`),
      ),
    ).not.toThrow();
    expect(() =>
      assertLiveMainCompatible(
        {
          commitSha: 'b'.repeat(40),
          registryBlobSha: 'c'.repeat(40),
          registrySchemaBlobSha: 'd'.repeat(40),
        },
        'a'.repeat(40),
        'c'.repeat(40),
        () => false,
      ),
    ).toThrow(/must be an ancestor of live origin\/main/);
    expect(() =>
      assertLiveMainCompatible(
        {
          commitSha: 'b'.repeat(40),
          registryBlobSha: 'c'.repeat(40),
          registrySchemaBlobSha: 'd'.repeat(40),
        },
        'a'.repeat(40),
        'c'.repeat(40),
        (ancestor, descendant) => `${ancestor[0]}${descendant[0]}` === 'ab',
      ),
    ).toThrow(/must contain live origin\/main/);
  });

  it('fails closed when the candidate HEAD or registry moves during discovery', () => {
    const stablePin = {
      headSha: 'a'.repeat(40),
      registryBlobSha: 'b'.repeat(40),
      registrySchemaBlobSha: 'c'.repeat(40),
    };
    expect(() => assertDiscoveryCandidateStable(stablePin, stablePin)).not.toThrow();
    expect(() =>
      assertDiscoveryCandidateStable(stablePin, {
        ...stablePin,
        headSha: 'c'.repeat(40),
      }),
    ).toThrow(/candidate moved during discovery/);
    expect(() =>
      assertDiscoveryCandidateStable(stablePin, {
        ...stablePin,
        registryBlobSha: 'd'.repeat(40),
      }),
    ).toThrow(/candidate registry moved during discovery/);
    expect(() =>
      assertDiscoveryCandidateStable(stablePin, {
        ...stablePin,
        registrySchemaBlobSha: 'e'.repeat(40),
      }),
    ).toThrow(/candidate registry schema moved during discovery/);
  });

  it('accepts immutable PR and post-merge main transitions without a future-SHA cycle', () => {
    const blobs = new Map([
      ['a'.repeat(40), 'e'.repeat(40)],
      ['b'.repeat(40), 'e'.repeat(40)],
      ['c'.repeat(40), 'e'.repeat(40)],
      ['d'.repeat(40), 'e'.repeat(40)],
    ]);
    const verifier = {
      isAncestor: (ancestor: string, descendant: string) =>
        ['ab', 'ac', 'bc', 'bd', 'cd'].includes(`${ancestor[0]}${descendant[0]}`) ||
        ancestor === descendant,
      registryBlobAt: (commitSha: string) => blobs.get(commitSha) ?? 'f'.repeat(40),
      registrySchemaBlobAt: () => '6'.repeat(40),
    };

    expect(() => assertGitHubMainTransition(githubTransitionFixture(), verifier)).not.toThrow();
    expect(() =>
      assertGitHubMainTransition(
        githubTransitionFixture({
          eventName: 'push',
          githubRef: 'refs/heads/main',
          githubBaseRef: '',
          githubSha: 'c'.repeat(40),
          pullRequestBaseSha: '',
          pushBeforeSha: 'b'.repeat(40),
          pushAfterSha: 'c'.repeat(40),
          checkoutSha: 'c'.repeat(40),
          headSha: 'c'.repeat(40),
          originMainSha: 'd'.repeat(40),
        }),
        verifier,
      ),
    ).not.toThrow();
  });

  it('accepts consecutive registry-changing transitions while preserving event authority', () => {
    const blobs = new Map([
      ['a'.repeat(40), 'e'.repeat(40)],
      ['b'.repeat(40), 'f'.repeat(40)],
      ['c'.repeat(40), '1'.repeat(40)],
      ['d'.repeat(40), 'f'.repeat(40)],
    ]);
    const verifier = {
      isAncestor: () => true,
      registryBlobAt: (commitSha: string) => blobs.get(commitSha) ?? '2'.repeat(40),
      registrySchemaBlobAt: () => '6'.repeat(40),
    };

    expect(() =>
      assertGitHubMainTransition(
        githubTransitionFixture({ discoveryRegistryBlobSha: '1'.repeat(40) }),
        verifier,
      ),
    ).not.toThrow();
    expect(() =>
      assertGitHubMainTransition(
        githubTransitionFixture({
          eventName: 'push',
          githubRef: 'refs/heads/main',
          githubBaseRef: '',
          pullRequestBaseSha: '',
          pushBeforeSha: 'b'.repeat(40),
          pushAfterSha: 'c'.repeat(40),
          originMainSha: 'd'.repeat(40),
          discoveryRegistryBlobSha: '1'.repeat(40),
        }),
        {
          ...verifier,
          registryBlobAt: (commitSha: string) =>
            commitSha === 'd'.repeat(40)
              ? '1'.repeat(40)
              : (blobs.get(commitSha) ?? '2'.repeat(40)),
        },
      ),
    ).not.toThrow();
  });

  it('rejects mixed, forced, stale-authority, or superseded GitHub main transitions', () => {
    const alwaysAncestor = {
      isAncestor: () => true,
      registryBlobAt: () => 'e'.repeat(40),
      registrySchemaBlobAt: () => '6'.repeat(40),
    };
    expect(() =>
      assertGitHubMainTransition(
        githubTransitionFixture({ pushBeforeSha: 'b'.repeat(40) }),
        alwaysAncestor,
      ),
    ).toThrow(/must be empty/);
    expect(() =>
      assertGitHubMainTransition(
        githubTransitionFixture({ githubRef: 'refs/heads/main' }),
        alwaysAncestor,
      ),
    ).toThrow(/trusted pull-request merge ref/);
    expect(() =>
      assertGitHubMainTransition(
        githubTransitionFixture({ eventName: 'schedule' }),
        alwaysAncestor,
      ),
    ).toThrow(/does not accept GitHub event/);
    expect(() =>
      assertGitHubMainTransition(githubTransitionFixture(), {
        ...alwaysAncestor,
        isAncestor: (ancestor, descendant) =>
          !(ancestor === 'b'.repeat(40) && descendant === 'c'.repeat(40)),
      }),
    ).toThrow(/not an ancestor of candidate/);
    expect(() =>
      assertGitHubMainTransition(githubTransitionFixture(), {
        ...alwaysAncestor,
        registryBlobAt: (commitSha) =>
          commitSha === 'c'.repeat(40) ? 'f'.repeat(40) : 'e'.repeat(40),
      }),
    ).toThrow(/differs from discovery authority/);
    expect(() =>
      assertGitHubMainTransition(githubTransitionFixture(), {
        ...alwaysAncestor,
        registryBlobAt: (commitSha) =>
          commitSha === 'd'.repeat(40) ? 'f'.repeat(40) : 'e'.repeat(40),
      }),
    ).toThrow(/differs from event authority/);
    expect(() =>
      assertGitHubMainTransition(githubTransitionFixture(), {
        ...alwaysAncestor,
        registrySchemaBlobAt: (commitSha) =>
          commitSha === 'd'.repeat(40) ? '7'.repeat(40) : '6'.repeat(40),
      }),
    ).toThrow(/differs from event authority/);
  });

  it('derives every allocator namespace floor from raw evidence without losing suffixes', () => {
    expect(
      deriveReservedDomainFloors([
        { raw_id: 'EDGE-CRITICAL-001-R1' },
        { raw_id: 'EDGE-HIGH-026' },
        { raw_id: 'DB-ADMIN-MEDIUM-007' },
        { raw_id: 'HIGH-057' },
        { raw_id: 'RUST-CVE-002' },
        { raw_id: 'FARM-DATAMIG-001' },
      ]),
    ).toEqual({
      'DB-ADMIN': 7,
      EDGE: 26,
      FARM: 1,
      RUST: 2,
      UNSCOPED: 57,
    });
  });

  it('requires a kernel-bounded execution profile for full discovery', () => {
    expect(parseCliOptions(['--check', '--scope=remote'])).toEqual({
      mode: 'check',
      scope: 'remote',
    });
    expect(() => assertExecutionSafety({ mode: 'check', scope: 'full' }, undefined)).toThrow(
      /kernel-enforced bounded-host cgroup/,
    );
    expect(() =>
      assertExecutionSafety({ mode: 'write', scope: 'full' }, ISOLATED_EXECUTION_EVIDENCE),
    ).not.toThrow();
    expect(() =>
      assertExecutionSafety(
        { mode: 'write', scope: 'full' },
        { ...ISOLATED_EXECUTION_EVIDENCE, cpuMax: 'max 100000' },
      ),
    ).toThrow(/finite positive quota/);
    expect(() =>
      assertExecutionSafety(
        { mode: 'write', scope: 'full' },
        {
          ...ISOLATED_EXECUTION_EVIDENCE,
          runnerEnvironment: 'self-hosted',
          cpusetPartition: 'member',
        },
      ),
    ).toThrow(/isolated cgroup v2 partition/);
    expect(() =>
      assertExecutionSafety({ mode: 'write', scope: 'full' }, BOUNDED_HOST_EXECUTION_EVIDENCE),
    ).not.toThrow();
    expect(() =>
      assertExecutionSafety(
        { mode: 'write', scope: 'full' },
        { ...BOUNDED_HOST_EXECUTION_EVIDENCE, memorySwapMax: '1' },
      ),
    ).toThrow(/must equal zero/);
    expect(() =>
      assertExecutionSafety(
        { mode: 'write', scope: 'full' },
        { ...BOUNDED_HOST_EXECUTION_EVIDENCE, cpuWeight: '100' },
      ),
    ).toThrow(/cpu.weight/);
    expect(() =>
      assertExecutionSafety({ mode: 'refresh', scope: 'full' }, undefined),
    ).not.toThrow();
  });
});

describe('checked-in source finding attestation', () => {
  const manifest = readJsonRecord(MANIFEST_PATH);
  const reconciliation = recordValue(
    manifest.capability_reconciliation,
    'capability_reconciliation',
  );
  const inventory = recordValue(reconciliation.finding_inventory, 'finding_inventory');
  const sources = objectArray(reconciliation.sources, 'sources');
  const sourceAdjudications = objectArray(
    reconciliation.source_adjudications,
    'source_adjudications',
  );
  const units = objectArray(reconciliation.integration_units, 'integration_units');
  const rows = readArtifact();

  it('is byte-identical to canonical writer formatting', () => {
    const checkedInManifest = readFileSync(MANIFEST_PATH, 'utf8');
    const firstPass = formatSourceFindingManifest(manifest);
    const secondPass = formatSourceFindingManifest(readJsonRecord(MANIFEST_PATH));
    expect(firstPass).toBe(checkedInManifest);
    expect(secondPass).toBe(firstPass);
  });

  it('keeps formatter config, engine, and semantic output inside one fail-closed contract', () => {
    expect(() =>
      parseSourceFindingPrettierConfig(
        JSON.stringify({
          printWidth: 100,
          overrides: [{ files: 'manifest.json', options: { printWidth: 80 } }],
        }),
      ),
    ).toThrow(/unsupported=overrides/);
    expect(() =>
      parseSourceFindingPrettierConfig(
        JSON.stringify({ printWidth: 100, plugins: ['./unattested-plugin.js'] }),
      ),
    ).toThrow(/unsupported=plugins/);

    const pinnedVersion = lockedPrettierVersion(readFileSync(PACKAGE_LOCK_PATH, 'utf8'));
    expect(pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => assertPrettierVersionAuthority('0.0.0', pinnedVersion)).toThrow(
      /differs from package-lock authority/,
    );

    expect(() => assertFormattedManifestSemantics('{"changed":true}\n', manifest)).toThrow(
      /changed manifest semantics/,
    );
    expect(() => assertFormattedManifestSemantics('not-json', manifest)).toThrow(/invalid JSON/);
  });

  it('verifies stored evidence against its own pins before current inputs are refreshed', () => {
    const artifactRaw = readFileSync(ARTIFACT_PATH, 'utf8');
    expect(assertStoredFindingInventoryIntegrity(artifactRaw, inventory)).toHaveLength(rows.length);

    const tamperedInventory = structuredClone(inventory);
    const sourceAttestations = objectArray(
      tamperedInventory.source_attestations,
      'tampered source_attestations',
    );
    sourceAttestations[0]!.occurrence_count =
      numberValue(sourceAttestations[0]!.occurrence_count, 'tampered occurrence_count') + 1;
    expect(() => assertStoredFindingInventoryIntegrity(artifactRaw, tamperedInventory)).toThrow(
      /prior finding_inventory.source_attestations/,
    );
  });

  it('pins the corrected semantic occurrence set and preserves preliminary audit lineage', () => {
    const artifactRaw = readFileSync(ARTIFACT_PATH);
    const lineage = recordValue(inventory.audit_lineage, 'finding_inventory.audit_lineage');
    const generation = recordValue(
      inventory.generation_attestation,
      'finding_inventory.generation_attestation',
    );

    expect(inventory.schema_version).toBe(3);
    expect(rows).toHaveLength(EXPECTED_OCCURRENCE_COUNT);
    expect(numberValue(inventory.occurrence_count, 'occurrence_count')).toBe(
      EXPECTED_OCCURRENCE_COUNT,
    );
    expect(stringValue(inventory.occurrence_sha256, 'occurrence_sha256')).toBe(
      EXPECTED_OCCURRENCE_DIGEST,
    );
    const artifactSha256 = createHash('sha256').update(artifactRaw).digest('hex');
    expect(stringValue(inventory.artifact_sha256, 'artifact_sha256')).toBe(artifactSha256);
    expect(stringValue(inventory.artifact_path, 'artifact_path')).toBe(
      `docs/plans/2026-06-18-enterprise-grade-debt-closure/source-findings.${artifactSha256}.jsonl`,
    );
    expect(
      readdirSync(PLAN_DIRECTORY)
        .filter((name) => /^source-findings(?:\.[0-9a-f]{64})?\.jsonl$/.test(name))
        .sort(),
    ).toEqual([basename(ARTIFACT_PATH)]);
    expect(numberValue(lineage.preliminary_textual_occurrence_count, 'preliminary count')).toBe(
      1030,
    );
    expect(stringValue(lineage.preliminary_textual_occurrence_sha256, 'preliminary digest')).toBe(
      PRELIMINARY_OCCURRENCE_DIGEST,
    );
    expect(numberValue(lineage.intermediate_semantic_occurrence_count, 'intermediate count')).toBe(
      1010,
    );
    expect(
      stringValue(lineage.intermediate_semantic_occurrence_sha256, 'intermediate digest'),
    ).toBe(INTERMEDIATE_OCCURRENCE_DIGEST);
    expect(numberValue(lineage.excluded_rechain_only_count, 'excluded count')).toBe(20);
    expect(stringArray(lineage.excluded_source_refs, 'excluded refs')).toHaveLength(20);
    expect(generation).toMatchObject({
      algorithm_version: 'REGISTRY_SCHEMA_CAPABILITY_V3',
      remote_source_state: 'LIVE_REDISCOVERED',
      host_source_state: 'RETAINED_PENDING_ISOLATED_REDISCOVERY',
    });
    const pendingRegeneration = recordValue(
      generation.pending_isolated_regeneration,
      'pending_isolated_regeneration',
    );
    expect(pendingRegeneration).toMatchObject({
      execution_owner: 'infra-expert',
      deadline: '2026-07-30',
    });
    expect(stringValue(pendingRegeneration.plan, 'regeneration plan')).toContain(
      'exclusive isolated CPU partition',
    );
  });

  it('normalizes registry and schema authority to unique content-attested Git blobs', () => {
    const registryAuthority = recordValue(
      inventory.registry_authority,
      'finding_inventory.registry_authority',
    );
    const reconciled = recordValue(
      registryAuthority.reconciled_base,
      'registry_authority.reconciled_base',
    );
    const discovery = recordValue(
      registryAuthority.discovery_candidate,
      'registry_authority.discovery_candidate',
    );
    const registrySnapshots = objectArray(
      registryAuthority.registry_snapshots,
      'registry_authority.registry_snapshots',
    );
    const schemaSnapshots = objectArray(
      registryAuthority.schema_snapshots,
      'registry_authority.schema_snapshots',
    );
    const expectedRegistryBlobs = [
      ...new Set([
        stringValue(reconciled.registry_blob_sha, 'reconciled.registry_blob_sha'),
        stringValue(discovery.registry_blob_sha, 'discovery.registry_blob_sha'),
      ]),
    ].sort();
    const expectedSchemaBlobs = [
      ...new Set([
        stringValue(reconciled.schema_blob_sha, 'reconciled.schema_blob_sha'),
        stringValue(discovery.schema_blob_sha, 'discovery.schema_blob_sha'),
      ]),
    ].sort();

    expect(
      registrySnapshots.map((snapshot) => stringValue(snapshot.blob_sha, 'snapshot.blob_sha')),
    ).toEqual(expectedRegistryBlobs);
    expect(
      schemaSnapshots.map((snapshot) => stringValue(snapshot.blob_sha, 'snapshot.blob_sha')),
    ).toEqual(expectedSchemaBlobs);
    for (const snapshot of registrySnapshots) {
      expect(stringValue(snapshot.blob_sha, 'snapshot.blob_sha')).toMatch(/^[0-9a-f]{40}$/);
      expect(stringValue(snapshot.sha256, 'snapshot.sha256')).toMatch(/^[0-9a-f]{64}$/);
      expect(numberValue(snapshot.row_count, 'snapshot.row_count')).toBeGreaterThan(0);
    }
    for (const snapshot of schemaSnapshots) {
      expect(Object.keys(snapshot).sort()).toEqual(['blob_sha', 'sha256']);
      expect(stringValue(snapshot.blob_sha, 'snapshot.blob_sha')).toMatch(/^[0-9a-f]{40}$/);
      expect(stringValue(snapshot.sha256, 'snapshot.sha256')).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('has one deterministic row per source-qualified raw ID with typed evidence', () => {
    const sourceRefs = rows.map((row) => stringValue(row.source_ref, 'source_ref'));
    const occurrenceIds = rows.map((row) => stringValue(row.occurrence_id, 'occurrence_id'));
    const classifications = rows.map((row) => stringValue(row.classification, 'classification'));
    const evidenceKinds = rows.map((row) => stringValue(row.evidence_kind, 'evidence_kind'));

    expect(new Set(sourceRefs).size).toBe(rows.length);
    expect(new Set(occurrenceIds).size).toBe(rows.length);
    expect(sourceRefDigest(sourceRefs)).toBe(EXPECTED_OCCURRENCE_DIGEST);
    expect(
      sourceRefs.every((sourceRef, index) => occurrenceIds[index] === occurrenceId(sourceRef)),
    ).toBe(true);
    expect(classifications.filter((value) => value === 'ID_COLLISION')).toHaveLength(27);
    expect(classifications.filter((value) => value === 'LEGACY_UNREGISTERED')).toHaveLength(618);
    expect(classifications.filter((value) => value === 'PENDING_ADJUDICATION')).toHaveLength(319);
    expect(evidenceKinds.filter((value) => value === 'REGISTRY_RECORD')).toHaveLength(645);
    expect(evidenceKinds.filter((value) => value === 'REGISTRY_REFERENCE')).toHaveLength(90);
    expect(evidenceKinds.filter((value) => value === 'REVIEW_MENTION')).toHaveLength(229);
    expect(sourceRefs).toContain('SRC-R-019#EDGE-CRITICAL-001-R1');
    expect(sourceRefs).toContain('SRC-R-019#RUST-CVE-002');
    expect(sourceRefs).not.toContain('SRC-R-005#ORPHAN-HIGH-472');
  });

  it('keeps collisions unallocated and unresolved evidence semantically unassigned', () => {
    const collisions = rows.filter((row) => row.classification === 'ID_COLLISION');
    const targeted = rows.filter((row) => {
      const adjudication = recordValue(row.adjudication, 'row.adjudication');
      return adjudication.target_integration_unit_id !== null;
    });

    expect(collisions.every((row) => row.canonical_id === null)).toBe(true);
    expect(collisions.every((row) => typeof row.main_record_sha256 === 'string')).toBe(true);
    expect(
      collisions.every(
        (row) =>
          recordValue(row.adjudication, 'collision.adjudication').target_integration_unit_id ===
          null,
      ),
    ).toBe(true);
    expect(targeted).toHaveLength(12);
    expect(
      rows
        .filter((row) => !targeted.includes(row))
        .every(
          (row) =>
            recordValue(row.adjudication, 'row.adjudication').target_integration_unit_id === null,
        ),
    ).toBe(true);
  });

  it('gives every source one explicit execution queue and attests zero-occurrence sources', () => {
    const sourceAttestations = objectArray(inventory.source_attestations, 'source_attestations');
    const unitAttestations = objectArray(inventory.unit_attestations, 'unit_attestations');
    const adjudicationsBySource = new Map(
      sourceAdjudications.map((entry) => [
        stringValue(entry.source_id, 'source_adjudication.source_id'),
        entry,
      ]),
    );

    expect(sourceAttestations).toHaveLength(sources.length);
    expect(sourceAdjudications).toHaveLength(sources.length);
    expect(unitAttestations).toHaveLength(units.length);
    expect(
      sourceAdjudications
        .map((entry) => stringValue(entry.source_id, 'source_adjudication.source_id'))
        .sort(),
    ).toEqual(sources.map((source) => stringValue(source.id, 'source.id')).sort());
    for (const adjudication of sourceAdjudications) {
      const sourceId = stringValue(adjudication.source_id, 'source_adjudication.source_id');
      expect(stringValue(adjudication.id, 'source_adjudication.id')).toBe(`SA-${sourceId}`);
      expect(stringValue(adjudication.execution_owner, 'execution_owner')).not.toBe('');
      expect(stringValue(adjudication.deadline, 'deadline')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stringValue(adjudication.plan, 'plan')).toContain(sourceId);
    }
    for (const row of rows) {
      const sourceId = stringValue(row.source_id, 'row.source_id');
      const adjudication = recordValue(row.adjudication, 'row.adjudication');
      expect(Object.keys(adjudication).sort()).toEqual(
        ['source_adjudication_id', 'status', 'target_integration_unit_id'].sort(),
      );
      expect(adjudication.source_adjudication_id).toBe(adjudicationsBySource.get(sourceId)?.id);
      expect(adjudication).not.toHaveProperty('adjudication_unit_id');
      expect(adjudication).not.toHaveProperty('owner');
      expect(adjudication).not.toHaveProperty('deadline');
      expect(adjudication).not.toHaveProperty('plan');
    }
    expect(
      sourceAttestations.map((entry) => stringValue(entry.source_id, 'source_id')).sort(),
    ).toEqual(sources.map((source) => stringValue(source.id, 'source.id')).sort());
    for (const attestation of sourceAttestations) {
      const sourceId = stringValue(attestation.source_id, 'source_attestation.source_id');
      expect(attestation.source_adjudication_id).toBe(adjudicationsBySource.get(sourceId)?.id);
      expect(numberValue(attestation.untargeted_occurrence_count, 'untargeted count')).toBe(
        rows.filter(
          (row) =>
            row.source_id === sourceId &&
            recordValue(row.adjudication, 'row.adjudication').target_integration_unit_id === null,
        ).length,
      );
      expect(attestation).not.toHaveProperty('adjudication_unit_id');
    }
    expect(
      unitAttestations
        .map((entry) => stringValue(entry.integration_unit_id, 'integration_unit_id'))
        .sort(),
    ).toEqual(units.map((unit) => stringValue(unit.id, 'unit.id')).sort());
    expect(
      sourceAttestations.some(
        (entry) => numberValue(entry.occurrence_count, 'occurrence_count') === 0,
      ),
    ).toBe(true);
    expect(
      unitAttestations.reduce(
        (sum, entry) =>
          sum + numberValue(entry.targeted_occurrence_count, 'targeted_occurrence_count'),
        0,
      ),
    ).toBe(12);
    expect(
      unitAttestations.every(
        (entry) =>
          !Object.hasOwn(entry, 'adjudication_occurrence_count') &&
          !Object.hasOwn(entry, 'pending_count'),
      ),
    ).toBe(true);
  });

  it('removes invalid provenance and resolves every surviving unit ref to its target row', () => {
    const rowsByRef = new Map(rows.map((row) => [stringValue(row.source_ref, 'source_ref'), row]));
    const survivingRefs: string[] = [];
    for (const unit of units) {
      const unitId = stringValue(unit.id, 'unit.id');
      const binding = recordValue(unit.finding_binding, `${unitId}.finding_binding`);
      for (const sourceRef of stringArray(binding.legacy_finding_refs, `${unitId}.legacy refs`)) {
        survivingRefs.push(sourceRef);
        expect(INVALID_LEGACY_REFS.has(sourceRef)).toBe(false);
        const row = rowsByRef.get(sourceRef);
        expect(row).toBeDefined();
        expect(
          recordValue(row?.adjudication, `${sourceRef}.adjudication`).target_integration_unit_id,
        ).toBe(unitId);
      }
    }
    expect(survivingRefs).toHaveLength(12);
  });

  it('derives allocator floors from every raw namespace in the artifact', () => {
    const allocationPolicy = recordValue(
      reconciliation.finding_allocation_policy,
      'finding_allocation_policy',
    );
    const derived = deriveReservedDomainFloors(
      rows.map((row) => ({ raw_id: stringValue(row.raw_id, 'raw_id') })),
    );

    expect(allocationPolicy.allocator).toBe('tools/gates/finding-registry.ts');
    expect(allocationPolicy.reserved_domain_floors).toEqual(derived);
    expect(Object.keys(derived).length).toBeGreaterThan(40);
  });

  it('wires registry writer fencing before event-pinned source validation in required CI', () => {
    const packageJson = readJsonRecord(PACKAGE_PATH);
    const scripts = recordValue(packageJson.scripts, 'package.scripts');
    const workflow = readFileSync(CI_FULL_PATH, 'utf8');
    const workflowDocument = recordValue(yaml.load(workflow) as unknown, 'ci-full workflow');
    const jobs = recordValue(workflowDocument.jobs, 'ci-full jobs');
    const deployGates = recordValue(jobs['deploy-ssot-gates'], 'deploy-ssot-gates');
    const steps = objectArray(deployGates.steps, 'deploy-ssot-gates.steps');
    const authorityTestIndex = steps.findIndex(
      (step) => step.run === 'npm run test:finding-registry-authority',
    );
    const writerPreflightIndex = steps.findIndex(
      (step) => step.run === 'npm run findings:writer-preflight',
    );
    const sourcePinIndex = steps.findIndex(
      (step) => step.run === 'npm run gates:capability-source-inventory:remote',
    );
    const findingIndex = steps.findIndex(
      (step) => step.run === 'npm run gates:source-finding-inventory:remote',
    );
    const invariantIndex = steps.findIndex((step) => step.run === 'npm run invariants:fast');
    const findingStep = steps[findingIndex];
    if (!findingStep) {
      throw new Error('remote source-finding step is absent');
    }

    expect(scripts['test:finding-registry-authority']).toBe(
      'ts-node --project tools/gates/tsconfig.json tools/gates/finding-registry-store.spec.ts',
    );
    expect(scripts['findings:writer-preflight']).toBe(
      'ts-node --project tools/gates/tsconfig.json tools/gates/finding-registry.ts writer-preflight',
    );
    expect(scripts['gates:source-finding-inventory:remote']).toContain('--check --scope=remote');
    expect(scripts['gates:source-finding-inventory:refresh']).toContain('--refresh');
    expect(scripts['gates:source-finding-inventory:generate']).toContain('--write');
    expect(authorityTestIndex).toBeGreaterThan(-1);
    expect(writerPreflightIndex).toBeGreaterThan(authorityTestIndex);
    expect(sourcePinIndex).toBeGreaterThan(writerPreflightIndex);
    expect(sourcePinIndex).toBeGreaterThan(-1);
    expect(findingIndex).toBeGreaterThan(sourcePinIndex);
    expect(invariantIndex).toBeGreaterThan(findingIndex);
    expect(findingStep.if).toBe(
      "github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main')",
    );
    expect(recordValue(findingStep.env, 'source-finding step env')).toEqual({
      SOURCE_FINDING_EVENT_PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      SOURCE_FINDING_EVENT_PUSH_BEFORE_SHA: '${{ github.event.before }}',
      SOURCE_FINDING_EVENT_PUSH_AFTER_SHA: '${{ github.event.after }}',
      SOURCE_FINDING_EVENT_CHECKOUT_SHA: '${{ github.sha }}',
    });
  });
});
