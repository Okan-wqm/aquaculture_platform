/**
 * scada-operator — Barrel exports for the SCADA HMI Operator Shell.
 *
 * Public API surface:
 *
 *   OperatorShell         — Root layout container (wraps DataProviderRoot,
 *                           header, sidenav, alarm summary bar + panel,
 *                           COMMS LOST banner, overlay manager).
 *   OperatorView          — Runtime screen renderer (single bulk tag
 *                           subscription, adapters, widget grid).
 *   OperatorHeader        — Top navigation bar (alarm badge, clock, role).
 *   OperatorSidenav       — Left navigation sidebar (nav items, modes).
 *   KioskMode             — Fullscreen kiosk wrapper (cursor hide, triple-tap).
 *   ViewOverlayManager    — Dialog / card / iframe / toast overlay layer.
 *
 * RENDERER SWAP (T7e): the WIDGET_REGISTRY / registerOperatorWidget /
 * FallbackWidget dispatch that used to live in OperatorView is DELETED.
 * Every widget — builder types and Runtime* types alike — renders through
 *   components/scada-operator/widgets/RuntimeWidgetRenderer
 * which owns permission gating, tag-driven actions, event bindings and the
 * command router. The names below that predate that swap are kept for
 * import compatibility and marked @deprecated where the renderer is the
 * replacement.
 */

// ── Main shell ────────────────────────────────────────────────────────────────

export { OperatorShell }  from './OperatorShell';
export type { OperatorShellProps } from './OperatorShell';

// ── Runtime view ──────────────────────────────────────────────────────────────
/**
 * @deprecated OperatorView no longer dispatches widgets through a registry.
 * It adapts builder widget config and delegates ALL widget rendering to
 * RuntimeWidgetRenderer (./widgets/RuntimeWidgetRenderer). Import that
 * directly when you need to render a single widget outside a screen.
 */
export { OperatorView } from './OperatorView';
export type { OperatorViewProps } from './OperatorView';

// ── Header ───────────────────────────────────────────────────────────────────

export { OperatorHeader } from './OperatorHeader';
export type { OperatorHeaderProps } from './OperatorHeader';

// ── Sidenav ──────────────────────────────────────────────────────────────────

export { OperatorSidenav } from './OperatorSidenav';
export type { OperatorSidenavProps } from './OperatorSidenav';

// ── Kiosk mode ───────────────────────────────────────────────────────────────

export { KioskMode } from './KioskMode';
export type { KioskModeProps } from './KioskMode';

// ── Overlay manager ──────────────────────────────────────────────────────────

export { ViewOverlayManager } from './ViewOverlayManager';

// ── Cards dashboard ─────────────────────────────────────────────────────────

export { CardsDashboard } from './CardsDashboard';
export type { CardsDashboardProps, DashboardCardConfig } from './CardsDashboard';

// ── Touch keyboard ──────────────────────────────────────────────────────────

export { TouchKeyboard } from './TouchKeyboard';
export type { TouchKeyboardProps, KeyboardMode } from './TouchKeyboard';

// ── Alarms ───────────────────────────────────────────────────────────────────

export { AlarmSummaryBar } from './AlarmSummaryBar';
export type { AlarmSummaryBarProps } from './AlarmSummaryBar';
export { AlarmPanel } from './AlarmPanel';
export type { AlarmPanelProps } from './AlarmPanel';

// ── Adapters (builder → runtime) ─────────────────────────────────────────────

export {
  adaptWidgetPermissions,
  adaptWidgetEvents,
  adaptAnimationRules,
} from './adapters';
