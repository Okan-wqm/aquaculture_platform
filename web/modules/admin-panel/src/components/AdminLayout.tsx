/**
 * Admin Panel Layout Component
 * Enterprise-grade layout with sidebar, header, and responsive design
 */

import React, { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AdminSidebar } from './AdminSidebar';

// ============================================================================
// Types
// ============================================================================

interface AdminLayoutProps {
  children?: React.ReactNode;
}

// ============================================================================
// Header Component
// ============================================================================

const AdminHeader: React.FC<{
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onToggleMobileSidebar: () => void;
}> = ({ sidebarCollapsed, onToggleSidebar, onToggleMobileSidebar }) => {
  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-6">
      {/* Left side */}
      <div className="flex items-center gap-4">
        {/* Mobile menu button */}
        <button
          onClick={onToggleMobileSidebar}
          className="lg:hidden p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Desktop collapse button */}
        <button
          onClick={onToggleSidebar}
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
        {/* Search */}
        <div className="hidden md:block">
          <div className="relative">
            <input
              type="text"
              placeholder="Search..."
              className="w-64 pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Notifications */}
        <button className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
        </button>

        {/* Settings */}
        <button className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
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
          <button className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center text-white font-medium">
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
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-gray-600 bg-opacity-75 transition-opacity"
        onClick={onClose}
      />

      {/* Sidebar */}
      <div className="fixed inset-y-0 left-0 flex w-full max-w-xs">
        <div className="relative flex-1 flex flex-col w-full bg-white">
          {/* Close button */}
          <div className="absolute top-0 right-0 -mr-12 pt-2">
            <button
              onClick={onClose}
              className="ml-1 flex items-center justify-center h-10 w-10 rounded-full focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white"
            >
              <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <AdminSidebar collapsed={false} />
        </div>
      </div>
    </div>
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
      {/* Desktop Sidebar */}
      <div className="hidden lg:block">
        <AdminSidebar
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
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 lg:p-6 max-w-[1920px] mx-auto">
            {children || <Outlet />}
          </div>
        </main>
      </div>
    </div>
  );
};

export default AdminLayout;
