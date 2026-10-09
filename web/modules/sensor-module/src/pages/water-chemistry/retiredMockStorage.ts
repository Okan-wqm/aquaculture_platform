/**
 * The monitoring view ran on a browser-local mock until PR-5: cards and
 * systems kept under these keys, with made-up readings. The view now reads
 * the farm API only; the old entries are removed — never read — so no stale
 * mock configuration lingers in an operator's browser.
 */
export const RETIRED_MOCK_STORAGE_KEYS = ['wc-cards-v1', 'wc-systems-v1'] as const;

export function clearRetiredMockStorage(
  storage: Pick<Storage, 'removeItem'> = window.localStorage,
): void {
  for (const key of RETIRED_MOCK_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage unavailable (private mode, quota): nothing is kept there to remove.
    }
  }
}
