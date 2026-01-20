import React, { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Package,
  Settings,
  Database,
  ChevronLeft,
  ChevronRight,
  Building2,
  User,
  MessageSquare,
  Ticket,
  Megaphone,
  Fish,
  Activity,
  UserCog,
  Loader2,
  FileText,
  Factory,
  Droplets,
} from 'lucide-react';

// GraphQL Configuration - Gateway API
const GRAPHQL_URL = '/graphql';

/**
 * Get auth token from localStorage
 */
const getAuthToken = (): string | null => {
  return localStorage.getItem('access_token');
};

/**
 * GraphQL query executor
 */
const executeGraphQL = async <T,>(query: string, variables?: Record<string, unknown>): Promise<T> => {
  const token = getAuthToken();

  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL error');
  }

  return result.data;
};

/**
 * Navigation item type
 */
interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
  badge?: number;
}

/**
 * Navigation section type
 */
interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * Module type from GraphQL API
 */
interface TenantModule {
  id: string;
  moduleId: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  isEnabled: boolean;
  defaultRoute?: string;
}

/**
 * Sidebar props
 */
interface TenantAdminSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  tenantName?: string;
  userName?: string;
}

/**
 * Module icon mapping
 */
const getModuleIcon = (code: string): React.ReactNode => {
  const iconMap: Record<string, React.ReactNode> = {
    'farm': <Fish className="w-5 h-5" />,
    'sensor': <Activity className="w-5 h-5" />,
    'hr': <UserCog className="w-5 h-5" />,
  };
  return iconMap[code] || <Package className="w-5 h-5" />;
};

/**
 * Module route mapping
 */
const getModuleRoute = (code: string): string => {
  const routeMap: Record<string, string> = {
    'farm': '/sites',
    'sensor': '/sensor',
    'hr': '/hr',
  };
  return routeMap[code] || `/${code}`;
};

/**
 * Static navigation sections for tenant admin
 */
const staticNavigationSections: NavSection[] = [
  {
    id: 'main',
    label: 'Main',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: <LayoutDashboard className="w-5 h-5" />,
        path: '/tenant',
      },
      {
        id: 'users',
        label: 'Users',
        icon: <Users className="w-5 h-5" />,
        path: '/tenant/users',
      },
      {
        id: 'modules',
        label: 'All Modules',
        icon: <Package className="w-5 h-5" />,
        path: '/tenant/modules',
      },
    ],
  },
  {
    id: 'farm',
    label: 'Farm Management',
    items: [
      {
        id: 'setup',
        label: 'Setup',
        icon: <Settings className="w-5 h-5" />,
        path: '/sites/setup',
      },
      {
        id: 'production',
        label: 'Production',
        icon: <Factory className="w-5 h-5" />,
        path: '/sites/production/batch-input',
      },
      {
        id: 'reports',
        label: 'Reports',
        icon: <FileText className="w-5 h-5" />,
        path: '/sites/reports/welfare',
      },
      {
        id: 'tanks',
        label: 'Tanks',
        icon: <Droplets className="w-5 h-5" />,
        path: '/sites/tanks',
      },
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    items: [
      {
        id: 'messages',
        label: 'Messages',
        icon: <MessageSquare className="w-5 h-5" />,
        path: '/tenant/messages',
        badge: 2,
      },
      {
        id: 'support',
        label: 'Support',
        icon: <Ticket className="w-5 h-5" />,
        path: '/tenant/support',
      },
      {
        id: 'announcements',
        label: 'Announcements',
        icon: <Megaphone className="w-5 h-5" />,
        path: '/tenant/announcements',
        badge: 3,
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        id: 'database',
        label: 'Database',
        icon: <Database className="w-5 h-5" />,
        path: '/tenant/database',
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: <Settings className="w-5 h-5" />,
        path: '/tenant/settings',
      },
    ],
  },
];

/**
 * TenantAdminSidebar Component
 */
export const TenantAdminSidebar: React.FC<TenantAdminSidebarProps> = ({
  collapsed,
  onCollapsedChange,
  tenantName = 'My Tenant',
  userName = 'Tenant Admin',
}) => {
  const location = useLocation();
  const [modules, setModules] = useState<TenantModule[]>([]);
  const [loadingModules, setLoadingModules] = useState(true);

  // Load tenant modules on mount via GraphQL
  useEffect(() => {
    loadModules();
  }, []);

  const loadModules = async () => {
    setLoadingModules(true);
    const token = getAuthToken();

    if (!token) {
      setLoadingModules(false);
      return;
    }

    try {
      const MY_MODULES_QUERY = `
        query MyModules {
          myModules {
            id
            moduleId
            name
            description
            icon
            color
            isEnabled
            defaultRoute
          }
        }
      `;

      const data = await executeGraphQL<{ myModules: TenantModule[] }>(MY_MODULES_QUERY);
      const modulesList = (data.myModules || []).filter(m => m.isEnabled);
      setModules(modulesList);
    } catch (err) {
      console.error('Failed to load modules for sidebar:', err);
    } finally {
      setLoadingModules(false);
    }
  };

  // Build dynamic modules section
  const modulesSection: NavSection | null = modules.length > 0 ? {
    id: 'assigned-modules',
    label: 'My Modules',
    items: modules.map((m) => {
      // Derive code from module name
      const code = m.name?.toLowerCase().includes('farm') ? 'farm'
        : m.name?.toLowerCase().includes('hr') || m.name?.toLowerCase().includes('insan') ? 'hr'
        : m.name?.toLowerCase().includes('sensor') || m.name?.toLowerCase().includes('sens') ? 'sensor'
        : 'default';
      return {
        id: `module-${m.moduleId}`,
        label: m.name,
        icon: getModuleIcon(code),
        path: m.defaultRoute || getModuleRoute(code),
      };
    }),
  } : null;

  // Combine static and dynamic sections
  const navigationSections: NavSection[] = [
    staticNavigationSections[0], // Main
    ...(modulesSection ? [modulesSection] : []), // My Modules (dynamic)
    ...staticNavigationSections.slice(1), // Communication, System
  ];

  /**
   * Check if a nav item is active
   */
  const isActive = (path: string): boolean => {
    if (path === '/tenant') {
      return location.pathname === '/tenant' || location.pathname === '/tenant/';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <aside
      className={`
        h-screen flex flex-col
        bg-gradient-to-b from-tenant-950 via-tenant-900 to-tenant-800
        text-white transition-all duration-300 ease-in-out
        ${collapsed ? 'w-20' : 'w-64'}
        border-r border-tenant-700/50
      `}
    >
      {/* Logo / Brand */}
      <div className="flex items-center justify-between h-16 px-4 border-b border-tenant-700/50">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-tenant-600 flex items-center justify-center shadow-lg">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          {!collapsed && (
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-bold text-white truncate">
                {tenantName}
              </span>
              <span className="text-xs text-tenant-300 truncate">Tenant Admin</span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 overflow-y-auto">
        <div className="space-y-6">
          {navigationSections.map((section) => (
            <div key={section.id}>
              {/* Section Label */}
              {!collapsed && (
                <div className="px-3 mb-2 flex items-center gap-2">
                  <span className="text-xs font-semibold text-tenant-400 uppercase tracking-wider">
                    {section.label}
                  </span>
                  {section.id === 'assigned-modules' && loadingModules && (
                    <Loader2 className="w-3 h-3 animate-spin text-tenant-400" />
                  )}
                </div>
              )}
              {collapsed && section.id !== 'main' && (
                <div className="border-t border-tenant-700/50 my-3" />
              )}

              {/* Section Items */}
              <ul className="space-y-1">
                {section.items.map((item) => (
                  <li key={item.id}>
                    <NavLink
                      to={item.path}
                      className={() => `
                        flex items-center gap-3 px-3 py-2.5 rounded-lg
                        transition-all duration-200 group relative
                        ${
                          isActive(item.path)
                            ? 'bg-tenant-600 text-white shadow-md'
                            : 'text-tenant-200 hover:bg-tenant-700/50 hover:text-white'
                        }
                      `}
                      title={collapsed ? item.label : undefined}
                    >
                      {/* Active indicator */}
                      {isActive(item.path) && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-white rounded-r-full" />
                      )}

                      {/* Icon */}
                      <span
                        className={`flex-shrink-0 ${
                          isActive(item.path) ? 'text-white' : 'text-tenant-300 group-hover:text-white'
                        }`}
                      >
                        {item.icon}
                      </span>

                      {/* Label */}
                      {!collapsed && (
                        <span className="flex-1 text-sm font-medium truncate">
                          {item.label}
                        </span>
                      )}

                      {/* Badge */}
                      {item.badge !== undefined && item.badge > 0 && (
                        <span
                          className={`flex-shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-medium flex items-center justify-center ${
                            collapsed ? 'absolute -top-1 -right-1 min-w-[16px] h-4 text-[10px]' : ''
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}

                      {/* Collapsed tooltip */}
                      {collapsed && (
                        <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-tenant-800 text-white text-sm whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                          {item.label}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Loading state for modules */}
          {loadingModules && !collapsed && (
            <div className="px-3">
              <div className="flex items-center gap-2 text-tenant-400 text-xs">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading modules...
              </div>
            </div>
          )}

          {/* No modules message */}
          {!loadingModules && modules.length === 0 && !collapsed && (
            <div className="px-3">
              <div className="text-tenant-400 text-xs">
                <span className="text-xs font-semibold uppercase tracking-wider block mb-2">
                  My Modules
                </span>
                <p className="text-tenant-500">No modules assigned yet</p>
              </div>
            </div>
          )}
        </div>
      </nav>

      {/* User Section */}
      <div className="border-t border-tenant-700/50 p-3">
        <div
          className={`flex items-center gap-3 px-3 py-2 rounded-lg bg-tenant-800/50 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-tenant-600 flex items-center justify-center">
            <User className="w-4 h-4 text-white" />
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{userName}</p>
              <p className="text-xs text-tenant-300 truncate">Tenant Admin</p>
            </div>
          )}
        </div>
      </div>

      {/* Collapse Toggle */}
      <div className="border-t border-tenant-700/50 p-3">
        <button
          onClick={() => onCollapsedChange(!collapsed)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-tenant-300 hover:bg-tenant-700/50 hover:text-white transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRight className="w-5 h-5" />
          ) : (
            <>
              <ChevronLeft className="w-5 h-5" />
              <span className="text-sm">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
};

export default TenantAdminSidebar;
