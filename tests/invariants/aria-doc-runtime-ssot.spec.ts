import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { ariaAuthorityHash, checkAriaAuthorityHash } from '../../tools/gates/aria-authority-hash';

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
  '.github/workflows/aria-kernel-fast.yml',
  '.github/workflows/aria-operational-proof.yml',
];

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

// The digest is defined once, in the module that also writes it — see the
// header of tools/gates/aria-authority-hash.ts. A private copy here would let
// `npm run aria:authority-hash:write` produce a value this spec rejects.
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
    // ORPHAN-MEDIUM-768 — the writer stamps hash AND date in the same write,
    // so the Date line must exist and stay ISO-shaped.
    // ORPHAN-MEDIUM-792 — that is all it must do: the date is descriptive
    // metadata, not an authorization predicate. A server-side merge runs no
    // local writer and may land on the next UTC day while the authority
    // content is byte-identical to what was stamped, and holding the date
    // accountable to the newest authority-commit day rejected exactly those
    // valid pins. Validity is the content hash asserted below;
    // tools/gates/aria-authority-hash.spec.ts pins the merge regression.
    const declaredDate = current.match(/^Date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
    expect(declaredDate).toBeTruthy();
    const target = current.match(/Target ref: `([^`]+)`/)?.[1];
    expect(target).toBe('origin/main');
    const verifiedHash = current.match(/Last verified ARIA authority hash: `([a-f0-9]{64})`/)?.[1];
    expect(verifiedHash).toBeTruthy();
    // ORPHAN-MEDIUM-792 — one verdict producer: the same pure checker the
    // CLI `--check` consumes decides validity here, so the invariant and the
    // gate can never disagree about what a valid pin is.
    const verdict = checkAriaAuthorityHash(REPO_ROOT);
    expect(verdict.valid).toBe(true);
    expect(verdict.reason).toBe('current');
    expect(verifiedHash).toBe(verdict.computed);
    expect(verifiedHash).toBe(ariaAuthorityHash());
    expect(current).not.toContain('Last verified commit');
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
    const current = read('docs/aria/CURRENT_STATE.md');
    const anchors = [...current.matchAll(/([\w./-]+\.py)::([A-Za-z_]\w*)/g)].map((match) => {
      const [, file, symbol] = match;
      if (!file || !symbol) {
        throw new Error(`Malformed ARIA anchor match: ${match[0] ?? '<empty>'}`);
      }
      return { file, symbol };
    });
    expect(anchors.length).toBeGreaterThan(0);
    const script = [
      'import ast, sys',
      'path, symbol = sys.argv[1], sys.argv[2]',
      'tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)',
      'for node in tree.body:',
      '    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol:',
      '        raise SystemExit(0)',
      '    if isinstance(node, ast.Assign):',
      '        for target in node.targets:',
      '            if isinstance(target, ast.Name) and target.id == symbol:',
      '                raise SystemExit(0)',
      '    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == symbol:',
      '        raise SystemExit(0)',
      'raise SystemExit(1)',
    ].join('\n');
    for (const anchor of anchors) {
      execFileSync('python3', ['-c', script, join(REPO_ROOT, anchor.file), anchor.symbol], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
    }
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
    expect(contract).toContain('claude_cli_version_minimum: claude-code 2.1.197');
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
    expect(executor).toContain('REQUIRED_CLAUDE_VERSION="2.1.197"');
    expect(executor).toContain('claude --version');
    // ORPHAN-MEDIUM-769 — aria-kernel-full.yml was deleted (a strict subset
    // of aria-kernel.yml, never a required context) and aria-kernel-fast.yml
    // became PR-only, so the push-on-main contract belongs to aria-kernel.yml
    // alone.
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

  it('package scripts expose the clean ARIA validation entrypoints', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['aria:compile']).toContain(
      "compile(p.read_text(encoding='utf-8'), str(p), 'exec')",
    );
    expect(pkg.scripts['aria:compile']).not.toContain('compileall');
    // The suite entrypoint delegates to scripts/ci/aria-suite-run.sh — the
    // single definition that runs the unittest half AND the pytest half
    // (unittest discovery collects TestCase classes only; the pytest-style
    // modules contributed zero executed tests under the old inline command).
    // These pins keep the delegation honest: entrypoint shape here, both
    // halves + the grep discovery in the script itself.
    expect(pkg.scripts['aria:test:unit']).toBe('bash scripts/ci/aria-suite-run.sh');
    expect(read('scripts/ci/aria-suite-run.sh')).toContain(
      "python3 -m unittest discover aria-kernel -p '*test*.py'",
    );
    expect(read('scripts/ci/aria-suite-run.sh')).toContain('python3 -m pytest -q');
    expect(read('scripts/ci/aria-suite-run.sh')).toContain(
      "grep -lE '^import pytest|^from pytest'",
    );
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
