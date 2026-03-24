import type { EventHandler } from '../types';

interface ViewManagerActions {
  openOverlay: (entry: {
    type: 'card' | 'dialog';
    screenId: string;
    position?: { x: number; y: number };
    size?: { width: number; height: number };
  }) => void;
}

export function createOverlayHandler(viewManager: ViewManagerActions): EventHandler {
  return (event) => {
    if (!event.params.targetScreenId) return;
    if (event.action === 'openCard') {
      viewManager.openOverlay({
        type: 'card',
        screenId: event.params.targetScreenId,
        position: event.mousePosition ?? { x: 300, y: 200 },
        size: { width: event.params.width ?? 400, height: event.params.height ?? 300 },
      });
    } else if (event.action === 'openDialog') {
      viewManager.openOverlay({
        type: 'dialog',
        screenId: event.params.targetScreenId,
        size: { width: event.params.width ?? 600, height: event.params.height ?? 450 },
      });
    }
  };
}
