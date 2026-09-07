/**
 * Admin-panel navigation configuration — pure data module.
 *
 * Before AUDIT-MEDIUM-011 (cold audit 2026-04-22) this content lived
 * inside a 486-line `AdminSidebar.tsx` fork of `web/shared-ui` Sidebar.
 * The fork existed because admin-panel runs in standalone dev mode
 * (App.tsx) without auth context — a justification that turned out to
 * be false once we read shared-ui Sidebar's API: `userRoles` is a
 * prop, not a context read, so consumers in isolation can just pass
 * their hardcoded role set.
 *
 * This module now provides two consumer-ready exports:
 *   - `adminNavItems`   — NavigationItem[] for the Sidebar `items` prop
 *   - `adminNavIcons`   — Record<string, React.ReactNode> for the
 *                          `customIcons` prop extension that shared-ui
 *                          Sidebar gained in the same PR (AUDIT-MEDIUM-011).
 *
 * Adding a new admin route: edit `adminNavItems` below. New SVG:
 * add a key to `adminNavIcons`. No other file is touched.
 */
import {
  ADMIN_BILLING_NAV_ITEMS,
  type NavigationItem,
} from '@aquaculture/shared-ui';
import React from 'react';

/**
 * Admin-specific icon set. Keys are the `icon` string on each
 * NavigationItem. These override / extend the built-in `defaultIcons`
 * in `web/shared-ui/src/components/Layout/Sidebar.tsx` via the
 * `customIcons` prop.
 */
export const adminNavIcons: Record<string, React.ReactNode> = {
  dashboard: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  ),
  analytics: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  tenants: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  ),
  users: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  ),
  billing: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  ),
  support: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  ),
  security: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  system: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  database: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  ),
  modules: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  audit: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  ),
  settings: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
    </svg>
  ),
  apiDocs: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  ),
  reports: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
};

const billingNavIconById: Record<string, string> = {
  'billing-overview': 'billing',
  'billing-module-pricing': 'billing',
  'billing-subscriptions': 'billing',
  'billing-invoices': 'reports',
  'billing-payments': 'billing',
  'billing-discounts': 'billing',
  'billing-custom-plans': 'modules',
};

const adminBillingNavItems: NavigationItem[] = ADMIN_BILLING_NAV_ITEMS.map((item) => ({
  ...item,
  icon: billingNavIconById[item.id] ?? 'billing',
}));

/**
 * Admin-panel navigation tree. `icon` is a string key into
 * `adminNavIcons` (or shared-ui's built-in `defaultIcons`).
 *
 * Adding a route here is enough — no other file changes.
 */
export const adminNavItems: NavigationItem[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/admin', icon: 'dashboard' },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: 'analytics',
    children: [
      { id: 'analytics-dashboard', label: 'Overview', path: '/admin/analytics', icon: 'analytics' },
      { id: 'analytics-reports', label: 'Reports', path: '/admin/analytics/reports', icon: 'reports' },
    ],
  },
  {
    id: 'tenants',
    label: 'Tenants',
    icon: 'tenants',
    children: [
      { id: 'tenant-list', label: 'All Tenants', path: '/admin/tenants', icon: 'tenants' },
      { id: 'tenant-create', label: 'Create Tenant', path: '/admin/tenants/new', icon: 'tenants' },
    ],
  },
  {
    id: 'users',
    label: 'Users',
    icon: 'users',
    children: [
      { id: 'user-list', label: 'All Users', path: '/admin/users', icon: 'users' },
      { id: 'user-roles', label: 'Roles & Permissions', path: '/admin/users/roles', icon: 'security' },
    ],
  },
  { id: 'modules', label: 'Modules', path: '/admin/modules', icon: 'modules' },
  {
    id: 'billing',
    label: 'Billing',
    icon: 'billing',
    children: adminBillingNavItems,
  },
  {
    id: 'support',
    label: 'Support',
    icon: 'support',
    children: [
      { id: 'support-tickets', label: 'Tickets', path: '/admin/support/tickets', icon: 'support' },
      { id: 'support-messaging', label: 'Messaging', path: '/admin/support/messaging', icon: 'support' },
      { id: 'support-announcements', label: 'Announcements', path: '/admin/support/announcements', icon: 'support' },
      { id: 'support-onboarding', label: 'Onboarding', path: '/admin/support/onboarding', icon: 'support' },
    ],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    icon: 'support',
    children: [
      { id: 'messaging-monitoring', label: 'Monitoring', path: '/admin/messaging/monitoring', icon: 'analytics' },
      { id: 'messaging-tenants', label: 'Tenants', path: '/admin/messaging/tenants', icon: 'tenants' },
      { id: 'messaging-audit', label: 'Audit Log', path: '/admin/messaging/audit', icon: 'audit' },
      { id: 'messaging-compliance', label: 'Compliance', path: '/admin/messaging/compliance', icon: 'security' },
      { id: 'messaging-retention', label: 'Retention', path: '/admin/messaging/retention', icon: 'database' },
      { id: 'messaging-ai-dashboard', label: 'AI Dashboard', path: '/admin/messaging/ai-dashboard', icon: 'analytics' },
      { id: 'messaging-ai-personas', label: 'AI Personas', path: '/admin/messaging/ai-personas', icon: 'users' },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    icon: 'security',
    children: [
      { id: 'security-activity', label: 'Activity Logs', path: '/admin/security/activity', icon: 'audit' },
      { id: 'security-audit', label: 'Audit Trail', path: '/admin/security/audit', icon: 'audit' },
      { id: 'security-compliance', label: 'Compliance', path: '/admin/security/compliance', icon: 'security' },
      { id: 'security-threats', label: 'Threat Detection', path: '/admin/security/threats', icon: 'security' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    icon: 'system',
    children: [
      { id: 'system-features', label: 'Feature Toggles', path: '/admin/system/features', icon: 'modules' },
      { id: 'system-maintenance', label: 'Maintenance', path: '/admin/system/maintenance', icon: 'system' },
      { id: 'system-performance', label: 'Performance', path: '/admin/system/performance', icon: 'analytics' },
      { id: 'system-errors', label: 'Error Tracking', path: '/admin/system/errors', icon: 'security' },
      { id: 'system-jobs', label: 'Job Queue', path: '/admin/system/jobs', icon: 'modules' },
    ],
  },
  { id: 'database', label: 'Database', path: '/admin/database', icon: 'database' },
  { id: 'audit', label: 'Audit Logs', path: '/admin/audit', icon: 'audit' },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'settings',
    children: [
      { id: 'settings-general', label: 'General', path: '/admin/settings', icon: 'settings' },
      { id: 'settings-email', label: 'Email Templates', path: '/admin/settings/email', icon: 'support' },
      { id: 'settings-integrations', label: 'Integrations', path: '/admin/settings/integrations', icon: 'modules' },
      { id: 'settings-provisioning', label: 'Provisioning', path: '/admin/settings/provisioning', icon: 'system' },
    ],
  },
  { id: 'api-docs', label: 'API Docs', path: 'http://localhost:3008/docs', icon: 'apiDocs', isExternal: true },
];
