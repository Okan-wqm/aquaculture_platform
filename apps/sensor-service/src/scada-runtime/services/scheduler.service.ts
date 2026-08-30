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

import type { ScadaScript, ScriptSchedulingMode } from '../scada-types';

import { ScriptEngineService } from './script-engine.service';

/* ================================================================== */
/*  Internal CronTimer — pure-Node cron evaluator                      */
/*                                                                     */
/*  Ticks once per second and evaluates the 5-field cron expression    */
/*  against the current wall-clock minute. Calls the callback once per */
/*  matching minute (not per tick within that minute).                  */
/* ================================================================== */

/* ================================================================== */
/*  Cron expression normalisation & validation                         */
/* ================================================================== */

/** Well-known cron aliases mapped to their 5-field equivalents. */
const CRON_ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** Month name → number mapping. */
const MONTH_NAMES: Record<string, string> = {
  JAN: '1',
  FEB: '2',
  MAR: '3',
  APR: '4',
  MAY: '5',
  JUN: '6',
  JUL: '7',
  AUG: '8',
  SEP: '9',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

/** Day-of-week name → number mapping. */
const DOW_NAMES: Record<string, string> = {
  SUN: '0',
  MON: '1',
  TUE: '2',
  WED: '3',
  THU: '4',
  FRI: '5',
  SAT: '6',
};

/**
 * Normalises a cron expression by expanding aliases (`@daily`, etc.)
 * and replacing month/day-of-week names with their numeric equivalents.
 */
function normalizeCronExpression(expr: string): string {
  const trimmed = expr.trim();

  // Handle predefined aliases
  const alias = CRON_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  // Replace month names (case-insensitive)
  let normalised = trimmed.replace(
    /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/gi,
    (match) => MONTH_NAMES[match.toUpperCase()] ?? match,
  );

  // Replace day-of-week names (case-insensitive)
  normalised = normalised.replace(
    /\b(SUN|MON|TUE|WED|THU|FRI|SAT)\b/gi,
    (match) => DOW_NAMES[match.toUpperCase()] ?? match,
  );

  return normalised;
}

/** Field definitions for validation: [name, min, max]. */
const CRON_FIELD_DEFS: [string, number, number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day-of-month', 1, 31],
  ['month', 1, 12],
  ['day-of-week', 0, 6],
];

/**
 * Validates a (already-normalised) 5-field cron expression.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, error: '...' }`
 * with a descriptive message on failure.
 */
function validateCronExpression(expr: string): { valid: boolean; error?: string } {
  const fields = expr.trim().split(/\s+/);

  if (fields.length !== 5) {
    return {
      valid: false,
      error: `Expected 5 cron fields (minute hour dom month dow), got ${fields.length}: "${expr}"`,
    };
  }

  for (let i = 0; i < fields.length; i++) {
    const [fieldName, min, max] = CRON_FIELD_DEFS[i]!;
    const field = fields[i]!;
    const err = validateCronField(field, fieldName, min, max);
    if (err) return { valid: false, error: err };
  }

  return { valid: true };
}

/**
 * Validates a single cron field value. Returns an error string or `null` if valid.
 */
function validateCronField(
  field: string,
  fieldName: string,
  min: number,
  max: number,
): string | null {
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      return `${fieldName}: empty value in list`;
    }

    const err = validateCronPart(trimmed, fieldName, min, max);
    if (err) return err;
  }
  return null;
}

function validateCronPart(
  part: string,
  fieldName: string,
  min: number,
  max: number,
): string | null {
  // Handle step: base/step
  const slashIdx = part.indexOf('/');
  if (slashIdx !== -1) {
    const rangePart = part.substring(0, slashIdx);
    const stepStr = part.substring(slashIdx + 1);
    const step = parseInt(stepStr, 10);

    if (isNaN(step) || step <= 0) {
      return `${fieldName}: invalid step value "${stepStr}" in "${part}"`;
    }

    if (rangePart !== '*') {
      return validateCronRangeOrValue(rangePart, fieldName, min, max);
    }
    return null;
  }

  // Handle range: lo-hi
  const dashIdx = part.indexOf('-');
  if (dashIdx !== -1) {
    return validateCronRangeOrValue(part, fieldName, min, max);
  }

  // Wildcard
  if (part === '*') return null;

  // Exact value
  const val = parseInt(part, 10);
  if (isNaN(val)) {
    return `${fieldName}: invalid value "${part}" (expected integer or *)`;
  }
  if (val < min || val > max) {
    return `${fieldName}: value ${val} out of range ${min}-${max}`;
  }
  return null;
}

function validateCronRangeOrValue(
  part: string,
  fieldName: string,
  min: number,
  max: number,
): string | null {
  const dashIdx = part.indexOf('-');
  if (dashIdx !== -1) {
    const loStr = part.substring(0, dashIdx);
    const hiStr = part.substring(dashIdx + 1);
    const lo = parseInt(loStr, 10);
    const hi = parseInt(hiStr, 10);

    if (isNaN(lo)) return `${fieldName}: invalid range start "${loStr}" in "${part}"`;
    if (isNaN(hi)) return `${fieldName}: invalid range end "${hiStr}" in "${part}"`;
    if (lo < min || lo > max) return `${fieldName}: range start ${lo} out of range ${min}-${max}`;
    if (hi < min || hi > max) return `${fieldName}: range end ${hi} out of range ${min}-${max}`;
    if (lo > hi) return `${fieldName}: range start ${lo} > end ${hi} in "${part}"`;
    return null;
  }

  const val = parseInt(part, 10);
  if (isNaN(val)) return `${fieldName}: invalid value "${part}"`;
  if (val < min || val > max) return `${fieldName}: value ${val} out of range ${min}-${max}`;
  return null;
}

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

function matchSingleCronPart(part: string, value: number, min: number, max: number): boolean {
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

  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  return (
    matchCronField(minF, now.getMinutes(), 0, 59) &&
    matchCronField(hourF, now.getHours(), 0, 23) &&
    matchCronField(domF, now.getDate(), 1, 31) &&
    matchCronField(monF, now.getMonth() + 1, 1, 12) &&
    matchCronField(dowF, now.getDay(), 0, 6)
  );
}

/**
 * Minimal CronTimer: polls at 1-second resolution, fires the callback
 * once per matching cron minute, then suppresses further firings for the
 * remainder of that minute.
 */
class CronTimer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFiredKey: string = '';

  constructor(
    private readonly expression: string,
    private readonly callback: () => void,
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const day = now.getDate();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const minuteKey = `${year}-${month}-${day}-${hour}-${minute}`;

      if (minuteKey === this.lastFiredKey) return; // already fired this minute

      if (matchesCronExpression(this.expression, now)) {
        this.lastFiredKey = minuteKey;
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
  | { kind: 'timeout'; handle: ReturnType<typeof setTimeout> }
  | { kind: 'cron'; timer: CronTimer };

/* ================================================================== */
/*  Service                                                             */
/* ================================================================== */

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);

  /**
   * jobKey(tenantId, scriptId) → active job handle. Jobs are keyed by the
   * (tenant, script) pair (RT-011) so two tenants that own a script with the
   * same id get independent timers, and per-tenant load/clear never touches
   * another tenant's jobs.
   */
  private readonly jobs = new Map<string, JobHandle>();

  /** jobKey → in-flight guard (per (tenant, script) re-entrancy mutex). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly scriptEngine: ScriptEngineService) {}

  /** Composite key for the per-(tenant, script) job/mutex maps. */
  private static jobKey(tenantId: string, scriptId: string): string {
    // A space cannot appear in a tenant UUID or a script id, so the composite
    // is unambiguous (same convention as TagManagerService.tenantTagKey).
    return `${tenantId} ${scriptId}`;
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  onModuleInit(): void {
    this.logger.log('SchedulerService initialised — waiting for script registration');
  }

  onModuleDestroy(): void {
    this.logger.log(`SchedulerService stopping — clearing ${this.jobs.size} job(s)`);
    this.clearAllJobs();
    this.logger.log('SchedulerService stopped');
  }

  /* ---------------------------------------------------------------- */
  /*  Bulk load                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Register all of a tenant's enabled server-mode scripts.
   *
   * Clears any of THIS tenant's previously registered jobs first (leaving
   * other tenants' jobs untouched) so it is safe to call on project reload.
   */
  loadScripts(tenantId: string, scripts: ScadaScript[]): void {
    this.clearTenantJobs(tenantId);

    const serverScripts = scripts.filter((s) => s.mode === 'server' && s.enabled && s.scheduling);

    for (const script of serverScripts) {
      try {
        this.registerJob(tenantId, script);
      } catch (err) {
        this.logger.error(
          `loadScripts: failed to register tenant=${tenantId} script id=${script.id} ` +
            `name="${script.name}" — ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `SchedulerService: tenant=${tenantId} loaded ${serverScripts.length} eligible script(s)`,
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
  addScript(tenantId: string, script: ScadaScript): boolean {
    const key = SchedulerService.jobKey(tenantId, script.id);
    if (this.jobs.has(key)) {
      this.logger.warn(
        `addScript: tenant=${tenantId} script id=${script.id} already registered — use updateScript`,
      );
      return false;
    }

    if (!script.enabled || script.mode !== 'server' || !script.scheduling) {
      this.logger.debug(
        `addScript: script id=${script.id} skipped (disabled, non-server, or no scheduling)`,
      );
      return false;
    }

    try {
      this.registerJob(tenantId, script);
      this.logger.log(
        `addScript: registered tenant=${tenantId} script id=${script.id} name="${script.name}" ` +
          `mode=${script.scheduling?.mode ?? 'unknown'}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `addScript: failed tenant=${tenantId} id=${script.id} — ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Remove a tenant's script from the scheduler and stop its job.
   */
  removeScript(tenantId: string, scriptId: string): void {
    const key = SchedulerService.jobKey(tenantId, scriptId);
    const job = this.jobs.get(key);
    if (!job) {
      this.logger.debug(`removeScript: tenant=${tenantId} script id=${scriptId} not found`);
      return;
    }

    this.clearJob(key, job);
    this.jobs.delete(key);
    this.logger.log(`removeScript: unregistered tenant=${tenantId} script id=${scriptId}`);
  }

  /**
   * Replace a tenant's script job registration with a fresh one.
   *
   * Stops the current job (if any), then re-registers according to the
   * new script configuration.
   */
  updateScript(tenantId: string, script: ScadaScript): void {
    this.removeScript(tenantId, script.id);
    const registered = this.addScript(tenantId, script);
    this.logger.log(
      registered
        ? `Refreshed script job: ${script.name}`
        : `Removed script job (now inactive): ${script.name}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Job registration                                                  */
  /* ---------------------------------------------------------------- */

  private registerJob(tenantId: string, script: ScadaScript): void {
    const scheduling = script.scheduling;
    if (!scheduling) {
      throw new Error(`Script id=${script.id} has no scheduling configuration`);
    }

    const key = SchedulerService.jobKey(tenantId, script.id);
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
          void this.executeScript(tenantId, script);
        }, intervalSec * 1_000);

        this.jobs.set(key, { kind: 'interval', handle });

        this.logger.log(
          `[scheduler] interval job registered: tenant=${tenantId} id=${script.id} ` +
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
          void this.executeScript(tenantId, script);
          // Remove the job handle after it fires — it's a one-shot
          this.jobs.delete(key);
        }, delaySec * 1_000);

        this.jobs.set(key, { kind: 'timeout', handle });

        this.logger.log(
          `[scheduler] start job registered: tenant=${tenantId} id=${script.id} ` +
            `name="${script.name}" delay=${delaySec}s`,
        );
        break;
      }

      case 'cron': {
        const rawExpr = scheduling.cronExpression;
        if (!rawExpr || rawExpr.trim() === '') {
          throw new Error(`Script id=${script.id}: cronExpression is required for cron mode`);
        }

        // Normalise aliases and named tokens, then validate
        const expr = normalizeCronExpression(rawExpr);
        const validation = validateCronExpression(expr);
        if (!validation.valid) {
          throw new Error(
            `Script id=${script.id}: invalid cron expression "${rawExpr}" — ${validation.error}`,
          );
        }

        const timer = new CronTimer(expr, () => {
          void this.executeScript(tenantId, script);
        });

        timer.start();
        this.jobs.set(key, { kind: 'cron', timer });

        this.logger.log(
          `[scheduler] cron job registered: id=${script.id} ` +
            `name="${script.name}" expr="${expr}"` +
            (expr !== rawExpr ? ` (normalised from "${rawExpr}")` : ''),
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
   * Execute a tenant's script via the ScriptEngineService.
   *
   * Uses `inFlight` as a per-(tenant, script) mutex: if the previous scheduled
   * execution has not yet finished when the next tick fires, the new tick is
   * skipped to prevent concurrent execution of the same script.
   */
  private async executeScript(tenantId: string, script: ScadaScript): Promise<void> {
    const key = SchedulerService.jobKey(tenantId, script.id);
    if (this.inFlight.has(key)) {
      this.logger.warn(
        `[scheduler] Skipping tenant=${tenantId} script id=${script.id} — previous execution still running`,
      );
      return;
    }

    this.inFlight.add(key);

    try {
      this.logger.debug(
        `[scheduler] Executing tenant=${tenantId} script id=${script.id} name="${script.name}"`,
      );

      const result = await this.scriptEngine.runScript(tenantId, script);

      if (result.success) {
        this.logger.debug(`[scheduler] Script id=${script.id} completed in ${result.durationMs}ms`);
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
      this.inFlight.delete(key);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Cleanup helpers                                                   */
  /* ---------------------------------------------------------------- */

  private clearJob(jobKey: string, job: JobHandle): void {
    switch (job.kind) {
      case 'interval':
        clearInterval(job.handle);
        this.logger.debug(`[scheduler] Cleared interval job key=${jobKey}`);
        break;

      case 'timeout':
        clearTimeout(job.handle);
        this.logger.debug(`[scheduler] Cleared timeout job key=${jobKey}`);
        break;

      case 'cron':
        job.timer.stop();
        this.logger.debug(`[scheduler] Stopped cron job key=${jobKey}`);
        break;

      default: {
        const _exhaustive: never = job;
        this.logger.warn(
          `[scheduler] Unknown job kind for key=${jobKey}: ${(_exhaustive as JobHandle).kind}`,
        );
      }
    }
  }

  private clearAllJobs(): void {
    for (const [key, job] of this.jobs) {
      try {
        this.clearJob(key, job);
      } catch (err) {
        this.logger.error(
          `clearAllJobs: error clearing job key=${key} — ${(err as Error).message}`,
        );
      }
    }
    this.jobs.clear();
    this.inFlight.clear();
  }

  /**
   * Clear only the jobs belonging to `tenantId`, leaving every other tenant's
   * jobs and in-flight guards untouched (used by per-tenant `loadScripts`).
   */
  private clearTenantJobs(tenantId: string): void {
    const prefix = `${tenantId} `;
    for (const [key, job] of this.jobs) {
      if (!key.startsWith(prefix)) continue;
      try {
        this.clearJob(key, job);
      } catch (err) {
        this.logger.error(
          `clearTenantJobs: error clearing job key=${key} — ${(err as Error).message}`,
        );
      }
      this.jobs.delete(key);
      this.inFlight.delete(key);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Diagnostics                                                       */
  /* ---------------------------------------------------------------- */

  /** Returns the number of currently registered jobs. */
  get jobCount(): number {
    return this.jobs.size;
  }

  /** Returns the composite `${tenantId} ${scriptId}` keys of all registered jobs. */
  get registeredJobKeys(): string[] {
    return Array.from(this.jobs.keys());
  }
}
