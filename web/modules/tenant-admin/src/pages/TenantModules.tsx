import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Search, RefreshCw, AlertCircle } from 'lucide-react';
import { useAuthContext, PageHeader, Button, Select } from '@aquaculture/shared-ui';
import { isOwnerModuleCode } from '@aquaculture/shared-contracts';
import { useModuleRefs, useModuleUsageStats, useTenantUsers } from '../hooks/useTenantData';
import { useModulePrimaryManagers } from '../hooks/useModuleAccess';
import { ModuleCard, AssignManagerModal, ModuleDetailsModal } from '../components/modules';
import type { DisplayModule } from '../components/modules';
import type { MyModuleRef } from '../lib/types';
import { SD_CARD } from '../components/ui/suderra';

/** Module route mapping -- correct dashboard routes. */
const moduleRouteMap: Record<string, string> = {
  farm: '/farm/dashboard',
  sensor: '/sensor/dashboard',
  hr: '/hr/dashboard',
  hydroponics: '/hydroponics/setup',
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
 * augmented by a myModules GraphQL call to obtain each module's record id
 * (BUG-019) and the icon name it carries (drawn by ModuleIcon; the login
 * payload has none). Assign Manager names the module by its code (PKG-06),
 * and each owner module's manager comes from the primary-manager listing.
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

  // BUG-019: Fetch real module UUIDs (and each record's icon name) from GraphQL
  const { data: moduleRefByCode = {}, error: moduleRefError } = useModuleRefs();

  // Wave 4: Fetch module usage stats (graceful fallback)
  const { data: usageStats = {}, error: usageError } = useModuleUsageStats();

  // PKG-06: each owner module's designated manager comes from the primary-manager listing — the
  // grant the token reads — and is named from the tenant's users. tenant_modules.managerId is no
  // longer read (ADR-051 §5).
  const { data: primaryManagers = [], error: managersError } = useModulePrimaryManagers();
  const { data: tenantUsers = [] } = useTenantUsers();

  // FIX MED-17: Surface fetch errors
  const fetchError = moduleRefError || usageError || managersError;

  // Transform AuthContext modules to DisplayModule format
  const modules = useMemo<DisplayModule[]>(() => {
    if (!authModules || authModules.length === 0) return [];

    return authModules.map((m) => {
      const code = m.code || '';
      const stats = usageStats[code];
      const ref: MyModuleRef | undefined = moduleRefByCode[code];
      const ownerModule = isOwnerModuleCode(code) ? code : null;
      const designated = primaryManagers.find((entry) => entry.moduleCode === ownerModule);
      const managerUser =
        designated === undefined
          ? undefined
          : tenantUsers.find((candidate) => candidate.id === designated.userId);
      return {
        id: ref ? ref.id : code,
        code,
        name: m.name || code.charAt(0).toUpperCase() + code.slice(1),
        description: `${m.name || code} module for your tenant`,
        status: 'active' as const,
        assignedUsers: stats?.userCount ?? 0,
        ownerModule,
        manager:
          managerUser === undefined
            ? undefined
            : {
                id: managerUser.id,
                name:
                  `${managerUser.firstName || ''} ${managerUser.lastName || ''}`.trim() ||
                  managerUser.email,
                email: managerUser.email,
              },
        lastActivity: stats?.lastAccessAt
          ? new Date(stats.lastAccessAt).toLocaleDateString()
          : 'Recently',
        features: moduleFeaturesMap[code] || [],
        icon: ref ? ref.icon : null,
        route: m.defaultRoute || moduleRouteMap[code],
        activatedAt: new Date().toISOString(),
      };
    });
  }, [authModules, moduleRefByCode, usageStats, primaryManagers, tenantUsers]);

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
    <div className="sd-page space-y-6">
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
      <div className={`${SD_CARD} p-4`}>
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
            <input
              type="text"
              placeholder="Search modules..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
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
        <div className={`${SD_CARD} py-12 text-center`}>
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
