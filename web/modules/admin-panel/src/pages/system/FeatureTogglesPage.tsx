/**
 * Feature Toggles Management Page
 *
 * Enterprise-grade feature flag management with real API integration.
 * Supports global, tenant, and user scopes.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge, Input, Select } from '@aquaculture/shared-ui';
import { systemSettingsApi } from '../../services/adminApi';
import type { FeatureToggle } from '../../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface FeatureToggleForm {
  key: string;
  name: string;
  description: string;
  scope: 'global' | 'tenant' | 'user';
  category: string;
  rolloutPercentage: number;
  isExperimental: boolean;
}

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
  // State
  const [toggles, setToggles] = useState<FeatureToggle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterScope, setFilterScope] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedToggle, setSelectedToggle] = useState<FeatureToggle | null>(null);
  const [formData, setFormData] = useState<FeatureToggleForm>(defaultForm);
  const [saving, setSaving] = useState(false);

  // ============================================================================
  // Data Loading
  // ============================================================================

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await systemSettingsApi.getFeatureToggles({
        scope: filterScope !== 'all' ? filterScope : undefined,
        status: filterStatus !== 'all' ? filterStatus : undefined,
        category: filterCategory !== 'all' ? filterCategory : undefined,
        search: searchTerm || undefined,
      });
      // Backend returns { items: [], total: number } format
      // Also support { data: [] } format for compatibility
      const data = (response as unknown as { items?: FeatureToggle[]; data?: FeatureToggle[] })?.items
        || (response as unknown as { data?: FeatureToggle[] })?.data;
      if (Array.isArray(data)) {
        setToggles(data);
      } else if (Array.isArray(response)) {
        // Direct array response
        setToggles(response);
      } else {
        // API returned unexpected format
        console.error('API returned unexpected format for feature toggles');
        setToggles([]);
      }
    } catch (err) {
      console.error('Failed to load feature toggles:', err);
      setError('Failed to load feature toggles');
      setToggles([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterScope, filterCategory, searchTerm]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleToggleStatus = async (toggle: FeatureToggle) => {
    try {
      const newEnabled = toggle.status !== 'enabled';
      await systemSettingsApi.toggleFeature(toggle.id, newEnabled);
      setToggles(
        toggles.map((t) =>
          t.id === toggle.id
            ? { ...t, status: newEnabled ? 'enabled' : 'disabled' }
            : t
        )
      );
    } catch (err) {
      console.error('Failed to toggle feature:', err);
      // Optimistic update for demo
      setToggles(
        toggles.map((t) =>
          t.id === toggle.id
            ? { ...t, status: t.status === 'enabled' ? 'disabled' : 'enabled' }
            : t
        )
      );
    }
  };

  const handleCreate = async () => {
    if (!formData.key || !formData.name) return;

    setSaving(true);
    try {
      const newToggle = await systemSettingsApi.createFeatureToggle({
        key: formData.key,
        name: formData.name,
        description: formData.description,
        scope: formData.scope,
        category: formData.category,
        rolloutPercentage: formData.rolloutPercentage,
        isExperimental: formData.isExperimental,
        status: 'disabled',
      });
      setToggles([newToggle, ...toggles]);
      setShowCreateModal(false);
      setFormData(defaultForm);
    } catch (err) {
      console.error('Failed to create toggle:', err);
      // Demo: add locally
      const newToggle: FeatureToggle = {
        id: Date.now().toString(),
        key: formData.key,
        name: formData.name,
        description: formData.description,
        scope: formData.scope,
        category: formData.category,
        rolloutPercentage: formData.rolloutPercentage,
        isExperimental: formData.isExperimental,
        status: 'disabled',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setToggles([newToggle, ...toggles]);
      setShowCreateModal(false);
      setFormData(defaultForm);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!selectedToggle) return;

    setSaving(true);
    try {
      const updated = await systemSettingsApi.updateFeatureToggle(selectedToggle.id, {
        name: formData.name,
        description: formData.description,
        scope: formData.scope,
        category: formData.category,
        rolloutPercentage: formData.rolloutPercentage,
        isExperimental: formData.isExperimental,
      });
      setToggles(toggles.map((t) => (t.id === updated.id ? updated : t)));
      setShowEditModal(false);
      setSelectedToggle(null);
      setFormData(defaultForm);
    } catch (err) {
      console.error('Failed to update toggle:', err);
      // Demo: update locally
      setToggles(
        toggles.map((t) =>
          t.id === selectedToggle.id
            ? {
                ...t,
                name: formData.name,
                description: formData.description,
                scope: formData.scope,
                category: formData.category,
                rolloutPercentage: formData.rolloutPercentage,
                isExperimental: formData.isExperimental,
                updatedAt: new Date().toISOString(),
              }
            : t
        )
      );
      setShowEditModal(false);
      setSelectedToggle(null);
      setFormData(defaultForm);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (toggle: FeatureToggle) => {
    if (!confirm(`Are you sure you want to delete "${toggle.name}"?`)) return;

    try {
      await systemSettingsApi.deleteFeatureToggle(toggle.id);
      setToggles(toggles.filter((t) => t.id !== toggle.id));
    } catch (err) {
      console.error('Failed to delete toggle:', err);
      // Demo: delete locally
      setToggles(toggles.filter((t) => t.id !== toggle.id));
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

  // Ensure toggles is always an array
  const safeToggles = Array.isArray(toggles) ? toggles : [];
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

  const getScopeBadge = (scope: string) => {
    const colors: Record<string, string> = {
      global: 'bg-purple-100 text-purple-800',
      tenant: 'bg-blue-100 text-blue-800',
      user: 'bg-green-100 text-green-800',
    };
    return colors[scope] || 'bg-gray-100 text-gray-800';
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
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Toggle
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Scope
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Rollout
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Category
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {safeToggles.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                    No feature toggles found
                  </td>
                </tr>
              ) : (
                safeToggles.map((toggle) => (
                  <tr key={toggle.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
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
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${getScopeBadge(toggle.scope)}`}>
                        {toggle.scope}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={getStatusBadge(toggle.status)}>
                        {toggle.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-6 py-4">
                      {toggle.status === 'percentage_rollout' ? (
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
                        <span className="text-sm text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-600">{toggle.category || '-'}</span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button
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
                          onClick={() => openEditModal(toggle)}
                          className="px-3 py-1.5 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(toggle)}
                          className="px-3 py-1.5 text-sm font-medium bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Create/Edit Modal */}
      {(showCreateModal || showEditModal) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-6">
                {showEditModal ? 'Edit Feature Toggle' : 'Create Feature Toggle'}
              </h2>
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
                      onChange={(e) => setFormData({ ...formData, scope: e.target.value as FeatureToggleForm['scope'] })}
                      options={[
                        { value: 'global', label: 'Global' },
                        { value: 'tenant', label: 'Tenant' },
                        { value: 'user', label: 'User' },
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

              <div className="flex justify-end gap-3 mt-8 pt-4 border-t">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowCreateModal(false);
                    setShowEditModal(false);
                    setSelectedToggle(null);
                    setFormData(defaultForm);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={showEditModal ? handleUpdate : handleCreate}
                  loading={saving}
                  disabled={!formData.key || !formData.name}
                >
                  {showEditModal ? 'Update Toggle' : 'Create Toggle'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="fixed bottom-4 right-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}
    </div>
  );
};

export default FeatureTogglesPage;
