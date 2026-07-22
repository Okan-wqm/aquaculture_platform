import type { NavigationItem } from '../types';

import { ADMIN_BILLING_ROUTES } from './admin-billing-routes';

/**
 * Whole-panel SUPER_ADMIN navigation SSoT (APA-255 / APA-256).
 *
 * Before this manifest, admin navigation truth was scattered across four
 * independently hand-maintained places (the shell's `superAdminNavigation`
 * literal, admin-panel `Module.tsx`'s `<Route>` list, a dead second nav tree in
 * `admin-panel/components/admin-nav-items.tsx`, and the billing SSoT), with
 * nothing tying them together. Routes were added to `Module.tsx` (the whole
 * messaging section, settings/provisioning, billing plans/usage) without the
 * live sidebar being updated, so a SUPER_ADMIN could only reach 10 shipped
 * pages by typing URLs.
 *
 * This module is the single source the live sidebar DERIVES from
 * (`buildSuperAdminNavigation`), and against which the mounted route table is
 * enforced by `tests/invariants/admin-route-nav-reachability.spec.ts` — a route
 * mounted in `Module.tsx` with no manifest entry, or a visible manifest entry
 * with no mounted route, or a hidden route with no declared reachability, fails
 * CI. The billing section is composed from the existing billing SSoT so billing
 * truth is not duplicated.
 */

export type AdminNavSection =
  | 'dashboard'
  | 'analytics'
  | 'tenants'
  | 'users'
  | 'modules'
  | 'billing'
  | 'support'
  | 'messaging'
  | 'security'
  | 'system'
  | 'database'
  | 'audit'
  | 'settings';

export interface AdminRoute {
  /** Stable nav id (also the NavigationItem id when this route is a nav leaf/child). */
  readonly id: string;
  readonly label: string;
  /** Full application path, e.g. `/admin/billing/plans`. */
  readonly path: string;
  /** The `<Route path>` value mounted in admin-panel `Module.tsx` (`''` for the index route). */
  readonly remotePath: string;
  readonly section: AdminNavSection;
  /** Whether this route surfaces as its own sidebar item. */
  readonly visible: boolean;
  /**
   * Why a non-visible route is still reachable (a parent nav item or the page
   * that links to it). REQUIRED for every `visible: false` route — the
   * reachability gate rejects a hidden route with no declared path in.
   */
  readonly reachableVia?: string;
}

interface AdminNavSectionMeta {
  readonly section: AdminNavSection;
  /** NavigationItem id for the section header (group) or the leaf item. */
  readonly navId: string;
  readonly label: string;
  readonly icon: string;
  /** `leaf` = a single direct nav item; `group` = a parent with visible children. */
  readonly kind: 'leaf' | 'group';
}

/**
 * Sidebar sections in render order. Existing sections keep their prior order;
 * `messaging` is inserted after `support` (both communication surfaces).
 */
export const ADMIN_NAV_SECTIONS: readonly AdminNavSectionMeta[] = [
  { section: 'dashboard', navId: 'admin-dashboard', label: 'Dashboard', icon: 'dashboard', kind: 'leaf' },
  { section: 'analytics', navId: 'admin-analytics', label: 'Analytics', icon: 'analytics', kind: 'group' },
  { section: 'tenants', navId: 'admin-tenants', label: 'Tenants', icon: 'tenants', kind: 'group' },
  { section: 'users', navId: 'admin-users', label: 'Users', icon: 'users', kind: 'group' },
  { section: 'modules', navId: 'admin-modules', label: 'Modules', icon: 'modules', kind: 'leaf' },
  { section: 'billing', navId: 'admin-billing', label: 'Billing', icon: 'billing', kind: 'group' },
  { section: 'support', navId: 'admin-support', label: 'Support', icon: 'support', kind: 'group' },
  { section: 'messaging', navId: 'admin-messaging', label: 'Messaging', icon: 'messages', kind: 'group' },
  { section: 'security', navId: 'admin-security', label: 'Security', icon: 'security', kind: 'group' },
  { section: 'system', navId: 'admin-system', label: 'System', icon: 'system', kind: 'group' },
  { section: 'database', navId: 'admin-database', label: 'Database', icon: 'database', kind: 'group' },
  { section: 'audit', navId: 'admin-audit', label: 'Audit Logs', icon: 'audit', kind: 'leaf' },
  { section: 'settings', navId: 'admin-settings', label: 'Settings', icon: 'settings', kind: 'group' },
];

/** Billing routes composed from the billing SSoT (single source of billing truth). */
const BILLING_ROUTES: readonly AdminRoute[] = ADMIN_BILLING_ROUTES.map((route) => ({
  id: route.id,
  label: route.label,
  path: route.path,
  remotePath: route.remotePath,
  section: 'billing' as const,
  visible: route.visible,
  reachableVia: route.visible
    ? undefined
    : `Hidden billing route, reachable via nav item ${route.parentId ?? route.activeNavId}`,
}));

/**
 * Every SUPER_ADMIN route mounted in admin-panel `Module.tsx`, except pure
 * `<Navigate>` redirect aliases (e.g. `billing/custom-plan-builder`) and the
 * `*` fallback, which are exempt from nav + reachability by construction.
 */
export const ADMIN_ROUTES: readonly AdminRoute[] = [
  { id: 'admin-dashboard', label: 'Dashboard', path: '/admin', remotePath: '', section: 'dashboard', visible: true },

  { id: 'analytics-dashboard', label: 'Overview', path: '/admin/analytics', remotePath: 'analytics', section: 'analytics', visible: true },
  { id: 'analytics-reports', label: 'Reports', path: '/admin/analytics/reports', remotePath: 'analytics/reports', section: 'analytics', visible: true },

  { id: 'tenant-list', label: 'All Tenants', path: '/admin/tenants', remotePath: 'tenants', section: 'tenants', visible: true },
  { id: 'tenant-create', label: 'Create Tenant', path: '/admin/tenants/new', remotePath: 'tenants/new', section: 'tenants', visible: true },
  { id: 'tenant-detail', label: 'Tenant Detail', path: '/admin/tenants/:tenantId', remotePath: 'tenants/:tenantId', section: 'tenants', visible: false, reachableVia: 'Row click on the Tenants list (TenantManagementPage)' },
  { id: 'tenant-configuration', label: 'Tenant Configuration', path: '/admin/tenants/:tenantId/configuration', remotePath: 'tenants/:tenantId/configuration', section: 'tenants', visible: false, reachableVia: 'Configuration link on TenantDetailPage' },

  { id: 'user-list', label: 'All Users', path: '/admin/users', remotePath: 'users', section: 'users', visible: true },
  { id: 'user-roles', label: 'Roles & Permissions', path: '/admin/users/roles', remotePath: 'users/roles', section: 'users', visible: true },

  { id: 'admin-modules', label: 'Modules', path: '/admin/modules', remotePath: 'modules', section: 'modules', visible: true },

  ...BILLING_ROUTES,

  { id: 'support-tickets', label: 'Tickets', path: '/admin/support/tickets', remotePath: 'support/tickets', section: 'support', visible: true },
  { id: 'support-messaging', label: 'Messaging', path: '/admin/support/messaging', remotePath: 'support/messaging', section: 'support', visible: true },
  { id: 'support-announcements', label: 'Announcements', path: '/admin/support/announcements', remotePath: 'support/announcements', section: 'support', visible: true },
  { id: 'support-onboarding', label: 'Onboarding', path: '/admin/support/onboarding', remotePath: 'support/onboarding', section: 'support', visible: true },

  { id: 'messaging-monitoring', label: 'Monitoring', path: '/admin/messaging/monitoring', remotePath: 'messaging/monitoring', section: 'messaging', visible: true },
  { id: 'messaging-tenants', label: 'Tenants', path: '/admin/messaging/tenants', remotePath: 'messaging/tenants', section: 'messaging', visible: true },
  { id: 'messaging-audit', label: 'Audit', path: '/admin/messaging/audit', remotePath: 'messaging/audit', section: 'messaging', visible: true },
  { id: 'messaging-compliance', label: 'Compliance', path: '/admin/messaging/compliance', remotePath: 'messaging/compliance', section: 'messaging', visible: true },
  { id: 'messaging-retention', label: 'Retention', path: '/admin/messaging/retention', remotePath: 'messaging/retention', section: 'messaging', visible: true },
  { id: 'messaging-ai-dashboard', label: 'AI Dashboard', path: '/admin/messaging/ai-dashboard', remotePath: 'messaging/ai-dashboard', section: 'messaging', visible: true },
  { id: 'messaging-ai-personas', label: 'AI Personas', path: '/admin/messaging/ai-personas', remotePath: 'messaging/ai-personas', section: 'messaging', visible: true },

  { id: 'security-activity', label: 'Activity Logs', path: '/admin/security/activity', remotePath: 'security/activity', section: 'security', visible: true },
  { id: 'security-audit', label: 'Audit Trail', path: '/admin/security/audit', remotePath: 'security/audit', section: 'security', visible: true },
  { id: 'security-compliance', label: 'Compliance', path: '/admin/security/compliance', remotePath: 'security/compliance', section: 'security', visible: true },
  { id: 'security-threats', label: 'Threat Detection', path: '/admin/security/threats', remotePath: 'security/threats', section: 'security', visible: true },

  { id: 'system-features', label: 'Feature Toggles', path: '/admin/system/features', remotePath: 'system/features', section: 'system', visible: true },
  { id: 'system-maintenance', label: 'Maintenance', path: '/admin/system/maintenance', remotePath: 'system/maintenance', section: 'system', visible: true },
  { id: 'system-performance', label: 'Performance', path: '/admin/system/performance', remotePath: 'system/performance', section: 'system', visible: true },
  { id: 'system-errors', label: 'Error Tracking', path: '/admin/system/errors', remotePath: 'system/errors', section: 'system', visible: true },
  { id: 'system-jobs', label: 'Job Queue', path: '/admin/system/jobs', remotePath: 'system/jobs', section: 'system', visible: true },
  { id: 'system-impersonation', label: 'Impersonation', path: '/admin/system/impersonation', remotePath: 'system/impersonation', section: 'system', visible: true },
  { id: 'system-debug', label: 'Debug Tools', path: '/admin/system/debug', remotePath: 'system/debug', section: 'system', visible: true },

  { id: 'database-management', label: 'Management', path: '/admin/database', remotePath: 'database', section: 'database', visible: true },
  { id: 'database-explorer', label: 'Explorer', path: '/admin/database/explorer', remotePath: 'database/explorer', section: 'database', visible: true },

  { id: 'admin-audit', label: 'Audit Logs', path: '/admin/audit', remotePath: 'audit', section: 'audit', visible: true },

  { id: 'settings-general', label: 'General', path: '/admin/settings', remotePath: 'settings', section: 'settings', visible: true },
  { id: 'settings-email', label: 'Email Templates', path: '/admin/settings/email', remotePath: 'settings/email', section: 'settings', visible: true },
  { id: 'settings-integrations', label: 'Integrations', path: '/admin/settings/integrations', remotePath: 'settings/integrations', section: 'settings', visible: true },
  { id: 'settings-provisioning', label: 'Provisioning', path: '/admin/settings/provisioning', remotePath: 'settings/provisioning', section: 'settings', visible: true },
];

/**
 * Derive the SUPER_ADMIN sidebar from the manifest: one nav item per section
 * (a leaf, or a group with its visible routes as children), in section order.
 * Adding a manifest entry is the only way to add a nav item — the hand-written
 * literal is gone, so the two cannot drift.
 */
export function buildSuperAdminNavigation(): NavigationItem[] {
  return ADMIN_NAV_SECTIONS.map((section) => {
    const visibleRoutes = ADMIN_ROUTES.filter(
      (route) => route.section === section.section && route.visible,
    );

    if (section.kind === 'leaf') {
      const leaf = visibleRoutes[0];
      if (leaf === undefined || visibleRoutes.length !== 1) {
        throw new Error(
          `Admin nav section '${section.section}' is declared 'leaf' but has ${visibleRoutes.length} visible routes (expected exactly 1).`,
        );
      }
      return { id: section.navId, label: section.label, icon: section.icon, path: leaf.path };
    }

    return {
      id: section.navId,
      label: section.label,
      icon: section.icon,
      children: visibleRoutes.map((route) => ({ id: route.id, label: route.label, path: route.path })),
    };
  });
}
