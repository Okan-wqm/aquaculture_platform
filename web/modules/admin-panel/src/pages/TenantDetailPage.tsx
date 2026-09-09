/**
 * Tenant Detail Page
 * Tenant'in tum detaylarini gosteren sayfa
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card,
  Button,
  Badge,
  Input,
  Select,
  Modal,
  Alert,
  formatDate,
  formatNumber,
} from '@aquaculture/shared-ui';
import {
  tenantsApi,
  modulesApi,
  TenantTier,
  TenantStatus,
  isEditableTenantTier,
  type TenantDetail,
  type SystemModule,
  type UpdateTenantDto,
} from '../services/adminApi';
import { formatBillingAmount } from '../utils/money';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';

// ============================================================================
// Simple Tab Component
// ============================================================================

interface TabItem {
  value: string;
  label: string;
}

const SimpleTabs: React.FC<{
  tabs: TabItem[];
  activeTab: string;
  onChange: (value: string) => void;
}> = ({ tabs, activeTab, onChange }) => (
  <div className="border-b border-gray-200">
    <div className="-mb-px flex space-x-8" aria-label="Tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={activeTab === tab.value}
          onClick={() => onChange(tab.value)}
          className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm ${
            activeTab === tab.value
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  </div>
);

// ============================================================================
// Helper Functions
// ============================================================================

const formatRelativeTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(date, 'short');
};

const getStatusVariant = (status: string): 'success' | 'warning' | 'error' | 'default' => {
  const variants: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
    active: 'success',
    ACTIVE: 'success',
    pending: 'warning',
    PENDING: 'warning',
    suspended: 'error',
    SUSPENDED: 'error',
    deactivated: 'default',
    DEACTIVATED: 'default',
  };
  return variants[status] || 'default';
};

const getTierVariant = (tier: string): 'success' | 'warning' | 'info' | 'default' => {
  const variants: Record<string, 'success' | 'warning' | 'info' | 'default'> = {
    enterprise: 'success',
    ENTERPRISE: 'success',
    professional: 'warning',
    PROFESSIONAL: 'warning',
    starter: 'info',
    STARTER: 'info',
    free: 'default',
    FREE: 'default',
  };
  return variants[tier] || 'default';
};

const getAvailableActions = (tenant: TenantDetail): Set<string> => {
  if (Array.isArray(tenant.availableActions)) {
    return new Set(tenant.availableActions);
  }

  if (tenant.status === TenantStatus.ACTIVE) return new Set(['suspend']);
  if (tenant.status === TenantStatus.SUSPENDED) return new Set(['activate']);
  return new Set();
};

// ============================================================================
// Progress Bar Component
// ============================================================================

const ProgressBar: React.FC<{ value: number; max: number; label?: string }> = ({
  value,
  max,
  label,
}) => {
  const percentage = max === -1 ? 0 : max === 0 ? 100 : Math.min((value / max) * 100, 100);
  const colorClass =
    percentage > 90 ? 'bg-red-500' : percentage > 70 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div className="space-y-1">
      {label && (
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">{label}</span>
          <span className="text-gray-900 font-medium">
            {value} / {max === -1 ? 'Unlimited' : max}
          </span>
        </div>
      )}
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className={`${colorClass} h-2 rounded-full transition-all`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};

// ============================================================================
// Tenant Detail Page
// ============================================================================

const TenantDetailPage: React.FC = () => {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();

  // State
  const [activeTab, setActiveTab] = useState('overview');

  // Modals
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isNoteModalOpen, setIsNoteModalOpen] = useState(false);
  const [isSuspendModalOpen, setIsSuspendModalOpen] = useState(false);

  // Forms
  const [editForm, setEditForm] = useState<UpdateTenantDto>({});
  const [newNote, setNewNote] = useState({ content: '', category: 'general' });
  const [suspendReason, setSuspendReason] = useState('');

  // ==========================================================================
  // Reads (ADMIN-HIGH-121)
  // ==========================================================================

  // The page used to guard this with a `detailRequestSeq` ref compared inside
  // every `then` and `catch` — a hand-rolled race guard for the problem the
  // `signal` solves.
  const detailQuery = useAdminQuery<TenantDetail>(
    adminKeys.tenants.detail(tenantId ?? 'none'),
    ({ signal }) => tenantsApi.getDetail(tenantId ?? '', signal),
    { enabled: Boolean(tenantId) },
  );

  const moduleFilters = { isActive: true, limit: 50 };

  const modulesQuery = useAdminQuery(adminKeys.modules.list(moduleFilters), ({ signal }) =>
    modulesApi.list(moduleFilters, signal),
  );

  const tenant = detailQuery.data;
  const modules: readonly SystemModule[] = modulesQuery.data?.data ?? [];

  const reload = (): void => {
    void detailQuery.refetch();
    void modulesQuery.refetch();
  };

  // Seed the edit form from the row the server returned, once it arrives.
  useEffect(() => {
    if (!tenant) return;
    setEditForm({
      name: tenant.name,
      description: tenant.description,
      domain: tenant.domain,
      // A tenant on a negotiated `custom` plan has no editable tier: the form
      // leaves it unset rather than offering a value the API would reject.
      tier: isEditableTenantTier(tenant.tier) ? tenant.tier : undefined,
      primaryContact: tenant.primaryContact,
      billingContact: tenant.billingContact,
      billingEmail: tenant.billingEmail,
      country: tenant.country,
      region: tenant.region,
    });
  }, [tenant]);

  // ==========================================================================
  // Writes (ADMIN-HIGH-121)
  // ==========================================================================

  // `tenants.all()`, not just this tenant's detail. Suspending from here used
  // to refetch only this page, so TenantManagementPage's list and its four
  // platform counts kept the pre-change state until something else refetched
  // them. Invalidating the domain makes one write correct on every page that
  // reads it.
  const tenantWriteKeys = [adminKeys.tenants.all()];

  const updateTenant = useAdminMutation<unknown, UpdateTenantDto>(
    (input) => tenantsApi.update(tenantId ?? '', input),
    { invalidateKeys: tenantWriteKeys },
  );

  const suspendTenant = useAdminMutation<unknown, { reason: string }>(
    ({ reason }) => tenantsApi.suspend(tenantId ?? '', reason),
    { invalidateKeys: tenantWriteKeys },
  );

  const activateTenant = useAdminMutation<unknown, void>(
    () => tenantsApi.activate(tenantId ?? ''),
    { invalidateKeys: tenantWriteKeys },
  );

  const createNote = useAdminMutation<unknown, { content: string; category: string }>(
    (note) => tenantsApi.createNote(tenantId ?? '', note),
    { invalidateKeys: tenantWriteKeys },
  );

  const deleteNote = useAdminMutation<unknown, { noteId: string }>(
    ({ noteId }) => tenantsApi.deleteNote(tenantId ?? '', noteId),
    { invalidateKeys: tenantWriteKeys },
  );

  const assignModule = useAdminMutation<unknown, { moduleId: string }>(
    ({ moduleId }) => modulesApi.assignToTenant(tenantId ?? '', moduleId),
    { invalidateKeys: tenantWriteKeys },
  );

  const removeModule = useAdminMutation<unknown, { moduleId: string }>(
    ({ moduleId }) => modulesApi.removeFromTenant(tenantId ?? '', moduleId),
    { invalidateKeys: tenantWriteKeys },
  );

  const saving = updateTenant.isPending || suspendTenant.isPending || createNote.isPending;

  const queryErrors = [
    detailQuery.error,
    modulesQuery.error,
    updateTenant.error,
    suspendTenant.error,
    activateTenant.error,
    createNote.error,
    deleteNote.error,
    assignModule.error,
    removeModule.error,
  ];

  const loading = detailQuery.isPending;

  // Handlers
  const handleUpdate = (): void => {
    updateTenant.mutate(editForm, { onSuccess: () => setIsEditModalOpen(false) });
  };

  const handleSuspend = (): void => {
    suspendTenant.mutate(
      { reason: suspendReason },
      {
        onSuccess: () => {
          setIsSuspendModalOpen(false);
          setSuspendReason('');
        },
      },
    );
  };

  const handleActivate = (): void => {
    activateTenant.mutate();
  };

  const handleAddNote = (): void => {
    if (!newNote.content.trim()) return;
    createNote.mutate(newNote, {
      onSuccess: () => {
        setIsNoteModalOpen(false);
        setNewNote({ content: '', category: 'general' });
      },
    });
  };

  const handleDeleteNote = (noteId: string): void => {
    deleteNote.mutate({ noteId });
  };

  const handleAssignModule = (moduleId: string): void => {
    assignModule.mutate({ moduleId });
  };

  const handleRemoveModule = (moduleId: string): void => {
    removeModule.mutate({ moduleId });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (!tenant) {
    return (
      <Card className="p-6 text-center">
        <QueryFailureNotice errors={queryErrors} hasContent={false} onRetry={reload} />
        {queryErrors.every((queryError) => !queryError) && (
          <p className="text-red-600">Tenant not found</p>
        )}
        <Button variant="outline" onClick={() => navigate('/admin/tenants')} className="mt-4">
          Go Back
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <QueryFailureNotice errors={queryErrors} hasContent onRetry={reload} />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start space-x-4">
          <Button variant="ghost" onClick={() => navigate('/admin/tenants')}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <div>
            <div className="flex items-center space-x-3">
              <h1 className="text-2xl font-bold text-gray-900">{tenant.name}</h1>
              <Badge variant={getStatusVariant(tenant.status)}>{tenant.status}</Badge>
              <Badge variant={getTierVariant(tenant.tier)}>{tenant.tier}</Badge>
              {tenant.isTrialActive && (
                <Badge variant="warning">Trial Active</Badge>
              )}
            </div>
            <p className="text-gray-500 mt-1">
              {tenant.slug} {tenant.domain && `• ${tenant.domain}`}
            </p>
          </div>
        </div>
        <div className="mt-4 sm:mt-0 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setIsEditModalOpen(true)}>
            Edit
          </Button>
          {getAvailableActions(tenant).has('suspend') && (
            <Button variant="danger" onClick={() => setIsSuspendModalOpen(true)}>
              Suspend
            </Button>
          )}
          {getAvailableActions(tenant).has('activate') && (
            <Button variant="outline" onClick={handleActivate}>
              Activate
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <SimpleTabs
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'users', label: 'Users' },
          { value: 'modules', label: 'Modules' },
          { value: 'usage', label: 'Usage' },
          { value: 'activity', label: 'Activity' },
          { value: 'billing', label: 'Billing' },
          { value: 'notes', label: 'Notes' },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Basic Info */}
          <Card className="p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold mb-4">General Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-gray-500">Company Name</label>
                <p className="font-medium">{tenant.name}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Slug</label>
                <p className="font-mono text-sm">{tenant.slug}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Domain</label>
                <p className="font-medium">{tenant.domain || '-'}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Country / Region</label>
                <p className="font-medium">
                  {tenant.country || '-'} {tenant.region && `/ ${tenant.region}`}
                </p>
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500">Description</label>
                <p className="text-gray-600">{tenant.description || '-'}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Created</label>
                <p className="font-medium">{formatDate(new Date(tenant.createdAt), 'long')}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Last Activity</label>
                <p className="font-medium">
                  {/*
                    Read off the newest tenant activity, not off a
                    `lastActivityAt` field: auth.tenants never had a column
                    backing that name, so it was always undefined and this
                    always rendered '-' (DB-ADMIN-HIGH-003, ADMIN-MEDIUM-111).
                    TenantActivityService orders createdAt DESC, so [0] is the
                    most recent.
                  */}
                  {tenant.recentActivities?.[0]
                    ? formatRelativeTime(tenant.recentActivities[0].createdAt)
                    : '-'}
                </p>
              </div>
            </div>

            {/* Contacts */}
            <h4 className="text-md font-semibold mt-6 mb-3">Contact Information</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-gray-50 rounded-lg">
                <label className="text-xs text-gray-500">Primary Contact</label>
                {tenant.primaryContact ? (
                  <>
                    <p className="font-medium">{tenant.primaryContact.name}</p>
                    <p className="text-sm text-gray-600">{tenant.primaryContact.email}</p>
                    <p className="text-sm text-gray-500">{tenant.primaryContact.role}</p>
                  </>
                ) : (
                  <p className="text-gray-500">Not specified</p>
                )}
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <label className="text-xs text-gray-500">Billing Contact</label>
                {tenant.billingContact ? (
                  <>
                    <p className="font-medium">{tenant.billingContact.name}</p>
                    <p className="text-sm text-gray-600">{tenant.billingContact.email}</p>
                  </>
                ) : (
                  <p className="text-gray-500">Not specified</p>
                )}
              </div>
            </div>
          </Card>

          {/* Quick Stats */}
          <div className="space-y-4">
            {/* `farmCount` and `sensorCount` are REQUIRED by TenantDetailDto, so
                the `?? 0` they carried was dead defensive code the compiler
                already ruled out. `userStats` and `modules` are OPTIONAL, so
                theirs was the opposite problem: a field the server omitted
                rendered as a measured zero — "0 users" for a tenant whose user
                stats simply did not come back. */}
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Users</h4>
              <p className="text-3xl font-bold text-gray-900">
                {tenant.userStats ? tenant.userStats.total.toLocaleString() : '—'}
              </p>
              <p className="text-sm text-green-600">
                {tenant.userStats ? `${tenant.userStats.active.toLocaleString()} active` : ' '}
              </p>
            </Card>
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Farms</h4>
              <p className="text-3xl font-bold text-gray-900">
                {tenant.farmCount.toLocaleString()}
              </p>
            </Card>
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Sensors</h4>
              <p className="text-3xl font-bold text-gray-900">
                {tenant.sensorCount.toLocaleString()}
              </p>
            </Card>
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Active Modules</h4>
              <p className="text-3xl font-bold text-gray-900">
                {tenant.modules
                  ? tenant.modules.filter((m) => m.isActive).length.toLocaleString()
                  : '—'}
              </p>
            </Card>
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Storage Limit</h4>
              <p className="text-3xl font-bold text-gray-900">
                {tenant.maxStorage === undefined || tenant.maxStorage === -1
                  ? 'Unlimited'
                  : `${tenant.maxStorage} GB`}
              </p>
            </Card>
            {tenant.isTrialActive && (
              <Card className="p-4 border-l-4 border-l-yellow-400">
                <h4 className="text-sm font-medium text-gray-500 mb-2">Trial Status</h4>
                <Badge variant="warning">Trial Active</Badge>
                {tenant.trialEndsAt && (
                  <p className="text-sm text-gray-500 mt-1">
                    Ends: {formatDate(new Date(tenant.trialEndsAt), 'short')}
                  </p>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && tenant.userStats && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">User Statistics</h3>
            <div className="space-y-4">
              <div className="flex justify-between">
                <span>Total Users</span>
                <span className="font-bold">{tenant.userStats.total}</span>
              </div>
              <div className="flex justify-between">
                <span>Active</span>
                <span className="font-bold text-green-600">{tenant.userStats.active}</span>
              </div>
              <div className="flex justify-between">
                <span>Inactive</span>
                <span className="font-bold text-gray-500">{tenant.userStats.inactive}</span>
              </div>
              <div className="flex justify-between">
                <span>Active in Last 7 Days</span>
                <span className="font-bold">{tenant.userStats.recentlyActive}</span>
              </div>
              <div className="flex justify-between">
                <span>New in Last 30 Days</span>
                <span className="font-bold text-blue-600">
                  {tenant.userStats.newUsersLast30Days}
                </span>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Distribution by Role</h3>
            <div className="space-y-3">
              {Object.entries(tenant.userStats.byRole).map(([role, count]) => (
                <div key={role} className="flex justify-between items-center">
                  <span className="capitalize">{role}</span>
                  <Badge variant="default">{count}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Modules Tab */}
      {activeTab === 'modules' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Assigned Modules</h3>
            {tenant.modules && tenant.modules.length > 0 ? (
              <div className="space-y-3">
                {tenant.modules.map((mod) => (
                  <div
                    key={mod.moduleId}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium">{mod.moduleName}</p>
                      <p className="text-xs text-gray-500">{mod.moduleCode}</p>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Badge variant={mod.isActive ? 'success' : 'default'}>
                        {mod.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleRemoveModule(mod.moduleId)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-500">No modules assigned</p>
            )}
          </Card>
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Available Modules</h3>
            <div className="space-y-3">
              {modules
                .filter((m) => !tenant.modules?.find((tm) => tm.moduleId === m.id))
                .map((mod) => (
                  <div
                    key={mod.id}
                    className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50"
                  >
                    <div>
                      <p className="font-medium">{mod.name}</p>
                      <p className="text-xs text-gray-500">{mod.code}</p>
                    </div>
                    <Button size="sm" onClick={() => handleAssignModule(mod.id)}>
                      Assign
                    </Button>
                  </div>
                ))}
            </div>
          </Card>
        </div>
      )}

      {/* Usage Tab */}
      {activeTab === 'usage' && tenant.resourceUsage && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Resource Usage</h3>
            <div className="space-y-4">
              <ProgressBar
                label="Users"
                value={tenant.resourceUsage.users.count}
                max={tenant.resourceUsage.users.limit}
              />
              <ProgressBar
                label="Farms"
                value={tenant.resourceUsage.farms.count}
                max={tenant.resourceUsage.farms.limit}
              />
              <ProgressBar
                label="Sensors"
                value={tenant.resourceUsage.sensors.count}
                max={tenant.resourceUsage.sensors.limit}
              />
              <ProgressBar
                label="Storage (GB)"
                value={tenant.resourceUsage.storage.usedGb}
                max={tenant.resourceUsage.storage.limitGb}
              />
            </div>
          </Card>
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">API Usage</h3>
            <div className="space-y-4">
              <div className="flex justify-between">
                <span>Last 24 Hours</span>
                <span className="font-bold">
                  {formatNumber(tenant.resourceUsage.apiCalls.last24h)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Last 7 Days</span>
                <span className="font-bold">
                  {formatNumber(tenant.resourceUsage.apiCalls.last7d)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Rate Limit</span>
                <span className="font-bold">
                  {tenant.resourceUsage.apiCalls.limit}/min
                </span>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Activity Tab */}
      {activeTab === 'activity' && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">Activity Timeline</h3>
          {tenant.recentActivities && tenant.recentActivities.length > 0 ? (
            <div className="space-y-4">
              {tenant.recentActivities.map((activity) => (
                <div key={activity.id} className="flex space-x-4 p-3 border-l-4 border-blue-500">
                  <div className="flex-1">
                    <p className="font-medium">{activity.title}</p>
                    {activity.description && (
                      <p className="text-sm text-gray-600">{activity.description}</p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">
                      {activity.performedByEmail || 'System'} •{' '}
                      {formatRelativeTime(activity.createdAt)}
                    </p>
                  </div>
                  <Badge variant="default">{activity.activityType}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No activity records</p>
          )}
        </Card>
      )}

      {/* Billing Tab */}
      {activeTab === 'billing' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Billing Information</h3>
            {tenant.billing ? (
              <div className="space-y-4">
                <div className="flex justify-between">
                  <span>Plan</span>
                  <Badge variant={getTierVariant(tenant.billing.currentPlan)}>
                    {tenant.billing.currentPlan}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span>Last Invoice</span>
                  <span className="font-bold">
                    {formatBillingAmount(
                      tenant.billing.lastInvoiceAmount,
                      tenant.billing.currency,
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Billing Cycle</span>
                  <span>{tenant.billing.billingCycle}</span>
                </div>
                <div className="flex justify-between">
                  <span>Subscription Status</span>
                  <Badge
                    variant={
                      tenant.billing.subscriptionStatus === 'active' ? 'success' : 'warning'
                    }
                  >
                    {tenant.billing.subscriptionStatus}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span>Next Invoice</span>
                  <span>
                    {tenant.billing.nextBillingDate
                      ? formatDate(new Date(tenant.billing.nextBillingDate), 'short')
                      : '-'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-gray-500">No billing information</p>
            )}
          </Card>
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Last Payment</h3>
            {tenant.billing?.lastPaymentDate ? (
              <div className="space-y-4">
                <div className="flex justify-between">
                  <span>Date</span>
                  <span>{formatDate(new Date(tenant.billing.lastPaymentDate), 'long')}</span>
                </div>
                <div className="flex justify-between">
                  <span>Amount</span>
                  <span className="font-bold text-green-600">
                    {formatBillingAmount(
                      tenant.billing.lastPaymentAmount,
                      tenant.billing.currency,
                    )}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-gray-500">No payment records</p>
            )}
          </Card>
        </div>
      )}

      {/* Notes Tab */}
      {activeTab === 'notes' && (
        <Card className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Notes</h3>
            <Button onClick={() => setIsNoteModalOpen(true)}>Add Note</Button>
          </div>
          {tenant.notes && tenant.notes.length > 0 ? (
            <div className="space-y-4">
              {tenant.notes.map((note) => (
                <div
                  key={note.id}
                  className={`p-4 rounded-lg border ${
                    note.isPinned ? 'border-yellow-400 bg-yellow-50' : 'border-gray-200'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <p className="text-gray-800 whitespace-pre-wrap">{note.content}</p>
                      <p className="text-xs text-gray-500 mt-2">
                        {note.createdByEmail || note.createdBy} •{' '}
                        {formatRelativeTime(note.createdAt)} •{' '}
                        <Badge variant="default">{note.category}</Badge>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteNote(note.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No notes</p>
          )}
        </Card>
      )}

      {/* Edit Modal */}
      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="Edit Tenant"
        size="lg"
      >
        <div className="space-y-4">
          <Input
            label="Company Name"
            value={editForm.name || ''}
            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
          />
          <Input
            label="Domain"
            value={editForm.domain || ''}
            onChange={(e) => setEditForm({ ...editForm, domain: e.target.value })}
          />
          <Input
            label="Description"
            value={editForm.description || ''}
            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Country"
              value={editForm.country || ''}
              onChange={(e) => setEditForm({ ...editForm, country: e.target.value })}
            />
            <Input
              label="Region"
              value={editForm.region || ''}
              onChange={(e) => setEditForm({ ...editForm, region: e.target.value })}
            />
          </div>
          <Select
            label="Tier"
            value={editForm.tier || ''}
            onChange={(e) => {
              const next = e.target.value;
              if (isEditableTenantTier(next)) setEditForm({ ...editForm, tier: next });
            }}
            options={[
              { value: TenantTier.FREE, label: 'Free' },
              { value: TenantTier.STARTER, label: 'Starter' },
              { value: TenantTier.PROFESSIONAL, label: 'Professional' },
              { value: TenantTier.ENTERPRISE, label: 'Enterprise' },
            ]}
          />
          <Input
            label="Billing Email"
            type="email"
            value={editForm.billingEmail || ''}
            onChange={(e) => setEditForm({ ...editForm, billingEmail: e.target.value })}
          />
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsEditModalOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleUpdate} loading={saving}>
            Save
          </Button>
        </div>
      </Modal>

      {/* Note Modal */}
      <Modal
        isOpen={isNoteModalOpen}
        onClose={() => setIsNoteModalOpen(false)}
        title="Add Note"
      >
        <div className="space-y-4">
          <Select
            label="Category"
            value={newNote.category}
            onChange={(e) => setNewNote({ ...newNote, category: e.target.value })}
            options={[
              { value: 'general', label: 'General' },
              { value: 'support', label: 'Support' },
              { value: 'billing', label: 'Billing' },
              { value: 'technical', label: 'Technical' },
            ]}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
            <textarea
              className="w-full border rounded-lg p-3 min-h-[120px]"
              value={newNote.content}
              onChange={(e) => setNewNote({ ...newNote, content: e.target.value })}
              placeholder="Note content..."
            />
          </div>
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsNoteModalOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleAddNote} loading={saving} disabled={!newNote.content.trim()}>
            Save
          </Button>
        </div>
      </Modal>

      {/* Suspend Modal */}
      <Modal
        isOpen={isSuspendModalOpen}
        onClose={() => setIsSuspendModalOpen(false)}
        title="Suspend Tenant"
      >
        <Alert type="warning" className="mb-4">
          This action will block access for all users of this tenant.
        </Alert>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
          <textarea
            className="w-full border rounded-lg p-3 min-h-[100px]"
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
            placeholder="Enter reason for suspension..."
          />
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsSuspendModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleSuspend}
            loading={saving}
            disabled={!suspendReason.trim()}
          >
            Suspend
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default TenantDetailPage;
