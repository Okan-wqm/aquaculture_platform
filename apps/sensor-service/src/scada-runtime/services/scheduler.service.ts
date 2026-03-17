/**
 * SchedulerService
 *
 * Cron / interval task scheduler for SCADA HMI server-mode scripts.
 *
 * Architecture
 * ─────────────
 * • Three scheduling modes (mirrors FUXA FunctionType):
 *     interval  — executes a script repeatedly every `intervalSec` seconds
 *                 (implemented with setInterval).
 *     start     — executes once after `startDelaySec` seconds from module
 *                 init (implemented with setTimeout).
 *     cron      — executes on a cron schedule defined by `cronExpression`
 *                 (implemented with the internal CronTimer helper which
 *                 uses setInterval at 1-second resolution to evaluate the
 *                 cron expression — no external npm package required).
 *
 * • All enabled server-mode scripts are registered via `loadScripts()`,
 *   called externally (e.g. from a project-load event handler).
 *
 * • `addScript` / `removeScript` / `updateScript` allow hot-reload of
 *   individual scripts without restarting the module.
 *
 * • Re-entrant execution is prevented per-script via an in-flight Set:
 *   if a scheduled tick fires while the previous execution is still
 *   running, the tick is skipped and a warning is logged.
 *
 * • Full cleanup (clearInterval / clearTimeout / stop CronTimer) on
 *   `onModuleDestroy` to avoid resource leaks in test and shutdown.
 *
 * Cron expression support
 * ──────────────────────
 * Standard 5-field POSIX cron syntax: minute hour dom month dow
 *   *   — any value
 *   ,   — value list separator   (e.g. 1,3,5)
 *   -   — range                  (e.g. 1-5)
 *   /   — step                   (e.g. *\/5)
 *
 * Examples:
 *   "* * * * *"       — every minute
 *   "0 * * * *"       — every hour on the hour
 *   "0 0 * * *"       — daily at midnight
 *   "*\/30 * * * *"   — every 30 minutes
 *   "0 8-18 * * 1-5"  — every hour between 08:00–18:00 Monday–Friday
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

import type { ScadaScript, ScriptSchedulingMode } from '../../../../../../web/modules/sensor-module/src/types/scada-runtime.types';

import { ScriptEngineService } from './script-engine.service';

/* ================================================================== */
/*  Internal CronTimer — pure-Node cron evaluator                      */
/*                                                                     */
/*  Ticks once per second and evaluates the 5-field cron expression    */
/*  against the current wall-clock minute. Calls the callback once per */
/*  matching minute (not per tick within that minute).                  */
/* ================================================================== */

/**
 * Parses and evaluates a single cron field.
 *
 * Handles: * | value | list (,) | range (-) | step (/) and combinations.
 * Returns true if `value` matches the field expression.
 */
function matchCronField(expr: string, value: number, min: number, max: number): boolean {
  for (const part of expr.split(',')) {
    if (matchSingleCronPart(part.trim(), value, min, max)) return true;
  }
  return false;
}

function matchSingleCronPart(
  part: string,
  value: number,
  min: number,
  max: number,
): boolean {
  // Step syntax: range/step or */step
  const slashIdx = part.indexOf('/');
  if (slashIdx !== -1) {
    const rangePart = part.substring(0, slashIdx);
    const step = parseInt(part.substring(slashIdx + 1), 10);
    if (isNaN(step) || step <= 0) return false;

    let rangeMin = min;
    let rangeMax = max;

    if (rangePart !== '*') {
      const dashIdx = rangePart.indexOf('-');
      if (dashIdx !== -1) {
        rangeMin = parseInt(rangePart.substring(0, dashIdx), 10);
        rangeMax = parseInt(rangePart.substring(dashIdx + 1), 10);
      } else {
        rangeMin = parseInt(rangePart, 10);
        rangeMax = max;
      }
    }

    for (let v = rangeMin; v <= rangeMax; v += step) {
      if (v === value) return true;
    }
    return false;
  }

  // Range syntax: min-max
  const dashIdx = part.indexOf('-');
  if (dashIdx !== -1) {
    const lo = parseInt(part.substring(0, dashIdx), 10);
    const hi = parseInt(part.substring(dashIdx + 1), 10);
    return value >= lo && value <= hi;
  }

  // Wildcard
  if (part === '*') return true;

  // Exact value
  const exact = parseInt(part, 10);
  return !isNaN(exact) && exact === value;
}

/**
 * Evaluate whether the current wall-clock moment matches a 5-field cron
 * expression.
 *
 * Fields: minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-6, 0=Sun)
 */
function matchesCronExpression(expression: string, now: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minF, hourF, domF, monF, dowF] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  return (
    matchCronField(minF,  now.getMinutes(),  0, 59) &&
    matchCronField(hourF, now.getHours(),    0, 23) &&
    matchCronField(domF,  now.getDate(),     1, 31) &&
    matchCronField(monF,  now.getMonth() + 1, 1, 12) &&
    matchCronField(dowF,  now.getDay(),      0, 6)
  );
}

/**
 * Minimal CronTimer: polls at 1-second resolution, fires the callback
 * once per matching cron minute, then suppresses further firings for the
 * remainder of that minute.
 */
class CronTimer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFiredMinute: number = -1;

  constructor(
    private readonly expression: string,
    private readonly callback: () => void,
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      const now = new Date();
      const minuteKey =
        now.getFullYear() * 525_960 + // unique per year+minute
        (now.getMonth() + 1) * 43_830 +
        now.getDate() * 1_440 +
        now.getHours() * 60 +
        now.getMinutes();

      if (minuteKey === this.lastFiredMinute) return; // already fired this minute

      if (matchesCronExpression(this.expression, now)) {
        this.lastFiredMinute = minuteKey;
        try {
          this.callback();
        } catch {
          // caller handles errors
        }
      }
    }, 1_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

/* ================================================================== */
/*  Job handle union — what we store per registered script             */
/* ================================================================== */

type JobHandle =
  | { kind: 'interval'; handle: ReturnType<typeof setInterval> }
  | { kind: 'timeout';  handle: ReturnType<typeof setTimeout> }
  | { kind: 'cron';     timer: CronTimer };

/* ================================================================== */
/*  Service                                                             */
/* ================================================================== */

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);

  /** scriptId → active job handle */
  private readonly jobs = new Map<string, JobHandle>();

  /** scriptId → currently running execution Promise (mutex guard) */
  private readonly inFlight = new Set<string>();

  constructor(private readonly scriptEngine: ScriptEngineService) {}

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  onModuleInit(): void {
    this.logger.log('SchedulerService initialised — waiting for script registration');
  }

  onModuleDestroy(): void {
    this.logger.log(
      `SchedulerService stopping — clearing ${this.jobs.size} job(s)`,
    );
    this.clearAllJobs();
    this.logger.log('SchedulerService stopped');
  }

  /* ---------------------------------------------------------------- */
  /*  Bulk load                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Register all enabled server-mode scripts.
   *
   * Clears any previously registered jobs first so this method is safe
   * to call on project reload.
   */
  loadScripts(scripts: ScadaScript[]): void {
    this.clearAllJobs();

    const serverScripts = scripts.filter(
      (s) => s.mode === 'server' && s.enabled && s.scheduling,
    );

    for (const script of serverScripts) {
      try {
        this.registerJob(script);
      } catch (err) {
        this.logger.error(
          `loadScripts: failed to register script id=${script.id} ` +
            `name="${script.name}" — ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `SchedulerService: loaded ${this.jobs.size} job(s) from ` +
        `${serverScripts.length} eligible script(s)`,
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Individual script management                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Add a single script to the scheduler.
   *
   * No-ops if the script already has a registered job (use `updateScript`
   * to replace an existing registration).
   */
  addScript(script: ScadaScript): void {
    if (this.jobs.has(script.id)) {
      this.logger.warn(
        `addScript: script id=${script.id} already registered — use updateScript`,
      );
      return;
    }

    if (!script.enabled || script.mode !== 'server' || !script.scheduling) {
      this.logger.debug(
        `addScript: script id=${script.id} skipped (disabled, non-server, or no scheduling)`,
      );
      return;
    }

    try {
      this.registerJob(script);
      this.logger.log(
        `addScript: registered script id=${script.id} name="${script.name}" ` +
          `mode=${script.scheduling?.mode ?? 'unknown'}`,
      );
    } catch (err) {
      this.logger.error(
        `addScript: failed id=${script.id} — ${(err as Error).message}`,
      );
    }
  }

  /**
   * Remove a script from the scheduler and stop its job.
   */
  removeScript(scriptId: string): void {
    const job = this.jobs.get(scriptId);
    if (!job) {
      this.logger.debug(`removeScript: script id=${scriptId} not found`);
      return;
    }

    this.clearJob(scriptId, job);
    this.jobs.delete(scriptId);
    this.logger.log(`removeScript: unregistered script id=${scriptId}`);
  }

  /**
   * Replace a script's job registration with a fresh one.
   *
   * Stops the current job (if any), then re-registers according to the
   * new script configuration.
   */
  updateScript(script: ScadaScript): void {
    this.removeScript(script.id);
    this.addScript(script);
    this.logger.log(`updateScript: refreshed script id=${script.id} name="${script.name}"`);
  }

  /* ---------------------------------------------------------------- */
  /*  Job registration                                                  */
  /* ---------------------------------------------------------------- */

  private registerJob(script: ScadaScript): void {
    const scheduling = script.scheduling;
    if (!scheduling) {
      throw new Error(`Script id=${script.id} has no scheduling configuration`);
    }

    const mode: ScriptSchedulingMode = scheduling.mode;

    switch (mode) {
      case 'interval': {
        const intervalSec = scheduling.intervalSec ?? 60;
        if (intervalSec <= 0) {
          throw new Error(
            `Script id=${script.id}: intervalSec must be positive (got ${intervalSec})`,
          );
        }

        const handle = setInterval(() => {
          void this.executeScript(script);
        }, intervalSec * 1_000);

        this.jobs.set(script.id, { kind: 'interval', handle });

        this.logger.log(
          `[scheduler] interval job registered: id=${script.id} ` +
            `name="${script.name}" every=${intervalSec}s`,
        );
        break;
      }

      case 'start': {
        const delaySec = scheduling.startDelaySec ?? 0;
        if (delaySec < 0) {
          throw new Error(
            `Script id=${script.id}: startDelaySec must be non-negative (got ${delaySec})`,
          );
        }

        const handle = setTimeout(() => {
          void this.executeScript(script);
          // Remove the job handle after it fires — it's a one-shot
          this.jobs.delete(script.id);
        }, delaySec * 1_000);

        this.jobs.set(script.id, { kind: 'timeout', handle });

        this.logger.log(
          `[scheduler] start job registered: id=${script.id} ` +
            `name="${script.name}" delay=${delaySec}s`,
        );
        break;
      }

      case 'cron': {
        const expr = scheduling.cronExpression;
        if (!expr || expr.trim() === '') {
          throw new Error(
            `Script id=${script.id}: cronExpression is required for cron mode`,
          );
        }

        const timer = new CronTimer(expr, () => {
          void this.executeScript(script);
        });

        timer.start();
        this.jobs.set(script.id, { kind: 'cron', timer });

        this.logger.log(
          `[scheduler] cron job registered: id=${script.id} ` +
            `name="${script.name}" expr="${expr}"`,
        );
        break;
      }

      default: {
        // Exhaustiveness guard — TypeScript will flag missing cases at compile time
        const _exhaustive: never = mode;
        throw new Error(
          `Script id=${script.id}: unknown scheduling mode "${_exhaustive as string}"`,
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Script execution (with mutex)                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Execute a script via the ScriptEngineService.
   *
   * Uses `inFlight` as a per-script mutex: if the previous scheduled
   * execution has not yet finished when the next tick fires, the new
   * tick is skipped to prevent concurrent execution of the same script.
   */
  private async executeScript(script: ScadaScript): Promise<void> {
    if (this.inFlight.has(script.id)) {
      this.logger.warn(
        `[scheduler] Skipping script id=${script.id} — previous execution still running`,
      );
      return;
    }

    this.inFlight.add(script.id);

    try {
      this.logger.debug(
        `[scheduler] Executing script id=${script.id} name="${script.name}"`,
      );

      const result = await this.scriptEngine.runScript(script);

      if (result.success) {
        this.logger.debug(
          `[scheduler] Script id=${script.id} completed in ${result.durationMs}ms`,
        );
      } else {
        this.logger.warn(
          `[scheduler] Script id=${script.id} execution failed: ${result.error ?? 'unknown error'}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[scheduler] Unexpected error executing script id=${script.id}: ` +
          `${(err as Error).message}`,
      );
    } finally {
      this.inFlight.delete(script.id);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Cleanup helpers                                                   */
  /* ---------------------------------------------------------------- */

  private clearJob(scriptId: string, job: JobHandle): void {
    switch (job.kind) {
      case 'interval':
        clearInterval(job.handle);
        this.logger.debug(`[scheduler] Cleared interval job scriptId=${scriptId}`);
        break;

      case 'timeout':
        clearTimeout(job.handle);
        this.logger.debug(`[scheduler] Cleared timeout job scriptId=${scriptId}`);
        break;

      case 'cron':
        job.timer.stop();
        this.logger.debug(`[scheduler] Stopped cron job scriptId=${scriptId}`);
        break;

      default: {
        const _exhaustive: never = job;
        this.logger.warn(
          `[scheduler] Unknown job kind for scriptId=${scriptId}: ${(_exhaustive as JobHandle).kind}`,
        );
      }
    }
  }

  private clearAllJobs(): void {
    for (const [scriptId, job] of this.jobs) {
      try {
        this.clearJob(scriptId, job);
      } catch (err) {
        this.logger.error(
          `clearAllJobs: error clearing job scriptId=${scriptId} — ${(err as Error).message}`,
        );
      }
    }
    this.jobs.clear();
    this.inFlight.clear();
  }

  /* ---------------------------------------------------------------- */
  /*  Diagnostics                                                       */
  /* ---------------------------------------------------------------- */

  /** Returns the number of currently registered jobs. */
  get jobCount(): number {
    return this.jobs.size;
  }

  /** Returns the IDs of all currently registered scripts. */
  get registeredScriptIds(): string[] {
    return Array.from(this.jobs.keys());
  }
}
