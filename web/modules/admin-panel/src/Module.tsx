/**
 * Admin panel route renderer. Route coordinates live only in ADMIN_ROUTES;
 * this module supplies the page component for each compile-time route id.
 */

import {
  ADMIN_PANEL_ROLE,
  ADMIN_ROUTE_REDIRECTS,
  ADMIN_ROUTES,
  Spinner,
  getAdminRoute,
  useAuthContext,
  type AdminRouteId,
} from '@aquaculture/shared-ui';
import React, { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));
const RoleManagementPage = lazy(() => import('./pages/RoleManagementPage'));
const TenantManagementPage = lazy(() => import('./pages/TenantManagementPage'));
const TenantDetailPage = lazy(() => import('./pages/TenantDetailPage'));
const CreateTenantPage = lazy(() => import('./pages/CreateTenantPage'));
const SystemSettingsPage = lazy(() => import('./pages/SystemSettingsPage'));
const AuditLogPage = lazy(() => import('./pages/AuditLogPage'));
const SubscriptionManagementPage = lazy(() => import('./pages/SubscriptionManagementPage'));
const PlanManagementPage = lazy(() => import('./pages/PlanManagementPage'));
const DiscountCodePage = lazy(() => import('./pages/DiscountCodePage'));
const TenantConfigurationPage = lazy(() => import('./pages/TenantConfigurationPage'));
const EmailTemplatesPage = lazy(() => import('./pages/EmailTemplatesPage'));
const IpAccessRulesPage = lazy(() => import('./pages/IpAccessRulesPage'));
const AnalyticsDashboardPage = lazy(() => import('./pages/AnalyticsDashboardPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const DatabaseManagementPage = lazy(() => import('./pages/DatabaseManagementPage'));
const MessagingPage = lazy(() => import('./pages/MessagingPage'));
const AnnouncementsPage = lazy(() => import('./pages/AnnouncementsPage'));
const TicketsPage = lazy(() => import('./pages/TicketsPage'));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'));
const ModulesPage = lazy(() => import('./pages/ModulesPage'));
const BillingDashboardPage = lazy(() => import('./pages/BillingDashboardPage'));
const InvoicesPage = lazy(() => import('./pages/InvoicesPage'));
const BillingReportsPage = lazy(() => import('./pages/BillingReportsPage'));
const DatabaseExplorerPage = lazy(() => import('./pages/DatabaseExplorerPage'));
const ModulePricingPage = lazy(() => import('./pages/ModulePricingPage'));
const CustomPlansListPage = lazy(() => import('./pages/CustomPlansListPage'));
const CustomPlanBuilderPage = lazy(() => import('./pages/CustomPlanBuilderPage'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage'));
const UsageDashboardPage = lazy(() => import('./pages/UsageDashboardPage'));
const ProvisioningSettingsPage = lazy(() => import('./pages/ProvisioningSettingsPage'));
const MessagingMonitoringPage = lazy(() => import('./pages/messaging/MessagingMonitoringPage'));
const MessagingTenantsPage = lazy(() => import('./pages/messaging/MessagingTenantsPage'));
const MessagingAuditPage = lazy(() => import('./pages/messaging/MessagingAuditPage'));
const MessagingCompliancePage = lazy(() => import('./pages/messaging/MessagingCompliancePage'));
const MessagingRetentionPage = lazy(() => import('./pages/messaging/MessagingRetentionPage'));
const MessagingAiDashboardPage = lazy(() => import('./pages/messaging/MessagingAiDashboardPage'));
const MessagingAiPersonasPage = lazy(() => import('./pages/messaging/MessagingAiPersonasPage'));
const CompliancePage = lazy(() => import('./pages/security/CompliancePage'));
const SecurityDashboardPage = lazy(() => import('./pages/security/SecurityDashboardPage'));
const FeatureTogglesPage = lazy(() => import('./pages/system/FeatureTogglesPage'));
const MaintenancePage = lazy(() => import('./pages/system/MaintenancePage'));
const PerformanceDashboardPage = lazy(() => import('./pages/system/PerformanceDashboardPage'));
const ErrorTrackingPage = lazy(() => import('./pages/system/ErrorTrackingPage'));
const JobQueuePage = lazy(() => import('./pages/system/JobQueuePage'));
const ImpersonationPage = lazy(() => import('./pages/system/ImpersonationPage'));
const DebugToolsPage = lazy(() => import('./pages/system/DebugToolsPage'));

const ADMIN_ROUTE_COMPONENTS: Readonly<Record<AdminRouteId, LazyExoticComponent<ComponentType>>> =
  Object.freeze({
    'admin-dashboard': AdminDashboard,
    'analytics-dashboard': AnalyticsDashboardPage,
    'analytics-reports': ReportsPage,
    'tenant-list': TenantManagementPage,
    'tenant-create': CreateTenantPage,
    'tenant-detail': TenantDetailPage,
    'tenant-configuration': TenantConfigurationPage,
    'user-list': UserManagementPage,
    'user-roles': RoleManagementPage,
    'admin-modules': ModulesPage,
    'billing-overview': BillingDashboardPage,
    'billing-module-pricing': ModulePricingPage,
    'billing-plans': PlanManagementPage,
    'billing-subscriptions': SubscriptionManagementPage,
    'billing-invoices': InvoicesPage,
    'billing-payments': PaymentsPage,
    'billing-usage': UsageDashboardPage,
    'billing-discounts': DiscountCodePage,
    'billing-custom-plans': CustomPlansListPage,
    'billing-invoice-create': InvoicesPage,
    'billing-custom-plan-create': CustomPlanBuilderPage,
    'billing-reports': BillingReportsPage,
    'support-tickets': TicketsPage,
    'support-messaging': MessagingPage,
    'support-announcements': AnnouncementsPage,
    'support-onboarding': OnboardingPage,
    'messaging-monitoring': MessagingMonitoringPage,
    'messaging-tenants': MessagingTenantsPage,
    'messaging-audit': MessagingAuditPage,
    'messaging-compliance': MessagingCompliancePage,
    'messaging-retention': MessagingRetentionPage,
    'messaging-ai-dashboard': MessagingAiDashboardPage,
    'messaging-ai-personas': MessagingAiPersonasPage,
    'security-compliance': CompliancePage,
    'security-threats': SecurityDashboardPage,
    'system-features': FeatureTogglesPage,
    'system-maintenance': MaintenancePage,
    'system-performance': PerformanceDashboardPage,
    'system-errors': ErrorTrackingPage,
    'system-jobs': JobQueuePage,
    'system-impersonation': ImpersonationPage,
    'system-debug': DebugToolsPage,
    'database-management': DatabaseManagementPage,
    'database-explorer': DatabaseExplorerPage,
    'admin-audit': AuditLogPage,
    'settings-general': SystemSettingsPage,
    'settings-email': EmailTemplatesPage,
    'settings-integrations': IpAccessRulesPage,
    'settings-provisioning': ProvisioningSettingsPage,
  });

const SuspenseFallback: React.FC = () => (
  <div className="flex h-64 items-center justify-center">
    <Spinner size="lg" text="Yukleniyor..." />
  </div>
);

const AdminPanelModule: React.FC = () => {
  const { user } = useAuthContext();
  if (user?.role !== ADMIN_PANEL_ROLE) {
    return <Navigate to="/unauthorized" replace />;
  }

  return (
    <Suspense fallback={<SuspenseFallback />}>
      <Routes>
        {ADMIN_ROUTES.map((route) => {
          const Page = ADMIN_ROUTE_COMPONENTS[route.id];
          return route.remotePath === '' ? (
            <Route key={route.id} index element={<Page />} />
          ) : (
            <Route key={route.id} path={route.remotePath} element={<Page />} />
          );
        })}
        {ADMIN_ROUTE_REDIRECTS.map((redirect) => (
          <Route
            key={redirect.id}
            path={redirect.remotePath}
            element={<Navigate to={getAdminRoute(redirect.targetRouteId).path} replace />}
          />
        ))}
        <Route path="*" element={<Navigate to={getAdminRoute('admin-dashboard').path} replace />} />
      </Routes>
    </Suspense>
  );
};

export default AdminPanelModule;
