/**
 * Backdate Policy Service
 *
 * Centralises the "how far back may the operator log this event?"
 * decision. Until this service existed, each handler either silently
 * accepted any historical date (allowing a `feedingDate` from 2012 on
 * a batch stocked last week) or applied an inconsistent ad-hoc limit.
 *
 * The rules:
 *
 *   - **No future dates.** A feedingDate / measurementDate / observedAt
 *     value that lies after "now" is rejected unconditionally. Present
 *     time may be derived from any clock skew around 60 seconds without
 *     complaint to tolerate client/server clock drift.
 *
 *   - **Per-context retention limit.** Every operational context has
 *     its own acceptable backdate window. The defaults are calibrated
 *     to the operational cadence of that domain:
 *
 *       feeding    →  7 days  (daily operation; missed meals show up quickly)
 *       mortality  → 14 days  (ops staff may batch-record a week's findings)
 *       growth     → 30 days  (monthly sampling cycles for large farms)
 *       harvest    →  7 days  (near-term recording)
 *
 *     Each default is overridable via env vars (e.g.
 *     `FEEDING_BACKDATE_LIMIT_DAYS=14`) so regulators can tighten or
 *     loosen the window per tenant deployment.
 *
 *   - **Per-call override.** The caller may pass `limitDays` to
 *     override the context default — used by bulk import jobs that
 *     legitimately need to land historical data.
 *
 * Compliance background: Girdi 8 (backdating policy) in
 * docs/illustrator/farm-modulu-kor-noktalar-dogrulama.md. FCR and SGR
 * calculations are time-order-sensitive; a retroactively-logged event
 * that lands in the middle of an established metric series corrupts
 * every downstream derivation. The backdate limit lets the system
 * bound that corruption window instead of letting it grow unbounded.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Named contexts recognised by the service. Adding one: extend here + add an env var. */
export type BackdateContext =
  | 'feeding'
  | 'mortality'
  | 'growth'
  | 'harvest';

export interface ValidateBackdateOptions {
  /** What is the caller recording? Drives the default limit. */
  context: BackdateContext;
  /** The user-supplied timestamp being validated. */
  proposedDate: Date;
  /** Optional per-call override. Rarely used — env vars are the normal knob. */
  limitDays?: number;
  /** Human-readable identifier (batchId, sampleId, etc.) for error messages. */
  subjectLabel?: string;
}

export interface BackdateDecision {
  /** Number of days between proposedDate and "now" — positive for past dates. */
  backdatedDays: number;
  /** The effective limit the decision used (env override or default). */
  limitDays: number;
  /** True when the date is historical enough to warrant an audit flag. */
  isBackdated: boolean;
}

/** Clock-drift tolerance — a proposedDate up to 60 seconds in the future is accepted silently. */
const FUTURE_CLOCK_SKEW_MS = 60_000;

/** Default limits — callable defaults keep the constants near the code that uses them. */
const DEFAULT_LIMITS: Record<BackdateContext, number> = {
  feeding: 7,
  mortality: 14,
  growth: 30,
  harvest: 7,
};

/** Env var names for per-context overrides. */
const ENV_VAR_NAMES: Record<BackdateContext, string> = {
  feeding: 'FEEDING_BACKDATE_LIMIT_DAYS',
  mortality: 'MORTALITY_BACKDATE_LIMIT_DAYS',
  growth: 'GROWTH_BACKDATE_LIMIT_DAYS',
  harvest: 'HARVEST_BACKDATE_LIMIT_DAYS',
};

@Injectable()
export class BackdatePolicyService {
  private readonly logger = new Logger(BackdatePolicyService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Resolve the effective limit for a context. Env var takes priority,
   * then the per-call override, then the built-in default. The limit is
   * cached on each call — cheap enough that memoising is not worth the
   * complexity.
   */
  getLimitForContext(context: BackdateContext, override?: number): number {
    if (override !== undefined) {
      return override;
    }
    const envValue = this.configService.get<number | string>(
      ENV_VAR_NAMES[context],
    );
    if (envValue !== undefined && envValue !== null && envValue !== '') {
      const parsed = Number(envValue);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
      this.logger.warn(
        `Ignoring non-numeric env var ${ENV_VAR_NAMES[context]}=${envValue}; ` +
          `falling back to default ${DEFAULT_LIMITS[context]} day(s).`,
      );
    }
    return DEFAULT_LIMITS[context];
  }

  /**
   * Throw BadRequestException if `proposedDate` violates the backdate
   * contract for `context`. Returns the decision metadata so the
   * caller can stamp `backdatedDays` on the audit log.
   *
   * Three failure modes produce BadRequestException:
   *
   *   1. proposedDate is in the future (beyond the 60 s skew window).
   *   2. proposedDate is older than `limitDays`.
   *   3. proposedDate is not a valid Date object.
   */
  validate(options: ValidateBackdateOptions): BackdateDecision {
    const { context, proposedDate, limitDays, subjectLabel } = options;

    if (!(proposedDate instanceof Date) || Number.isNaN(proposedDate.getTime())) {
      throw new BadRequestException(
        `Invalid ${context} date: proposed value is not a valid Date.`,
      );
    }

    const now = new Date();
    const futureMs = proposedDate.getTime() - now.getTime();

    if (futureMs > FUTURE_CLOCK_SKEW_MS) {
      throw new BadRequestException(
        `Invalid ${context} date: ${proposedDate.toISOString()} is in the future. ` +
          `Future-dated operational records are never accepted.`,
      );
    }

    const effectiveLimit = this.getLimitForContext(context, limitDays);
    const backdatedDays = Math.max(0, Math.floor(-futureMs / 86_400_000));

    if (backdatedDays > effectiveLimit) {
      const subject = subjectLabel ? ` for ${subjectLabel}` : '';
      throw new BadRequestException(
        `Proposed ${context} date${subject} is ${backdatedDays} day(s) in the past, ` +
          `beyond the configured limit of ${effectiveLimit} day(s). ` +
          `Adjust the ${ENV_VAR_NAMES[context]} environment variable if the bulk-import ` +
          `use case requires a larger window, or pass a per-call override.`,
      );
    }

    return {
      backdatedDays,
      limitDays: effectiveLimit,
      isBackdated: backdatedDays > 0,
    };
  }
}
