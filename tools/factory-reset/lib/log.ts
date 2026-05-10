/**
 * Structured JSON logger for the factory-reset CLI.
 *
 * Every line is one JSON object on stdout. The log shape is intentionally
 * narrow so downstream tooling (operator runbooks, audit ingest, jq pipes)
 * can rely on a fixed contract without parsing free-form text.
 *
 * Why JSON-on-stdout (not winston/pino):
 *   - The CLI runs OUTSIDE the NestJS process tree on the droplet host;
 *     pulling a logger framework would expand the install surface for a
 *     one-shot operator tool. Native console + JSON.stringify is enough.
 *   - One line per record makes `docker logs aqua-factory-reset | jq`
 *     trivial when the tool is wrapped in a sidecar in the future.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogRecord {
  timestamp: string;
  phase: string;
  level: LogLevel;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Emit a single structured JSON record to stdout. Errors go to stderr so
 * operators piping to a file still see them on the terminal.
 */
export function log(
  level: LogLevel,
  phase: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    phase,
    level,
    message,
    ...(details ? { details } : {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const logInfo = (phase: string, message: string, details?: Record<string, unknown>): void =>
  log('info', phase, message, details);
export const logWarn = (phase: string, message: string, details?: Record<string, unknown>): void =>
  log('warn', phase, message, details);
export const logError = (phase: string, message: string, details?: Record<string, unknown>): void =>
  log('error', phase, message, details);
export const logDebug = (phase: string, message: string, details?: Record<string, unknown>): void =>
  log('debug', phase, message, details);
