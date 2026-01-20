/**
 * Modules Management Page
 * View and manage system modules across all tenants
 */

import React, { useState, useCallback } from 'react';
import { useAsyncData } from '../hooks/useAsyncData';
import { modulesApi } from '../services/adminApi';

interface Module {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultRoute: string;
  icon: string | null;
  isCore: boolean;
  isActive: boolean;
  price: number;
  tenantsCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ModuleStats {
  totalModules: number;
  activeModules: number;
  coreModules: number;
  totalAssignments: number;
  moduleUsage: { moduleId: string; moduleName: string; tenantsCount: number }[];
}

const ModulesPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isActiveFilter, setIsActiveFilter] = useState<boolean | undefined>(undefined);
  const [isCoreFilter, setIsCoreFilter] = useState<boolean | undefined>(undefined);
  const [togglingModuleId, setTogglingModuleId] = useState<string | null>(null);

  // Fetch modules from API
  const {
    data: modulesData,
    loading,
    error,
    refresh,
    canRetry,
    retry,
  } = useAsyncData<{ data: Module[]; total: number; page: number; limit: number; totalPages: number }>(
    () => modulesApi.list({
      search: searchTerm || undefined,
      isActive: isActiveFilter,
      isCore: isCoreFilter,
    }),
    { immediate: true, cacheKey: `modules-${searchTerm}-${isActiveFilter}-${isCoreFilter}` }
  );

  // Fetch module stats
  const { data: stats } = useAsyncData<ModuleStats>(
    () => modulesApi.getStats(),
    { immediate: true, cacheKey: 'module-stats' }
  );

  const modules = modulesData?.data || [];

  // Debounced search
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  }, []);

  // Trigger search on Enter or after typing
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      refresh();
    }
  }, [refresh]);

  // Toggle module active status
  const handleToggleModule = useCallback(async (module: Module) => {
    if (togglingModuleId) return; // Prevent multiple toggles

    setTogglingModuleId(module.id);
    try {
      if (module.isActive) {
        await modulesApi.deactivate(module.id);
      } else {
        await modulesApi.activate(module.id);
      }
      // Refresh the list after toggle
      refresh();
    } catch (err) {
      console.error('Failed to toggle module status:', err);
      alert(`Modül durumu değiştirilemedi: ${err instanceof Error ? err.message : 'Bilinmeyen hata'}`);
    } finally {
      setTogglingModuleId(null);
    }
  }, [togglingModuleId, refresh]);

  // Get category badge color based on module code
  const getCategoryColor = (code: string) => {
    if (code.includes('FARM') || code.includes('CORE')) return 'bg-blue-100 text-blue-700';
    if (code.includes('SENSOR') || code.includes('IOT')) return 'bg-green-100 text-green-700';
    if (code.includes('ALERT') || code.includes('AUTO')) return 'bg-purple-100 text-purple-700';
    if (code.includes('ANALYTICS') || code.includes('REPORT')) return 'bg-orange-100 text-orange-700';
    if (code.includes('HR') || code.includes('EMPLOYEE')) return 'bg-pink-100 text-pink-700';
    return 'bg-gray-100 text-gray-700';
  };

  // Get category name from code
  const getCategoryName = (code: string) => {
    if (code.includes('FARM')) return 'Farm';
    if (code.includes('SENSOR') || code.includes('IOT')) return 'IoT';
    if (code.includes('ALERT')) return 'Automation';
    if (code.includes('ANALYTICS') || code.includes('REPORT')) return 'Analytics';
    if (code.includes('HR') || code.includes('EMPLOYEE')) return 'HR';
    return 'System';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Modules</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage platform modules and their availability to tenants
          </p>
        </div>
        <button className="inline-flex items-center px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Module
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <input
                type="text"
                placeholder="Search modules..."
                value={searchTerm}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setIsActiveFilter(undefined);
                setIsCoreFilter(undefined);
                refresh();
              }}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                isActiveFilter === undefined && isCoreFilter === undefined
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              All
            </button>
            <button
              onClick={() => {
                setIsActiveFilter(true);
                setIsCoreFilter(undefined);
                refresh();
              }}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                isActiveFilter === true
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Active
            </button>
            <button
              onClick={() => {
                setIsCoreFilter(true);
                setIsActiveFilter(undefined);
                refresh();
              }}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                isCoreFilter === true
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Core
            </button>
            <button
              onClick={() => {
                setIsActiveFilter(false);
                setIsCoreFilter(undefined);
                refresh();
              }}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                isActiveFilter === false
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Inactive
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{stats?.totalModules ?? modules.length}</div>
          <div className="text-sm text-gray-500">Total Modules</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-2xl font-bold text-green-600">
            {stats?.activeModules ?? modules.filter((m) => m.isActive).length}
          </div>
          <div className="text-sm text-gray-500">Active Modules</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-2xl font-bold text-purple-600">
            {stats?.coreModules ?? modules.filter((m) => m.isCore).length}
          </div>
          <div className="text-sm text-gray-500">Core Modules</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <div className="text-2xl font-bold text-blue-600">
            {stats?.totalAssignments ?? modules.reduce((sum, m) => sum + m.tenantsCount, 0)}
          </div>
          <div className="text-sm text-gray-500">Total Assignments</div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-red-500 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-red-700">{error}</span>
            </div>
            {canRetry && (
              <button
                onClick={retry}
                className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {/* Modules Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-1/3 mb-4" />
              <div className="h-6 bg-gray-200 rounded w-2/3 mb-2" />
              <div className="h-3 bg-gray-200 rounded w-full mb-4" />
              <div className="h-3 bg-gray-200 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : modules.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <svg className="w-12 h-12 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No modules found</h3>
          <p className="text-gray-500">
            {searchTerm ? 'Try adjusting your search criteria.' : 'No modules have been created yet.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {modules.map((module) => (
            <div
              key={module.id}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 text-xs font-medium rounded ${getCategoryColor(module.code)}`}>
                    {getCategoryName(module.code)}
                  </span>
                  {module.price > 0 && (
                    <span className="px-2 py-1 text-xs font-medium bg-yellow-100 text-yellow-700 rounded">
                      Premium
                    </span>
                  )}
                  {module.isCore && (
                    <span className="px-2 py-1 text-xs font-medium bg-indigo-100 text-indigo-700 rounded">
                      Core
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleToggleModule(module)}
                  disabled={togglingModuleId === module.id}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    module.isActive ? 'bg-blue-600' : 'bg-gray-200'
                  } ${togglingModuleId === module.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      module.isActive ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <h3 className="text-lg font-semibold text-gray-900 mb-1">{module.name}</h3>
              <p className="text-xs text-gray-400 mb-2">{module.code}</p>
              <p className="text-sm text-gray-600 mb-4">{module.description || 'No description available'}</p>

              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">
                  {module.price > 0 ? `$${module.price}/mo` : 'Free'}
                </span>
                <span className="text-blue-600 font-medium">{module.tenantsCount} tenants</span>
              </div>

              {module.defaultRoute && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <p className="text-xs text-gray-500">
                    Route: <code className="bg-gray-100 px-1 rounded">{module.defaultRoute}</code>
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModulesPage;
