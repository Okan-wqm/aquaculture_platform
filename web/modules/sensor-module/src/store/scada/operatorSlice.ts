/**
 * operatorSlice — Operator mode UI state & actions.
 *
 * Manages the HMI operator shell: layout configuration, sidenav,
 * alarm panel visibility, kiosk mode, user role, and view overlays.
 *
 * STORE UNIFICATION (T7): this slice lives ONLY inside the unified
 * useScadaPackageStore — the standalone operatorStore.ts is deleted. The
 * overlay mutators are named *ViewOverlay (not openOverlay/closeOverlay) so
 * they do not collide with ViewManagerSlice in the composed ScadaStore type.
 *
 * SERVER-AUTHORITATIVE ROLE (T4): currentUserRole is written from the
 * socket AUTH handshake (`{ authenticated, role, tenantId, userId }`) —
 * the JWT role is the single source of truth. There is deliberately no
 * client-side role switching.
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
  /**
   * Set the operator role. Source of truth is the server's AUTH push;
   * unknown server roles degrade to 'viewer' (least privilege).
   */
  setCurrentUserRole: (role: HmiRole) => void;

  // Overlay management (operator runtime overlay stack — distinct from the
  // builder's ViewManagerSlice overlays; named *ViewOverlay to compose).
  openViewOverlay: (overlay: Omit<ViewOverlay, 'id' | 'zIndex'>) => string;
  closeViewOverlay: (id: string) => void;
  closeAllViewOverlays: () => void;
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
  openViewOverlay: (overlay) => {
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

  closeViewOverlay: (id) =>
    set((state) => {
      state.activeOverlays = state.activeOverlays.filter((o) => o.id !== id);
    }),

  closeAllViewOverlays: () =>
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
