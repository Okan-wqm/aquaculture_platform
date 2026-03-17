/**
 * operatorSlice — Operator mode UI state & actions.
 *
 * Manages the HMI operator shell: layout configuration, sidenav,
 * alarm panel visibility, kiosk mode, user role, and view overlays.
 */
import type { ScadaSliceCreator } from './types';
import { generateId } from './types';
import type {
  OperatorLayoutConfig,
  ViewOverlay,
  HmiRole,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Default layout config                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_OPERATOR_LAYOUT: OperatorLayoutConfig = {
  sidenavMode: 'overlay',
  zoomMode: 'autoresize',
  inputMode: 'enabled',
  hideNavigation: false,
  showDateTime: true,
  showAlarmBadge: true,
  headerItems: [],
  navItems: [],
  startScreenId: undefined,
  customCss: undefined,
  viewRenderDelay: undefined,
  backgroundColor: undefined,
};

/* ------------------------------------------------------------------ */
/*  Slice Interface                                                     */
/* ------------------------------------------------------------------ */

export interface OperatorSlice {
  // State
  operatorMode: boolean;
  operatorLayout: OperatorLayoutConfig;
  activeOverlays: ViewOverlay[];
  sidenavOpen: boolean;
  alarmPanelOpen: boolean;
  kioskMode: boolean;
  currentUserRole: HmiRole;

  // Actions
  setOperatorMode: (on: boolean) => void;
  setOperatorLayout: (layout: OperatorLayoutConfig) => void;
  toggleSidenav: () => void;
  setSidenavOpen: (open: boolean) => void;
  toggleAlarmPanel: () => void;
  setKioskMode: (on: boolean) => void;
  setCurrentUserRole: (role: HmiRole) => void;

  // Overlay management
  openOverlay: (overlay: Omit<ViewOverlay, 'id' | 'zIndex'>) => string;
  closeOverlay: (id: string) => void;
  closeAllOverlays: () => void;
  bringOverlayToFront: (id: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Slice Creator                                                       */
/* ------------------------------------------------------------------ */

export const createOperatorSlice: ScadaSliceCreator<OperatorSlice> = (set, get) => ({
  // Initial state
  operatorMode: false,
  operatorLayout: { ...DEFAULT_OPERATOR_LAYOUT, headerItems: [], navItems: [] },
  activeOverlays: [],
  sidenavOpen: false,
  alarmPanelOpen: false,
  kioskMode: false,
  currentUserRole: 'viewer',

  // Actions
  setOperatorMode: (on) =>
    set((state) => {
      state.operatorMode = on;
    }),

  setOperatorLayout: (layout) =>
    set((state) => {
      state.operatorLayout = layout;
    }),

  toggleSidenav: () =>
    set((state) => {
      state.sidenavOpen = !state.sidenavOpen;
    }),

  setSidenavOpen: (open) =>
    set((state) => {
      state.sidenavOpen = open;
    }),

  toggleAlarmPanel: () =>
    set((state) => {
      state.alarmPanelOpen = !state.alarmPanelOpen;
    }),

  setKioskMode: (on) =>
    set((state) => {
      state.kioskMode = on;
    }),

  setCurrentUserRole: (role) =>
    set((state) => {
      state.currentUserRole = role;
    }),

  // Overlay management
  openOverlay: (overlay) => {
    const id = generateId();
    set((state) => {
      const maxZIndex = state.activeOverlays.reduce(
        (max, o) => (o.zIndex > max ? o.zIndex : max),
        0,
      );
      state.activeOverlays.push({ ...overlay, id, zIndex: maxZIndex + 1 });
    });
    return id;
  },

  closeOverlay: (id) =>
    set((state) => {
      state.activeOverlays = state.activeOverlays.filter((o) => o.id !== id);
    }),

  closeAllOverlays: () =>
    set((state) => {
      state.activeOverlays = [];
    }),

  bringOverlayToFront: (id) =>
    set((state) => {
      const overlay = state.activeOverlays.find((o) => o.id === id);
      if (!overlay) return;
      const maxZIndex = state.activeOverlays.reduce(
        (max, o) => (o.zIndex > max ? o.zIndex : max),
        0,
      );
      if (overlay.zIndex === maxZIndex) return; // already on top
      overlay.zIndex = maxZIndex + 1;
    }),
});
