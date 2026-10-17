/**
 * The SUPER_ADMIN console's navigation — the flat list its Sidebar renders.
 *
 * Tenant-side roles do not read this: their navigation is the console nav
 * model (web/shell/src/console/nav), one definition per page for the rail,
 * the palette and the coverage invariant.
 */
import {
  ADMIN_BILLING_NAV_ITEMS,
  type I18nContextValue,
  type MessageKey,
  type NavigationItem,
} from '@aquaculture/shared-ui';

/**
 * A navigation entry as the shell declares it: the label is a message key,
 * localized at render, so the menu follows the user's language rather than
 * this file's (FE-HIGH-089). An entry may instead carry a literal `label` —
 * the SUPER_ADMIN billing routes do, as the panel is a declared English-only
 * surface.
 */
type NavigationDefinition = Omit<NavigationItem, 'label' | 'children'> & {
  children?: NavigationDefinition[];
} & ({ labelKey: MessageKey; label?: never } | { label: string; labelKey?: never });

export function localizeNavigation(
  items: readonly NavigationDefinition[],
  t: I18nContextValue['t'],
): NavigationItem[] {
  return items.map((item) => ({
    id: item.id,
    icon: item.icon,
    path: item.path,
    requiredRoles: item.requiredRoles,
    requiredPermissions: item.requiredPermissions,
    badge: item.badge,
    isExternal: item.isExternal,
    label: item.labelKey !== undefined ? t(item.labelKey) : item.label,
    ...(item.children ? { children: localizeNavigation(item.children, t) } : {}),
  }));
}

/**
 * SUPER_ADMIN navigation - Full System Management
 * Synchronized with AdminSidebar
 */
const adminBillingNavItems: NavigationItem[] = ADMIN_BILLING_NAV_ITEMS.map((item) => ({ ...item }));

export const SUPER_ADMIN_NAVIGATION: readonly NavigationDefinition[] = [
  {
    id: 'admin-dashboard',
    labelKey: 'nav.dashboard',
    path: '/admin',
    icon: 'dashboard',
  },
  {
    id: 'admin-analytics',
    labelKey: 'nav.analytics',
    icon: 'analytics',
    children: [
      { id: 'analytics-dashboard', labelKey: 'nav.overview', path: '/admin/analytics' },
      { id: 'analytics-reports', labelKey: 'nav.reports', path: '/admin/analytics/reports' },
    ],
  },
  {
    id: 'admin-tenants',
    labelKey: 'nav.tenants',
    icon: 'tenants',
    children: [
      { id: 'tenant-list', labelKey: 'nav.allTenants', path: '/admin/tenants' },
      { id: 'tenant-create', labelKey: 'nav.createTenant', path: '/admin/tenants/new' },
    ],
  },
  {
    id: 'admin-users',
    labelKey: 'nav.users',
    icon: 'users',
    children: [
      { id: 'user-list', labelKey: 'nav.allUsers', path: '/admin/users' },
      { id: 'user-roles', labelKey: 'nav.rolesPermissions', path: '/admin/users/roles' },
    ],
  },
  {
    id: 'admin-modules',
    labelKey: 'nav.modules',
    path: '/admin/modules',
    icon: 'modules',
  },
  {
    id: 'admin-billing',
    labelKey: 'nav.billing',
    icon: 'billing',
    children: adminBillingNavItems,
  },
  {
    id: 'admin-support',
    labelKey: 'nav.support',
    icon: 'support',
    children: [
      { id: 'support-tickets', labelKey: 'nav.tickets', path: '/admin/support/tickets' },
      { id: 'support-messaging', labelKey: 'nav.messaging', path: '/admin/support/messaging' },
      {
        id: 'support-announcements',
        labelKey: 'nav.announcements',
        path: '/admin/support/announcements',
      },
      { id: 'support-onboarding', labelKey: 'nav.onboarding', path: '/admin/support/onboarding' },
    ],
  },
  {
    id: 'admin-security',
    labelKey: 'nav.security',
    icon: 'security',
    children: [
      { id: 'security-activity', labelKey: 'nav.activityLogs', path: '/admin/security/activity' },
      { id: 'security-audit', labelKey: 'nav.auditTrail', path: '/admin/security/audit' },
      { id: 'security-compliance', labelKey: 'nav.compliance', path: '/admin/security/compliance' },
      { id: 'security-threats', labelKey: 'nav.threatDetection', path: '/admin/security/threats' },
    ],
  },
  {
    id: 'admin-system',
    labelKey: 'nav.system',
    icon: 'system',
    children: [
      { id: 'system-features', labelKey: 'nav.featureToggles', path: '/admin/system/features' },
      { id: 'system-maintenance', labelKey: 'nav.maintenance', path: '/admin/system/maintenance' },
      { id: 'system-performance', labelKey: 'nav.performance', path: '/admin/system/performance' },
      { id: 'system-errors', labelKey: 'nav.errorTracking', path: '/admin/system/errors' },
      { id: 'system-jobs', labelKey: 'nav.jobQueue', path: '/admin/system/jobs' },
    ],
  },
  {
    id: 'admin-database',
    labelKey: 'nav.database',
    icon: 'database',
    children: [
      { id: 'database-management', labelKey: 'nav.management', path: '/admin/database' },
      { id: 'database-explorer', labelKey: 'nav.explorer', path: '/admin/database/explorer' },
    ],
  },
  {
    id: 'admin-audit',
    labelKey: 'nav.auditLogs',
    path: '/admin/audit',
    icon: 'audit',
  },
  {
    id: 'admin-settings',
    labelKey: 'nav.settings',
    icon: 'settings',
    children: [
      { id: 'settings-general', labelKey: 'nav.general', path: '/admin/settings' },
      { id: 'settings-email', labelKey: 'nav.emailTemplates', path: '/admin/settings/email' },
    ],
  },
];

interface NavigationMatch {
  readonly label: string;
  /** The matched path's length: the longer, the deeper the entry. */
  readonly depth: number;
}

function deepestMatch(items: readonly NavigationItem[], pathname: string): NavigationMatch | null {
  let best: NavigationMatch | null = null;
  for (const item of items) {
    const path = item.path;
    const opens = path !== undefined && (pathname === path || pathname.startsWith(`${path}/`));
    if (opens && (best === null || path.length > best.depth))
      best = { label: item.label, depth: path.length };
    const child = item.children === undefined ? null : deepestMatch(item.children, pathname);
    if (child !== null && (best === null || child.depth > best.depth)) best = child;
  }
  return best;
}

/**
 * The name of the page the location opens, for the admin console's document
 * title and route announcement (RouteAnnouncer): the label of the deepest
 * entry whose path is the location or a parent of it, so `/admin` names an
 * admin page no deeper entry claims. '' where no entry does.
 */
export function activeNavigationLabel(items: readonly NavigationItem[], pathname: string): string {
  const match = deepestMatch(items, pathname);
  return match === null ? '' : match.label;
}
