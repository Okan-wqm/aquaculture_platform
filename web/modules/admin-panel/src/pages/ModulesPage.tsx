/**
 * Modules Management Page
 * View and manage system modules across all tenants
 */

import React, { useCallback, useMemo, useState } from 'react';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components';
import { modulesApi } from '../services/adminApi';
// The page-local shadows of these two shapes are gone: both were
// byte-identical copies of the canonical declarations, which is how a copy
// stops matching the endpoint it describes without anything saying so.
import type { ModuleStats, PaginatedResult, SystemModule } from '../services/types';
import { PageHeader, ToggleButton } from '@aquaculture/shared-ui';
import { Box, CircleX, Plus, Search as SearchIcon, X } from 'lucide-react';

/**
 * What a stat card shows when `/modules/stats` did not answer.
 *
 * These four used to fall back to a computation over `modules` — the CURRENT
 * PAGE of results. "Total Modules" would then quietly show a page count, and
 * "Total Assignments" the sum over one page, both looking exactly like the
 * figures they were standing in for. A number that is wrong is worse than a
 * number that is absent, and the failure itself is now reported by
 * `QueryFailureNotice` rather than papered over (ADMIN-HIGH-121).
 */
const UNAVAILABLE = '—';

/** Stable empty — `?? []` hands a new array on every render. */
const EMPTY_MODULES: readonly SystemModule[] = [];

const ModulesPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isActiveFilter, setIsActiveFilter] = useState<boolean | undefined>(undefined);
  const [isCoreFilter, setIsCoreFilter] = useState<boolean | undefined>(undefined);
  const listFilter = useMemo(
    () => ({
      search: searchTerm || undefined,
      isActive: isActiveFilter,
      isCore: isCoreFilter,
    }),
    [searchTerm, isActiveFilter, isCoreFilter],
  );

  const modulesQuery = useAdminQuery<PaginatedResult<SystemModule>>(
    adminKeys.modules.list(listFilter),
    ({ signal }) => modulesApi.list(listFilter, signal),
    { placeholderData: (previous) => previous, staleTime: 30_000 },
  );

  const statsQuery = useAdminQuery<ModuleStats>(
    [...adminKeys.modules.all(), 'stats'],
    ({ signal }) => modulesApi.getStats(signal),
    { staleTime: 60_000 },
  );

  const modules = modulesQuery.data?.data ?? EMPTY_MODULES;
  const stats = statsQuery.data;
  const loading = modulesQuery.isPending;
  const queryErrors = [modulesQuery.error, statsQuery.error];
  const refresh = (): void => {
    void modulesQuery.refetch();
    void statsQuery.refetch();
  };

  // Debounced search
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  }, []);

  // Trigger search on Enter or after typing
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        refresh();
      }
    },
    [refresh],
  );

  /**
   * Activate / deactivate, through the write primitive (ADMIN-HIGH-121).
   *
   * The old handler called `refresh()`, which re-fetched the LIST only — and
   * the stats lived in a separate `useAsyncData` cache entry with its own TTL.
   * So toggling a module left the "Active Modules" card showing the count from
   * before the toggle, for up to a minute, on the same screen as the switch
   * the operator had just flipped. `invalidateKeys` names BOTH slices, which
   * is the whole reason a write declares what it affected.
   */
  const toggleModule = useAdminMutation<SystemModule, SystemModule>(
    (module) =>
      module.isActive ? modulesApi.deactivate(module.id) : modulesApi.activate(module.id),
    { invalidateKeys: [adminKeys.modules.all()] },
  );

  const togglingModuleId = toggleModule.isPending ? (toggleModule.variables?.id ?? null) : null;
  const toggleError = toggleModule.error
    ? `Failed to change module status: ${toggleModule.error.message}`
    : null;

  const handleToggleModule = useCallback(
    async (module: SystemModule): Promise<void> => {
      if (toggleModule.isPending) return; // one toggle at a time
      try {
        await toggleModule.mutateAsync(module);
      } catch {
        // `toggleModule.error` carries it and the banner above renders it; the
        // `console.error` that used to sit here duplicated a message the user
        // was already shown.
      }
    },
    [toggleModule],
  );

  // Get category badge color based on module code
  const getCategoryColor = (code: string) => {
    if (code.includes('FARM') || code.includes('CORE'))
      return 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300';
    if (code.includes('SENSOR') || code.includes('IOT'))
      return 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300';
    if (code.includes('ALERT') || code.includes('AUTO'))
      return 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300';
    if (code.includes('ANALYTICS') || code.includes('REPORT'))
      return 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300';
    if (code.includes('HR') || code.includes('EMPLOYEE'))
      return 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300';
    return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';
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
      <PageHeader
        title="System Modules"
        description="Manage platform modules and their availability to tenants"
        actions={
          <button className="inline-flex items-center px-4 py-2 bg-info-600 text-white text-sm font-medium rounded-lg hover:bg-info-700 transition-colors">
            <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
            Add Module
          </button>
        }
      />

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <input
                type="text"
                placeholder="Search modules..."
                value={searchTerm}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-info-500"
              />
              <SearchIcon
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 dark:text-gray-400"
                aria-hidden="true"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <ToggleButton
              onClick={() => {
                setIsActiveFilter(undefined);
                setIsCoreFilter(undefined);
                refresh();
              }}
              pressed={isActiveFilter === undefined && isCoreFilter === undefined}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              pressedClassName="bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300"
              idleClassName="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              All
            </ToggleButton>
            <ToggleButton
              onClick={() => {
                setIsActiveFilter(true);
                setIsCoreFilter(undefined);
                refresh();
              }}
              pressed={isActiveFilter === true}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              pressedClassName="bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300"
              idleClassName="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              Active
            </ToggleButton>
            <ToggleButton
              onClick={() => {
                setIsCoreFilter(true);
                setIsActiveFilter(undefined);
                refresh();
              }}
              pressed={isCoreFilter === true}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              pressedClassName="bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300"
              idleClassName="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              Core
            </ToggleButton>
            <ToggleButton
              onClick={() => {
                setIsActiveFilter(false);
                setIsCoreFilter(undefined);
                refresh();
              }}
              pressed={isActiveFilter === false}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              pressedClassName="bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300"
              idleClassName="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              Inactive
            </ToggleButton>
          </div>
        </div>
      </div>

      {/* Toggle error */}
      {toggleError && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-4 flex items-start gap-3">
          <CircleX className="w-5 h-5 text-error-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-sm text-error-700 dark:text-error-300 flex-1">{toggleError}</p>
          <button
            onClick={() => toggleModule.reset()}
            className="text-error-400 hover:text-error-600 dark:hover:text-error-300"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {stats?.totalModules ?? UNAVAILABLE}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Modules</div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-2xl font-bold text-success-600 dark:text-success-400">
            {stats?.activeModules ?? UNAVAILABLE}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Active Modules</div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-2xl font-bold text-accent-600 dark:text-accent-400">
            {stats?.coreModules ?? UNAVAILABLE}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Core Modules</div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-2xl font-bold text-info-600 dark:text-info-400">
            {stats?.totalAssignments ?? UNAVAILABLE}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Assignments</div>
        </div>
      </div>

      {/* One component owns banner-vs-full-page for every admin page
          (ADMIN-HIGH-121). The stats query failing no longer silently turns
          the four cards into page-scoped computations. */}
      <QueryFailureNotice errors={queryErrors} hasContent={modules.length > 0} onRetry={refresh} />

      {/* Modules Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 animate-pulse"
            >
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-4" />
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-2/3 mb-2" />
              <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-full mb-4" />
              <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : modules.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 text-center">
          <Box
            className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto mb-4"
            aria-hidden="true"
          />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            No modules found
          </h3>
          <p className="text-gray-500 dark:text-gray-400">
            {searchTerm
              ? 'Try adjusting your search criteria.'
              : 'No modules have been created yet.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {modules.map((module) => (
            <div
              key={module.id}
              className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-1 text-xs font-medium rounded ${getCategoryColor(module.code)}`}
                  >
                    {getCategoryName(module.code)}
                  </span>
                  {module.price > 0 && (
                    <span className="px-2 py-1 text-xs font-medium bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 rounded">
                      Premium
                    </span>
                  )}
                  {module.isCore && (
                    <span className="px-2 py-1 text-xs font-medium bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 rounded">
                      Core
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleToggleModule(module)}
                  disabled={togglingModuleId === module.id}
                  role="switch"
                  aria-checked={module.isActive}
                  aria-label={module.name}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    module.isActive ? 'bg-info-600' : 'bg-gray-200 dark:bg-gray-700'
                  } ${togglingModuleId === module.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${
                      module.isActive ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
                {module.name}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{module.code}</p>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {module.description || 'No description available'}
              </p>

              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">
                  {module.price > 0 ? `$${module.price}/mo` : 'Free'}
                </span>
                <span className="text-info-600 dark:text-info-400 font-medium">
                  {module.tenantsCount} tenants
                </span>
              </div>

              {module.defaultRoute && (
                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Route:{' '}
                    <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
                      {module.defaultRoute}
                    </code>
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
