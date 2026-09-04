/**
 * Tenant Detail Page
 * Tenant'in tum detaylarini gosteren sayfa
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  type TenantDetail,
  type SystemModule,
  type UpdateTenantDto,
} from '../services/adminApi';

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
  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [modules, setModules] = useState<readonly SystemModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');

  // Modals
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isNoteModalOpen, setIsNoteModalOpen] = useState(false);
  const [isSuspendModalOpen, setIsSuspendModalOpen] = useState(false);

  // Forms
  const [editForm, setEditForm] = useState<UpdateTenantDto>({});
  const [newNote, setNewNote] = useState({ content: '', category: 'general' });
  const [suspendReason, setSuspendReason] = useState('');
  const [saving, setSaving] = useState(false);
  const detailRequestSeq = useRef(0);

  // Fetch tenant detail
  const fetchTenant = useCallback(async () => {
    if (!tenantId) return;

    const requestId = detailRequestSeq.current + 1;
    detailRequestSeq.current = requestId;
    try {
      setLoading(true);
      setError(null);
      const [detail, allModules] = await Promise.all([
        tenantsApi.getDetail(tenantId),
        modulesApi.list({ isActive: true, limit: 50 }),
      ]);
      if (detailRequestSeq.current !== requestId) return;
      setTenant(detail);
      setModules(allModules.data);
      setEditForm({
        name: detail.name,
        description: detail.description,
        domain: detail.domain,
        tier: detail.tier,
        primaryContact: detail.primaryContact,
        billingContact: detail.billingContact,
        billingEmail: detail.billingEmail,
        country: detail.country,
        region: detail.region,
      });
    } catch (err) {
      if (detailRequestSeq.current !== requestId) return;
      console.error('Failed to fetch tenant details:', err);
      setTenant(null);
      setModules([]);
      setError('Failed to load tenant details. Please try again.');
    } finally {
      if (detailRequestSeq.current === requestId) {
        setLoading(false);
      }
    }
  }, [tenantId]);

  useEffect(() => {
    fetchTenant();
  }, [fetchTenant]);

  // Handlers
  const handleUpdate = async () => {
    if (!tenantId) return;
    setSaving(true);
    try {
      await tenantsApi.update(tenantId, editForm);
      setIsEditModalOpen(false);
      fetchTenant();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleSuspend = async () => {
    if (!tenantId) return;
    setSaving(true);
    try {
      await tenantsApi.suspend(tenantId, suspendReason);
      setIsSuspendModalOpen(false);
      setSuspendReason('');
      fetchTenant();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async () => {
    if (!tenantId) return;
    try {
      await tenantsApi.activate(tenantId);
      fetchTenant();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAddNote = async () => {
    if (!tenantId || !newNote.content.trim()) return;
    setSaving(true);
    try {
      await tenantsApi.createNote(tenantId, newNote);
      setIsNoteModalOpen(false);
      setNewNote({ content: '', category: 'general' });
      fetchTenant();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    if (!tenantId) return;
    try {
      await tenantsApi.deleteNote(tenantId, noteId);
      fetchTenant();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAssignModule = async (moduleId: string) => {
    if (!tenantId) return;
    try {
      await modulesApi.assignToTenant(tenantId, moduleId);
      fetchTenant();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRemoveModule = async (moduleId: string) => {
    if (!tenantId) return;
    try {
      await modulesApi.removeFromTenant(tenantId, moduleId);
      fetchTenant();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error || !tenant) {
    return (
      <Card className="p-6 text-center">
        <p className="text-red-600">{error || 'Tenant not found'}</p>
        <Button variant="outline" onClick={() => navigate('/admin/tenants')} className="mt-4">
          Go Back
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
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
                  {tenant.lastActivityAt ? formatRelativeTime(tenant.lastActivityAt) : '-'}
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
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Users</h4>
              <p className="text-3xl font-bold text-gray-900">{tenant.userStats?.total ?? 0}</p>
              <p className="text-sm text-green-600">
                {tenant.userStats?.active ?? 0} active
              </p>
            </Card>
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Farms</h4>
              <p className="text-3xl font-bold text-gray-900">{tenant.farmCount ?? 0}</p>
            </Card>
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Sensors</h4>
              <p className="text-3xl font-bold text-gray-900">{tenant.sensorCount ?? 0}</p>
            </Card>
            <Card className="p-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">Active Modules</h4>
              <p className="text-3xl font-bold text-gray-900">
                {tenant.modules?.filter((m) => m.isActive).length ?? 0}
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
                  <span>Monthly Fee</span>
                  <span className="font-bold">
                    {tenant.billing.currency} {tenant.billing.monthlyAmount}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Billing Cycle</span>
                  <span>{tenant.billing.billingCycle}</span>
                </div>
                <div className="flex justify-between">
                  <span>Payment Status</span>
                  <Badge
                    variant={
                      tenant.billing.paymentStatus === 'active' ? 'success' : 'warning'
                    }
                  >
                    {tenant.billing.paymentStatus}
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
                    {tenant.billing.currency} {tenant.billing.lastPaymentAmount}
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
            onChange={(e) => setEditForm({ ...editForm, tier: e.target.value as TenantTier })}
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
