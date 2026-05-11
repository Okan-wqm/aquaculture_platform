import type { EventHandler } from '../types';

interface ViewManagerActions {
  openOverlay: (entry: {
    type: 'card' | 'dialog';
    screenId: string;
    position: { x: number; y: number };
    size?: { width: number; height: number };
    variableMap?: Record<string, string>;
  }) => string | void;
}

function withVariableMap<T extends object>(
  entry: T,
  variableMap: Record<string, string> | undefined,
): T & { variableMap?: Record<string, string> } {
  return variableMap ? { ...entry, variableMap } : entry;
}

export function createOverlayHandler(viewManager: ViewManagerActions): EventHandler {
  return (event) => {
    if (!event.params.targetScreenId) return;
    if (event.action === 'openCard') {
      viewManager.openOverlay(withVariableMap({
        type: 'card',
        screenId: event.params.targetScreenId,
        position: event.mousePosition ?? { x: 300, y: 200 },
        size: { width: event.params.width ?? 400, height: event.params.height ?? 300 },
      }, event.params.variableMap));
    } else if (event.action === 'openDialog') {
      viewManager.openOverlay(withVariableMap({
        type: 'dialog',
        screenId: event.params.targetScreenId,
        position: event.mousePosition ?? { x: 300, y: 160 },
        size: { width: event.params.width ?? 600, height: event.params.height ?? 450 },
      }, event.params.variableMap));
    }
  };
}
