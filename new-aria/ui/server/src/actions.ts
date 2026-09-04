// Kernel actions — every mutation the console offers is a kernel CLI call.
//
// WHY: the console must never write ledgers itself (the kernel's declared-surface
// gate and hash chains are the authority); it may only ask the kernel to act and
// show the kernel's own answer. Read-only verifications (`integrity verify`,
// `doctor`) are always allowed; state-changing verbs need ARIA_UI_ALLOW_ACTIONS.
// WHAT: spawn with explicit argv (never a shell string), bounded stdout/stderr,
// a timeout that kills the child, and a small in-memory job table for the
// long-running `cycle run`.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ActionResponse, JobResponse, JobState } from '../../shared/api-contract.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';

const OUTPUT_CAP_BYTES = 1024 * 1024;
const TAIL_CAP_BYTES = 16 * 1024;

interface SpawnOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function appendBounded(current: string, chunk: Buffer, cap: number): string {
  const next = current + chunk.toString('utf8');
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function runKernel(config: ServerConfig, argv: ReadonlyArray<string>, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    const child = spawn(config.kernelBin, [...argv], {
      cwd: config.workspaceRoot ?? config.toolsDir,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, OUTPUT_CAP_BYTES);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, OUTPUT_CAP_BYTES);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectOutcome(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveOutcome({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function runAction(config: ServerConfig, argv: ReadonlyArray<string>): Promise<ActionResponse> {
  const startedAt = new Date().toISOString();
  const outcome = await runKernel(config, argv, config.actionTimeoutMs);
  const finishedAt = new Date().toISOString();
  return {
    ok: outcome.exitCode === 0 && !outcome.timedOut,
    command: [config.kernelBin, ...argv],
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.timedOut ? `${outcome.stderr}\n[killed after ${config.actionTimeoutMs} ms]` : outcome.stderr,
    parsed: parseJsonOrNull(outcome.stdout),
    startedAt,
    finishedAt,
  };
}

function requireWorkspace(config: ServerConfig): string {
  if (config.workspaceRoot === null) throw new HttpError(409, 'workspace_root_not_configured');
  return config.workspaceRoot;
}

function requireActions(config: ServerConfig): void {
  if (!config.allowActions) throw new HttpError(403, 'actions_disabled', 'set ARIA_UI_ALLOW_ACTIONS=1 to enable mutating actions');
}

export function integrityVerify(config: ServerConfig): Promise<ActionResponse> {
  const workspace = requireWorkspace(config);
  return runAction(config, ['integrity', 'verify', '--tools-dir', config.toolsDir, '--workspace-root', workspace, '--workspace-base', config.workspaceBase]);
}

export function doctor(config: ServerConfig): Promise<ActionResponse> {
  const workspace = requireWorkspace(config);
  return runAction(config, ['doctor', '--tools-dir', config.toolsDir, '--workspace-root', workspace]);
}

export function control(config: ServerConfig, verb: string, reason: string): Promise<ActionResponse> {
  requireActions(config);
  if (verb !== 'pause' && verb !== 'resume') throw new HttpError(400, 'control_verb_invalid');
  if (reason.trim().length < 10) throw new HttpError(400, 'reason_too_short', 'the kernel audit row needs at least 10 characters');
  return runAction(config, ['control', verb, '--tools-dir', config.toolsDir, '--reason', reason.trim()]);
}

interface JobRecord {
  readonly jobId: string;
  readonly command: ReadonlyArray<string>;
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

export class JobTable {
  private readonly jobs = new Map<string, JobRecord>();

  startCycle(config: ServerConfig, cycleId: string | undefined, discoveryOnly: boolean): JobResponse {
    requireActions(config);
    const workspace = requireWorkspace(config);
    const id = cycleId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cycleId) ? cycleId : `console-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
    const argv = ['cycle', 'run', '--cycle-id', id, '--workspace-root', workspace, '--workspace-base', config.workspaceBase, '--tools-dir', config.toolsDir];
    if (discoveryOnly) argv.push('--discovery-only');
    const record: JobRecord = {
      jobId: randomUUID(),
      command: [config.kernelBin, ...argv],
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      stdoutTail: '',
      stderrTail: '',
    };
    this.jobs.set(record.jobId, record);
    runKernel(config, argv, config.actionTimeoutMs)
      .then((outcome) => {
        record.state = outcome.exitCode === 0 && !outcome.timedOut ? 'succeeded' : 'failed';
        record.exitCode = outcome.exitCode;
        record.stdoutTail = outcome.stdout.slice(-TAIL_CAP_BYTES);
        record.stderrTail = outcome.stderr.slice(-TAIL_CAP_BYTES);
        record.finishedAt = new Date().toISOString();
      })
      .catch((error: unknown) => {
        record.state = 'failed';
        record.stderrTail = error instanceof Error ? error.message : String(error);
        record.finishedAt = new Date().toISOString();
      });
    return this.view(record);
  }

  get(jobId: string): JobResponse {
    const record = this.jobs.get(jobId);
    if (record === undefined) throw new HttpError(404, 'job_not_found');
    return this.view(record);
  }

  private view(record: JobRecord): JobResponse {
    return {
      jobId: record.jobId,
      kind: 'cycle',
      state: record.state,
      command: record.command,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      stdoutTail: record.stdoutTail,
      stderrTail: record.stderrTail,
    };
  }
}
