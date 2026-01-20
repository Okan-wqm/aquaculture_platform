import React from 'react';
import {
  Menu,
  Bell,
  Search,
  HelpCircle,
  LogOut,
  User,
  Settings,
  ChevronDown,
} from 'lucide-react';

/**
 * Header props
 */
interface TenantAdminHeaderProps {
  onMenuClick: () => void;
  onLogout?: () => void;
  userName?: string;
  tenantName?: string;
}

/**
 * TenantAdminHeader Component
 *
 * Top header for tenant admin panel.
 * Features:
 * - Mobile menu toggle
 * - Search bar
 * - Notifications
 * - User dropdown
 */
export const TenantAdminHeader: React.FC<TenantAdminHeaderProps> = ({
  onMenuClick,
  onLogout,
  userName = 'Tenant Admin',
  tenantName = 'My Tenant',
}) => {
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-6">
      {/* Left Section */}
      <div className="flex items-center gap-4">
        {/* Mobile Menu Button */}
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          aria-label="Toggle menu"
        >
          <Menu className="w-6 h-6" />
        </button>

        {/* Search Bar - Hidden on mobile */}
        <div className="hidden md:flex items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search..."
              className="w-64 pl-10 pr-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent transition-all"
            />
          </div>
        </div>
      </div>

      {/* Right Section */}
      <div className="flex items-center gap-2">
        {/* Help Button */}
        <button className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors">
          <HelpCircle className="w-5 h-5" />
        </button>

        {/* Notifications */}
        <button className="relative p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors">
          <Bell className="w-5 h-5" />
          {/* Notification Badge */}
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-tenant-500" />
        </button>

        {/* Divider */}
        <div className="h-8 w-px bg-gray-200 mx-2" />

        {/* User Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-100 transition-colors"
          >
            {/* Avatar */}
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center">
              <User className="w-4 h-4 text-white" />
            </div>

            {/* Name - Hidden on mobile */}
            <div className="hidden md:flex flex-col items-start">
              <span className="text-sm font-medium text-gray-700">{userName}</span>
              <span className="text-xs text-gray-500">{tenantName}</span>
            </div>

            <ChevronDown className="hidden md:block w-4 h-4 text-gray-400" />
          </button>

          {/* Dropdown Menu */}
          {showUserMenu && (
            <>
              {/* Backdrop */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowUserMenu(false)}
              />

              {/* Menu */}
              <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-900">{userName}</p>
                  <p className="text-xs text-gray-500">{tenantName}</p>
                </div>

                <div className="py-1">
                  <button className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                    <User className="w-4 h-4" />
                    Profile
                  </button>
                  <button className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                    <Settings className="w-4 h-4" />
                    Settings
                  </button>
                </div>

                <div className="border-t border-gray-100 py-1">
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      onLogout?.();
                    }}
                    className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
};

export default TenantAdminHeader;
