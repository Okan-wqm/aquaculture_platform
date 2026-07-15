/**
 * Enterprise-grade debt closure plan contract.
 *
 * The 2026-06-18 debt-closure program is a control-plane artifact, not a
 * narrative-only roadmap. This invariant keeps its README, machine-readable
 * manifest, and CODEOWNERS coverage present and internally consistent.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

  it('keeps the governed plan README present with the wave structure', () => {
    expect(readme).toContain('# Enterprise-Grade Debt Closure Program');
    expect(readme).toContain('## Waves');
    expect(readme).toContain('### Wave 0 - Truth Freeze And Control Plane');
    expect(readme).toContain('### Wave 6 - Closure, Evidence, Release Discipline');
    expect(readme).toContain('The companion manifest is `manifest.json`.');
    expect(readme).toContain('`finding-truth-table.md`');
    expect(readme).toContain('`.github/manifests/main-required-status-checks.json`');
    expect(readme).toContain('`npm run gates:required-status-checks`');
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

  it('keeps active criticals, core agents, and attacker lanes explicit', () => {
    const activeCriticalIds = stringArray(manifest.active_critical_ids);
    const agentRoster = stringArray(manifest.agent_roster);
    const attackers = stringArray(manifest.reverse_engineering_attackers);

    expect(activeCriticalIds).toHaveLength(
      numberValue(manifest.active_critical_count, 'active_critical_count'),
    );
    expect(activeCriticalIds.every((id) => id.includes('-CRITICAL-'))).toBe(true);
    expect(agentRoster.length).toBeGreaterThanOrEqual(12);
    expect(agentRoster).toContain('architectural-arbiter');
    expect(agentRoster).toContain('context-manager');
    expect(agentRoster).toContain('security-reviewer');
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
});
