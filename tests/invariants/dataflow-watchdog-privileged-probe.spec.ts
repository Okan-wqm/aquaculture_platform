/**
 * RW-2 — the dataflow-integrity watchdog reaches its privileged facts (container
 * state, tenant reality in Postgres) through ONE root-owned, fixed-argv,
 * read-only probe, never through docker from the runner account.
 *
 * WHY. Two of the five T1 probes (`container_state_truth`,
 * `tenant_reality_parity`) run `docker ps -q` / `docker exec aqua-postgres psql`
 * from `tools/watchdog/probe-runner.mjs` on the self-hosted runner. The runner
 * account (gharunner) has never been able to open /var/run/docker.sock: every
 * run of `dataflow-integrity-watchdog.yml` from the first one (2026-08-06,
 * run 31069638350) through run 39743828362 (2026-10-22) reports
 * `probe-error: ... permission denied while trying to connect to the docker
 * API`. No least-privilege mechanism was ever there to restore; the probes were
 * written against an access the runner did not have, and because a probe-error
 * exits 1 (not the CRITICAL exit 3) the lane stayed green while measuring
 * nothing for ten weeks.
 *
 * The fix must not give the runner docker: docker-group membership is root by
 * another name, and the runner identity (ADR-0023; pinned by
 * aria-kernel/tests/test_trust_anchor_boundary.py, measured by the hourly T2
 * probe) is `SupplementaryGroups=` + `NoNewPrivileges=yes`. That last property
 * also makes sudo inert for every process a job starts (measured on the live
 * unit: `systemctl show actions.runner.* -p NoNewPrivileges` = yes), so a
 * sudoers rule called from the job could never run the probe either. The
 * runner side therefore names no docker, no psql and no privilege gain; the
 * privileged half is a root-owned probe in the repository whose install
 * (ownership, mode, how root runs it) is a runbook section the program lead
 * applies after review.
 *
 * HOW. Static contract over the workflow's `probe` job and every script it
 * executes (followed through their relative imports); behavioural check that
 * the probe refuses any caller argument before it runs anything; static check
 * that every psql session the probe opens is read-only and that the probe
 * carries no write SQL and no docker verb beyond ps/inspect/exec-psql; one
 * owner of the tenant-reality statement; the install runbook section.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import yaml from 'js-yaml';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/dataflow-integrity-watchdog.yml');
const WATCHDOG_TOOLS_DIR = join(REPO_ROOT, 'tools/watchdog');
const PROBE_RUNNER_PATH = join(WATCHDOG_TOOLS_DIR, 'probe-runner.mjs');
const PROBE_RELPATH = 'infrastructure/scripts/aqua-dataflow-probe.sh';
const PROBE_PATH = join(REPO_ROOT, PROBE_RELPATH);
const PROBE_NAME = 'aqua-dataflow-probe';
const RUNBOOK_PATH = join(REPO_ROOT, 'docs/runbooks/monitoring/dataflow-integrity.md');

/** Commands the runner account must never start: the daemon socket, the database, a privilege gain. */
const RUNNER_FORBIDDEN_COMMANDS = ['docker', 'psql', 'sudo', 'su', 'pkexec', 'doas'] as const;
/** The tenant-reality statement's anchor: the one read of the declared tenant rows. */
const TENANT_REALITY_SQL = /FROM\s+auth\.tenants\b/i;
const READ_ONLY_SESSION = /default_transaction_read_only\s*=\s*on\b/;

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

interface Workflow {
  readonly jobs: { readonly probe: { readonly steps: readonly WorkflowStep[] } };
}

/** A capture group the pattern always fills; a miss is a broken pattern, not an input to tolerate. */
function captured(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`pattern group ${index} did not capture in ${match[0]}`);
  return value;
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function probeJobRunBlocks(): string[] {
  const workflow = yaml.load(read(WORKFLOW_PATH)) as Workflow;
  return workflow.jobs.probe.steps.flatMap((step) => (step.run ? [step.run] : []));
}

/** Shell text without full-line comments, continuation lines joined. */
function shellLogicalLines(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** JS text without line and block comments (good enough for these tool files: no `//` in strings that matter). */
function jsWithoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function shellInvokesForbidden(line: string): string | null {
  for (const command of RUNNER_FORBIDDEN_COMMANDS) {
    const pattern = new RegExp(`(?:^|[\\s;&|(\`$])(?:/[\\w/]*/)?${command}(?=\\s|$|;|\\))`);
    if (pattern.test(line)) return command;
  }
  return null;
}

function jsInvokesForbidden(text: string): string[] {
  const code = jsWithoutComments(text);
  const found: string[] = [];
  for (const command of RUNNER_FORBIDDEN_COMMANDS) {
    const spawnCall = new RegExp(
      String.raw`\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\s*\(\s*(['"\`])(?:[^'"\`]*/)?${command}\b`,
    );
    const commandLiteral = new RegExp(String.raw`(['"\`])(?:/[\w/]*/)?${command}\1`);
    if (spawnCall.test(code) || commandLiteral.test(code)) found.push(command);
  }
  return found;
}

/** Every node script the probe job runs, followed through relative imports. */
function scriptsTheJobExecutes(): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const block of probeJobRunBlocks()) {
    for (const match of block.matchAll(/\bnode\s+([\w./-]+\.m?js)\b/g)) {
      queue.push(join(REPO_ROOT, captured(match, 1)));
    }
  }
  // The array iterator re-reads the length on each step, so imports pushed
  // while walking are visited in the same loop.
  for (const file of queue) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = read(file);
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      queue.push(resolve(dirname(file), captured(match, 1)));
    }
  }
  return [...seen].sort();
}

function runnerSideFiles(): string[] {
  const tools = readdirSync(WATCHDOG_TOOLS_DIR)
    .filter((name) => /\.m?[jt]s$/.test(name) && !/\.(spec|test)\.m?[jt]s$/.test(name))
    .map((name) => join(WATCHDOG_TOOLS_DIR, name));
  return [WORKFLOW_PATH, ...tools];
}

function nonCommentText(path: string): string {
  const text = read(path);
  if (path.endsWith('.yml')) {
    return text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
  }
  return jsWithoutComments(text);
}

function expectProbePresent(): string {
  expect(existsSync(PROBE_PATH)).toBe(true);
  return read(PROBE_PATH);
}

describe('RW-2 — the runner side of the dataflow watchdog reaches no privileged surface', () => {
  it('nothing the probe job runs starts docker, psql or a privilege gain', () => {
    const offenders: string[] = [];
    for (const block of probeJobRunBlocks()) {
      for (const line of shellLogicalLines(block)) {
        const command = shellInvokesForbidden(line);
        if (command) offenders.push(`workflow run: ${command}: ${line}`);
      }
    }
    const scripts = scriptsTheJobExecutes();
    expect(scripts).toContain(PROBE_RUNNER_PATH);
    for (const script of scripts) {
      for (const command of jsInvokesForbidden(read(script))) {
        offenders.push(`${relative(REPO_ROOT, script)}: ${command}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the privileged evidence enters through the probe, named once on the runner side', () => {
    const naming = runnerSideFiles().flatMap((path) => {
      const count = nonCommentText(path).split(PROBE_NAME).length - 1;
      return count > 0 ? [`${relative(REPO_ROOT, path)} x${count}`] : [];
    });
    expect(naming).toHaveLength(1);
    expect(naming[0]).toMatch(/ x1$/);
  });

  it('the container and tenant-reality probes keep reporting under their ids (no probe is dropped to go green)', () => {
    const sources = [read(PROBE_RUNNER_PATH), existsSync(PROBE_PATH) ? read(PROBE_PATH) : ''].join(
      '\n',
    );
    expect(sources).toContain('container_state_truth');
    expect(sources).toContain('tenant_reality_parity');
  });
});

describe('RW-2 — the root-owned probe takes nothing from its caller and only reads', () => {
  it('refuses every caller argument before it runs anything', () => {
    expectProbePresent();
    const root = mkdtempSync(join(tmpdir(), 'rw2-probe-argv-'));
    try {
      const stubs = join(root, 'bin');
      const log = join(root, 'calls.log');
      mkdirSync(stubs);
      writeFileSync(log, '');
      for (const command of ['docker', 'psql', 'sudo']) {
        const stub = join(stubs, command);
        writeFileSync(stub, `#!/bin/sh\nprintf '%s %s\\n' "${command}" "$*" >> '${log}'\nexit 0\n`);
        chmodSync(stub, 0o755);
      }
      for (const argv of [['--repo', '/tmp'], [''], ['-c', 'DROP TABLE auth.tenants'], ['x']]) {
        const result = spawnSync('bash', [PROBE_PATH, ...argv], {
          encoding: 'utf8',
          env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: root },
          timeout: 10000,
        });
        expect({
          argv,
          status: result.status === 0 ? 0 : 'nonzero',
          stdout: result.stdout,
        }).toEqual({
          argv,
          status: 'nonzero',
          stdout: '',
        });
      }
      expect(read(log)).toBe('');
    } finally {
      removeFixtureTree(root);
    }
  });

  it('opens every psql session read-only (default_transaction_read_only=on)', () => {
    const lines = shellLogicalLines(expectProbePresent());
    const readOnlyVariables = new Set(
      lines.flatMap((line) => {
        const assignment = /^(?:readonly\s+|declare\s+-r\s+|local\s+)?([A-Za-z_]\w*)=(.*)$/.exec(
          line,
        );
        return assignment && READ_ONLY_SESSION.test(captured(assignment, 2))
          ? [captured(assignment, 1)]
          : [];
      }),
    );
    const psqlLines = lines.filter((line) => /\bpsql\b/.test(line) && !/^[A-Za-z_]\w*=/.test(line));
    expect(psqlLines.length).toBeGreaterThan(0);
    const unguarded = psqlLines.filter(
      (line) =>
        !READ_ONLY_SESSION.test(line) &&
        ![...readOnlyVariables].some((name) => new RegExp(String.raw`\$\{?${name}\b`).test(line)),
    );
    expect(unguarded).toEqual([]);
  });

  it('uses only read-only docker verbs, and exec only to run psql in the database container', () => {
    const lines = shellLogicalLines(expectProbePresent());
    const offenders: string[] = [];
    for (const line of lines) {
      for (const match of line.matchAll(
        /(?:^|[\s;&|(`$"'])(?:\/[\w/]*\/)?docker\s+([a-z][\w-]*)/g,
      )) {
        const verb = captured(match, 1);
        if (!['ps', 'inspect', 'exec'].includes(verb)) offenders.push(`verb ${verb}: ${line}`);
        if (verb === 'exec' && !(/\baqua-postgres\b/.test(line) && /\bpsql\b/.test(line))) {
          offenders.push(`exec beyond psql in aqua-postgres: ${line}`);
        }
        if (/--privileged\b/.test(line)) offenders.push(`privileged exec: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no write, DDL or read-write switch in its SQL', () => {
    const code = shellLogicalLines(expectProbePresent()).join('\n');
    const writes = [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+[\w."]+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\b(?:DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\s+[A-Z]/i,
      /\bCOPY\s+[\w."(]/i,
      /\bREAD\s+WRITE\b/i,
      /default_transaction_read_only\s*=\s*off\b/i,
      /\bset_config\s*\(/i,
    ].filter((pattern) => pattern.test(code));
    expect(writes.map(String)).toEqual([]);
  });

  it('owns the tenant-reality statement: the probe has it and no runner-side tool does', () => {
    expect(TENANT_REALITY_SQL.test(expectProbePresent())).toBe(true);
    const secondOwners = runnerSideFiles().filter((path) =>
      TENANT_REALITY_SQL.test(nonCommentText(path)),
    );
    expect(secondOwners.map((path) => relative(REPO_ROOT, path))).toEqual([]);
  });
});

describe('RW-2 — the probe install is reviewed in the repository', () => {
  it('the dataflow runbook carries the install section: source, root-owned install path, owner and a mode no one else can write', () => {
    const runbook = read(RUNBOOK_PATH);
    expect(runbook).toContain(PROBE_RELPATH);
    expect(runbook).toMatch(/\/usr\/local\/(?:s?bin|libexec)\/aqua-dataflow-probe\b/);
    expect(runbook).toMatch(/\broot:root\b|-o\s+root\s+-g\s+root\b/);
    expect(runbook).toMatch(/\b0[0-7][0145][0145]\b/);
  });
});
