/**
 * Enterprise-grade debt closure plan contract.
 *
 * The 2026-06-18 debt-closure program is a control-plane artifact, not a
 * narrative-only roadmap. This invariant keeps its README, machine-readable
 * manifest, and CODEOWNERS coverage present and internally consistent.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  computeSourceSliceSelectorSha256,
  LocalDispatchIdentityCatalog,
  parseIntegrationEvidenceManifest,
  parseRequiredStatusContract,
  validateExecutionIdentityDefinitions,
  validateIntegrationEvidenceStatic,
} from '../../tools/gates/capability-integration-evidence';
import { parseInventoryManifest } from '../../tools/gates/capability-source-inventory';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PLAN_ID = '2026-06-18-enterprise-grade-debt-closure';
const PLAN_DIR = join(REPO_ROOT, 'docs/plans', PLAN_ID);
const README_PATH = join(PLAN_DIR, 'README.md');
const MANIFEST_PATH = join(PLAN_DIR, 'manifest.json');
const TRUTH_TABLE_PATH = join(PLAN_DIR, 'finding-truth-table.md');
const CODEOWNERS_PATH = join(REPO_ROOT, '.github/CODEOWNERS');
const REGISTRY_PATH = join(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');
const REQUIRED_STATUS_CHECKS_PATH = join(
  REPO_ROOT,
  '.github/manifests/main-required-status-checks.json',
);
const QUALITY_RUNNER_PATH = join(REPO_ROOT, 'tools/quality/quality.mjs');
const CLOSURE_MANIFEST_PATH = join(REPO_ROOT, 'tools/quality/closure-manifest.json');
const NX_JSON_PATH = join(REPO_ROOT, 'nx.json');
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json');
const TRUTH_BUCKETS = new Set([
  'real-open',
  'already-fixed-needs-close',
  'superseded',
  'blocked',
  'stale',
  'new-finding-required',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Expected string array');
  }
  return value;
}

function objectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error('Expected object array');
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Expected numeric manifest field: ${field}`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected string field: ${field}`);
  }
  return value;
}

function readManifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Plan manifest must be a JSON object');
  }
  return parsed;
}

function readRegistryEntries(): Record<string, unknown>[] {
  return readFileSync(REGISTRY_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error(`Registry line ${index + 1} must be a JSON object`);
      }
      return parsed;
    });
}

function stateOf(entry: Record<string, unknown>): string {
  return stringValue(entry.state, `${stringValue(entry.id, 'registry.id')}.state`);
}

function isActiveCritical(entry: Record<string, unknown>): boolean {
  if (
    stringValue(entry.severity, `${stringValue(entry.id, 'registry.id')}.severity`) !== 'CRITICAL'
  ) {
    return false;
  }
  return stateOf(entry) === 'OPEN' || stateOf(entry) === 'IN-PROGRESS';
}

function truthTableRows(truthTable: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of truthTable.split(/\r?\n/)) {
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length !== 5 || !cells[0]?.startsWith('`')) continue;
    const id = cells[0].replace(/^`|`$/g, '');
    rows.set(id, cells[4]!);
  }
  return rows;
}

describe('enterprise-grade debt closure plan contract', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  const truthTable = readFileSync(TRUTH_TABLE_PATH, 'utf8');
  const manifest = readManifest();
  const registryEntries = readRegistryEntries();
  const reconciliation = isRecord(manifest.capability_reconciliation)
    ? manifest.capability_reconciliation
    : {};
  const findingInventory = isRecord(reconciliation.finding_inventory)
    ? reconciliation.finding_inventory
    : {};
  const sourceFindingsPath = resolve(
    REPO_ROOT,
    stringValue(findingInventory.artifact_path, 'finding_inventory.artifact_path'),
  );

  it('keeps the governed plan README present with the wave structure', () => {
    expect(readme).toContain('# Enterprise-Grade Debt Closure Program');
    expect(readme).toContain('## Waves');
    expect(readme).toContain('### Wave 0 - Truth Freeze And Control Plane');
    expect(readme).toContain('### Wave 6 - Closure, Evidence, Release Discipline');
    expect(readme).toContain('The companion manifest is `manifest.json`.');
    expect(readme).toContain('`finding-truth-table.md`');
    expect(readme).toContain('`.github/manifests/main-required-status-checks.json`');
    expect(readme).toContain('`npm run gates:required-status-checks`');
    expect(readme).toContain('Control-plane status reviewed: 2026-07-30');
    expect(readme).toContain('Program status is `ACTIVE`');
    expect(readme).toContain('### Open P1 Control-Plane Blockers — 2026-07-30');
    const p1Rows = new Map(
      readme
        .split(/\r?\n/)
        .filter((line) => line.startsWith('| `P1-'))
        .map((line) => {
          const cells = line
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
          expect(cells).toHaveLength(6);
          return [cells[0], cells] as const;
        }),
    );
    for (const [id, owner] of [
      ['`P1-WRITER-PROTOCOL-001`', '`context-manager`'],
      ['`P1-ALLOCATOR-OIDC-001`', '`security-reviewer`'],
      ['`P1-HOST-SOURCE-TRANSFER-001`', '`infra-expert`'],
    ]) {
      const cells = p1Rows.get(id);
      expect(cells).toBeDefined();
      expect(cells?.[1]).toBe('`OPEN`');
      expect(cells?.[2]).toBe(owner);
      expect(cells?.[3]).toBe('2026-07-30');
      expect(cells?.[4]).not.toBe('');
      expect(cells?.[5]).not.toBe('');
    }
    expect(readme).toMatch(
      /The publication\s+writer calls `assertCompatibleWriters\(\)` while resolving its\s+repository-common lease/,
    );
  });

  it('keeps the manifest identity and baseline fields machine-readable', () => {
    expect(manifest.plan_id).toBe(PLAN_ID);
    expect(manifest.truth_table_path).toBe(`docs/plans/${PLAN_ID}/finding-truth-table.md`);
    expect(manifest.required_status_checks_manifest).toBe(
      '.github/manifests/main-required-status-checks.json',
    );
    expect(manifest.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(manifest.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.registry_tip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(numberValue(manifest.registry_entries, 'registry_entries')).toBeGreaterThan(0);
    expect(numberValue(manifest.open_findings_count, 'open_findings_count')).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      numberValue(manifest.in_progress_findings_count, 'in_progress_findings_count'),
    ).toBeGreaterThanOrEqual(0);
    expect(numberValue(manifest.active_critical_count, 'active_critical_count')).toBeGreaterThan(0);
  });

  it('keeps manifest counts and active criticals pinned to the finding registry SSoT', () => {
    const activeCriticalIds = stringArray(manifest.active_critical_ids);
    const registryActiveCriticalIds = registryEntries
      .filter(isActiveCritical)
      .map((entry) => stringValue(entry.id, 'registry.id'));
    const registryOpenCount = registryEntries.filter((entry) => stateOf(entry) === 'OPEN').length;
    const registryInProgressCount = registryEntries.filter(
      (entry) => stateOf(entry) === 'IN-PROGRESS',
    ).length;
    const registryTip = stringValue(
      registryEntries[registryEntries.length - 1]?.content_hash,
      'registry tip content_hash',
    );

    expect(manifest.registry_tip_hash).toBe(registryTip);
    expect(numberValue(manifest.registry_entries, 'registry_entries')).toBe(registryEntries.length);
    expect(numberValue(manifest.open_findings_count, 'open_findings_count')).toBe(
      registryOpenCount,
    );
    expect(numberValue(manifest.in_progress_findings_count, 'in_progress_findings_count')).toBe(
      registryInProgressCount,
    );
    expect(numberValue(manifest.active_critical_count, 'active_critical_count')).toBe(
      registryActiveCriticalIds.length,
    );
    expect(activeCriticalIds).toEqual(registryActiveCriticalIds);
  });

  it('keeps active criticals, dispatchable agents, and attacker lanes explicit', () => {
    const activeCriticalIds = stringArray(manifest.active_critical_ids);
    const agentRoster = stringArray(manifest.agent_roster);
    const attackers = stringArray(manifest.reverse_engineering_attackers);
    const agentDefinitions = new LocalDispatchIdentityCatalog().definitions();
    const definitionCountByName = new Map<string, number>();

    for (const definition of agentDefinitions) {
      definitionCountByName.set(
        definition.name,
        (definitionCountByName.get(definition.name) ?? 0) + 1,
      );
    }

    expect(activeCriticalIds).toHaveLength(
      numberValue(manifest.active_critical_count, 'active_critical_count'),
    );
    expect(activeCriticalIds.every((id) => id.includes('-CRITICAL-'))).toBe(true);
    expect(agentRoster).toEqual([
      'architectural-arbiter',
      'context-manager',
      'prompt-writer',
      'data-expert',
      'multi-tenant-saas-expert',
      'auth-security-expert',
      'security-reviewer',
      'compliance-expert',
      'legal-hold-auditor',
      'infra-expert',
      'performance-expert',
      'hr-expert',
      'frontend-expert',
      'messaging-expert',
      'farm-expert',
      'edge-expert',
      'alert-engine-expert',
      'supply-chain-auditor',
      'test-runner',
      'admin-expert',
      'mcp-expert',
      'build-validator',
      'mobile-app-auditor',
      'observability-expert',
    ]);
    for (const agent of agentRoster) {
      expect(definitionCountByName.get(agent)).toBe(1);
    }
    expect(attackers).toHaveLength(8);
    expect(attackers).toContain('ssot-control-plane-attacker');
  });

  it('keeps every sprint and finding owner inside the agent roster SSoT', () => {
    const agentRoster = new Set(stringArray(manifest.agent_roster));
    const sprints = objectArray(manifest.sprints);
    const findingAssignments = objectArray(manifest.finding_assignments);
    const missingOwners = new Set<string>();

    for (const sprint of sprints) {
      const sprintId = stringValue(sprint.id, 'sprint.id');
      for (const owner of stringArray(sprint.owner_agents)) {
        if (!agentRoster.has(owner)) {
          missingOwners.add(`${sprintId}:${owner}`);
        }
      }
    }

    for (const assignment of findingAssignments) {
      const pattern = stringValue(assignment.pattern, 'finding_assignment.pattern');
      const owner = stringValue(assignment.owner_agent, 'finding_assignment.owner_agent');
      if (!agentRoster.has(owner)) {
        missingOwners.add(`${pattern}:${owner}`);
      }
    }

    expect([...missingOwners].sort()).toEqual([]);
  });

  it('keeps the truth table aligned with active critical IDs', () => {
    const activeCriticalIds = stringArray(manifest.active_critical_ids);
    const rows = truthTableRows(truthTable);

    expect(truthTable).toContain('# Finding Truth Table');
    expect(truthTable).toContain('Allowed truth buckets:');
    for (const bucket of TRUTH_BUCKETS) {
      expect(truthTable).toContain(`\`${bucket}\``);
    }

    for (const id of activeCriticalIds) {
      expect(rows.has(id)).toBe(true);
      expect(TRUTH_BUCKETS.has(rows.get(id) ?? '')).toBe(true);
    }
    expect(rows.size).toBe(activeCriticalIds.length);
  });

  it('keeps waves, sprints, and exit gates linked', () => {
    const waves = objectArray(manifest.waves);
    const sprints = objectArray(manifest.sprints);
    const acceptanceGates = objectArray(manifest.acceptance_gates);
    const sprintIds = new Set(sprints.map((sprint) => sprint.id));

    expect(waves.map((wave) => wave.id)).toEqual([
      'wave-0',
      'wave-1',
      'wave-2',
      'wave-3',
      'wave-4',
      'wave-5',
      'wave-6',
    ]);
    expect(sprints.length).toBeGreaterThanOrEqual(12);
    expect(acceptanceGates.length).toBeGreaterThanOrEqual(7);
    expect(acceptanceGates.some((gate) => gate.id === 'required-status-checks-static')).toBe(true);
    expect(acceptanceGates.some((gate) => gate.id === 'required-status-checks-live')).toBe(true);

    for (const wave of waves) {
      for (const sprintId of stringArray(wave.sprints)) {
        expect(sprintIds.has(sprintId)).toBe(true);
      }
    }

    const wave0 = waves.find((wave) => wave.id === 'wave-0');
    expect(wave0).toBeDefined();
    expect(stringArray(wave0?.exit_gates)).toEqual([
      'findings-verify',
      'invariants-fast',
      'plan-manifest-valid',
    ]);
  });

  it('keeps docs/plans covered by CODEOWNERS', () => {
    const lines = readFileSync(CODEOWNERS_PATH, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(lines.some((line) => line.startsWith('docs/plans/'))).toBe(true);
  });

  it('keeps main required checks policy pinned to Sens enterprise gates', () => {
    const parsed: unknown = JSON.parse(readFileSync(REQUIRED_STATUS_CHECKS_PATH, 'utf8'));
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) return;
    expect(parsed.repository).toBe('Okan-wqm/aquaculture_platform');
    expect(parsed.branch).toBe('main');
    expect(parsed.finding_ids).toContain('EDGE-CRITICAL-001');
    expect(isRecord(parsed.branch_protection)).toBe(true);
    if (!isRecord(parsed.branch_protection)) return;
    expect(parsed.branch_protection.enforce_admins).toBe(true);
    expect(isRecord(parsed.required_status_checks)).toBe(true);
    if (!isRecord(parsed.required_status_checks)) return;
    expect(parsed.required_status_checks.strict).toBe(true);
    expect(parsed.required_status_checks.contexts).toEqual([
      'sens-enterprise-summary',
      'merge-gate',
      'aria-merge-authority',
      'build-status',
    ]);
  });

  it('runs enterprise closure noninteractively and verifies a clean tree after every step', () => {
    const runner = readFileSync(QUALITY_RUNNER_PATH, 'utf8');

    expect(runner).toContain("CI: 'true'");
    expect(runner).toContain("NX_DAEMON: 'false'");
    expect(runner).toContain("NX_INTERACTIVE: 'false'");
    expect(runner).toContain("NX_TASKS_RUNNER_DYNAMIC_OUTPUT: 'false'");
    expect(runner).toContain("const cleanTreeResult = run('git', ['status', '--short']");
    expect(runner).toContain('clean_tree_output_sha256: sha256(cleanTreeOutput)');
    expect(runner).toContain('${item.name} modified the worktree`');
  });

  it('keeps Nx analytics and sync writes disabled with a read-only closure preflight', () => {
    const nxJson: unknown = JSON.parse(readFileSync(NX_JSON_PATH, 'utf8'));
    const closureManifest: unknown = JSON.parse(readFileSync(CLOSURE_MANIFEST_PATH, 'utf8'));

    expect(isRecord(nxJson)).toBe(true);
    expect(isRecord(closureManifest)).toBe(true);
    if (!isRecord(nxJson) || !isRecord(closureManifest)) return;

    expect(nxJson.analytics).toBe(false);
    expect(isRecord(nxJson.sync)).toBe(true);
    if (!isRecord(nxJson.sync)) return;
    expect(nxJson.sync.applyChanges).toBe(false);

    expect(isRecord(closureManifest.profiles)).toBe(true);
    if (!isRecord(closureManifest.profiles)) return;
    const enterpriseProfile = closureManifest.profiles['enterprise-closure'];
    expect(isRecord(enterpriseProfile)).toBe(true);
    if (!isRecord(enterpriseProfile)) return;

    const closureSteps = objectArray(enterpriseProfile.steps);
    const stepNames = closureSteps.map((closureStep) => stringValue(closureStep.name, 'step.name'));
    const syncStepIndex = stepNames.indexOf('nx-sync-check');
    const installedTreeIndex = stepNames.indexOf('npm-ls-installed-tree');
    const syncStep = closureSteps[syncStepIndex];

    expect(syncStepIndex).toBeGreaterThan(installedTreeIndex);
    expect(stringArray(syncStep?.command)).toEqual([
      'node',
      'tools/toolchain/run.mjs',
      'nx',
      'sync:check',
    ]);
    for (const taskStep of ['format-check', 'lint-all', 'type-check', 'test-all', 'build-all']) {
      expect(stepNames.indexOf(taskStep)).toBeGreaterThan(syncStepIndex);
    }
  });

  it('keeps every closure npm command bound to an existing package script', () => {
    const packageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    const closureManifest: unknown = JSON.parse(readFileSync(CLOSURE_MANIFEST_PATH, 'utf8'));

    expect(isRecord(packageJson)).toBe(true);
    expect(isRecord(closureManifest)).toBe(true);
    if (!isRecord(packageJson) || !isRecord(closureManifest)) return;

    expect(isRecord(packageJson.scripts)).toBe(true);
    expect(isRecord(closureManifest.profiles)).toBe(true);
    if (!isRecord(packageJson.scripts) || !isRecord(closureManifest.profiles)) return;

    const missingScripts: string[] = [];
    for (const [profileName, profile] of Object.entries(closureManifest.profiles)) {
      if (!isRecord(profile)) throw new Error(`Expected closure profile object: ${profileName}`);
      for (const closureStep of objectArray(profile.steps)) {
        const command = stringArray(closureStep.command);
        if (command[0] !== 'npm' || command[1] !== 'run') continue;
        const scriptName = stringValue(command[2], `${profileName}.npm_script`);
        if (typeof packageJson.scripts[scriptName] !== 'string') {
          missingScripts.push(
            `${profileName}:${stringValue(closureStep.name, 'step.name')}:${scriptName}`,
          );
        }
      }
    }

    expect(missingScripts).toEqual([]);
  });

  it('validates the installed npm tree produced by the clean lockfile install', () => {
    const closureManifest: unknown = JSON.parse(readFileSync(CLOSURE_MANIFEST_PATH, 'utf8'));
    expect(isRecord(closureManifest)).toBe(true);
    if (!isRecord(closureManifest)) return;

    expect(isRecord(closureManifest.profiles)).toBe(true);
    if (!isRecord(closureManifest.profiles)) return;
    const enterpriseProfile = closureManifest.profiles['enterprise-closure'];
    expect(isRecord(enterpriseProfile)).toBe(true);
    if (!isRecord(enterpriseProfile)) return;

    const installedTreeStep = objectArray(enterpriseProfile.steps).find(
      (closureStep) => closureStep.name === 'npm-ls-installed-tree',
    );
    expect(installedTreeStep).toBeDefined();
    expect(stringArray(installedTreeStep?.command)).toEqual(['npm', 'ls', '--all']);
  });

  it('governs atomic capability integration independently from branch history', () => {
    const reconciliation = manifest.capability_reconciliation;
    expect(isRecord(reconciliation)).toBe(true);
    if (!isRecord(reconciliation)) return;
    const evidenceManifest = parseIntegrationEvidenceManifest(manifest);
    const requiredStatus = parseRequiredStatusContract(readFileSync(REQUIRED_STATUS_CHECKS_PATH));

    expect(validateIntegrationEvidenceStatic(evidenceManifest, requiredStatus)).toEqual([]);
    expect(
      validateExecutionIdentityDefinitions(evidenceManifest, new LocalDispatchIdentityCatalog()),
    ).toEqual([]);
    expect(parseInventoryManifest(manifest).sources).toHaveLength(44);

    const gitObjectId = /^[0-9a-f]{40}$/;
    const visitGitObjectIds = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visitGitObjectIds(item, path + '[' + index + ']'));
        return;
      }
      if (!isRecord(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (key.endsWith('_sha')) {
          expect(stringValue(child, path + '.' + key)).toMatch(gitObjectId);
        } else {
          visitGitObjectIds(child, path + '.' + key);
        }
      }
    };

    expect(reconciliation.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(reconciliation.last_reconciled_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(reconciliation.reconciled_base_sha).toMatch(gitObjectId);
    expect(reconciliation).not.toHaveProperty('main_sha');
    expect(reconciliation).not.toHaveProperty('capabilities');
    visitGitObjectIds(reconciliation, 'capability_reconciliation');

    const executionPolicy = reconciliation.execution_policy;
    expect(isRecord(executionPolicy)).toBe(true);
    if (!isRecord(executionPolicy)) return;
    const dropletPolicy = executionPolicy.production_droplet;
    expect(isRecord(dropletPolicy)).toBe(true);
    if (!isRecord(dropletPolicy)) return;
    expect(dropletPolicy.broad_test_execution).toBe('FORBIDDEN');
    expect(stringArray(dropletPolicy.allowed_operations)).toContain(
      'encrypted backup stream; restore only on an isolated runner',
    );
    expect(
      stringArray(dropletPolicy.evidence).some((entry) => /2026-07-29.*OOM/i.test(entry)),
    ).toBe(true);

    const retirementPolicy = reconciliation.source_retirement_policy;
    expect(isRecord(retirementPolicy)).toBe(true);
    if (!isRecord(retirementPolicy)) return;
    expect(retirementPolicy.retirement_status).toBe('RETIRE_APPROVED');
    expect(stringArray(retirementPolicy.required_approval_fields)).toEqual([
      'approved_at',
      'approved_by',
      'snapshot_sha256',
      'snapshot_uri',
      'evidence',
      'authorization',
    ]);
    expect(stringArray(retirementPolicy.dirty_worktree_required_approval_fields)).toEqual([
      'captured_content_sha256',
    ]);
    expect(stringArray(retirementPolicy.authorization_required_fields)).toEqual([
      'kind',
      'issuer',
      'signer_identity',
      'subject_sha256',
      'statement_sha256',
      'statement_uri',
      'bundle_sha256',
      'bundle_uri',
    ]);
    expect(retirementPolicy.authorization_contract).toBe('SIGSTORE_BUNDLE_V1');

    const allocationPolicy = reconciliation.finding_allocation_policy;
    expect(isRecord(allocationPolicy)).toBe(true);
    if (!isRecord(allocationPolicy)) return;
    expect(allocationPolicy.canonical_registry).toBe('docs/reviews/_registry/findings.jsonl');
    expect(allocationPolicy.allocator).toBe('tools/gates/finding-registry.ts');
    expect(allocationPolicy.legacy_refs_are_noncanonical).toBe(true);
    expect(isRecord(allocationPolicy.reserved_domain_floors)).toBe(true);
    if (isRecord(allocationPolicy.reserved_domain_floors)) {
      expect(Object.keys(allocationPolicy.reserved_domain_floors).length).toBeGreaterThan(40);
      for (const floor of Object.values(allocationPolicy.reserved_domain_floors)) {
        if (typeof floor !== 'number') throw new Error('finding reservation floor must be numeric');
        expect(Number.isSafeInteger(floor)).toBe(true);
      }
    }

    const sources = objectArray(reconciliation.sources);
    expect(sources).toHaveLength(44);
    const sourceIds = sources.map((source) => stringValue(source.id, 'source.id'));
    const sourceCoordinates = sources.map((source) => {
      const id = stringValue(source.id, 'source.id');
      const kind = stringValue(source.kind, id + '.kind');
      const locator = stringValue(source.locator, id + '.locator');
      const headSha = stringValue(source.head_sha, id + '.head_sha');
      expect(headSha).toMatch(gitObjectId);
      expect(['REMOTE_BRANCH', 'LOCAL_BRANCH', 'DIRTY_WORKTREE']).toContain(kind);
      expect(['UNASSESSED', 'ASSESSING', 'PRESERVED_DIRTY', 'SUPERSEDED', 'INTEGRATED']).toContain(
        source.state,
      );
      expect([
        'ALREADY_ON_MAIN',
        'SUPERSEDE',
        'REIMPLEMENT',
        'SELECTIVE_EXTRACT',
        'EXACT_HEAD_PR',
        'FORENSIC_ONLY',
        'PRESERVE_PENDING',
      ]).toContain(source.disposition);
      expect(stringValue(source.assessed_at, id + '.assessed_at')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stringValue(source.assessment, id + '.assessment')).not.toBe('');
      expect(stringArray(source.evidence).length).toBeGreaterThan(0);
      expect(stringValue(source.next_action, id + '.next_action')).not.toBe('');

      if (kind === 'DIRTY_WORKTREE') {
        expect(stringValue(source.content_sha256, id + '.content_sha256')).toMatch(
          /^[0-9a-f]{64}$/,
        );
      }
      if (source.disposition === 'ALREADY_ON_MAIN') {
        expect(kind).toBe('REMOTE_BRANCH');
        expect(source.state).toBe('INTEGRATED');
        expect(isRecord(source.main_proof)).toBe(true);
        if (!isRecord(source.main_proof)) return '';
        const proofKind = stringValue(source.main_proof.kind, id + '.main_proof.kind');
        expect(['ANCESTOR', 'TREE_EQUIVALENT']).toContain(proofKind);
        expect(source.main_proof.source_commit_sha).toBe(headSha);
        if (proofKind === 'TREE_EQUIVALENT') {
          expect(source.main_proof.source_tree_sha).toBe(source.main_proof.main_tree_sha);
        }
      } else {
        expect(source.main_proof).toBeUndefined();
      }
      if (source.state === 'INTEGRATED') {
        expect(source.disposition).toBe('ALREADY_ON_MAIN');
      }
      if (source.state === 'SUPERSEDED') {
        expect(['SUPERSEDE', 'FORENSIC_ONLY']).toContain(source.disposition);
      }
      if (source.retirement !== undefined) {
        expect(['SUPERSEDED', 'INTEGRATED']).toContain(source.state);
        expect(isRecord(source.retirement)).toBe(true);
        if (!isRecord(source.retirement)) return '';
        expect(source.retirement.status).toBe('RETIRE_APPROVED');
        const approvedAt = stringValue(
          source.retirement.approved_at,
          id + '.retirement.approved_at',
        );
        expect(approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(new Date(approvedAt).toISOString()).toBe(approvedAt);
        expect(stringValue(source.retirement.approved_by, id + '.retirement.approved_by')).not.toBe(
          '',
        );
        expect(
          stringValue(source.retirement.snapshot_sha256, id + '.retirement.snapshot_sha256'),
        ).toMatch(/^[0-9a-f]{64}$/);
        const snapshotUri = stringValue(
          source.retirement.snapshot_uri,
          id + '.retirement.snapshot_uri',
        );
        expect(snapshotUri).toContain(
          `artifact://sha256/${String(source.retirement.snapshot_sha256)}/`,
        );
        expect(stringArray(source.retirement.evidence).length).toBeGreaterThan(0);
        expect(source.retirement.evidence).toContain(snapshotUri);
        expect(isRecord(source.retirement.authorization)).toBe(true);
        if (!isRecord(source.retirement.authorization)) return '';
        expect(source.retirement.authorization.kind).toBe('SIGSTORE_BUNDLE_V1');
        const signedSubjectSha256 = stringValue(
          source.retirement.authorization.subject_sha256,
          id + '.retirement.authorization.subject_sha256',
        );
        expect(signedSubjectSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(
          stringValue(
            source.retirement.authorization.bundle_sha256,
            id + '.retirement.authorization.bundle_sha256',
          ),
        ).toMatch(/^[0-9a-f]{64}$/);
        const bundleUri = stringValue(
          source.retirement.authorization.bundle_uri,
          id + '.retirement.authorization.bundle_uri',
        );
        expect(bundleUri).toContain(
          `artifact://sha256/${String(source.retirement.authorization.bundle_sha256)}/`,
        );
        expect(source.retirement.evidence).toContain(bundleUri);
        const statementSha256 = stringValue(
          source.retirement.authorization.statement_sha256,
          id + '.retirement.authorization.statement_sha256',
        );
        expect(statementSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(signedSubjectSha256).toBe(statementSha256);
        const statementUri = stringValue(
          source.retirement.authorization.statement_uri,
          id + '.retirement.authorization.statement_uri',
        );
        expect(statementUri).toContain(statementSha256);
        expect(source.retirement.evidence).toContain(statementUri);
        expect(
          stringValue(
            source.retirement.authorization.issuer,
            id + '.retirement.authorization.issuer',
          ),
        ).toBe('https://token.actions.githubusercontent.com');
        expect(
          stringValue(
            source.retirement.authorization.signer_identity,
            id + '.retirement.authorization.signer_identity',
          ),
        ).toBe(
          'https://github.com/Okan-wqm/aquaculture_platform/.github/workflows/source-retirement.yml@refs/heads/main',
        );
        if (kind === 'DIRTY_WORKTREE') {
          expect(source.retirement.captured_content_sha256).toBe(source.content_sha256);
        } else {
          expect(source.retirement.captured_content_sha256).toBeUndefined();
        }
      }
      if (source.slice_proof !== undefined) {
        expect(isRecord(source.slice_proof)).toBe(true);
        if (isRecord(source.slice_proof)) {
          expect(source.slice_proof.kind).toBe('SLICE_BLOB_EQ');
          for (const pathBlob of objectArray(source.slice_proof.path_blobs)) {
            expect(stringValue(pathBlob.path, id + '.slice.path')).not.toBe('');
            expect(stringValue(pathBlob.blob_sha, id + '.slice.blob_sha')).toMatch(gitObjectId);
          }
        }
      }
      return kind + ':' + locator + '@' + headSha;
    });
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(new Set(sourceCoordinates).size).toBe(sourceCoordinates.length);

    const findingInventory = reconciliation.finding_inventory;
    expect(isRecord(findingInventory)).toBe(true);
    if (!isRecord(findingInventory)) return;
    expect(findingInventory.schema_version).toBe(3);
    const artifactSha256 = stringValue(
      findingInventory.artifact_sha256,
      'finding_inventory.artifact_sha256',
    );
    expect(findingInventory.artifact_path).toBe(
      `docs/plans/${PLAN_ID}/source-findings.${artifactSha256}.jsonl`,
    );
    expect(findingInventory.occurrence_count).toBe(1012);
    expect(stringValue(findingInventory.occurrence_sha256, 'finding_inventory.digest')).toBe(
      '35f21f0c4297c841f82a8ab1005595921b107eb7e590824058b2750e7ffb75f0',
    );
    expect(objectArray(findingInventory.source_attestations)).toHaveLength(sources.length);
    const sourceFindingRows = readFileSync(sourceFindingsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const row: unknown = JSON.parse(line);
        if (!isRecord(row)) throw new Error('source finding row must be an object');
        return row;
      });
    expect(sourceFindingRows).toHaveLength(1012);
    expect(sourceFindingRows.filter((row) => row.classification === 'ID_COLLISION')).toHaveLength(
      25,
    );
    expect(
      sourceFindingRows.filter((row) => row.classification === 'LEGACY_UNREGISTERED'),
    ).toHaveLength(674);
    expect(
      sourceFindingRows.filter((row) => row.classification === 'PENDING_ADJUDICATION'),
    ).toHaveLength(313);

    const gateProfiles = reconciliation.gate_profiles;
    expect(isRecord(gateProfiles)).toBe(true);
    if (!isRecord(gateProfiles)) return;
    expect(Object.keys(gateProfiles)).toEqual(['ATOMIC_PR_V1']);
    const atomicProfile = gateProfiles.ATOMIC_PR_V1;
    expect(isRecord(atomicProfile)).toBe(true);
    if (!isRecord(atomicProfile)) return;
    const requiredGateIds = [
      'duplicate-authority-absent',
      'root-cause-closed',
      'focused-tests-green',
      'affected-test-lint-build-green',
      'exact-head-actions-green',
    ];
    expect(stringArray(atomicProfile.required_gate_ids)).toEqual(requiredGateIds);
    expect(atomicProfile.evidence_contracts).toEqual({
      'duplicate-authority-absent': 'COMMAND_RESULT',
      'root-cause-closed': 'FINDING_STATE',
      'focused-tests-green': 'COMMAND_RESULT',
      'affected-test-lint-build-green': 'COMMAND_RESULT',
      'exact-head-actions-green': 'GITHUB_CHECK',
    });
    expect(atomicProfile).not.toHaveProperty('status');
    expect(atomicProfile).not.toHaveProperty('evidence');
    expect(atomicProfile).not.toHaveProperty('gates');

    const groups = objectArray(reconciliation.capability_groups);
    const units = objectArray(reconciliation.integration_units);
    const integrationOrder = stringArray(reconciliation.integration_order);
    const sourceAdjudications = objectArray(reconciliation.source_adjudications);
    const sourceSlices = objectArray(reconciliation.source_slices);
    const unitIds = units.map((unit) => stringValue(unit.id, 'unit.id'));
    const knownUnits = new Set(unitIds);
    const knownSources = new Set(sourceIds);
    const sourceSliceIds = sourceSlices.map((slice) => stringValue(slice.id, 'source_slice.id'));
    const knownSourceSlices = new Set(sourceSliceIds);
    const governedOwners = new Set(stringArray(manifest.agent_roster));
    const dispatchableAgentNames = new Set(
      new LocalDispatchIdentityCatalog().definitions().map((definition) => definition.name),
    );
    const registryById = new Map(
      registryEntries.map((entry) => [stringValue(entry.id, 'registry.id'), entry]),
    );
    const orderIndex = new Map(integrationOrder.map((id, index) => [id, index]));

    expect(units).toHaveLength(126);
    expect(integrationOrder).toHaveLength(126);
    expect(new Set(integrationOrder).size).toBe(integrationOrder.length);
    expect([...integrationOrder].sort()).toEqual([...unitIds].sort());
    expect(new Set(unitIds).size).toBe(unitIds.length);

    const adjudicatedSourceIds = sourceAdjudications.map((adjudication) => {
      const id = stringValue(adjudication.id, 'source_adjudication.id');
      const sourceId = stringValue(adjudication.source_id, id + '.source_id');
      expect(id).toBe(`SA-${sourceId}`);
      expect(knownSources.has(sourceId)).toBe(true);
      stringValue(adjudication.status, id + '.status');
      const executionOwner = stringValue(adjudication.execution_owner, id + '.execution_owner');
      expect(governedOwners.has(executionOwner)).toBe(true);
      expect(dispatchableAgentNames.has(executionOwner)).toBe(true);
      expect(stringValue(adjudication.deadline, id + '.deadline')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stringValue(adjudication.plan, id + '.plan')).not.toBe('');
      return sourceId;
    });
    expect(sourceAdjudications).toHaveLength(sources.length);
    expect(new Set(adjudicatedSourceIds).size).toBe(adjudicatedSourceIds.length);
    expect([...adjudicatedSourceIds].sort()).toEqual([...sourceIds].sort());

    expect(new Set(sourceSliceIds).size).toBe(sourceSliceIds.length);
    for (const slice of sourceSlices) {
      const id = stringValue(slice.id, 'source_slice.id');
      expect(knownSources.has(stringValue(slice.source_id, id + '.source_id'))).toBe(true);
      expect(['IMPLEMENTATION_CANDIDATE', 'MAIN_EQUIVALENCE', 'FORENSIC_EVIDENCE']).toContain(
        slice.purpose,
      );
      expect(slice.authority_role).toBe('PROVENANCE_ONLY');
      expect(['RESOLVED', 'UNRESOLVED']).toContain(slice.resolution);
      expect(isRecord(slice.selector)).toBe(true);
      if (!isRecord(slice.selector)) continue;
      expect([
        'COMMIT_SET',
        'COMMIT_PATH_SET',
        'PATH_BLOB_SET',
        'DIRTY_PATCH',
        'WHOLE_TREE_PROOF',
      ]).toContain(slice.selector.kind);
      expect(stringValue(slice.selector_sha256, id + '.selector_sha256')).toBe(
        computeSourceSliceSelectorSha256(slice.selector),
      );
      if (slice.selector.kind === 'WHOLE_TREE_PROOF') {
        expect(slice.purpose).not.toBe('IMPLEMENTATION_CANDIDATE');
      }
    }

    const groupUnitIds: string[] = [];
    const groupIds: string[] = [];
    const reportingKeys: string[] = [];
    for (const group of groups) {
      expect(Object.keys(group).sort()).toEqual(
        ['id', 'integration_unit_ids', 'reporting_key', 'title'].sort(),
      );
      groupIds.push(stringValue(group.id, 'group.id'));
      stringValue(group.title, 'group.title');
      reportingKeys.push(stringValue(group.reporting_key, 'group.reporting_key'));
      for (const unitId of stringArray(group.integration_unit_ids)) {
        expect(knownUnits.has(unitId)).toBe(true);
        groupUnitIds.push(unitId);
      }
    }
    expect(new Set(groupIds).size).toBe(groupIds.length);
    expect(new Set(reportingKeys).size).toBe(reportingKeys.length);
    expect(groupUnitIds.sort()).toEqual([...unitIds].sort());
    expect(new Set(groupUnitIds).size).toBe(groupUnitIds.length);

    const authorityKeys: string[] = [];
    const claimedSourceSliceIds: string[] = [];
    const ownedFindingIds: string[] = [];
    const allLegacyFindingRefs: string[] = [];
    const canonicalPromotionOccurrences: string[] = [];
    const canonicalPromotionFindings: string[] = [];
    const dependencyGraph = new Map<string, string[]>();
    const sourceRefPattern =
      /^(SRC-(?:R|L|W)-\d{3})#(?:(?:[A-Z][A-Z0-9]*-)*)(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}(?:-[A-Z0-9]+)?$/;

    expect(objectArray(findingInventory.unit_attestations)).toHaveLength(units.length);

    for (const unit of units) {
      const id = stringValue(unit.id, 'unit.id');
      authorityKeys.push(stringValue(unit.authority_key, id + '.authority_key'));
      expect(['ASSESSING', 'READY', 'INTEGRATING', 'VERIFIED', 'BLOCKED_EXTERNAL']).toContain(
        unit.state,
      );
      expect([
        'ASSESS',
        'CHERRY_PICK',
        'REIMPLEMENT',
        'MERGE',
        'ALREADY_ON_MAIN',
        'SUPERSEDE',
        'EXTERNAL_ACTION',
      ]).toContain(unit.strategy);
      expect(unit).not.toHaveProperty('disposition');
      expect(unit).not.toHaveProperty('finding_ids');
      expect(unit).not.toHaveProperty('reported_finding_ids');
      expect(unit).not.toHaveProperty('legacy_finding_refs');
      expect(unit).not.toHaveProperty('acceptance_gates');
      expect(unit).not.toHaveProperty('owner');
      expect(unit).not.toHaveProperty('source_ids');
      expect(unit).not.toHaveProperty('derived_from');
      expect(stringValue(unit.target_date, id + '.target_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stringValue(unit.gap, id + '.gap')).not.toBe('');
      expect(stringArray(unit.implementation_plan).length).toBeGreaterThan(0);

      expect(isRecord(unit.ownership)).toBe(true);
      if (!isRecord(unit.ownership)) continue;
      const executionOwner = stringValue(unit.ownership.execution_owner, id + '.execution_owner');
      const mandatoryReviewers = stringArray(unit.ownership.mandatory_reviewers);
      expect(governedOwners.has(executionOwner)).toBe(true);
      expect(dispatchableAgentNames.has(executionOwner)).toBe(true);
      expect(new Set(mandatoryReviewers).size).toBe(mandatoryReviewers.length);
      expect(mandatoryReviewers).not.toContain(executionOwner);
      for (const reviewer of mandatoryReviewers) {
        expect(governedOwners.has(reviewer)).toBe(true);
        expect(dispatchableAgentNames.has(reviewer)).toBe(true);
      }

      const sourceSlicesForUnit =
        unit.source_slice_ids === undefined ? [] : stringArray(unit.source_slice_ids);
      expect(new Set(sourceSlicesForUnit).size).toBe(sourceSlicesForUnit.length);
      for (const sourceSliceId of sourceSlicesForUnit) {
        expect(knownSourceSlices.has(sourceSliceId)).toBe(true);
        claimedSourceSliceIds.push(sourceSliceId);
      }

      const dependencies = stringArray(unit.depends_on);
      expect(new Set(dependencies).size).toBe(dependencies.length);
      for (const dependency of dependencies) {
        expect(knownUnits.has(dependency)).toBe(true);
        expect(dependency).not.toBe(id);
        expect(orderIndex.get(dependency)).toBeLessThan(orderIndex.get(id)!);
      }
      dependencyGraph.set(id, dependencies);

      expect(unit.gate_profile).toBe('ATOMIC_PR_V1');
      objectArray(unit.main_evidence);

      expect(isRecord(unit.finding_binding)).toBe(true);
      if (!isRecord(unit.finding_binding)) continue;
      const binding = unit.finding_binding;
      const bindingStatus = stringValue(binding.status, id + '.finding_binding.status');
      const findingIds = stringArray(binding.finding_ids);
      const reportedFindingIds = stringArray(binding.reported_finding_ids);
      const unitLegacyFindingRefs = stringArray(binding.legacy_finding_refs);

      for (const findingId of reportedFindingIds) {
        expect(registryById.has(findingId)).toBe(true);
      }
      for (const legacyRef of unitLegacyFindingRefs) {
        const match = sourceRefPattern.exec(legacyRef);
        expect(match).not.toBeNull();
        if (match) expect(knownSources.has(match[1]!)).toBe(true);
        allLegacyFindingRefs.push(legacyRef);
      }
      if (binding.canonical_promotion !== undefined) {
        expect(isRecord(binding.canonical_promotion)).toBe(true);
        if (isRecord(binding.canonical_promotion)) {
          const promotion = binding.canonical_promotion;
          expect(Object.keys(promotion).sort()).toEqual(
            [
              'schema_version',
              'prior_artifact_sha256',
              'prior_occurrence_id',
              'prior_source_head_sha',
              'source_ref',
              'integration_unit_id',
              'canonical_finding_id',
              'candidate_registry_blob_sha',
              'semantic_sha256',
              'recorded_at',
              'recorded_by',
            ].sort(),
          );
          expect(promotion.schema_version).toBe(1);
          expect(bindingStatus).toBe('BOUND');
          expect(unitLegacyFindingRefs).toEqual([]);
          expect(promotion.integration_unit_id).toBe(id);
          expect(promotion.recorded_by).toBe(executionOwner);
          expect(stringValue(promotion.recorded_at, id + '.promotion.recorded_at')).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
          );
          expect(
            stringValue(promotion.prior_artifact_sha256, id + '.promotion.prior_artifact_sha256'),
          ).toMatch(/^[0-9a-f]{64}$/);
          const priorOccurrenceId = stringValue(
            promotion.prior_occurrence_id,
            id + '.promotion.prior_occurrence_id',
          );
          expect(priorOccurrenceId).toMatch(/^[0-9a-f]{64}$/);
          expect(
            stringValue(promotion.prior_source_head_sha, id + '.promotion.prior_source_head_sha'),
          ).toMatch(gitObjectId);
          expect(
            stringValue(
              promotion.candidate_registry_blob_sha,
              id + '.promotion.candidate_registry_blob_sha',
            ),
          ).toMatch(gitObjectId);
          expect(stringValue(promotion.semantic_sha256, id + '.promotion.semantic_sha256')).toMatch(
            /^[0-9a-f]{64}$/,
          );
          const promotionSourceRef = stringValue(
            promotion.source_ref,
            id + '.promotion.source_ref',
          );
          expect(promotionSourceRef).toMatch(sourceRefPattern);
          const canonicalFindingId = stringValue(
            promotion.canonical_finding_id,
            id + '.promotion.canonical_finding_id',
          );
          expect(promotionSourceRef.endsWith(`#${canonicalFindingId}`)).toBe(true);
          expect(findingIds).toContain(canonicalFindingId);
          canonicalPromotionOccurrences.push(priorOccurrenceId);
          canonicalPromotionFindings.push(canonicalFindingId);
        }
      }

      if (bindingStatus === 'BOUND') {
        expect(findingIds.length).toBeGreaterThan(0);
        expect(unitLegacyFindingRefs).toEqual([]);
        const accountableRegistryOwner = stringValue(
          unit.ownership.accountable_registry_owner,
          id + '.ownership.accountable_registry_owner',
        );
        for (const findingId of findingIds) {
          const registryEntry = registryById.get(findingId);
          expect(registryEntry).toBeDefined();
          if (!registryEntry) continue;
          expect(registryEntry.owner_agent).toBe(accountableRegistryOwner);
          ownedFindingIds.push(findingId);
          if (unit.state === 'VERIFIED') expect(registryEntry.state).toBe('RESOLVED');
        }

        expect(isRecord(unit.deadline_alignment)).toBe(true);
        if (isRecord(unit.deadline_alignment)) {
          const dated = findingIds.filter((findingId) => {
            const deadline = registryById.get(findingId)?.deadline;
            return typeof deadline === 'string' && deadline.length > 0;
          });
          const expectedMismatches = dated
            .filter(
              (findingId) =>
                stringValue(registryById.get(findingId)?.deadline, findingId + '.deadline') <
                stringValue(unit.target_date, id + '.target_date'),
            )
            .map((findingId) => ({
              finding_id: findingId,
              registry_deadline: registryById.get(findingId)?.deadline,
              target_date: unit.target_date,
            }));
          const expectedStatus =
            expectedMismatches.length > 0
              ? 'REGISTRY_RESCHEDULE_REQUIRED'
              : dated.length > 0
                ? 'ALIGNED'
                : 'NO_DEADLINE';
          expect(unit.deadline_alignment.status).toBe(expectedStatus);
          expect(objectArray(unit.deadline_alignment.mismatches)).toEqual(expectedMismatches);
          if (expectedStatus === 'REGISTRY_RESCHEDULE_REQUIRED') {
            expect(['READY', 'INTEGRATING', 'VERIFIED']).not.toContain(unit.state);
          }
        }
      } else if (bindingStatus === 'CREATE_REQUIRED') {
        expect(unit.ownership.accountable_registry_owner).toBeNull();
        expect(findingIds).toEqual([]);
        expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).toContain(binding.severity);
        stringValue(binding.domain, id + '.finding_binding.domain');
        stringValue(binding.reason, id + '.finding_binding.reason');
        expect(['READY', 'INTEGRATING', 'VERIFIED']).not.toContain(unit.state);
        expect(unit.deadline_alignment).toBeUndefined();
      } else {
        expect(bindingStatus).toBe('NOT_REQUIRED');
        expect(unit.ownership.accountable_registry_owner).toBeNull();
        expect(findingIds).toEqual([]);
        stringValue(binding.reason, id + '.finding_binding.reason');
        expect(unit.deadline_alignment).toBeUndefined();
      }

      if (id.startsWith('IU-LEDGER-')) {
        expect(isRecord(unit.authority_boundary)).toBe(true);
        if (isRecord(unit.authority_boundary)) {
          expect(unit.authority_boundary.primary_authority).toBe('JSONL_PRIMARY');
          expect(['ABSENT', 'POSTGRES_SHADOW']).toContain(unit.authority_boundary.postgres_role);
          expect(['FORBIDDEN', 'PRE_PRODUCTION_ONLY']).toContain(
            unit.authority_boundary.postgres_primary_policy,
          );
          expect(unit.authority_boundary.production_cutover).toBe(false);
          expect(JSON.stringify(unit.authority_boundary)).not.toContain('POSTGRES_PRIMARY');
          if (unit.authority_boundary.postgres_primary_policy === 'PRE_PRODUCTION_ONLY') {
            expect(id).toBe('IU-LEDGER-007');
          }
        }
      } else {
        expect(unit.authority_boundary).toBeUndefined();
      }
    }

    expect(new Set(authorityKeys).size).toBe(authorityKeys.length);
    expect(claimedSourceSliceIds.sort()).toEqual([...sourceSliceIds].sort());
    expect(new Set(claimedSourceSliceIds).size).toBe(claimedSourceSliceIds.length);
    expect(new Set(ownedFindingIds).size).toBe(ownedFindingIds.length);
    expect(new Set(allLegacyFindingRefs).size).toBe(allLegacyFindingRefs.length);
    expect(new Set(canonicalPromotionOccurrences).size).toBe(canonicalPromotionOccurrences.length);
    expect(new Set(canonicalPromotionFindings).size).toBe(canonicalPromotionFindings.length);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error('Integration-unit dependency cycle: ' + id);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of dependencyGraph.get(id) ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of unitIds) visit(id);

    const unitsById = new Map(units.map((unit) => [stringValue(unit.id, 'unit.id'), unit]));
    const ledgerParity = unitsById.get('IU-LEDGER-006');
    const ledgerCutover = unitsById.get('IU-LEDGER-007');
    expect(ledgerParity).toBeDefined();
    expect(ledgerCutover).toBeDefined();
    expect(objectArray(ledgerParity?.acceptance_requirements)).toEqual([
      {
        id: 'ledger-two-main-parity-cycles',
        kind: 'TWO_PROTECTED_MAIN_PARITY_CYCLES',
        minimum_cycles: 2,
        distinct_protected_main_shas: true,
      },
    ]);
    expect(objectArray(ledgerCutover?.acceptance_requirements)).toEqual([
      {
        id: 'ledger-preproduction-cutover-rollback',
        kind: 'LEDGER_PREPRODUCTION_CUTOVER_ROLLBACK',
        environment: 'PRE_PRODUCTION_ONLY',
        production_cutover: 'FORBIDDEN',
        required_evidence_kinds: [
          'ENCRYPTED_RESTORE',
          'SHADOW_PARITY',
          'PRE_PRODUCTION_CUTOVER',
          'ROLLBACK',
        ],
      },
    ]);
  });

  it('uses integration_order as the sole topological order authority', () => {
    const reordered: unknown = JSON.parse(JSON.stringify(manifest));
    expect(isRecord(reordered)).toBe(true);
    if (!isRecord(reordered) || !isRecord(reordered.capability_reconciliation)) return;

    const units = objectArray(reordered.capability_reconciliation.integration_units);
    reordered.capability_reconciliation.integration_units = [...units].reverse();
    const requiredStatus = parseRequiredStatusContract(readFileSync(REQUIRED_STATUS_CHECKS_PATH));

    expect(
      validateIntegrationEvidenceStatic(
        parseIntegrationEvidenceManifest(reordered),
        requiredStatus,
      ),
    ).toEqual([]);
  });

  it('rejects duplicate typed behavior authority and source provenance as behavior authority', () => {
    const requiredStatus = parseRequiredStatusContract(readFileSync(REQUIRED_STATUS_CHECKS_PATH));
    const collisionManifest: unknown = JSON.parse(JSON.stringify(manifest));
    expect(isRecord(collisionManifest)).toBe(true);
    if (!isRecord(collisionManifest) || !isRecord(collisionManifest.capability_reconciliation)) {
      return;
    }
    const collisionUnits = objectArray(
      collisionManifest.capability_reconciliation.integration_units,
    );
    const unitsWithTargets = collisionUnits.filter(
      (unit) => Array.isArray(unit.authority_targets) && unit.authority_targets.length > 0,
    );
    expect(unitsWithTargets.length).toBeGreaterThanOrEqual(2);
    const firstTarget = objectArray(unitsWithTargets[0]?.authority_targets)[0];
    expect(firstTarget).toBeDefined();
    unitsWithTargets[1]!.authority_targets = [
      JSON.parse(JSON.stringify(firstTarget)) as Record<string, unknown>,
    ];
    const collisionCodes = validateIntegrationEvidenceStatic(
      parseIntegrationEvidenceManifest(collisionManifest),
      requiredStatus,
    ).map((issue) => issue.code);
    expect(collisionCodes).toContain('AUTHORITY_TARGET_COLLISION');

    const sourceAuthorityManifest: unknown = JSON.parse(JSON.stringify(manifest));
    expect(isRecord(sourceAuthorityManifest)).toBe(true);
    if (
      !isRecord(sourceAuthorityManifest) ||
      !isRecord(sourceAuthorityManifest.capability_reconciliation)
    ) {
      return;
    }
    const sourceAuthorityUnit = objectArray(
      sourceAuthorityManifest.capability_reconciliation.integration_units,
    )[0];
    expect(sourceAuthorityUnit).toBeDefined();
    sourceAuthorityUnit!.authority_targets = [
      {
        kind: 'POLICY',
        resolution: 'UNRESOLVED',
        policy_id: 'SRC-R-001',
      },
    ];
    const sourceAuthorityCodes = validateIntegrationEvidenceStatic(
      parseIntegrationEvidenceManifest(sourceAuthorityManifest),
      requiredStatus,
    ).map((issue) => issue.code);
    expect(sourceAuthorityCodes).toContain('SOURCE_CANNOT_BE_BEHAVIOR_AUTHORITY');
  });

  it('rejects retirement records without the cryptographic authorization contract', () => {
    const retirementManifest: unknown = JSON.parse(JSON.stringify(manifest));
    expect(isRecord(retirementManifest)).toBe(true);
    if (!isRecord(retirementManifest) || !isRecord(retirementManifest.capability_reconciliation)) {
      return;
    }
    const terminalSource = objectArray(retirementManifest.capability_reconciliation.sources).find(
      (source) => source.state === 'INTEGRATED' || source.state === 'SUPERSEDED',
    );
    expect(terminalSource).toBeDefined();
    if (!terminalSource) return;
    terminalSource.retirement = {
      status: 'RETIRE_APPROVED',
      approved_at: '2026-07-29T12:00:00.000Z',
      approved_by: 'infra-expert',
      snapshot_sha256: 'a'.repeat(64),
      snapshot_uri: `artifact://sha256/${'a'.repeat(64)}/snapshot.tar.zst`,
      evidence: [`artifact://sha256/${'a'.repeat(64)}/snapshot.tar.zst`],
    };

    expect(() => parseInventoryManifest(retirementManifest)).toThrow(
      'retirement.authorization must be an object',
    );
  });
});
