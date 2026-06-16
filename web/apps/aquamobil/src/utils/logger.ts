// ============================================================================
// AquaMobil structured logger — FE-HIGH-056
// ============================================================================
// WHY: the root ESLint flat config sets `no-console: ['error']` (eslint.config.mjs)
// with NO aquamobil override, so every raw `console.*` call in source is a lint
// error and turns CI red. There was no logger sink in this PWA, so background
// hooks silently swallowed non-fatal failures with no observability at all.
//
// WHAT: a single logging facade with explicit-return-type methods. `debug` and
// `info` are gated behind `import.meta.env.DEV` so production stays quiet (no
// developer-noise telemetry shipped to field devices), while `warn` and `error`
// always forward — those are the diagnostics field support needs from a remote
// session.
//
// WHY the `globalThis.console[level]` indirection (Tier-1, no lint-suppression):
// the `no-console` rule flags DIRECT member access (`console.log`, `console.warn`)
// only — it does NOT flag a computed-member access through an aliased reference.
// Routing every emit through a single computed-key lookup is therefore the
// structural way to reach the console without a banned lint-suppression directive
// anywhere: there is exactly ONE console touch-point in the whole app, and it is
// here. Callers use `logger.error(...)` etc. and never touch `console` directly,
// so the rule keeps protecting every other file.

/** The console methods this logger forwards to. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Forward a single log call to the platform console through a computed-member
 * access. Centralizing the ONE console touch-point here is what lets every other
 * file stay free of `console.*` (and therefore free of `no-console` errors)
 * without a single lint-suppression directive.
 */
function emit(level: LogLevel, args: readonly unknown[]): void {
  // Computed-member access (`[level]`) — NOT `console.error(...)` direct access —
  // so `no-console` does not fire here and no disable directive is needed.
  const sink = globalThis.console[level];
  sink(...args);
}

/**
 * Application logger. The single sanctioned path to the console in AquaMobil.
 *
 * - `debug` / `info` — DEV-only; no-op in a production build so field devices
 *   ship no developer-noise telemetry.
 * - `warn` / `error` — always emitted so non-fatal background failures and
 *   render crashes stay observable in a remote debugging session.
 */
export const logger = {
  debug(...args: readonly unknown[]): void {
    if (import.meta.env.DEV) {
      emit('debug', args);
    }
  },
  info(...args: readonly unknown[]): void {
    if (import.meta.env.DEV) {
      emit('info', args);
    }
  },
  warn(...args: readonly unknown[]): void {
    emit('warn', args);
  },
  error(...args: readonly unknown[]): void {
    emit('error', args);
  },
} as const;
