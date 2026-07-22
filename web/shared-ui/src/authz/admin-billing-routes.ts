import type { NavigationItem } from '../types';

export type AdminBillingRouteId =
  | 'billing-overview'
  | 'billing-module-pricing'
  | 'billing-plans'
  | 'billing-subscriptions'
  | 'billing-invoices'
  | 'billing-payments'
  | 'billing-usage'
  | 'billing-discounts'
  | 'billing-custom-plans'
  | 'billing-invoice-create'
  | 'billing-custom-plan-create'
  | 'billing-reports';

export interface AdminBillingRoute {
  id: AdminBillingRouteId;
  label: string;
  path: string;
  remotePath: string;
  visible: boolean;
  parentId?: AdminBillingRouteId;
  activeNavId: AdminBillingRouteId;
}

export const ADMIN_BILLING_ROLE = 'SUPER_ADMIN' as const;

export const ADMIN_BILLING_ROUTES: readonly AdminBillingRoute[] = [
  {
    id: 'billing-overview',
    label: 'Overview',
    path: '/admin/billing',
    remotePath: 'billing',
    visible: true,
    activeNavId: 'billing-overview',
  },
  {
    id: 'billing-module-pricing',
    label: 'Module Pricing',
    path: '/admin/billing/module-pricing',
    remotePath: 'billing/module-pricing',
    visible: true,
    activeNavId: 'billing-module-pricing',
  },
  {
    // APA-255: mounted in admin-panel Module.tsx (billing/plans ->
    // PlanManagementPage) but previously absent from this SSoT, so it never
    // appeared in the sidebar and was reachable only by typing the URL.
    id: 'billing-plans',
    label: 'Plan Catalog',
    path: '/admin/billing/plans',
    remotePath: 'billing/plans',
    visible: true,
    activeNavId: 'billing-plans',
  },
  {
    id: 'billing-subscriptions',
    label: 'Subscriptions',
    path: '/admin/billing/subscriptions',
    remotePath: 'billing/subscriptions',
    visible: true,
    activeNavId: 'billing-subscriptions',
  },
  {
    id: 'billing-invoices',
    label: 'Invoices',
    path: '/admin/billing/invoices',
    remotePath: 'billing/invoices',
    visible: true,
    activeNavId: 'billing-invoices',
  },
  {
    id: 'billing-payments',
    label: 'Payments',
    path: '/admin/billing/payments',
    remotePath: 'billing/payments',
    visible: true,
    activeNavId: 'billing-payments',
  },
  {
    // APA-255: mounted in admin-panel Module.tsx (billing/usage ->
    // UsageDashboardPage) but previously absent from this SSoT, so it never
    // appeared in the sidebar and was reachable only by typing the URL.
    id: 'billing-usage',
    label: 'Usage Metering',
    path: '/admin/billing/usage',
    remotePath: 'billing/usage',
    visible: true,
    activeNavId: 'billing-usage',
  },
  {
    id: 'billing-discounts',
    label: 'Discounts',
    path: '/admin/billing/discounts',
    remotePath: 'billing/discounts',
    visible: true,
    activeNavId: 'billing-discounts',
  },
  {
    id: 'billing-custom-plans',
    label: 'Custom Plans',
    path: '/admin/billing/custom-plans',
    remotePath: 'billing/custom-plans',
    visible: true,
    activeNavId: 'billing-custom-plans',
  },
  {
    id: 'billing-invoice-create',
    label: 'Create Invoice',
    path: '/admin/billing/invoices/new',
    remotePath: 'billing/invoices/new',
    visible: false,
    parentId: 'billing-invoices',
    activeNavId: 'billing-invoices',
  },
  {
    id: 'billing-custom-plan-create',
    label: 'New Custom Plan',
    path: '/admin/billing/custom-plans/new',
    remotePath: 'billing/custom-plans/new',
    visible: false,
    parentId: 'billing-custom-plans',
    activeNavId: 'billing-custom-plans',
  },
  {
    id: 'billing-reports',
    label: 'Billing Reports',
    path: '/admin/billing/reports',
    remotePath: 'billing/reports',
    visible: false,
    parentId: 'billing-overview',
    activeNavId: 'billing-overview',
  },
] as const;

export const ADMIN_BILLING_VISIBLE_ROUTES = ADMIN_BILLING_ROUTES.filter(
  (route) => route.visible,
);

export const ADMIN_BILLING_HIDDEN_ROUTES = ADMIN_BILLING_ROUTES.filter(
  (route) => !route.visible,
);

export const ADMIN_BILLING_NAV_ITEMS: NavigationItem[] =
  ADMIN_BILLING_VISIBLE_ROUTES.map((route) => ({
    id: route.id,
    label: route.label,
    path: route.path,
  }));

export function getAdminBillingRoute(id: AdminBillingRouteId): AdminBillingRoute {
  const route = ADMIN_BILLING_ROUTES.find((candidate) => candidate.id === id);
  if (!route) {
    throw new Error(`Unknown admin billing route: ${id}`);
  }
  return route;
}
