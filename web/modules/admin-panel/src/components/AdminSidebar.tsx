/**
 * Admin Panel Sidebar Component
 * Enterprise-grade navigation with all admin routes
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

// ============================================================================
// Types
// ============================================================================

interface NavItem {
  id: string;
  label: string;
  path?: string;
  icon: React.ReactNode;
  badge?: number | string;
  children?: NavItem[];
  isNew?: boolean;
}

interface AdminSidebarProps {
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

// ============================================================================
// Icons
// ============================================================================

const Icons = {
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
  reports: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  chevronDown: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  ),
  collapse: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
    </svg>
  ),
};

// ============================================================================
// Navigation Configuration
// ============================================================================

const navigationItems: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: '/admin',
    icon: Icons.dashboard,
  },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: Icons.analytics,
    children: [
      { id: 'analytics-dashboard', label: 'Overview', path: '/admin/analytics', icon: Icons.analytics },
      { id: 'analytics-reports', label: 'Reports', path: '/admin/analytics/reports', icon: Icons.reports },
    ],
  },
  {
    id: 'tenants',
    label: 'Tenants',
    icon: Icons.tenants,
    children: [
      { id: 'tenant-list', label: 'All Tenants', path: '/admin/tenants', icon: Icons.tenants },
      { id: 'tenant-create', label: 'Create Tenant', path: '/admin/tenants/new', icon: Icons.tenants },
    ],
  },
  {
    id: 'users',
    label: 'Users',
    icon: Icons.users,
    children: [
      { id: 'user-list', label: 'All Users', path: '/admin/users', icon: Icons.users },
      { id: 'user-roles', label: 'Roles & Permissions', path: '/admin/users/roles', icon: Icons.security },
    ],
  },
  {
    id: 'modules',
    label: 'Modules',
    path: '/admin/modules',
    icon: Icons.modules,
  },
  {
    id: 'billing',
    label: 'Billing',
    icon: Icons.billing,
    children: [
      { id: 'billing-overview', label: 'Overview', path: '/admin/billing', icon: Icons.billing },
      { id: 'billing-subscriptions', label: 'Subscriptions', path: '/admin/billing/subscriptions', icon: Icons.billing },
      { id: 'billing-invoices', label: 'Invoices', path: '/admin/billing/invoices', icon: Icons.reports },
      { id: 'billing-plans', label: 'Plans', path: '/admin/billing/plans', icon: Icons.modules },
    ],
  },
  {
    id: 'support',
    label: 'Support',
    icon: Icons.support,
    children: [
      { id: 'support-tickets', label: 'Tickets', path: '/admin/support/tickets', icon: Icons.support },
      { id: 'support-messaging', label: 'Messaging', path: '/admin/support/messaging', icon: Icons.support },
      { id: 'support-announcements', label: 'Announcements', path: '/admin/support/announcements', icon: Icons.support },
      { id: 'support-onboarding', label: 'Onboarding', path: '/admin/support/onboarding', icon: Icons.support, isNew: true },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    icon: Icons.security,
    children: [
      { id: 'security-activity', label: 'Activity Logs', path: '/admin/security/activity', icon: Icons.audit },
      { id: 'security-audit', label: 'Audit Trail', path: '/admin/security/audit', icon: Icons.audit },
      { id: 'security-compliance', label: 'Compliance', path: '/admin/security/compliance', icon: Icons.security },
      { id: 'security-threats', label: 'Threat Detection', path: '/admin/security/threats', icon: Icons.security },
    ],
  },
  {
    id: 'system',
    label: 'System',
    icon: Icons.system,
    children: [
      { id: 'system-features', label: 'Feature Toggles', path: '/admin/system/features', icon: Icons.modules },
      { id: 'system-maintenance', label: 'Maintenance', path: '/admin/system/maintenance', icon: Icons.system },
      { id: 'system-performance', label: 'Performance', path: '/admin/system/performance', icon: Icons.analytics },
      { id: 'system-errors', label: 'Error Tracking', path: '/admin/system/errors', icon: Icons.security },
      { id: 'system-jobs', label: 'Job Queue', path: '/admin/system/jobs', icon: Icons.modules },
      { id: 'system-impersonation', label: 'Impersonation', path: '/admin/system/impersonation', icon: Icons.users },
      { id: 'system-debug', label: 'Debug Tools', path: '/admin/system/debug', icon: Icons.system },
    ],
  },
  {
    id: 'database',
    label: 'Database',
    path: '/admin/database',
    icon: Icons.database,
  },
  {
    id: 'audit',
    label: 'Audit Logs',
    path: '/admin/audit',
    icon: Icons.audit,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Icons.settings,
    children: [
      { id: 'settings-general', label: 'General', path: '/admin/settings', icon: Icons.settings },
      { id: 'settings-email', label: 'Email Templates', path: '/admin/settings/email', icon: Icons.support },
      { id: 'settings-integrations', label: 'Integrations', path: '/admin/settings/integrations', icon: Icons.modules },
    ],
  },
];

// ============================================================================
// MenuItem Component
// ============================================================================

const MenuItem: React.FC<{
  item: NavItem;
  collapsed: boolean;
  activePath: string;
  expandedItems: Set<string>;
  onToggle: (id: string) => void;
  onNavigate: (path: string) => void;
  depth?: number;
}> = ({ item, collapsed, activePath, expandedItems, onToggle, onNavigate, depth = 0 }) => {
  const hasChildren = item.children && item.children.length > 0;
  const isExpanded = expandedItems.has(item.id);
  const isActive = item.path === activePath;
  const isChildActive = item.children?.some(
    (child) => child.path === activePath || child.children?.some((gc) => gc.path === activePath)
  );

  const handleClick = () => {
    if (hasChildren) {
      onToggle(item.id);
    } else if (item.path) {
      onNavigate(item.path);
    }
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className={`
          w-full flex items-center gap-3
          ${collapsed && depth === 0 ? 'justify-center' : 'justify-between'}
          px-3 py-2.5 rounded-lg
          text-sm font-medium
          transition-all duration-200
          ${depth > 0 ? 'pl-10' : ''}
          ${isActive
            ? 'bg-blue-600 text-white shadow-sm'
            : isChildActive
              ? 'bg-blue-50 text-blue-700'
              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
          }
        `}
        title={collapsed ? item.label : undefined}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`flex-shrink-0 ${isActive ? 'text-white' : 'text-gray-500'}`}>
            {item.icon}
          </span>
          {!collapsed && (
            <span className="truncate">{item.label}</span>
          )}
        </div>

        {!collapsed && (
          <div className="flex items-center gap-2">
            {item.isNew && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-green-500 text-white rounded uppercase">
                New
              </span>
            )}
            {item.badge !== undefined && (
              <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                isActive ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-700'
              }`}>
                {item.badge}
              </span>
            )}
            {hasChildren && (
              <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>
                {Icons.chevronDown}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Children */}
      {hasChildren && isExpanded && !collapsed && (
        <div className="mt-1 space-y-1">
          {item.children!.map((child) => (
            <MenuItem
              key={child.id}
              item={child}
              collapsed={collapsed}
              activePath={activePath}
              expandedItems={expandedItems}
              onToggle={onToggle}
              onNavigate={onNavigate}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// AdminSidebar Component
// ============================================================================

export const AdminSidebar: React.FC<AdminSidebarProps> = ({
  collapsed = false,
  onCollapsedChange,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Auto-expand parent when child is active
  useEffect(() => {
    const activeParent = navigationItems.find(
      (item) => item.children?.some((child) => location.pathname === child.path)
    );
    if (activeParent && !expandedItems.has(activeParent.id)) {
      setExpandedItems((prev) => new Set(prev).add(activeParent.id));
    }
  }, [location.pathname]);

  const handleToggle = useCallback((id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleNavigate = useCallback((path: string) => {
    navigate(path);
  }, [navigate]);

  return (
    <aside
      className={`
        flex flex-col
        ${collapsed ? 'w-16' : 'w-64'}
        h-screen bg-white border-r border-gray-200
        transition-all duration-300 ease-in-out
        flex-shrink-0
      `}
    >
      {/* Header */}
      <div className={`
        h-16 flex items-center border-b border-gray-200
        ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}
      `}>
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">A</span>
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-900">Admin Panel</h1>
              <p className="text-[10px] text-gray-500">Aquaculture Platform</p>
            </div>
          </div>
        )}

        {onCollapsedChange && (
          <button
            onClick={() => onCollapsedChange(!collapsed)}
            className={`
              p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg
              transition-all duration-200
              ${collapsed ? 'rotate-180' : ''}
            `}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {Icons.collapse}
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-thin scrollbar-thumb-gray-300">
        {navigationItems.map((item) => (
          <MenuItem
            key={item.id}
            item={item}
            collapsed={collapsed}
            activePath={location.pathname}
            expandedItems={expandedItems}
            onToggle={handleToggle}
            onNavigate={handleNavigate}
          />
        ))}
      </nav>

      {/* Footer */}
      {!collapsed && (
        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">Super Admin</p>
              <p className="text-xs text-gray-500 truncate">admin@aquaculture.com</p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default AdminSidebar;
