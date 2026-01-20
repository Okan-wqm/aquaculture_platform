import React, { useState, useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuthContext, useTenantContext } from '@aquaculture/shared-ui';
import { TenantAdminSidebar } from './TenantAdminSidebar';
import { TenantAdminHeader } from './TenantAdminHeader';
import { X } from 'lucide-react';

/**
 * Layout props
 */
interface TenantAdminLayoutProps {
  children?: React.ReactNode;
}

/**
 * Mobile Sidebar Overlay Component
 */
const MobileSidebarOverlay: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  tenantName?: string;
  userName?: string;
}> = ({ isOpen, onClose, tenantName, userName }) => {
  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sidebar */}
      <div className="absolute left-0 top-0 h-full w-64 animate-slide-in">
        <TenantAdminSidebar
          collapsed={false}
          onCollapsedChange={() => {}}
          tenantName={tenantName}
          userName={userName}
        />

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 rounded-lg bg-tenant-700 text-white hover:bg-tenant-600 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};

/**
 * TenantAdminLayout Component
 *
 * Main layout wrapper for tenant admin panel.
 * Features:
 * - Responsive sidebar (collapsible on desktop, overlay on mobile)
 * - Persistent collapsed state via localStorage
 * - Header with user info and actions
 * - Dark green gradient theme for sidebar
 * - Clean white content area
 */
export const TenantAdminLayout: React.FC<TenantAdminLayoutProps> = ({
  children,
}) => {
  // Sidebar collapsed state with localStorage persistence
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('tenantAdmin.sidebarCollapsed');
      return saved ? JSON.parse(saved) : false;
    }
    return false;
  });

  // Mobile sidebar state
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Get location for route change detection
  const location = useLocation();

  // Get user and tenant from context (provided by shell's AuthProvider/TenantProvider)
  const { user, logout } = useAuthContext();
  const { tenant } = useTenantContext();

  // Derive display names from context
  const tenantName = useMemo(() => {
    return tenant?.name || 'Tenant Admin';
  }, [tenant]);

  const userName = useMemo(() => {
    if (user?.firstName && user?.lastName) {
      return `${user.firstName} ${user.lastName}`;
    }
    return user?.email || 'User';
  }, [user]);

  // Persist collapsed state
  useEffect(() => {
    localStorage.setItem(
      'tenantAdmin.sidebarCollapsed',
      JSON.stringify(sidebarCollapsed)
    );
  }, [sidebarCollapsed]);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Desktop Sidebar */}
      <div className="hidden lg:block">
        <TenantAdminSidebar
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          tenantName={tenantName}
          userName={userName}
        />
      </div>

      {/* Mobile Sidebar Overlay */}
      <MobileSidebarOverlay
        isOpen={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
        tenantName={tenantName}
        userName={userName}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <TenantAdminHeader
          onMenuClick={() => setMobileSidebarOpen(true)}
          onLogout={logout}
          userName={userName}
          tenantName={tenantName}
        />

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 lg:p-6 max-w-[1920px] mx-auto">
            {children || <Outlet />}
          </div>
        </main>
      </div>
    </div>
  );
};

export default TenantAdminLayout;
