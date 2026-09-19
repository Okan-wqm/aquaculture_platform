/**
 * Feature Toggles Management Page
 *
 * Enterprise-grade feature flag management with real API integration.
 * Supports global, tenant, and user scopes.
 */

import React, { useMemo, useState } from 'react';
import { Card, Button, Badge, DataTable, Input, Select, Modal, useConfirm, type DataTableColumn } from '@aquaculture/shared-ui';

import { systemSettingsApi } from '../../services/adminApi';
import { adminKeys, useAdminMutation, useAdminQuery } from '../../hooks';
import { QueryFailureNotice } from '../../components';
import type { FeatureToggle, FeatureToggleScope } from '../../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface FeatureToggleForm {
  key: string;
  name: string;
  description: string;
  scope: FeatureToggleScope;
  category: string;
  rolloutPercentage: number;
  isExperimental: boolean;
}

const EMPTY_TOGGLES: readonly FeatureToggle[] = [];

const defaultForm: FeatureToggleForm = {
  key: '',
  name: '',
  description: '',
  scope: 'global',
  category: '',
  rolloutPercentage: 0,
  isExperimental: false,
};

// ============================================================================
// Component
// ============================================================================

export const FeatureTogglesPage: React.FC = () => {
  const confirm = useConfirm();
  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterScope, setFilterScope] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedToggle, setSelectedToggle] = useState<FeatureToggle | null>(null);
  const [formData, setFormData] = useState<FeatureToggleForm>(defaultForm);

  // ============================================================================
  // Data Loading
  // ============================================================================

  // ==========================================================================
  // Read (ADMIN-HIGH-121)
  // ==========================================================================

  const toggleFilter = useMemo(
    () => ({
      scope: filterScope !== 'all' ? filterScope : undefined,
      status: filterStatus !== 'all' ? filterStatus : undefined,
      category: filterCategory !== 'all' ? filterCategory : undefined,
      search: searchTerm || undefined,
    }),
    [filterScope, filterStatus, filterCategory, searchTerm],
  );

  const togglesKey = [...adminKeys.system.all(), 'feature-toggles'];

  const togglesQuery = useAdminQuery(
    [...togglesKey, toggleFilter],
    ({ signal }) => systemSettingsApi.getFeatureToggles(toggleFilter, signal),
    { placeholderData: (previous) => previous },
  );

  const safeToggles: readonly FeatureToggle[] = togglesQuery.data?.data ?? EMPTY_TOGGLES;
  const loading = togglesQuery.isPending;

  // ==========================================================================
  // Writes — the list comes back from the server (ADMIN-HIGH-121)
  //
  // Every handler used to edit the local array: the flip wrote
  // `status: newEnabled ? 'enabled' : 'disabled'` without looking at what the
  // endpoint returned, so a flag the server had put into any other state — or
  // had refused to change at all — still showed as flipped. Create unshifted
  // its own optimistic row, update spliced, delete filtered. `invalidateKeys`
  // makes the server's answer the one on screen.
  // ==========================================================================

  const invalidateToggles = { invalidateKeys: [togglesKey] };

  const flipToggle = useAdminMutation<FeatureToggle, { id: string; enabled: boolean }>(
    ({ id, enabled }) => systemSettingsApi.toggleFeature(id, enabled),
    invalidateToggles,
  );

  const createToggle = useAdminMutation<FeatureToggle, FeatureToggleForm>(
    (form) =>
      systemSettingsApi.createFeatureToggle({
        key: form.key,
        name: form.name,
        description: form.description,
        scope: form.scope,
        category: form.category,
        rolloutPercentage: form.rolloutPercentage,
        isExperimental: form.isExperimental,
        status: 'disabled',
      }),
    invalidateToggles,
  );

  const updateToggle = useAdminMutation<FeatureToggle, { id: string; form: FeatureToggleForm }>(
    // ADMIN-HIGH-113: this used to send `scope` and `isExperimental` too.
    // `UpdateFeatureToggleDto` declares neither — a toggle's scope is fixed at
    // creation, and the platform ValidationPipe runs `forbidNonWhitelisted`,
    // so every save was rejected 400 and no edit ever landed. The call is
    // typed from the request DTO, so a field the endpoint will not accept
    // cannot be sent.
    ({ id, form }) =>
      systemSettingsApi.updateFeatureToggle(id, {
        name: form.name,
        description: form.description,
        category: form.category,
        rolloutPercentage: form.rolloutPercentage,
      }),
    invalidateToggles,
  );

  const deleteToggle = useAdminMutation<void, string>(
    (id) => systemSettingsApi.deleteFeatureToggle(id),
    invalidateToggles,
  );

  const mutations = [flipToggle, createToggle, updateToggle, deleteToggle];
  const saving = createToggle.isPending || updateToggle.isPending;
  const queryErrors = [togglesQuery.error, ...mutations.map((mutation) => mutation.error)];

  const loadData = (): void => {
    void togglesQuery.refetch();
  };

  const handleToggleStatus = async (toggle: FeatureToggle): Promise<void> => {
    try {
      await flipToggle.mutateAsync({ id: toggle.id, enabled: toggle.status !== 'enabled' });
    } catch {
      // `flipToggle.error` carries it into the page's notice.
    }
  };

  const closeForm = (): void => {
    setShowCreateModal(false);
    setShowEditModal(false);
    setSelectedToggle(null);
    setFormData(defaultForm);
  };

  const handleCreate = async (): Promise<void> => {
    if (!formData.key || !formData.name) return;
    try {
      await createToggle.mutateAsync(formData);
      // Only on a confirmed create: the modal used to close on the optimistic
      // row it had just pushed into local state.
      setShowCreateModal(false);
      setFormData(defaultForm);
    } catch {
      // Reported through `createToggle.error`; the modal stays open.
    }
  };

  const handleUpdate = async (): Promise<void> => {
    if (!selectedToggle) return;
    try {
      await updateToggle.mutateAsync({ id: selectedToggle.id, form: formData });
      setShowEditModal(false);
      setSelectedToggle(null);
      setFormData(defaultForm);
    } catch {
      // Reported through `updateToggle.error`.
    }
  };

  const handleDelete = async (toggle: FeatureToggle): Promise<void> => {
    if (!(await confirm({ title: `Delete toggle "${toggle.name}"?`, message: 'Code paths reading this flag fall back to their default.', confirmText: 'Delete', cancelText: 'Cancel', variant: 'danger' }))) return;
    try {
      await deleteToggle.mutateAsync(toggle.id);
    } catch {
      // Reported through `deleteToggle.error`.
    }
  };

  const openEditModal = (toggle: FeatureToggle) => {
    setSelectedToggle(toggle);
    setFormData({
      key: toggle.key,
      name: toggle.name,
      description: toggle.description || '',
      scope: toggle.scope,
      category: toggle.category || '',
      rolloutPercentage: toggle.rolloutPercentage,
      isExperimental: toggle.isExperimental,
    });
    setShowEditModal(true);
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  const categories = [...new Set(safeToggles.map((t) => t.category).filter(Boolean))];

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'success' | 'default' | 'info' | 'warning'> = {
      enabled: 'success',
      disabled: 'default',
      percentage_rollout: 'info',
      scheduled: 'warning',
    };
    return variants[status] || 'default';
  };

  const getScopeBadge = (scope: FeatureToggleScope): string => {
    // Exhaustive over the real scopes. `environment` was missing, so an
    // environment-scoped toggle fell through to the grey fallback and read as
    // uncategorised (ADMIN-MEDIUM-111).
    const colors: Record<FeatureToggleScope, string> = {
      global: 'bg-purple-100 text-purple-800',
      tenant: 'bg-blue-100 text-blue-800',
      user: 'bg-green-100 text-green-800',
      environment: 'bg-amber-100 text-amber-800',
    };
    return colors[scope];
  };

  const stats = {
    total: safeToggles.length,
    enabled: safeToggles.filter((t) => t.status === 'enabled').length,
    disabled: safeToggles.filter((t) => t.status === 'disabled').length,
    rollout: safeToggles.filter((t) => t.status === 'percentage_rollout').length,
    experimental: safeToggles.filter((t) => t.isExperimental).length,
  };

  // ============================================================================
  // Render
  // ============================================================================

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-gray-200 rounded w-1/4" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-xl p-6 h-24" />
          ))}
        </div>
        <div className="bg-white rounded-xl p-6 h-96" />
      </div>
    );
  }

  const toggleColumns: DataTableColumn<FeatureToggle>[] = [
    {
      key: 'name',
      header: 'Toggle',
      render: (_value, toggle) => (
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{toggle.name}</span>
            {toggle.isExperimental && (
              <Badge variant="warning" size="sm">Experimental</Badge>
            )}
          </div>
          <span className="text-sm font-mono text-gray-500">{toggle.key}</span>
          {toggle.description && (
            <span className="text-sm text-gray-500 mt-1 line-clamp-1">
              {toggle.description}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (_value, toggle) => (
        <span className={`px-2 py-1 text-xs font-medium rounded-full ${getScopeBadge(toggle.scope)}`}>
          {toggle.scope}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, toggle) => (
        <Badge variant={getStatusBadge(toggle.status)}>
          {toggle.status.replace('_', ' ')}
        </Badge>
      ),
    },
    {
      key: 'rolloutPercentage',
      header: 'Rollout',
      render: (_value, toggle) =>
        toggle.status === 'percentage_rollout' ? (
          <div className="flex items-center gap-2">
            <div className="w-20 bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${toggle.rolloutPercentage}%` }}
              />
            </div>
            <span className="text-sm text-gray-600">{toggle.rolloutPercentage}%</span>
          </div>
        ) : (
          <span className="text-sm text-gray-500">-</span>
        ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (_value, toggle) => <span className="text-sm text-gray-600">{toggle.category || '-'}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, toggle) => (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => handleToggleStatus(toggle)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              toggle.status === 'enabled'
                ? 'bg-red-100 text-red-700 hover:bg-red-200'
                : 'bg-green-100 text-green-700 hover:bg-green-200'
            }`}
          >
            {toggle.status === 'enabled' ? 'Disable' : 'Enable'}
          </button>
          <button
            type="button"
            onClick={() => openEditModal(toggle)}
            className="px-3 py-1.5 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => handleDelete(toggle)}
            className="px-3 py-1.5 text-sm font-medium bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Feature Toggles</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage feature flags and rollouts across the platform
          </p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Create Toggle
        </Button>
      </div>

      {/* A failed read or a rejected flag action, named where the operator is
          looking rather than in a fixed toast in the corner. */}
      <QueryFailureNotice
        errors={queryErrors}
        hasContent={togglesQuery.data !== undefined}
        onRetry={loadData}
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="p-4">
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
          <div className="text-sm text-gray-500">Total Toggles</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-green-600">{stats.enabled}</div>
          <div className="text-sm text-gray-500">Enabled</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-gray-600">{stats.disabled}</div>
          <div className="text-sm text-gray-500">Disabled</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-blue-600">{stats.rollout}</div>
          <div className="text-sm text-gray-500">Rolling Out</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.experimental}</div>
          <div className="text-sm text-gray-500">Experimental</div>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <Input
              placeholder="Search by key, name, or description..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full"
            />
          </div>
          <Select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            options={[
              { value: 'all', label: 'All Statuses' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'disabled', label: 'Disabled' },
              { value: 'percentage_rollout', label: 'Rolling Out' },
              { value: 'scheduled', label: 'Scheduled' },
            ]}
          />
          <Select
            value={filterScope}
            onChange={(e) => setFilterScope(e.target.value)}
            options={[
              { value: 'all', label: 'All Scopes' },
              { value: 'global', label: 'Global' },
              { value: 'tenant', label: 'Tenant' },
              { value: 'user', label: 'User' },
            ]}
          />
          <Select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            options={[
              { value: 'all', label: 'All Categories' },
              ...categories.map((cat) => ({ value: cat!, label: cat! })),
            ]}
          />
        </div>
      </Card>

      {/* Toggles List */}
      <DataTable<FeatureToggle>
        data={safeToggles}
        columns={toggleColumns}
        keyExtractor={(toggle) => toggle.id}
        loading={loading}
        loadingMessage="Loading feature toggles..."
        emptyMessage="No feature toggles found"
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />

      {/* Create/Edit Modal */}
      {(showCreateModal || showEditModal) && (
        <Modal
          isOpen
          onClose={closeForm}
          size="lg"
          title={showEditModal ? 'Edit Feature Toggle' : 'Create Feature Toggle'}
          showCloseButton={!saving}
          closeOnEscape={!saving}
          closeOnOverlayClick={!saving}
          bodyClassName="p-6"
          footer={
            <>
              <Button variant="secondary" onClick={closeForm}>
                Cancel
              </Button>
              <Button
                onClick={showEditModal ? handleUpdate : handleCreate}
                loading={saving}
                disabled={!formData.key || !formData.name}
              >
                {showEditModal ? 'Update Toggle' : 'Create Toggle'}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Key <span className="text-red-500">*</span>
                </label>
                <Input
                  value={formData.key}
                  onChange={(e) => setFormData({ ...formData, key: e.target.value })}
                  placeholder="feature_key"
                  disabled={showEditModal}
                  className="font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name <span className="text-red-500">*</span>
                </label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Feature Name"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Describe what this feature does..."
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Scope
                </label>
                <Select
                  value={formData.scope}
                  // Fixed at creation — `UpdateFeatureToggleDto` has no
                  // `scope`, so an editable control here would offer a
                  // change the API discards (ADMIN-HIGH-113).
                  disabled={showEditModal}
                  onChange={(e) => setFormData({ ...formData, scope: e.target.value as FeatureToggleForm['scope'] })}
                  options={[
                    { value: 'global', label: 'Global' },
                    { value: 'tenant', label: 'Tenant' },
                    { value: 'user', label: 'User' },
                    // Offered because the API can return it: an
                    // environment-scoped toggle opened here without this
                    // option would have been saved back with a different
                    // scope (ADMIN-MEDIUM-111).
                    { value: 'environment', label: 'Environment' },
                  ]}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category
                </label>
                <Input
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  placeholder="e.g., ui, analytics, ml"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Rollout Percentage
              </label>
              <div className="flex items-center gap-4">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={formData.rolloutPercentage}
                  onChange={(e) => setFormData({ ...formData, rolloutPercentage: parseInt(e.target.value) })}
                  className="flex-1"
                />
                <span className="w-12 text-center font-medium">{formData.rolloutPercentage}%</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.isExperimental}
                  onChange={(e) => setFormData({ ...formData, isExperimental: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Experimental</span>
              </label>
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
};

export default FeatureTogglesPage;
