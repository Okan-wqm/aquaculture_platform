/**
 * logError — the single structured client-side error logger for web packages.
 *
 * Observability/SSOT rationale (not a lint workaround): before this util the
 * only structured logger lived in tenant-admin's local error-handling.ts, so
 * every other module either stayed silent or would have grown a copy. The
 * boundary family routes its default onError here; modules import it from the
 * package entry instead of console.* calls.
 */
import { parseError } from './error-types';

export function logError(
  context: string,
  error: unknown,
  additionalInfo?: Record<string, unknown>,
): void {
  const processed = parseError(error);
  console.error(`[${context}]`, {
    code: processed.code,
    message: processed.message,
    userMessage: processed.userMessage,
    timestamp: new Date().toISOString(),
    retryable: processed.recoveryAction !== 'none',
    ...additionalInfo,
  });
  if (import.meta.env.DEV) {
    console.error('Original error:', error);
  }
}
