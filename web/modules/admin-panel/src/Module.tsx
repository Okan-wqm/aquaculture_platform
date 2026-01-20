/**
 * Admin Panel Module Root
 *
 * Super Admin Panel for managing tenants, users, billing, support, and system settings.
 * NOT: AdminLayout Shell'de kullanılıyor, burada sadece sayfa route'ları tanımlı.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AdminDashboard from './pages/AdminDashboard';
import UserManagementPage from './pages/UserManagementPage';
import RoleManagementPage from './pages/RoleManagementPage';
import TenantManagementPage from './pages/TenantManagementPage';
import TenantDetailPage from './pages/TenantDetailPage';
import CreateTenantPage from './pages/CreateTenantPage';
import SystemSettingsPage from './pages/SystemSettingsPage';
import AuditLogPage from './pages/AuditLogPage';
import SubscriptionManagementPage from './pages/SubscriptionManagementPage';
import PlanManagementPage from './pages/PlanManagementPage';
import DiscountCodePage from './pages/DiscountCodePage';
import TenantConfigurationPage from './pages/TenantConfigurationPage';
import EmailTemplatesPage from './pages/EmailTemplatesPage';
import IpAccessRulesPage from './pages/IpAccessRulesPage';
import AnalyticsDashboardPage from './pages/AnalyticsDashboardPage';
import ReportsPage from './pages/ReportsPage';
import DatabaseManagementPage from './pages/DatabaseManagementPage';
import MessagingPage from './pages/MessagingPage';
import AnnouncementsPage from './pages/AnnouncementsPage';
import TicketsPage from './pages/TicketsPage';
import OnboardingPage from './pages/OnboardingPage';
import ModulesPage from './pages/ModulesPage';
import BillingDashboardPage from './pages/BillingDashboardPage';
import InvoicesPage from './pages/InvoicesPage';
import DatabaseExplorerPage from './pages/DatabaseExplorerPage';
import ModulePricingPage from './pages/ModulePricingPage';
import CustomPlanBuilderPage from './pages/CustomPlanBuilderPage';
import {
  ActivityLogPage,
  AuditTrailPage,
  CompliancePage,
  SecurityDashboardPage,
} from './pages/security';
import {
  FeatureTogglesPage,
  MaintenancePage,
  PerformanceDashboardPage,
  ErrorTrackingPage,
  JobQueuePage,
  ImpersonationPage,
  DebugToolsPage,
} from './pages/system';

const AdminPanelModule: React.FC = () => {
  return (
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

      {/* Users & Roles */}
      <Route path="users" element={<UserManagementPage />} />
      <Route path="users/:userId" element={<UserManagementPage />} />
      <Route path="users/roles" element={<RoleManagementPage />} />

      {/* Modules */}
      <Route path="modules" element={<ModulesPage />} />

      {/* Billing */}
      <Route path="billing" element={<BillingDashboardPage />} />
      <Route path="billing/subscriptions" element={<SubscriptionManagementPage />} />
      <Route path="billing/invoices" element={<InvoicesPage />} />
      <Route path="billing/plans" element={<PlanManagementPage />} />
      <Route path="billing/discounts" element={<DiscountCodePage />} />
      <Route path="billing/module-pricing" element={<ModulePricingPage />} />
      <Route path="billing/custom-plan-builder" element={<CustomPlanBuilderPage />} />

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
      <Route path="system/impersonation" element={<ImpersonationPage />} />
      <Route path="system/debug" element={<DebugToolsPage />} />

      {/* Database */}
      <Route path="database" element={<DatabaseManagementPage />} />
      <Route path="database/explorer" element={<DatabaseExplorerPage />} />

      {/* Audit */}
      <Route path="audit" element={<AuditLogPage />} />

      {/* Settings */}
      <Route path="settings" element={<SystemSettingsPage />} />
      <Route path="settings/email" element={<EmailTemplatesPage />} />
      <Route path="settings/integrations" element={<IpAccessRulesPage />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
};

export default AdminPanelModule;
