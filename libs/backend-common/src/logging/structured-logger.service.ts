import { LoggerService, LogLevel } from '@nestjs/common';
import { getRequestContext } from './request-context';
import { maskPii } from '../utils/pii-mask.util';

/**
 * Sensitive keys whose values are replaced with [REDACTED] before serialisation.
 * Matching is case-insensitive and applies to top-level metadata keys as well as
 * recursively nested objects up to MAX_DEPTH levels deep.
 */
const SENSITIVE_KEYS = /^(password|passwd|secret|token|authorization|apikey|api_key|access_token|refresh_token|private_key|credentials?)$/i;
const MAX_DEPTH = 4;

/** Default log levels enabled in production (error, warn, info). */
const PRODUCTION_LEVELS: ReadonlySet<string> = new Set(['error', 'warn', 'log']);

/** All log levels in NestJS order. */
const ALL_LEVELS: ReadonlySet<string> = new Set([
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
]);

/**
 * Map NestJS log-level names to severity strings that Promtail / Loki / Grafana
 * understand. NestJS uses "log" where the industry standard is "info".
 */
function toSeverity(level: string): string {
  if (level === 'log') return 'info';
  return level;
}

/**
 * Recursively mask sensitive values in an object.
 * Returns a shallow-ish clone with sensitive leaves replaced by "[REDACTED]".
 *
 * SECURITY (HIGH-005): two-layer redaction.
 *   Layer 1 — KEY-based: whole value is replaced with [REDACTED] when the
 *             key name matches SENSITIVE_KEYS (password, token, etc.).
 *   Layer 2 — VALUE-based: every surviving string leaf is passed through
 *             `maskPii()` which replaces email / phone / credit-card / SSN
 *             / IP patterns regardless of the key name. Closes the gap
 *             where PII was embedded in free-form strings (e.g. "failed
 *             login for alice@example.com from 10.1.2.3").
 */
function maskSensitive(obj: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || obj === null || obj === undefined) return obj;

  // Value-level PII redaction for string leaves that don't already live
  // under a sensitive key. For objects and arrays, recurse before returning.
  if (typeof obj === 'string') return maskPii(obj);
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => maskSensitive(item, depth + 1));
  }

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) {
      masked[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskSensitive(value, depth + 1);
    } else if (typeof value === 'string') {
      masked[key] = maskPii(value);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Platform-wide structured logger.
 *
 * Implements the NestJS `LoggerService` interface so it can be used as a
 * drop-in replacement via `NestFactory.create(AppModule, { logger: ... })`.
 *
 * Every log line is emitted as a single JSON object to stdout, which is
 * the format that Promtail / Loki expects for automatic parsing.
 *
 * Request context (tenantId, traceId, correlationId, userId) is
 * automatically injected from AsyncLocalStorage -- callers do not need
 * to pass these fields.
 *
 * @example
 * ```ts
 * const app = await NestFactory.create(AppModule, {
 *   logger: new StructuredLoggerService('my-service'),
 * });
 * ```
 */
export class StructuredLoggerService implements LoggerService {
  private readonly enabledLevels: ReadonlySet<string>;

  constructor(
    private readonly serviceName: string,
    logLevels?: LogLevel[],
  ) {
    if (logLevels) {
      this.enabledLevels = new Set(logLevels);
    } else {
      const isProduction = process.env['NODE_ENV'] === 'production';
      this.enabledLevels = isProduction ? PRODUCTION_LEVELS : ALL_LEVELS;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  NestJS LoggerService interface                                     */
  /* ------------------------------------------------------------------ */

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('warn', message, optionalParams);
  }

  debug?(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('debug', message, optionalParams);
  }

  verbose?(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('verbose', message, optionalParams);
  }

  fatal?(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('error', message, optionalParams);
  }

  /**
   * Called by NestJS internally to set log levels at runtime.
   * We accept but do not mutate because our levels are fixed at construction.
   */
  setLogLevels?(_levels: LogLevel[]): void {
    // Intentionally no-op. Levels are fixed by constructor / NODE_ENV.
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  private writeLog(
    level: string,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.enabledLevels.has(level)) return;

    const ctx = getRequestContext();

    // NestJS convention: the LAST string in optionalParams is the "context"
    // (i.e., the class / module name). Non-string params are extra metadata.
    let context: string | undefined;
    let stack: string | undefined;
    let extra: Record<string, unknown> | undefined;

    for (const param of optionalParams) {
      if (typeof param === 'string') {
        // For errors, the first string after the message is the stack trace,
        // the second is the context. For non-errors, it's the context.
        if (level === 'error' && !stack && param.includes('\n')) {
          stack = param;
        } else {
          context = param;
        }
      } else if (param instanceof Error) {
        stack = param.stack;
        if (!message || message === '') {
          message = param.message;
        }
      } else if (typeof param === 'object' && param !== null) {
        extra = maskSensitive(param) as Record<string, unknown>;
      }
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: toSeverity(level),
      service: this.serviceName,
      // WHY: Error properties (message, stack) are non-enumerable — JSON.stringify produces '{}'.
      // Must extract message explicitly for DI errors, bootstrap failures, etc.
      message: typeof message === 'string'
        ? message
        : message instanceof Error
          ? message.message || String(message)
          : JSON.stringify(message),
      ...(context ? { context } : {}),
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(ctx.spanId ? { spanId: ctx.spanId } : {}),
      ...(stack ? { stack } : {}),
      ...(extra ? { extra } : {}),
    };

    // Single-line JSON to stdout -- Promtail / Docker / Kubernetes log drivers
    // pick this up natively.
    const line = JSON.stringify(entry);

    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}
