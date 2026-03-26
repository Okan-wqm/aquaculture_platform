/**
 * CloseDialogHandler — Event action that closes the current popup card or modal dialog.
 *
 * Enables "Close" buttons inside overlay views without scripting.
 *
 * Architecture: Dispatches to the overlay store's closeOverlay action
 * to remove the topmost overlay entry. If no overlay is open, the
 * action is a no-op.
 */

import type { EventHandler } from '../types';

interface OverlayEntry {
  id: string;
}

interface OverlayStoreActions {
  overlays: OverlayEntry[];
  closeOverlay: (id: string) => void;
}

/**
 * Creates a handler that pops the topmost overlay from the stack.
 * Uses a getter function instead of a direct reference so the handler
 * always reads the latest overlay state at dispatch time.
 */
export function createCloseDialogHandler(
  getOverlayStore: () => OverlayStoreActions,
): EventHandler {
  return (event) => {
    if (event.action !== 'closeDialog') return;

    const store = getOverlayStore();
    const { overlays } = store;

    // No-op when there are no open overlays
    if (!overlays || overlays.length === 0) return;

    // Close the topmost (last-pushed) overlay — LIFO stack behavior
    const topOverlay = overlays[overlays.length - 1];
    store.closeOverlay(topOverlay.id);
  };
}
