import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Search, RefreshCw, AlertCircle } from 'lucide-react';
import { useAuthContext, PageHeader, Button, Select } from '@aquaculture/shared-ui';
import { useModuleIds, useModuleUsageStats } from '../hooks/useTenantData';
import { ModuleCard, AssignManagerModal, ModuleDetailsModal } from '../components/modules';
import type { DisplayModule } from '../components/modules';

/** Module route mapping -- correct dashboard routes. */
const moduleRouteMap: Record<string, string> = {
  farm: '/farm/dashboard',
  sensor: '/sensor/dashboard',
  hr: '/hr/dashboard',
  hydroponics: '/hydroponics/setup',
};

const moduleIconMap: Record<string, string> = {
  farm: '\uD83D\uDC1F',
  sensor: '\uD83D\uDCCA',
  hr: '\uD83D\uDC65',
  hydroponics: '\uD83C\uDF31',
};

const moduleFeaturesMap: Record<string, string[]> = {
  farm: ['Site Management', 'Tank Tracking', 'Batch Management', 'Feeding', 'Growth Monitoring'],
  sensor: ['Real-time Data', 'Alerts', 'Historical Trends', 'Device Management'],
  hr: ['Employee Records', 'Attendance', 'Payroll', 'Leave Management'],
  hydroponics: [
    'System Management',
    'Nutrient Solutions',
    'Growing Beds',
    'Climate Control',
    'Harvest Tracking',
  ],
};

/**
 * TenantModules Page
 *
 * Uses AuthContext modules (from login) as the source of truth for display,
 * augmented by a myModules GraphQL call to obtain real module UUIDs needed
 * for mutations such as assignModuleManager (BUG-019).
 *
 * FIX MED-08: Uses module.code as stable React key instead of module.id
 * (which changes when the UUID lookup resolves) to prevent card flicker.
 *
 * FIX MED-17: Shows error state when module ID fetch or usage stats fail
 * instead of silently swallowing the error.
 */
const TenantModules: React.FC = () => {
  const navigate = useNavigate();
  const { modules: authModules, isLoading: authLoading, refreshAuth } = useAuthContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [selectedModule, setSelectedModule] = useState<DisplayModule | null>(null);

  // BUG-019: Fetch real module UUIDs from GraphQL
  const { data: moduleIdByCode = {}, error: moduleIdError } = useModuleIds();

  // Wave 4: Fetch module usage stats (graceful fallback)
  const { data: usageStats = {}, error: usageError } = useModuleUsageStats();

  // FIX MED-17: Surface fetch errors
  const fetchError = moduleIdError || usageError;

  // Transform AuthContext modules to DisplayModule format
  const modules = useMemo<DisplayModule[]>(() => {
    if (!authModules || authModules.length === 0) return [];

    return authModules.map((m) => {
      const code = m.code || '';
      const stats = usageStats[code];
      return {
        id: moduleIdByCode[code] || code,
        code,
        name: m.name || code.charAt(0).toUpperCase() + code.slice(1),
        description: `${m.name || code} module for your tenant`,
        status: 'active' as const,
        assignedUsers: stats?.userCount ?? 0,
        manager: undefined,
        lastActivity: stats?.lastAccessAt
          ? new Date(stats.lastAccessAt).toLocaleDateString()
          : 'Recently',
        features: moduleFeaturesMap[code] || [],
        icon: moduleIconMap[code] || '\uD83D\uDCE6',
        route: m.defaultRoute || moduleRouteMap[code],
        activatedAt: new Date().toISOString(),
      };
    });
  }, [authModules, moduleIdByCode, usageStats]);

  const filteredModules = modules.filter((module) => {
    const matchesSearch = module.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || module.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getModuleRoute = (module: DisplayModule): string | undefined =>
    module.route || moduleRouteMap[module.code];

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-success-600 dark:text-success-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Modules"
        description="Manage your tenant's modules and assign managers"
        actions={
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              onClick={() => refreshAuth()}
              title="Refresh"
            >
              <RefreshCw className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            </Button>
            <span className="px-3 py-1.5 rounded-lg bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 text-sm font-medium">
              {modules.filter((m) => m.status === 'active').length} Active
            </span>
          </div>
        }
      />

      {/* FIX MED-17: Error state when fetch fails */}
      {fetchError && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-error-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-error-800 dark:text-error-200">
              Failed to load module data
            </p>
            <p className="text-sm text-error-600 dark:text-error-400">
              {fetchError instanceof Error ? fetchError.message : 'Unknown error occurred'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refreshAuth()}>
            Retry
          </Button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
            <input
              type="text"
              placeholder="Search modules..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-success-500 focus:border-transparent"
            />
          </div>
          <Select
            options={[
              { value: 'all', label: 'All Status' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'pending', label: 'Pending' },
            ]}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Modules Grid -- FIX MED-08: key={module.code} for stable keys */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredModules.map((module) => (
          <ModuleCard
            key={module.code}
            module={module}
            usageStats={usageStats[module.code]}
            moduleRoute={getModuleRoute(module)}
            onAssignManager={(m) => {
              setSelectedModule(m);
              setAssignModalOpen(true);
            }}
            onViewDetails={(m) => {
              setSelectedModule(m);
              setDetailsModalOpen(true);
            }}
            onOpenModule={(m) => {
              const route = m.route || moduleRouteMap[m.code];
              if (route && m.status === 'active') navigate(route);
            }}
          />
        ))}
      </div>

      {/* Empty State */}
      {filteredModules.length === 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 py-12 text-center">
          <Package className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto" />
          <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-gray-100">
            {modules.length === 0 ? 'No modules assigned' : 'No modules found'}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {modules.length === 0
              ? 'Contact your administrator to get modules assigned to your tenant.'
              : 'Try adjusting your search or filter criteria.'}
          </p>
        </div>
      )}

      {/* Modals */}
      <AssignManagerModal
        isOpen={assignModalOpen}
        onClose={() => setAssignModalOpen(false)}
        module={selectedModule}
      />
      <ModuleDetailsModal
        isOpen={detailsModalOpen}
        onClose={() => setDetailsModalOpen(false)}
        module={selectedModule}
      />
    </div>
  );
};

export default TenantModules;
