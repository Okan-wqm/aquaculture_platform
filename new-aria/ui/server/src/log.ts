// Structured logging — one JSON object per line on stdout.
//
// WHY: the console runs under Docker; line-delimited JSON is what the log
// pipeline and `docker logs --tail` both read without a parser of their own.
// WHAT: a level-tagged writer that never throws and never prints the operator
// token (callers pass redacted fields; `redactHeaders` helps them do so).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

const REDACTED = '[redacted]';

export function redactHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = name.toLowerCase() === 'authorization' ? REDACTED : Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
  process.stdout.write(`${line}\n`);
}
