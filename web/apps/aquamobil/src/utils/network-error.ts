/**
 * Classifies transport failures that are safe to enqueue for offline replay.
 *
 * WHY 2026-04-29: only network/transport failures should fall back to the
 * offline queue. GraphQL validation/business errors must stay visible to the
 * user instead of being queued forever as invalid operations.
 */
export function isRecoverableNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('load failed')
  );
}
