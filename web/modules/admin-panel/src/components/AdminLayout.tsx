/**
 * Admin Panel Layout Component
 * Enterprise-grade layout with sidebar, header, and responsive design
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar, type UserRole, type NavigationItem } from '@aquaculture/shared-ui';
import { adminNavItems, adminNavIcons } from './admin-nav-items';

// Admin panel standalone dev mode runs without auth context. The
// shared-ui Sidebar resolves access via `userRoles` PROPS — so we
// pass the platform-admin role set directly. No auth provider needed.
const ADMIN_DEV_ROLES: UserRole[] = ['SUPER_ADMIN'];

// ============================================================================
// Types
// ============================================================================

interface AdminLayoutProps {
  children?: React.ReactNode;
}

// ============================================================================
// Nav quick-filter search index (flattened from adminNavItems)
// ============================================================================

interface NavSearchEntry {
  id: string;
  label: string;
  path: string;
}

const buildNavSearchIndex = (
  items: NavigationItem[],
  parentLabel?: string
): NavSearchEntry[] => {
  const entries: NavSearchEntry[] = [];
  for (const item of items) {
    const label = parentLabel ? `${parentLabel} / ${item.label}` : item.label;
    if (item.path && !item.isExternal) {
      entries.push({ id: item.id, label, path: item.path });
    }
    if (item.children && item.children.length > 0) {
      entries.push(...buildNavSearchIndex(item.children, label));
    }
  }
  return entries;
};

const NAV_SEARCH_INDEX: NavSearchEntry[] = buildNavSearchIndex(adminNavItems);

// ============================================================================
// Header Component
// ============================================================================

const AdminHeader: React.FC<{
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onToggleMobileSidebar: () => void;
}> = ({ sidebarCollapsed, onToggleSidebar, onToggleMobileSidebar }) => {
  const navigate = useNavigate();
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const matches = trimmedQuery
    ? NAV_SEARCH_INDEX.filter((entry) =>
        entry.label.toLowerCase().includes(trimmedQuery)
      )
    : [];

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setActiveIndex(-1);
  }, []);

  const selectMatch = useCallback(
    (entry: NavSearchEntry) => {
      navigate(entry.path);
      setSearchQuery('');
      closeSearch();
    },
    [navigate, closeSearch]
  );

  // Close the dropdown on outside click
  useEffect(() => {
    if (!searchOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (
        searchContainerRef.current &&
        e.target instanceof Node &&
        !searchContainerRef.current.contains(e.target)
      ) {
        closeSearch();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [searchOpen, closeSearch]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      closeSearch();
      return;
    }
    if (matches.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchOpen(true);
      setActiveIndex((prev) => (prev + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchOpen(true);
      setActiveIndex((prev) => (prev <= 0 ? matches.length - 1 : prev - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = matches[activeIndex >= 0 ? activeIndex : 0];
      if (entry) {
        selectMatch(entry);
      }
    }
  };

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-6">
      {/* Left side */}
      <div className="flex items-center gap-4">
        {/* Mobile menu button */}
        <button
          onClick={onToggleMobileSidebar}
          aria-label="Toggle mobile menu"
          className="lg:hidden p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Desktop collapse button */}
        <button
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
          className="hidden lg:flex p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        >
          <svg className={`w-5 h-5 transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>

        {/* Breadcrumb placeholder */}
        <div className="hidden md:block text-sm text-gray-500">
          Super Admin Panel
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-4">
        {/* Nav quick-filter search */}
        <div className="hidden md:block">
          <div className="relative" ref={searchContainerRef}>
            <input
              type="text"
              placeholder="Search pages..."
              value={searchQuery}
              role="combobox"
              aria-expanded={searchOpen && matches.length > 0}
              aria-controls="admin-nav-search-results"
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex >= 0 && activeIndex < matches.length
                  ? `admin-nav-search-option-${activeIndex}`
                  : undefined
              }
              aria-label="Search admin pages"
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
                setActiveIndex(-1);
              }}
              onFocus={() => {
                if (searchQuery.trim()) setSearchOpen(true);
              }}
              onKeyDown={handleSearchKeyDown}
              className="w-64 pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>

            {searchOpen && trimmedQuery && (
              <ul
                id="admin-nav-search-results"
                role="listbox"
                aria-label="Matching admin pages"
                className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto"
              >
                {matches.length === 0 ? (
                  <li className="px-4 py-2 text-sm text-gray-500" role="presentation">
                    No matching pages
                  </li>
                ) : (
                  matches.map((entry, idx) => (
                    <li
                      key={entry.id}
                      id={`admin-nav-search-option-${idx}`}
                      role="option"
                      aria-selected={idx === activeIndex}
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => selectMatch(entry)}
                        onMouseEnter={() => setActiveIndex(idx)}
                        className={`w-full text-left px-4 py-2 text-sm ${
                          idx === activeIndex
                            ? 'bg-blue-50 text-blue-700'
                            : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {entry.label}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </div>

        {/* Settings */}
        <button
          aria-label="Settings"
          onClick={() => navigate('/admin/settings')}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {/* User menu */}
        <div className="flex items-center gap-3 pl-4 border-l border-gray-200">
          <div className="hidden sm:block text-right">
            <p className="text-sm font-medium text-gray-900">Super Admin</p>
            <p className="text-xs text-gray-500">Administrator</p>
          </div>
          <button aria-label="User menu" className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center text-white font-medium">
            SA
          </button>
        </div>
      </div>
    </header>
  );
};

// ============================================================================
// Mobile Sidebar Overlay
// ============================================================================

const MobileSidebarOverlay: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Focus trap and Escape key handling
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      // Focus trap
      if (e.key === 'Tab' && overlayRef.current) {
        const focusable = overlayRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    // Focus the close button on open
    const closeBtn = overlayRef.current?.querySelector<HTMLElement>('button');
    closeBtn?.focus();

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Mobile navigation">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-gray-600/75 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sidebar */}
      <div className="fixed inset-y-0 left-0 flex w-full max-w-xs">
        <div className="relative flex-1 flex flex-col w-full bg-white">
          {/* Close button */}
          <div className="absolute top-0 right-0 -mr-12 pt-2">
            <button
              onClick={onClose}
              aria-label="Close navigation menu"
              className="ml-1 flex items-center justify-center h-10 w-10 rounded-full focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-white"
            >
              <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <AdminNavSidebar collapsed={false} />
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// AdminNavSidebar — thin wrapper around the shared-ui Sidebar with
// admin-specific items, icons, and 'admin' theme baked in.
// ============================================================================

const AdminNavSidebar: React.FC<{
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}> = ({ collapsed = false, onCollapsedChange }) => {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Sidebar
      items={adminNavItems}
      customIcons={adminNavIcons}
      activePath={location.pathname}
      onNavigate={(path) => navigate(path)}
      userRoles={ADMIN_DEV_ROLES}
      theme="admin"
      collapsed={collapsed}
      {...(onCollapsedChange ? { onCollapsedChange } : {})}
    />
  );
};

// ============================================================================
// AdminLayout Component
// ============================================================================

export const AdminLayout: React.FC<AdminLayoutProps> = ({ children }) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const location = useLocation();

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  // Load sidebar state from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('admin-sidebar-collapsed');
    if (saved) {
      setSidebarCollapsed(JSON.parse(saved));
    }
  }, []);

  // Save sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem('admin-sidebar-collapsed', JSON.stringify(sidebarCollapsed));
  }, [sidebarCollapsed]);

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Skip to content link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-4 focus:left-4 focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded-lg focus:text-sm focus:font-medium"
      >
        Skip to main content
      </a>

      {/* Desktop Sidebar */}
      <div className="hidden lg:block">
        <AdminNavSidebar
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
        />
      </div>

      {/* Mobile Sidebar */}
      <MobileSidebarOverlay
        isOpen={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <AdminHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onToggleMobileSidebar={() => setMobileSidebarOpen(!mobileSidebarOpen)}
        />

        {/* Page content */}
        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="p-4 lg:p-6 max-w-[1920px] mx-auto">
            {children || <Outlet />}
          </div>
        </main>
      </div>
    </div>
  );
};

export default AdminLayout;
