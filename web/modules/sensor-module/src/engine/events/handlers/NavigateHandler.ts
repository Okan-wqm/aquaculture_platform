import type { EventHandler } from '../types';

export function createNavigateHandler(
  setActiveScreen: (id: string) => void,
): EventHandler {
  return (event) => {
    if (event.params.targetScreenId) {
      setActiveScreen(event.params.targetScreenId);
    }
  };
}
