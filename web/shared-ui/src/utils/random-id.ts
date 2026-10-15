/**
 * randomId — the single client-side opaque-id generator (SEC-015 entropy
 * rules). api-client.ts carries two private copies from before this util
 * existed; converging them onto this export is tracked as a follow-up
 * finding — new code MUST consume it instead of growing a third copy.
 */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
