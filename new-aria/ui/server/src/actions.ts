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

import type { ActionResponse, JobKind, JobResponse, JobState } from '../../shared/api-contract.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';

/** The pack adapter the console can run over a case archive. */
const LEGAL_INVENTORY_TOOL_ID = 'legal-document-inventory';

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

export interface LegalInventoryRequest {
  readonly caseId: string;
  /** Archive path relative to the workspace root the adapter runs in. */
  readonly archiveRoot: string;
  readonly title: string | null;
  /**
   * The case's intake receipt, one row per arrival. It is the only source of a
   * record's learnedAt: without it every timeline event's learnedAt is null and
   * the question the product exists to answer ("what was known on that date")
   * cannot be asked. MEASURED 2026-09-04: the console omitted it.
   */
  readonly intake: ReadonlyArray<{ readonly relativePath: string; readonly receivedAt: string }>;
  /** Corpus roots the instance manifest declares off-limits; the adapter records them as excluded and never reads them. */
  readonly excludeRoots: ReadonlyArray<string>;
}

interface JobRecord {
  readonly jobId: string;
  readonly kind: JobKind;
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
      kind: 'cycle',
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

  /**
   * Runs the legal document-inventory adapter over one case archive.
   *
   * It goes through `aria tool run` rather than a direct process spawn for the
   * same reason every other mutation does: the kernel owns tool execution, its
   * scope validation and its run ledger, so a console-triggered inventory is
   * recorded exactly like any other adapter run and is subject to the same
   * declared-scope enforcement. The adapter is registered at console boot with
   * `aria tool register`; the registry is additive, so registering a pack
   * adapter does not disturb the core set.
   *
   * Authorization is the route's job (the `corpus_inventory` gate of the
   * instance's approval policy), not the kernel-control switch: an inventory
   * reads the archive and writes case artifacts; it never touches the kernel's
   * own lifecycle.
   *
   * The input carries everything the adapter accepts for a case: the intake
   * receipt (learnedAt), the excluded roots, and the cycle id this run is
   * stamped with, so case.json names the run that produced it. The kernel's
   * run id is minted after the adapter has already been given its input, so
   * it cannot be passed in truthfully and is left null.
   */
  startLegalInventory(config: ServerConfig, request: LegalInventoryRequest): JobResponse {
    const cycleId = `legal-inventory-${request.caseId}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
    const input = JSON.stringify({
      archive_root: request.archiveRoot,
      case_id: request.caseId,
      ...(request.title === null ? {} : { title: request.title }),
      exclude_roots: request.excludeRoots,
      intake: request.intake,
      cycle_id: cycleId,
    });
    const argv = [
      'tool',
      'run',
      '--tool-id',
      LEGAL_INVENTORY_TOOL_ID,
      '--input',
      input,
      '--cycle-id',
      cycleId,
      // The ARIA install is the workspace root: the runner resolves the
      // adapter's own code and its node runtime relative to it. Case archives
      // live inside it, and archiveRunRoot has already proved they do.
      '--workspace-root',
      requireWorkspace(config),
      '--tools-dir',
      config.toolsDir,
    ];
    return this.spawnTracked(config, 'legal-inventory', argv);
  }

  private spawnTracked(config: ServerConfig, kind: JobKind, argv: ReadonlyArray<string>): JobResponse {
    const record: JobRecord = {
      jobId: randomUUID(),
      kind,
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
      kind: record.kind,
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
