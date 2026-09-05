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

/**
 * A request path with the client's identifiers removed. A case id names a
 * client and a document id names their file; stdout is a log pipeline, not a
 * custody record, and must carry neither. The access ledger inside the case
 * directory records the full request, signed.
 */
export function maskLegalPath(path: string): string {
  return path.replace(/(\/legal\/cases\/)[^/]+/, '$1[case]').replace(/(\/documents\/)[^/]+/, '$1[document]');
}

type LogWriter = (line: string) => void;

const stdoutWriter: LogWriter = (line) => {
  process.stdout.write(`${line}\n`);
};
let writer: LogWriter = stdoutWriter;

/**
 * Redirects log lines, for a test that must assert what the console would
 * have written to stdout without disturbing the test runner's own stream.
 * Passing null restores stdout.
 */
export function setLogWriter(next: LogWriter | null): void {
  writer = next ?? stdoutWriter;
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  writer(JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }));
}
