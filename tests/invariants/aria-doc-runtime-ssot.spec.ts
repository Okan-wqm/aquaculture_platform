import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';

import { checkCurrentState } from '../../tools/gates/aria-authority-hash';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';
const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
}

function gitSucceeds(args: string[]): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`, 'utf8');
  chmodSync(path, 0o755);
}

const LIVE_DOCS = [
  'docs/aria/SPEC.md',
  'docs/aria/CONTRACTS.md',
  'docs/aria/IDENTITY.md',
  'docs/aria/ROADMAP.md',
  'docs/adr/033-aria-autonomous-profile.md',
];

const ARCHITECTURE_DOC = 'docs/aria/ARCHITECTURE.md';
const ENTERPRISE_AUTONOMY_DOC = 'docs/aria/ENTERPRISE_AUTONOMY_SSOT.md';
const SNOWBALL_CURATION_RECORD = 'docs/aria/reviews/2026-06-19-snowball-curation-audit.md';
const BURN_IN_SCHEMA = 'docs/aria/schemas/autonomy-burn-in-report.schema.json';
const PLAN_MARKERS = ['ARIA-HISTORICAL', 'ARIA-SUPERSEDED', 'ARIA-LIVE-AUTHORITY'];
const STALE_LIVE_PLAN_PATTERNS = [
  /merge_if_green`?\s+is\s+the\s+only\s+(?:real\s+)?merge\s+executor/i,
  /Claude\/Anthropic(?:-oriented)?\s+(?:execution\s+model|runtime|executor)/i,
  /(?:full|complete)\s+autonom(?:y|ous).*closed/i,
  /generated(?:\/mechanically checked)?\s+docs\s+SSoT\s+complete/i,
];

const HISTORICAL_ARIA_RUNBOOKS = [
  'docs/runbooks/aria-v3-1-smoke.md',
  'docs/runbooks/aria-github-app-setup.md',
];

const LIVE_WORKFLOWS = [
  '.github/workflows/aria-agent-eval.yml',
  '.github/workflows/aria-agent-executor.yml',
  '.github/workflows/aria-daily-report.yml',
  '.github/workflows/aria-kernel.yml',
  '.github/workflows/aria-operational-proof.yml',
];

const ARIA_SUITE_RUNNER = 'scripts/ci/aria-suite-run.sh';
const ARIA_SUITE_SELECTOR = 'scripts/ci/aria-suite-changed.mjs';
const ARIA_IMPORT_GRAPH = 'scripts/ci/aria-import-graph.py';
// The selector probes parse the real kernel (~1,200 modules) before their cache is warm.
const SELECTOR_PROBE_MS = 180_000;
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const ARIA_ADAPTERS_DIR = 'tools/aria-adapters';
const ARIA_PYTEST_NATIVE_PLUGIN = 'aria_kernel.pytest_native_only';
// ARIA-HIGH-136 — measured and reasoned next to the values in aria-kernel.yml.
const KERNEL_SHARD_BUDGET_MINUTES = 30;
const KERNEL_LANE_BUDGET_MINUTES = 15;

type WorkflowStep = { id?: string; run?: string; env?: Record<string, string> };
type PullRequestWorkflow = {
  on?: { pull_request?: null | { paths?: string[] } };
  jobs?: Record<
    string,
    {
      'timeout-minutes'?: number;
      needs?: string | string[];
      if?: string;
      strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
      steps?: WorkflowStep[];
    }
  >;
};

// INFRA-HIGH-215 — the kernel lane runs on every PR (`aria-kernel` is a required
// context); its `changes` job decides from KERNEL_SURFACE whether the suite runs.
function kernelScopeStep(workflow: PullRequestWorkflow): WorkflowStep {
  const step = (workflow.jobs?.changes?.steps ?? []).find((candidate) => candidate.id === 'scope');
  if (step === undefined) throw new Error('aria-kernel.yml: the `changes` job has no `scope` step');
  return step;
}

function kernelSurface(workflow: PullRequestWorkflow): string[] {
  return (kernelScopeStep(workflow).env?.KERNEL_SURFACE ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

const ARCHITECTURE_SECTIONS = [
  'Authority Chain / Yetki Zinciri',
  'Main Value / Ana Değer',
  'Repo-Shape Acquisition / Repo Şeklini Edinme',
  'Memory And State / Hafıza ve Durum',
  'Decision Making / Karar Verme',
  'Skill Writing / Skill Yazımı',
  'Agent Writing / Agent Yazımı',
  'Bug Finding / Hata Bulma',
  'Aqua Risk Maps / Aqua Risk Haritaları',
  'Runtime And Safety / Çalışma Zamanı ve Güvenlik',
  "Historical Docs And Runbooks / Tarihsel Dokümanlar ve Runbook'lar",
  'Executable Anchor Matrix / Çalıştırılabilir Dayanak Matrisi',
  'Known Limits / Bilinen Sınırlar',
];

// What CURRENT_STATE must still say about the tree is decided once, in
// tools/gates/aria-authority-hash.ts (`checkCurrentState`); the CLI `--check`
// consumes the same verdict, so the two cannot disagree (ORPHAN-MEDIUM-792).
function markdownSection(body: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = body.indexOf('\n## ', start + marker.length);
  return body.slice(start, next === -1 ? body.length : next);
}

function planDocs(): string[] {
  const tracked = git(['ls-files', 'docs/aria/plans'])
    .split(/\r?\n/)
    .filter((rel) => rel.endsWith('.md'));
  const fromFs: string[] = [];
  const visit = (rel: string): void => {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      const child = `${rel}/${name}`;
      const childAbs = join(REPO_ROOT, child);
      const stat = statSync(childAbs);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile() && child.endsWith('.md')) fromFs.push(child);
    }
  };
  visit('docs/aria/plans');
  return [...new Set([...tracked, ...fromFs])].sort();
}

function planMarkerCount(body: string): number {
  return PLAN_MARKERS.reduce((count, marker) => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return count + (body.match(new RegExp(escaped, 'g')) ?? []).length;
  }, 0);
}

describe('ARIA live runtime/documentation SSoT', () => {
  it('BEHAVIOUR labels itself as dated measurement and points to machine truth', () => {
    const behaviour = read('docs/aria/BEHAVIOUR.md');
    expect(behaviour).toMatch(/\*\*Status:\*\* measured \d{4}-\d{2}-\d{2}/);
    expect(behaviour).toContain('aria-kernel autonomy status --evidence');
    expect(behaviour).toContain('docs/aria/CURRENT_STATE.md');
    expect(behaviour).toContain('dated measurement');
  });

  it('CURRENT_STATE declares the live authority chain and executable anchors', () => {
    const current = read('docs/aria/CURRENT_STATE.md');
    // ORPHAN-MEDIUM-768 / -792 — the Date line is descriptive metadata the
    // author keeps, never an authorization predicate: it must exist and stay
    // ISO-shaped, and nothing compares it with a commit date.
    const declaredDate = current.match(/^Date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
    expect(declaredDate).toBeTruthy();
    const target = current.match(/Target ref: `([^`]+)`/)?.[1];
    expect(target).toBe('origin/main');
    // PROC-HIGH-046 — the document records no digest of the tree (a recorded
    // one made every ARIA PR rewrite the same line); what it claims about the
    // tree is its anchors, and every one must resolve. Server-side merges and
    // next-day squashes need no re-stamp because nothing is stamped;
    // tools/gates/aria-authority-hash.spec.ts pins the merge behaviour and the
    // red cases.
    const verdict = checkCurrentState(REPO_ROOT);
    expect(verdict.defects).toEqual([]);
    expect(verdict.valid).toBe(true);
    expect(verdict.pathAnchors).toBeGreaterThan(0);
    expect(verdict.symbolAnchors).toBeGreaterThan(0);
    expect(current).not.toContain('Last verified');
    expect(current).toContain('## Authority Chain');
    expect(current).toContain('Executable code and machine-checked contracts are normative');
    expect(current).toContain('Claude Code CLI');
    for (const anchor of [
      'aria-kernel/aria_kernel/cli.py',
      'aria-kernel/aria_kernel/runtime_profile.py',
      'aria-kernel/aria_kernel/state_manifest.py',
      'aria-kernel/aria_kernel/tool_registry.py',
      'aria-kernel/aria_kernel/runtime_artifacts.py',
      'aria-kernel/aria_kernel/agent_surface.py',
      'aria-kernel/aria_kernel/burn_in.py',
      'docs/aria/schemas/autonomy-burn-in-report.schema.json',
      'tools/aria-poc/ci_executor.py',
      'tools/aria-poc/worker_executor.py',
    ]) {
      expect(current).toContain(anchor);
    }
    expect(current).toContain('artifact-bearing');
    expect(current).toContain('Lifecycle-only cycles do not authorize promotion');
    expect(current).toContain('autonomy burn-in observe');
    expect(current).toContain('It is not a full autonomous merge proof');
    expect(current).toContain(ENTERPRISE_AUTONOMY_DOC);
    expect(current).toContain('production-autonomy target decisions');
    expect(current).toContain('hybrid GitHub Actions plus private-runner runtime');
    expect(current).toContain('hybrid ledger/state authority');
    expect(current).toContain('not live merge');
  });

  it('CURRENT_STATE file.py::symbol anchors resolve through Python AST', () => {
    // The AST rule lives in checkCurrentState (one interpreter for every
    // anchor); this keeps the symbol half visible as its own failure.
    const symbolDefects = checkCurrentState(REPO_ROOT).defects.filter(
      (defect) => defect.kind === 'unresolved_symbol',
    );
    expect(symbolDefects).toEqual([]);
  });

  it('every ARIA plan doc has exactly one authority marker', () => {
    const rels = planDocs();
    expect(rels.length).toBeGreaterThan(0);
    for (const rel of rels) {
      expect(planMarkerCount(read(rel))).toBe(1);
    }
  });

  it('plan marker invariant rejects an unmarked stale plan fixture', () => {
    const stale = '# Plan\n\n`merge_if_green` is the only real merge executor.\n';
    expect(planMarkerCount(stale)).toBe(0);
    expect(STALE_LIVE_PLAN_PATTERNS.some((pattern) => pattern.test(stale))).toBe(true);
  });

  it('live-authority ARIA plan docs do not contain stale runtime closure claims', () => {
    for (const rel of planDocs()) {
      const body = read(rel);
      if (!body.includes('ARIA-LIVE-AUTHORITY')) continue;
      for (const pattern of STALE_LIVE_PLAN_PATTERNS) {
        expect(body).not.toMatch(pattern);
      }
    }
  });

  it('historical live docs are explicitly subordinate to CURRENT_STATE', () => {
    const staleRuntimeTerms = [
      'Codex CLI',
      'codex exec',
      'codex_runtime.py',
      'OPENAI_API_KEY',
      'llm_bridge.py',
      'only implemented ARIA code',
      'does not implement the kernel',
      'never auto-merge pull requests',
    ];
    for (const rel of LIVE_DOCS) {
      const body = read(rel);
      const containsStaleTerm = staleRuntimeTerms.some((term) => body.includes(term));
      if (!containsStaleTerm) continue;
      expect(body).toMatch(/ARIA-LIVE-AUTHORITY|ARIA-CURRENT-STATE-NOTICE/);
    }
  });

  it('ARCHITECTURE is a bilingual diagram-heavy explanatory map subordinate to CURRENT_STATE', () => {
    const architecture = read(ARCHITECTURE_DOC);
    expect(architecture).toContain('ARIA-CURRENT-STATE-NOTICE');
    expect(architecture).toContain('Authority: explanatory-architecture');
    expect(architecture).toContain(
      'Current authority: `docs/aria/CURRENT_STATE.md` + executable contracts',
    );
    for (const anchor of [
      'Executable code and machine-checked contracts are normative',
      'Claude Code CLI',
      'artifact-bearing',
      'Lifecycle-only cycles do not authorize promotion',
      'docs/aria/CURRENT_STATE.md',
    ]) {
      expect(architecture).toContain(anchor);
    }
    for (const section of ARCHITECTURE_SECTIONS) {
      const sectionBody = markdownSection(architecture, section);
      expect(sectionBody).toContain('### EN');
      expect(sectionBody).toContain('### TR');
      expect(sectionBody).toContain('### Executable Links / Çalıştırılabilir Bağlantılar');
      expect(sectionBody).toContain('### Diagram / Diyagram');
    }
    expect(architecture.match(/```mermaid/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    for (const diagramKind of [
      'flowchart TD',
      'flowchart LR',
      'stateDiagram-v2',
      'sequenceDiagram',
    ]) {
      expect(architecture).toContain(diagramKind);
    }
    for (const anchor of [
      'aria-kernel/aria_kernel/cli.py',
      'aria-kernel/aria_kernel/runtime_profile.py',
      'aria-kernel/aria_kernel/state_manifest.py',
      'aria-kernel/aria_kernel/tool_registry.py',
      'aria-kernel/aria_kernel/runtime_artifacts.py',
      'aria-kernel/aria_kernel/tool_health.py',
      'aria-kernel/aria_kernel/runs_reader.py',
      'aria-kernel/aria_kernel/agent_surface.py',
      'aria-kernel/aria_kernel/agent_contract.py',
      'aria-kernel/aria_kernel/ledger.py',
      'aria-kernel/aria_kernel/auto_merge.py',
      'tools/aria-poc/ci_executor.py',
      'tools/aria-poc/worker_executor.py',
      'tools/aria-poc/claude_runtime.py',
      'aria-kernel/aria_kernel/artifact_safety.py',
      'aria-kernel/aria_kernel/burn_in.py',
      'docs/aria/ENTERPRISE_AUTONOMY_SSOT.md',
    ]) {
      expect(architecture).toContain(anchor);
    }
  });

  it('enterprise autonomy SSoT defines observe burn-in gates and genesis lifecycle', () => {
    const body = read(ENTERPRISE_AUTONOMY_DOC);
    expect(body).toContain('ARIA-CURRENT-STATE-NOTICE');
    expect(body).toContain('Authority: enterprise-autonomy-ssot');
    expect(body).toContain(
      'Current authority: `docs/aria/CURRENT_STATE.md` + executable contracts',
    );
    expect(body).toContain('Runtime entrypoint: `autonomy burn-in observe`');
    expect(body).toContain(BURN_IN_SCHEMA);
    expect(body).toContain('## EN');
    expect(body).toContain('## TR');
    expect(body).toContain(
      '## Production Autonomy Target Decisions (2026-06-20) / Production Otonomi Hedef Kararları (2026-06-20)',
    );
    for (const required of [
      '30-attempt observe burn-in',
      'No Action Surfaces',
      'PRESSURE',
      'CANDIDATE_PROPOSED',
      'HUMAN_REQUIRED',
      'REAL_SANDBOX',
      'EVAL_WINDOW',
      'ACTIVE',
      'global workflow kill switch',
      'remote CAS lease proof',
      'Full production autonomy',
      'Whole repo, risk-gated',
      'Hybrid runtime',
      'Hybrid token model',
      'Hybrid policy SSoT',
      'Hybrid ledger/state',
      'Prose does not grant runtime',
      'docs/aria/policy/*.json',
      'aria-merge-authority',
      'CODEOWNERS-protected policy files',
      'state_manifest.py',
      'declared JSONL writers',
    ]) {
      expect(body).toContain(required);
    }
    expect(body.match(/```mermaid/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    for (const anchor of [
      'aria-kernel/aria_kernel/burn_in.py',
      'aria-kernel/aria_kernel/cli.py',
      'aria-kernel/aria_kernel/state_manifest.py',
      'aria-kernel/aria_kernel/discovery.py',
      'aria-kernel/aria_kernel/memory.py',
      'aria-kernel/aria_kernel/pressure.py',
      'aria-kernel/aria_kernel/triage.py',
      'risk_policy.py',
      'autonomy_unlock.py',
      'policy_approval.py',
      'rollback_bundle.py',
      'incident_ledger.py',
      'merge_authority.py',
    ]) {
      expect(body).toContain(anchor);
    }
  });

  it('observe burn-in report schema is the machine contract for enterprise acceptance', () => {
    const generated = execFileSync('python3', ['-m', 'aria_kernel.docs_ssot', 'burn-in-schema'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: 'aria-kernel' },
    });
    expect(read(BURN_IN_SCHEMA)).toBe(generated);
    const schema = JSON.parse(read(BURN_IN_SCHEMA)) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema).toHaveProperty('$id', 'aria/autonomy-burn-in-report/v1');
    expect(schema.additionalProperties).toBe(false);
    for (const field of [
      'schema_version',
      'generated_at',
      'started_at',
      'completed_at',
      'target_ref',
      'base_commit_sha',
      'cycle_attempts',
      'valid_cycles',
      'min_valid_cycles',
      'workspace_root',
      'workspace_base',
      'tools_dir',
      'profile',
      'discovery_summary',
      'memory_summary',
      'pressure_summary',
      'finding_summary',
      'triage_summary',
      'skill_gap_candidates',
      'agent_gap_candidates',
      'candidate_observations',
      'disallowed_actions_observed',
      'cycles',
      'artifact_hashes',
      'cycle_ledger_summary',
      'disallowed_actions_report',
      'manifest_tail_hashes',
      'candidate_detection',
      'evidence_bundle',
      'evidence_bundle_hash',
      'failure_reports',
      'failed_cycles',
      'acceptance_conditions',
      'acceptance_verdict',
    ]) {
      expect(schema.required).toContain(field);
      expect(schema.properties).toHaveProperty(field);
    }
  });

  it('stale ARIA runbooks are marked historical or compatibility material', () => {
    const staleRuntimeTerms = ['snowball', 'llm_bridge.py'];
    for (const rel of HISTORICAL_ARIA_RUNBOOKS) {
      const body = read(rel);
      const containsStaleTerm = staleRuntimeTerms.some((term) => body.includes(term));
      if (!containsStaleTerm) continue;
      expect(body).toContain('ARIA-CURRENT-STATE-NOTICE');
      expect(body).toMatch(/Historical\/compatibility|historical|compatibility/i);
      expect(body).toContain('docs/aria/CURRENT_STATE.md');
    }
  });

  it('Claude Code executor contract is mainline, version-bound, and has no pending verification placeholders', () => {
    const contract = read('tools/aria-poc/ci_executor_contract_proven.md');
    expect(contract).toContain('checkout the `main` target ref');
    expect(contract).toContain('claude_cli_version_minimum: claude-code 2.1.221');
    expect(contract).toContain('verification_mode: runtime-preflight');
    expect(contract).toContain('managed Claude Code login');
    expect(contract).not.toMatch(
      /PENDING-CLAUDE-CONTRACT-TESTS|claude_cli_version_minimum:\s*PENDING|verified_by_operator_handle:\s*PENDING|verified_at_iso8601:\s*PENDING/,
    );
  });

  it('snowball curation is SSoT-bound and rejects duplicate runtime ownership', () => {
    const body = read(SNOWBALL_CURATION_RECORD);
    expect(body).toContain('Do not merge either snowball branch directly into `main`.');
    expect(body).toContain('## SSOT Integration Contract');
    expect(body).toContain('Snowball is evidence, not a second architecture line.');
    expect(body).toContain('## Duplicate And Cleanup Gate');
    expect(body).toContain('SSOT-GAP-CANDIDATE');
    expect(body).not.toMatch(/^\| `CANDIDATE`/m);
    expect(body).toContain('Reject any duplicate module, duplicate schema, duplicate CLI path');
    expect(body).toContain('Remove or mark obsolete legacy material');
    expect(body).toContain('one owner per behavior');
    expect(body).toContain('no generated runtime state');
    expect(body).toMatch(/no direct branch\s+merge/);
  });

  it('live ARIA workflows target main and enforce the Claude Code CLI floor', () => {
    for (const rel of LIVE_WORKFLOWS) {
      const workflow = read(rel);
      expect(workflow).not.toMatch(
        /ref:\s*snowball|refs\/heads\/snowball|origin snowball|branches:\s*\n\s*-\s*snowball/,
      );
    }
    const executor = read('.github/workflows/aria-agent-executor.yml');
    expect(executor).toContain('ref: main');
    expect(executor).toContain('REQUIRED_CLAUDE_VERSION="2.1.221"');
    expect(executor).toContain('claude --version');
    // ORPHAN-MEDIUM-769 — aria-kernel-full.yml was deleted (a strict subset
    // of aria-kernel.yml, never a required context); ARIA-MEDIUM-135 retired
    // aria-kernel-fast.yml the same way (the identical full suite under a
    // 60-minute budget it could not meet), so the kernel suite on PR and on
    // main push belongs to aria-kernel.yml alone.
    expect(read('.github/workflows/aria-kernel.yml')).toMatch(/branches:\s*\n\s*- main/);
    const kernelWorkflow = read('.github/workflows/aria-kernel.yml');
    expect(kernelWorkflow).toContain('node-version: "22"');
    // The dependency contract moved, and got stricter. It used to be pinned
    // as literal text inside these two workflows; the same text existed in
    // nine other jobs and was ABSENT from five that ran kernel code anyway
    // (ORPHAN-HIGH-529 — aria-daily-report imported the kernel twenty-seven
    // lines before installing it and died silently for seventeen days).
    // Provisioning now has one definition, so the property is asserted at
    // that definition and these workflows are checked for USING it —
    // which covers every kernel-running job, not the two remembered here.
    const setupAction = read('.github/actions/setup-aria-kernel/action.yml');
    expect(setupAction).toContain('tomllib.load');
    expect(setupAction).toContain('aria-kernel/pyproject.toml');
    for (const workflow of [kernelWorkflow]) {
      expect(workflow).toContain('uses: ./.github/actions/setup-aria-kernel');
      // Still banned, everywhere: installing the package would add a second
      // source for `import aria_kernel` and make the explicit pyproject
      // dependency read dead code.
      expect(workflow).not.toMatch(/pip install[^\n]*\s-e\s+aria-kernel/);
    }
    // The same ban on the action is checked in
    // `aria-kernel-workflow-setup.spec.ts` against the PARSED script rather
    // than the file text: the action's header explains why the package is
    // never installed, and a text scan that cannot tell an explanation from
    // an instruction would force that explanation out of the file.
    expect(kernelWorkflow).toContain('Run ARIA docs/runtime SSoT invariant');
    expect(kernelWorkflow).toContain('Run ARIA runtime artifact smoke');
    expect(kernelWorkflow).toContain('Verify post-run clean worktree');
  });

  // Runs the canonical runner with a fake `python3` on PATH and returns every
  // interpreter invocation it made: environment and argv, one block per call.
  const probeRunnerInvocations = (...invocations: string[][]): string[] => {
    const probeDir = mkdtempSync(join(tmpdir(), 'aria-suite-run-'));
    const invocationLog = join(probeDir, 'python-invocations');
    try {
      writeExecutable(
        join(probeDir, 'python3'),
        [
          '{',
          "  printf 'BEGIN\\n'",
          '  printf \'PYTHONDONTWRITEBYTECODE=%s\\n\' "$PYTHONDONTWRITEBYTECODE"',
          '  printf \'PYTHONPATH=%s\\n\' "$PYTHONPATH"',
          '  printf \'ARG=%s\\n\' "$@"',
          "  printf 'END\\n'",
          '} >> "$ARIA_SUITE_PROBE"',
        ].join('\n'),
      );
      for (const args of invocations) {
        execFileSync('bash', [ARIA_SUITE_RUNNER, ...args], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            ARIA_SUITE_PROBE: invocationLog,
            PATH: `${probeDir}:${process.env.PATH ?? ''}`,
            PYTHONPATH: 'caller-pythonpath',
          },
        });
      }
      return readFileSync(invocationLog, 'utf8').trim().split('\n');
    } finally {
      removeFixtureTree(probeDir);
    }
  };

  const PYTEST_NATIVE_INVOCATION = [
    'BEGIN',
    'PYTHONDONTWRITEBYTECODE=1',
    'PYTHONPATH=aria-kernel:.:caller-pythonpath',
    'ARG=-m',
    'ARG=pytest',
    'ARG=-q',
    'ARG=-p',
    `ARG=${ARIA_PYTEST_NATIVE_PLUGIN}`,
    'ARG=aria-kernel',
    'END',
  ];

  it('runs the complete ARIA Python suite through one semantic partition', () => {
    expect(probeRunnerInvocations([])).toEqual([
      'BEGIN',
      'PYTHONDONTWRITEBYTECODE=1',
      'PYTHONPATH=aria-kernel:.:caller-pythonpath',
      'ARG=-m',
      'ARG=unittest',
      'ARG=discover',
      'ARG=aria-kernel',
      'ARG=-p',
      'ARG=*test*.py',
      'END',
      ...PYTEST_NATIVE_INVOCATION,
    ]);
    expect(read(ARIA_SUITE_RUNNER)).not.toMatch(/\bgrep\b|PYTEST_STYLE_MODULES/);
  });

  it('splits that partition into shards of the unittest half and the pytest half whole', () => {
    // ARIA-HIGH-136 — the kernel lane runs `--shard K/N` once per matrix job
    // and `--pytest-native` once; together they are the two-collector
    // partition above. The shard runner is the one module that discovers,
    // assigns and reports (aria-kernel/tests/_helpers/suite_shards.py).
    expect(
      probeRunnerInvocations(['--shard', '2/8', '/probe/shard-2.json'], ['--pytest-native']),
    ).toEqual([
      'BEGIN',
      'PYTHONDONTWRITEBYTECODE=1',
      'PYTHONPATH=aria-kernel:.:caller-pythonpath',
      'ARG=aria-kernel/tests/_helpers/suite_shards.py',
      'ARG=run',
      'ARG=--shard',
      'ARG=2/8',
      'ARG=--report',
      'ARG=/probe/shard-2.json',
      'END',
      ...PYTEST_NATIVE_INVOCATION,
    ]);
  });

  it('preserves the legacy *test*.py collection contract in pytest configuration', () => {
    const pythonFiles = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          [
            'import json, pathlib, sys, tomllib',
            'config = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
            'print(json.dumps(config.get("tool", {}).get("pytest", {}).get("ini_options", {}).get("python_files")))',
          ].join('\n'),
          join(REPO_ROOT, 'aria-kernel/pyproject.toml'),
        ],
        { encoding: 'utf8' },
      ),
    ) as unknown;

    expect(pythonFiles).toEqual(['*test*.py']);
  });

  it('runs the kernel suite as measured shards that prove they covered it once', () => {
    // ARIA-HIGH-136 — one interpreter stopped fitting a lane budget: 40.9 min
    // on run 34578152903, ~77 min on the 22.04 image (run 34902506329), and
    // runs 36386654289 / 36358071953 cancelled at the 110-minute cap with
    // 7,387 tests and nothing red. The budgets below are reasoned next to the
    // values in the workflow, from the shard measurement.
    // ARIA-MEDIUM-135: a second lane over the same suite is drift.
    expect(existsSync(join(REPO_ROOT, '.github/workflows/aria-kernel-fast.yml'))).toBe(false);
    const workflow = yaml.load(read('.github/workflows/aria-kernel.yml')) as PullRequestWorkflow;
    // INFRA-HIGH-215 — unfiltered, so the required context reports on every PR.
    expect(workflow.on?.pull_request).toBeNull();
    expect(kernelSurface(workflow)).toContain(ARIA_SUITE_RUNNER);
    // ARIA-HIGH-098 — the adapter registry contract
    // (aria-kernel/tests/test_adapter_fixture_evidence_contract.py) is a
    // suite test over tools/aria-adapters/**; a lane that does not run on
    // that directory checks an adapters-only PR first on main.
    expect(kernelSurface(workflow)).toContain(ARIA_ADAPTERS_DIR + '/**');

    const jobs = workflow.jobs ?? {};
    expect(Object.keys(jobs)).toEqual(['changes', 'suite', 'lane', 'state', 'aria-kernel']);
    for (const job of ['suite', 'lane', 'state']) {
      expect(jobs[job]?.needs).toBe('changes');
      expect(jobs[job]?.if).toBe("needs.changes.outputs.kernel == 'true'");
    }
    const runnerSteps = (job: string): WorkflowStep[] =>
      (jobs[job]?.steps ?? []).filter((step) => step.run?.startsWith(`bash ${ARIA_SUITE_RUNNER}`));

    // suite: a matrix whose labels are exactly 1..N; the partition takes its
    // index and count from the matrix itself, never from the labels.
    const suite = jobs.suite;
    expect(suite?.['timeout-minutes']).toBe(KERNEL_SHARD_BUDGET_MINUTES);
    expect(suite?.strategy?.['fail-fast']).toBe(false);
    const labels = suite?.strategy?.matrix?.shard ?? [];
    expect(labels.length).toBeGreaterThan(1);
    expect(labels).toEqual(labels.map((_, index) => index + 1));
    const shardSteps = runnerSteps('suite');
    expect(shardSteps).toHaveLength(1);
    expect(shardSteps[0]?.run).toBe(
      `bash ${ARIA_SUITE_RUNNER} --shard "$((SHARD_INDEX + 1))/` +
        '${SHARD_TOTAL}" "${RUNNER_TEMP}/aria-suite-shards/shard-$((SHARD_INDEX + 1)).attempt-${GITHUB_RUN_ATTEMPT}.json"',
    );
    expect(shardSteps[0]?.env).toEqual({
      SHARD_INDEX: '${{ strategy.job-index }}',
      SHARD_TOTAL: '${{ strategy.job-total }}',
    });

    // lane: the pytest half whole, and nothing else from the runner.
    expect(jobs.lane?.['timeout-minutes']).toBe(KERNEL_LANE_BUDGET_MINUTES);
    expect(runnerSteps('lane').map((step) => step.run)).toEqual([
      `bash ${ARIA_SUITE_RUNNER} --pytest-native`,
    ]);

    // state (ARIA-HIGH-240): this change's kernel compacts and verifies the
    // live aria/state tip; its likeness to the maintenance lane is pinned by
    // aria-kernel/tests/test_state_compaction_gate.py. No suite runner here.
    expect(runnerSteps('state')).toEqual([]);

    // aria-kernel: the verdict — every job green AND the reports prove the
    // shards ran the whole suite exactly once.
    const verdict = jobs['aria-kernel'];
    expect(verdict?.needs).toEqual(['changes', 'suite', 'lane', 'state']);
    expect(verdict?.if).toBe('${{ !cancelled() }}');
    expect((verdict?.steps ?? []).map((step) => step.run)).toContain(
      'python3 aria-kernel/tests/_helpers/suite_shards.py verify --reports-dir "${RUNNER_TEMP}/aria-suite-shards"',
    );
  });

  it('runs the kernel jobs on a PR exactly when it touches the kernel surface', () => {
    // INFRA-HIGH-215 — the surface moved from the `pull_request.paths` filter into the
    // `changes` job. This runs that job's own script against a PR-shaped checkout (the
    // merge of a branch into its base, as actions/checkout hands a pull_request run), so
    // the globs keep the meaning they had as a filter.
    const workflow = yaml.load(read('.github/workflows/aria-kernel.yml')) as PullRequestWorkflow;
    const scope = kernelScopeStep(workflow);
    const script = scope.run ?? '';
    const surface = scope.env?.KERNEL_SURFACE ?? '';
    const fixture = mkdtempSync(join(tmpdir(), 'aria-kernel-scope-'));
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'scope',
      GIT_AUTHOR_EMAIL: 'scope@example.invalid',
      GIT_COMMITTER_NAME: 'scope',
      GIT_COMMITTER_EMAIL: 'scope@example.invalid',
    };
    const git = (repo: string, ...args: string[]): void => {
      execFileSync(REAL_GIT, args, { cwd: repo, env: gitEnv, stdio: 'pipe' });
    };
    const decide = (eventName: string, changedPath: string): string => {
      const repo = mkdtempSync(join(fixture, 'repo-'));
      git(repo, 'init', '--quiet', '--initial-branch=main');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '--quiet', '-m', 'base');
      git(repo, 'checkout', '--quiet', '-b', 'pr');
      mkdirSync(join(repo, changedPath, '..'), { recursive: true });
      writeFileSync(join(repo, changedPath), 'change\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '--quiet', '-m', 'change');
      git(repo, 'checkout', '--quiet', 'main');
      writeFileSync(join(repo, 'README.md'), 'base moved on\n');
      git(repo, 'commit', '--quiet', '-am', 'base moves');
      git(repo, 'merge', '--quiet', '--no-ff', '--no-edit', 'pr');
      const output = join(repo, '.github-output');
      writeFileSync(output, '');
      execFileSync('bash', ['-e', '-c', script], {
        cwd: repo,
        env: { ...gitEnv, EVENT_NAME: eventName, KERNEL_SURFACE: surface, GITHUB_OUTPUT: output },
        stdio: 'pipe',
      });
      return readFileSync(output, 'utf8').trim();
    };
    try {
      for (const changed of [
        'aria-kernel/aria_kernel/deep/module.py',
        'scripts/ci/aria-suite-run.sh',
        'docs/aria/SPEC.md',
        'docs/adr/033-aria-autonomous-profile.md',
        '.github/workflows/aria-kernel.yml',
        'tools/aria-poc/poc.py',
        'tools/shared/invariants/test_x.py',
        `${ARIA_ADAPTERS_DIR}/some-adapter/manifest.json`,
      ]) {
        expect([changed, decide('pull_request', changed)]).toEqual([changed, 'kernel=true']);
      }
      for (const changed of [
        'apps/farm-service/src/main.ts',
        'docs/runbooks/aria-pr-landing-gate.md',
        'scripts/ci/aria-suite-changed.mjs',
        'tools/aria-poc-notes.md',
      ]) {
        expect([changed, decide('pull_request', changed)]).toEqual([changed, 'kernel=false']);
      }
      // A main push runs the lane whole, whatever it touched (ARIA-V-007).
      expect(decide('push', 'apps/farm-service/src/main.ts')).toBe('kernel=true');
    } finally {
      removeFixtureTree(fixture);
    }
  });

  it('budgets the operational proof for the package-bound suite and burn-in', () => {
    const workflow = yaml.load(
      read('.github/workflows/aria-operational-proof.yml'),
    ) as PullRequestWorkflow;
    const jobs = Object.values(workflow.jobs ?? {});
    expect(jobs).toHaveLength(1);
    // 150, not 90: the suite alone consumed 35.6 min in run 33113524069 before
    // the burn-in started, and a completing cycle now costs ~5.5 min locally
    // (~37 min for 30 cycles on a hosted runner). 90 left ~17 min of margin
    // against a 19-minute estimate made when cycles were cheaper, so the lane
    // failed on the clock and reported it as a proof failure.
    expect(jobs[0]?.['timeout-minutes']).toBe(150);
    expect(
      (jobs[0]?.steps ?? []).filter((step) => step.run === 'npm run aria:test:unit'),
    ).toHaveLength(1);

    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['aria:test:unit']).toBe(`bash ${ARIA_SUITE_RUNNER}`);
  });

  // Runs the pre-push selector against a faked diff and returns what it asked git for and
  // what it started. Shims live in `bin/` and write only into `log/`: a shim whose record
  // lands on PATH can end up executing its own record (the 2026-10-02 fork bomb, see
  // aria-suite-selector.spec.ts). `git ls-files` is the real one, so the import graph
  // reads the real kernel.
  const probeSelector = (
    changed: string,
  ): { diffArgs: string[]; bash: string[][]; npx: string[] | null } => {
    const probeDir = mkdtempSync(join(tmpdir(), 'aria-suite-changed-'));
    const bin = join(probeDir, 'bin');
    const log = join(probeDir, 'log');
    const common = join(probeDir, 'common');
    try {
      for (const dir of [bin, log, common]) mkdirSync(dir);
      writeExecutable(
        join(bin, 'git'),
        [
          'case "$1 $2" in',
          '  "rev-parse --abbrev-ref") echo probe-branch; exit 0 ;;',
          '  "rev-parse --verify") exit 0 ;;',
          `  "rev-parse --git-common-dir") echo "${common}"; exit 0 ;;`,
          'esac',
          'if [ "$1" = "diff" ]; then',
          `  printf '%s\\n' "$@" > "${join(log, 'git-diff')}"`,
          `  printf '%s\\n' '${changed}'`,
          '  exit 0',
          'fi',
          `if [ "$1" = "ls-files" ]; then exec "${REAL_GIT}" "$@"; fi`,
          'exit 2',
        ].join('\n'),
      );
      writeExecutable(join(bin, 'bash'), `printf '%s\\n' "$@" -- >> "${join(log, 'bash')}"`);
      writeExecutable(
        join(bin, 'npx'),
        `printf '%s\\n' "ARIA_SUITE_GATE_RUN=$ARIA_SUITE_GATE_RUN" "$@" > "${join(log, 'npx')}"`,
      );

      execFileSync(process.execPath, [ARIA_SUITE_SELECTOR], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ARIA_PREPUSH_LOCK: join(probeDir, 'lock'),
          ARIA_PREPUSH_BUDGET_S: '',
          ARIA_SUITE_FULL: '',
          ARIA_SUITE_GATE_RUN: '',
        },
      });

      const lines = (name: string): string[] | null =>
        existsSync(join(log, name))
          ? readFileSync(join(log, name), 'utf8').trim().split('\n')
          : null;
      const bash = existsSync(join(log, 'bash'))
        ? readFileSync(join(log, 'bash'), 'utf8')
            .split('--\n')
            .filter((block) => block !== '')
            .map((block) => block.trim().split('\n'))
        : [];
      return { diffArgs: lines('git-diff') ?? [], bash, npx: lines('npx') };
    } finally {
      removeFixtureTree(probeDir);
    }
  };

  it(
    'treats the ARIA suite selector and both entrypoints as pre-push surfaces',
    () => {
      const { diffArgs, bash, npx } = probeSelector(ARIA_SUITE_SELECTOR);
      expect(diffArgs).toContain(ARIA_SUITE_SELECTOR);
      expect(diffArgs).toContain(ARIA_SUITE_RUNNER);
      expect(diffArgs).toContain(ARIA_IMPORT_GRAPH);
      expect(diffArgs).toContain('package.json');
      expect(diffArgs).toContain(ARIA_ADAPTERS_DIR);
      // GATE SELF-VALIDATION (PROC-MEDIUM-045): a change to the code deciding what the next
      // push runs is validated by the specs that drive that code, this one among them — the
      // kernel suite never executed a line of the selector. The jest run is marked so the
      // selector those specs start cannot start it again.
      expect(npx).toEqual(
        expect.arrayContaining([
          'ARIA_SUITE_GATE_RUN=1',
          'jest',
          'tests/invariants/aria-doc-runtime-ssot.spec.ts',
          'tests/invariants/aria-suite-selector.spec.ts',
        ]),
      );
      expect(bash).toEqual([]);
    },
    SELECTOR_PROBE_MS,
  );

  it(
    'selects the adapter registry contract when only tools/aria-adapters changes',
    () => {
      // ARIA-HIGH-098 — a manifest without a fixture case, or a case rewritten
      // to expect a non-ok run, touches only tools/aria-adapters/**. The
      // pre-push selector must reach the kernel module that refuses both, and
      // run it before anything that merely reads the directory.
      const { bash } = probeSelector(`${ARIA_ADAPTERS_DIR}/probe-adapter.tool.json`);
      expect(bash[0]).toEqual([
        ARIA_SUITE_RUNNER,
        'aria-kernel/tests/test_adapter_fixture_evidence_contract.py',
      ]);
    },
    SELECTOR_PROBE_MS,
  );

  it('package scripts expose the clean ARIA validation entrypoints', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['aria:compile']).toContain(
      "compile(p.read_text(encoding='utf-8'), str(p), 'exec')",
    );
    expect(pkg.scripts['aria:compile']).not.toContain('compileall');
    expect(pkg.scripts['aria:test:unit']).toBe(`bash ${ARIA_SUITE_RUNNER}`);
    expect(pkg.scripts['aria:docs:ssot']).toBe(
      'jest --config tests/invariants/jest.config.ts --selectProjects layer-3 --runTestsByPath tests/invariants/aria-doc-runtime-ssot.spec.ts',
    );
    expect(pkg.scripts['aria:burnin:observe']).toBe(
      'PYTHONPATH=aria-kernel python3 -m aria_kernel autonomy burn-in observe',
    );
    expect(pkg.scripts['aria:ci:all']).toBe(
      'npm run aria:compile && npm run aria:test:unit && npm run invariants:fast',
    );
  });

  it('CODEOWNERS covers the ARIA control-plane authority chain', () => {
    const owners = read('.github/CODEOWNERS');
    for (const required of [
      'aria-kernel/',
      'docs/aria/',
      'tools/aria-poc/',
      'aria-tools/preflight/',
      'package.json',
      '.gitignore',
    ]) {
      expect(owners).toContain(required);
    }
  });

  it('runtime state roots are ignored and .aria-ci is not tracked', () => {
    expect(git(['ls-files', '.aria-ci']).trim()).toBe('');
    for (const rel of [
      '.aria-ci/tools/runs.jsonl',
      'artifacts/example.json',
      'aria-kernel/aria-tools/runs.jsonl',
      'aria-tools/autonomy_state.jsonl',
      'aria-tools/daemons/lease.json',
      'aria-tools/quarantine/finding.jsonl',
      // ORPHAN-HIGH-793 — the writers attestation is a DELIBERATE
      // host-local SIBLING of the store directory (state_store.py keeps
      // it outside the store so store invariants stay blind to it), and
      // the nightly's workspace-clean gate tripped on it for exactly as
      // long as git refused to ignore it: three dead nights.
      '.aria-state-store.writers.jsonl',
    ]) {
      expect(gitSucceeds(['check-ignore', '--no-index', '-q', '--', rel])).toBe(true);
    }
    expect(existsSync(join(REPO_ROOT, '.gitignore'))).toBe(true);
  });
});
