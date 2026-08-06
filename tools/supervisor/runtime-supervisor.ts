#!/usr/bin/env node
/**
 * T0 runtime supervisor — the layer that notices within minutes, not days.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two production incidents came from the same blind spot. On 2026-08-03 six
 * containers exited on a full disk at 02:07 and `docker ps` kept printing
 * "Up 2 weeks" for two days, because the text listing reports the container
 * record, not `State.Running`. On 2026-08-06 the tenant-schema provisioner
 * was found dead since 2026-07-31: its restart policy is `unless-stopped`,
 * Docker had given up after repeated DNS failures, and nothing asked again
 * for six days.
 *
 * Docker's restart policy is a retry, not a supervisor. It gives up, and
 * when it gives up nobody is told. This process is the thing that keeps
 * asking.
 *
 * DESIGN RULES
 * ------------
 * - No LLM, no network calls, no repository state. It must work when the
 *   platform is down, which is the only time it matters.
 * - `State.Running` from `docker inspect` is the truth. The `docker ps`
 *   text listing is not consulted anywhere.
 * - It revives what Docker's own policy already says should be running,
 *   and NOTHING else. A container with `restart: no` that exited cleanly is
 *   a finished job, not a fault - db-migrate looks exactly like that.
 * - Restarts are capped per container per window. An unbounded restarter
 *   turns a crash-loop into a resource fire and hides the crash while doing
 *   it; after the cap it stops trying and says so.
 * - Disk and memory pressure are REPORTED, never reclaimed. Deleting images
 *   to free space is a judgement about what is safe to lose, and this
 *   process is deliberately too dumb to make it.
 *
 * OUTPUT
 * ------
 * One JSON evidence envelope on stdout (same convention as
 * scripts/deploy/post-deploy-verify.sh), plus a Prometheus textfile so the
 * existing rules can alert on what it found. Exit 0 when healthy, 3 when
 * something CRITICAL is unresolved after intervention.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface SupervisorState {
  /** container name -> restart attempt timestamps (ms), pruned to the window */
  restarts: Record<string, number[]>;
}

interface ContainerFact {
  name: string;
  running: boolean;
  exitCode: number;
  restartPolicy: string;
  finishedAt: string;
}

interface Action {
  container: string;
  action: 'restarted' | 'restart_failed' | 'restart_capped';
  detail: string;
}

interface Problem {
  severity: 'critical' | 'high' | 'warning';
  kind: string;
  detail: string;
}

const STATE_PATH = process.env.SUPERVISOR_STATE_PATH ?? '/var/lib/aqua-supervisor/state.json';
const TEXTFILE_PATH =
  process.env.SUPERVISOR_TEXTFILE_PATH ?? '/var/lib/node_exporter/textfile/aqua_supervisor.prom';
const RESTART_WINDOW_MS = 60 * 60 * 1000;
const RESTART_CAP = 3;
const DISK_WARN_PERCENT = 85;
const DISK_CRITICAL_PERCENT = 92;
const SWAP_WARN_PERCENT = 50;

/** Policies under which Docker itself claims the container should be running. */
const SUPERVISED_POLICIES = new Set(['always', 'unless-stopped']);

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
}

function readState(): SupervisorState {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as SupervisorState;
    return { restarts: raw.restarts ?? {} };
  } catch {
    return { restarts: {} };
  }
}

function writeState(state: SupervisorState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}

function containerFacts(): ContainerFact[] {
  const ids = docker(['ps', '-aq']).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const format =
    '{{.Name}}\t{{.State.Running}}\t{{.State.ExitCode}}\t{{.HostConfig.RestartPolicy.Name}}\t{{.State.FinishedAt}}';
  const raw = docker(['inspect', '-f', format, ...ids]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, running, exitCode, restartPolicy, finishedAt] = line.split('\t');
      return {
        name: (name ?? '').replace(/^\//, ''),
        running: running === 'true',
        exitCode: Number(exitCode ?? 0),
        restartPolicy: restartPolicy ?? 'no',
        finishedAt: finishedAt ?? '',
      };
    });
}

function diskPercent(): number {
  const out = execFileSync('df', ['-P', '/'], { encoding: 'utf8' }).trim().split('\n');
  const line = out[out.length - 1] ?? '';
  const match = line.match(/(\d+)%/);
  return match ? Number(match[1]) : 0;
}

function swapPercent(): number {
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const total = Number(/SwapTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0);
  const free = Number(/SwapFree:\s+(\d+)/.exec(meminfo)?.[1] ?? 0);
  if (total === 0) return 0;
  return Math.round(((total - free) / total) * 100);
}

function reviveIfSupervised(
  fact: ContainerFact,
  state: SupervisorState,
  now: number,
): Action | null {
  if (fact.running) return null;
  // Docker's own policy is the declaration of intent. A one-shot job with
  // `restart: no` that exited is finished work, not a casualty.
  if (!SUPERVISED_POLICIES.has(fact.restartPolicy)) return null;

  const recent = (state.restarts[fact.name] ?? []).filter((at) => now - at < RESTART_WINDOW_MS);
  if (recent.length >= RESTART_CAP) {
    state.restarts[fact.name] = recent;
    return {
      container: fact.name,
      action: 'restart_capped',
      detail: `${recent.length} restarts in the last hour; not trying again - this needs a human, not another restart`,
    };
  }

  try {
    docker(['start', fact.name]);
    state.restarts[fact.name] = [...recent, now];
    return {
      container: fact.name,
      action: 'restarted',
      detail: `was not running (exit ${fact.exitCode}, policy ${fact.restartPolicy}, stopped ${fact.finishedAt})`,
    };
  } catch (error) {
    state.restarts[fact.name] = [...recent, now];
    return {
      container: fact.name,
      action: 'restart_failed',
      detail: (error as Error).message.split('\n')[0] ?? 'docker start failed',
    };
  }
}

function writeTextfile(params: {
  problems: Problem[];
  actions: Action[];
  disk: number;
  swap: number;
  notRunning: number;
}): void {
  const lines = [
    '# HELP aqua_supervisor_last_run_timestamp_seconds Unix time of the last supervisor pass',
    '# TYPE aqua_supervisor_last_run_timestamp_seconds gauge',
    `aqua_supervisor_last_run_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
    '# HELP aqua_supervisor_containers_not_running Supervised containers found stopped',
    '# TYPE aqua_supervisor_containers_not_running gauge',
    `aqua_supervisor_containers_not_running ${params.notRunning}`,
    '# HELP aqua_supervisor_actions Interventions taken on the last pass, by action',
    '# TYPE aqua_supervisor_actions gauge',
    '# HELP aqua_supervisor_problems Unresolved problems on the last pass, by severity',
    '# TYPE aqua_supervisor_problems gauge',
    '# HELP aqua_supervisor_disk_used_percent Root filesystem usage',
    '# TYPE aqua_supervisor_disk_used_percent gauge',
    `aqua_supervisor_disk_used_percent ${params.disk}`,
    '# HELP aqua_supervisor_swap_used_percent Swap usage',
    '# TYPE aqua_supervisor_swap_used_percent gauge',
    `aqua_supervisor_swap_used_percent ${params.swap}`,
  ];
  for (const action of ['restarted', 'restart_failed', 'restart_capped']) {
    const count = params.actions.filter((a) => a.action === action).length;
    lines.push(`aqua_supervisor_actions{action="${action}"} ${count}`);
  }
  for (const severity of ['critical', 'high', 'warning']) {
    const count = params.problems.filter((p) => p.severity === severity).length;
    lines.push(`aqua_supervisor_problems{severity="${severity}"} ${count}`);
  }
  try {
    mkdirSync(dirname(TEXTFILE_PATH), { recursive: true });
    const tmp = `${TEXTFILE_PATH}.tmp`;
    writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
    renameSync(tmp, TEXTFILE_PATH);
  } catch {
    // A missing textfile directory must not stop the supervisor from doing
    // its actual job; the evidence envelope still carries everything.
  }
}

function main(): number {
  const now = Date.now();
  const state = readState();
  const facts = containerFacts();
  const actions: Action[] = [];
  const problems: Problem[] = [];

  for (const fact of facts) {
    const action = reviveIfSupervised(fact, state, now);
    if (!action) continue;
    actions.push(action);
    if (action.action !== 'restarted') {
      problems.push({
        severity: 'critical',
        kind: 'container_down',
        detail: `${action.container}: ${action.detail}`,
      });
    }
  }

  const supervisedDown = facts.filter(
    (f) => !f.running && SUPERVISED_POLICIES.has(f.restartPolicy),
  );

  const disk = diskPercent();
  if (disk >= DISK_CRITICAL_PERCENT) {
    problems.push({
      severity: 'critical',
      kind: 'disk_pressure',
      detail: `root filesystem ${disk}% used; the 2026-08-03 outage began here. Reclaiming space is a human decision - this process will not delete anything.`,
    });
  } else if (disk >= DISK_WARN_PERCENT) {
    problems.push({
      severity: 'warning',
      kind: 'disk_pressure',
      detail: `root filesystem ${disk}% used`,
    });
  }

  const swap = swapPercent();
  if (swap >= SWAP_WARN_PERCENT) {
    problems.push({
      severity: 'warning',
      kind: 'swap_pressure',
      detail: `swap ${swap}% used; something is over its memory budget`,
    });
  }

  writeState(state);
  writeTextfile({
    problems,
    actions,
    disk,
    swap,
    notRunning: supervisedDown.length,
  });

  const envelope = {
    schema: 'aqua/runtime-supervisor/v1',
    checked_at: new Date(now).toISOString(),
    container_count: facts.length,
    supervised_down: supervisedDown.map((f) => f.name),
    actions,
    problems,
    disk_used_percent: disk,
    swap_used_percent: swap,
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);

  return problems.some((p) => p.severity === 'critical') ? 3 : 0;
}

process.exitCode = main();
