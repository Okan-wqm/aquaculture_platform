/**
 * @deprecated Use AlertSummaryWidget from widgets/AlertSummaryWidget.tsx instead.
 *
 * BUG-M1: This component duplicated AlertSummaryWidget with an incompatible,
 * less capable API (3 severity levels, boolean acknowledged, no-op buttons).
 * DashboardPage now uses AlertSummaryWidget directly.
 *
 * This file is kept only to avoid breaking any existing imports.
 * Remove this file once all import sites are updated.
 */

export { default, AlertSummaryWidget } from '../widgets/AlertSummaryWidget';
