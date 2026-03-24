/**
 * viewManagerSlice — Overlay / view-manager state & actions.
 *
 * Manages the stack of floating overlay panels (PopupCard, ModalDialog)
 * that can be opened programmatically from widget events or automation.
 */
import type { ScadaSliceCreator, ViewManagerSlice } from './types';
import { generateId } from './types';

export const createViewManagerSlice: ScadaSliceCreator<ViewManagerSlice> = (set) => ({
  overlays: [],

  openOverlay: (entry) => {
    const id = generateId();
    set((state) => {
      state.overlays.push({ ...entry, id });
    });
    return id;
  },

  closeOverlay: (id) => {
    set((state) => {
      state.overlays = state.overlays.filter((o) => o.id !== id);
    });
  },

  closeAllOverlays: () => {
    set((state) => {
      state.overlays = [];
    });
  },
});
