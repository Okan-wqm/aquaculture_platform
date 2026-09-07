/**
 * Admin Panel Module Root
 *
 * Super Admin Panel for managing tenants, users, billing, support, and system settings.
 * NOT: AdminLayout Shell'de kullanılıyor, burada sadece sayfa route'ları tanımlı.
 *
 * All page imports use React.lazy for code splitting — each page chunk is loaded
 * on demand so the initial bundle stays small.
 */

import { Spinner, useAuthContext } from '@aquaculture/shared-ui';
import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// ============================================================================
// Lazy Page Imports
// ============================================================================

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

// Messaging monitoring pages
const MessagingMonitoringPage = lazy(() => import('./pages/messaging/MessagingMonitoringPage'));
const MessagingTenantsPage = lazy(() => import('./pages/messaging/MessagingTenantsPage'));
const MessagingAuditPage = lazy(() => import('./pages/messaging/MessagingAuditPage'));
const MessagingCompliancePage = lazy(() => import('./pages/messaging/MessagingCompliancePage'));
const MessagingRetentionPage = lazy(() => import('./pages/messaging/MessagingRetentionPage'));
const MessagingAiDashboardPage = lazy(() => import('./pages/messaging/MessagingAiDashboardPage'));
const MessagingAiPersonasPage = lazy(() => import('./pages/messaging/MessagingAiPersonasPage'));

// Security pages
const ActivityLogPage = lazy(() => import('./pages/security/ActivityLogPage'));
const AuditTrailPage = lazy(() => import('./pages/security/AuditTrailPage'));
const CompliancePage = lazy(() => import('./pages/security/CompliancePage'));
const SecurityDashboardPage = lazy(() => import('./pages/security/SecurityDashboardPage'));

// System pages
const FeatureTogglesPage = lazy(() => import('./pages/system/FeatureTogglesPage'));
const MaintenancePage = lazy(() => import('./pages/system/MaintenancePage'));
const PerformanceDashboardPage = lazy(() => import('./pages/system/PerformanceDashboardPage'));
const ErrorTrackingPage = lazy(() => import('./pages/system/ErrorTrackingPage'));
const JobQueuePage = lazy(() => import('./pages/system/JobQueuePage'));

// ============================================================================
// Suspense Fallback
// ============================================================================

const SuspenseFallback: React.FC = () => (
  <div className="flex items-center justify-center h-64">
    <Spinner size="lg" text="Yukleniyor..." />
  </div>
);

const isPlatformAdminRole = (role?: string | null): boolean =>
  role === 'SUPER_ADMIN';

// ============================================================================
// Module Component
// ============================================================================

const AdminPanelModule: React.FC = () => {
  const { user } = useAuthContext();

  if (!user || !isPlatformAdminRole(user.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return (
    <Suspense fallback={<SuspenseFallback />}>
      <Routes>
        {/* Dashboard */}
        <Route index element={<AdminDashboard />} />

        {/* Analytics */}
        <Route path="analytics" element={<AnalyticsDashboardPage />} />
        <Route path="analytics/reports" element={<ReportsPage />} />

        {/* Tenants */}
        <Route path="tenants" element={<TenantManagementPage />} />
        <Route path="tenants/new" element={<CreateTenantPage />} />
        <Route path="tenants/:tenantId" element={<TenantDetailPage />} />
        <Route path="tenants/:tenantId/configuration" element={<TenantConfigurationPage />} />

        {/* Users & Roles — static route must precede dynamic segment */}
        <Route path="users" element={<UserManagementPage />} />
        <Route path="users/roles" element={<RoleManagementPage />} />
        {/* users/:userId renders the user list filtered by ID; kept for back-compat but
            UserManagementPage does not yet read the param — navigate to /admin/users instead */}

        {/* Modules */}
        <Route path="modules" element={<ModulesPage />} />

        {/* Billing */}
        <Route path="billing" element={<BillingDashboardPage />} />
        <Route path="billing/subscriptions" element={<SubscriptionManagementPage />} />
        <Route path="billing/invoices" element={<InvoicesPage />} />
        <Route path="billing/invoices/new" element={<InvoicesPage />} />
        <Route path="billing/reports" element={<BillingReportsPage />} />
        <Route path="billing/plans" element={<PlanManagementPage />} />
        <Route path="billing/discounts" element={<DiscountCodePage />} />
        <Route path="billing/module-pricing" element={<ModulePricingPage />} />
        <Route path="billing/payments" element={<PaymentsPage />} />
        <Route path="billing/usage" element={<UsageDashboardPage />} />
        <Route path="billing/custom-plans" element={<CustomPlansListPage />} />
        <Route path="billing/custom-plans/new" element={<CustomPlanBuilderPage />} />
        <Route path="billing/custom-plan-builder" element={<Navigate to="/admin/billing/custom-plans/new" replace />} />

        {/* Messaging Monitoring (SUPER_ADMIN) */}
        <Route path="messaging/monitoring" element={<MessagingMonitoringPage />} />
        <Route path="messaging/tenants" element={<MessagingTenantsPage />} />
        <Route path="messaging/audit" element={<MessagingAuditPage />} />
        <Route path="messaging/compliance" element={<MessagingCompliancePage />} />
        <Route path="messaging/retention" element={<MessagingRetentionPage />} />
        <Route path="messaging/ai-dashboard" element={<MessagingAiDashboardPage />} />
        <Route path="messaging/ai-personas" element={<MessagingAiPersonasPage />} />

        {/* Support */}
        <Route path="support/tickets" element={<TicketsPage />} />
        <Route path="support/messaging" element={<MessagingPage />} />
        <Route path="support/announcements" element={<AnnouncementsPage />} />
        <Route path="support/onboarding" element={<OnboardingPage />} />

        {/* Security */}
        <Route path="security/activity" element={<ActivityLogPage />} />
        <Route path="security/audit" element={<AuditTrailPage />} />
        <Route path="security/compliance" element={<CompliancePage />} />
        <Route path="security/threats" element={<SecurityDashboardPage />} />

        {/* System Management */}
        <Route path="system/features" element={<FeatureTogglesPage />} />
        <Route path="system/maintenance" element={<MaintenancePage />} />
        <Route path="system/performance" element={<PerformanceDashboardPage />} />
        <Route path="system/errors" element={<ErrorTrackingPage />} />
        <Route path="system/jobs" element={<JobQueuePage />} />

        {/* Database */}
        <Route path="database" element={<DatabaseManagementPage />} />
        <Route path="database/explorer" element={<DatabaseExplorerPage />} />

        {/* Audit */}
        <Route path="audit" element={<AuditLogPage />} />

        {/* Settings */}
        <Route path="settings" element={<SystemSettingsPage />} />
        <Route path="settings/email" element={<EmailTemplatesPage />} />
        <Route path="settings/integrations" element={<IpAccessRulesPage />} />
        <Route path="settings/provisioning" element={<ProvisioningSettingsPage />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </Suspense>
  );
};

export default AdminPanelModule;
