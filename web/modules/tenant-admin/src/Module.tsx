/**
 * Tenant Admin Module Root
 *
 * Tenant Admin Panel for managing users, modules, settings, and communication.
 * NOT: Layout is handled by Shell's MainLayout, only page routes defined here.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// Pages
import TenantDashboard from './pages/TenantDashboard';
import TenantUsers from './pages/TenantUsers';
import TenantModules from './pages/TenantModules';
import TenantSettings from './pages/TenantSettings';
import TenantDatabase from './pages/TenantDatabase';
import TenantMessagesPage from './pages/TenantMessagesPage';
import TenantSupportPage from './pages/TenantSupportPage';
import TenantAnnouncementsPage from './pages/TenantAnnouncementsPage';

/**
 * Tenant Admin Module
 *
 * Routes:
 * - /tenant (index) - Dashboard with stats and modules overview
 * - /tenant/users - User management for tenant
 * - /tenant/modules - Module assignments and manager assignment
 * - /tenant/messages - Messages with platform support
 * - /tenant/support - Support ticket management
 * - /tenant/announcements - Platform announcements
 * - /tenant/settings - Tenant settings and configuration
 * - /tenant/database - View tenant database information
 */
const TenantAdminModule: React.FC = () => {
  return (
    <Routes>
      {/* Dashboard - default route */}
      <Route index element={<TenantDashboard />} />

      {/* User Management */}
      <Route path="users" element={<TenantUsers />} />

      {/* Module Management */}
      <Route path="modules" element={<TenantModules />} />

      {/* Communication */}
      <Route path="messages" element={<TenantMessagesPage />} />
      <Route path="support" element={<TenantSupportPage />} />
      <Route path="announcements" element={<TenantAnnouncementsPage />} />

      {/* Tenant Settings */}
      <Route path="settings" element={<TenantSettings />} />

      {/* Database View */}
      <Route path="database" element={<TenantDatabase />} />

      {/* Catch-all redirect to dashboard */}
      <Route path="*" element={<Navigate to="/tenant" replace />} />
    </Routes>
  );
};

export default TenantAdminModule;
