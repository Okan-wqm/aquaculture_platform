/**
 * scada-operator — Barrel exports for the SCADA HMI Operator Shell.
 *
 * Public API surface:
 *
 *   OperatorShell         — Root layout container (wraps DataProviderRoot,
 *                           header, sidenav, alarm panel, overlay manager).
 *   OperatorView          — Runtime screen renderer (tag subscriptions,
 *                           widget grid, command routing).
 *   OperatorHeader        — Top navigation bar (alarm badge, clock, user role).
 *   OperatorSidenav       — Left navigation sidebar (nav items, modes).
 *   KioskMode             — Fullscreen kiosk wrapper (cursor hide, triple-tap).
 *   ViewOverlayManager    — Dialog / card / iframe overlay layer.
 *   registerOperatorWidget — Registry function: call this from each runtime
 *                           widget to make it renderable by OperatorView.
 */

// ── Main shell ────────────────────────────────────────────────────────────────

export { OperatorShell }  from './OperatorShell';
export type { OperatorShellProps } from './OperatorShell';

// ── Runtime view ──────────────────────────────────────────────────────────────

export { OperatorView, registerOperatorWidget } from './OperatorView';
export type { OperatorViewProps, OperatorWidgetProps } from './OperatorView';

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
