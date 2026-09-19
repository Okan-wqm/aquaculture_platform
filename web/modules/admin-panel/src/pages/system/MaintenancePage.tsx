/**
 * Maintenance Mode Management Page
 *
 * Enterprise-grade maintenance window scheduling with real API integration.
 * Supports scheduled, emergency, rolling updates, and database migrations.
 */

import React, { useState } from 'react';
import {
  Card,
  Button,
  Badge,
  Input,
  Select,
  Modal,
  useConfirm,
  usePrompt,
  PageHeader,
} from '@aquaculture/shared-ui';
import { systemSettingsApi } from '../../services/adminApi';
import { adminKeys, useAdminMutation, useAdminQuery } from '../../hooks';
import { QueryFailureNotice } from '../../components';
// The page-local shadow copy of this shape is gone: it disagreed with the
// canonical type on five points, and a double type assertion at the call site
// was the only reason that compiled.
import type {
  CreateMaintenanceWindowInput,
  MaintenanceWindow,
} from '../../services/types/settings';
import { Check, Plus, Settings, ShieldCheck } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface MaintenanceForm {
  title: string;
  description: string;
  scope: MaintenanceWindow['scope'];
  type: MaintenanceWindow['type'];
  scheduledStart: string;
  estimatedDurationMinutes: number;
  userMessage: string;
  allowReadOnlyAccess: boolean;
  bypassForSuperAdmins: boolean;
}

const EMPTY_WINDOWS: readonly MaintenanceWindow[] = [];

const defaultForm: MaintenanceForm = {
  title: '',
  description: '',
  scope: 'global',
  type: 'scheduled',
  scheduledStart: '',
  estimatedDurationMinutes: 60,
  userMessage: '',
  allowReadOnlyAccess: false,
  bypassForSuperAdmins: true,
};

// ============================================================================
// No Mock Data - Using Real API Only
// ============================================================================

// ============================================================================
// Component
// ============================================================================

export const MaintenancePage: React.FC = () => {
  const confirm = useConfirm();
  const prompt = usePrompt();
  // State
  const [activeTab, setActiveTab] = useState<'upcoming' | 'active' | 'history'>('upcoming');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedMaintenance, setSelectedMaintenance] = useState<MaintenanceWindow | null>(null);
  const [formData, setFormData] = useState<MaintenanceForm>(defaultForm);

  // ============================================================================
  // Data Loading
  // ============================================================================

  // ==========================================================================
  // Read (ADMIN-HIGH-121)
  // ==========================================================================

  const maintenanceKey = [...adminKeys.system.all(), 'maintenance'];

  const windowsQuery = useAdminQuery(maintenanceKey, ({ signal }) =>
    systemSettingsApi.getMaintenanceWindows(undefined, signal),
  );

  const maintenanceList: readonly MaintenanceWindow[] = windowsQuery.data?.data ?? EMPTY_WINDOWS;
  const loading = windowsQuery.isPending;

  // ==========================================================================
  // Writes — the window comes back from the server (ADMIN-HIGH-129)
  //
  // Every action here discarded the updated window the endpoint returns and
  // wrote its own: `status: 'in_progress', actualStart: new Date()` after a
  // start, `status: 'completed', actualEnd: new Date()` after an end, and a
  // locally recomputed `scheduledEnd` plus `estimatedDurationMinutes` after an
  // extend. `actualStart` and `actualEnd` are the operational record of when
  // the platform went into maintenance and came out; they were being filled in
  // from the operator's browser clock, for a transition the server may have
  // performed at a different moment — or, on a 200 that did not change the
  // status, not performed at all.
  // ==========================================================================

  const invalidateWindows = { invalidateKeys: [maintenanceKey] };

  const createWindow = useAdminMutation<MaintenanceWindow, CreateMaintenanceWindowInput>(
    (input) => systemSettingsApi.createMaintenanceWindow(input),
    invalidateWindows,
  );

  const startWindow = useAdminMutation<MaintenanceWindow, string>(
    (id) => systemSettingsApi.startMaintenance(id),
    invalidateWindows,
  );

  const endWindow = useAdminMutation<MaintenanceWindow, string>(
    (id) => systemSettingsApi.endMaintenance(id),
    invalidateWindows,
  );

  const extendWindow = useAdminMutation<MaintenanceWindow, { id: string; minutes: number }>(
    ({ id, minutes }) => systemSettingsApi.extendMaintenance(id, minutes),
    invalidateWindows,
  );

  const cancelWindow = useAdminMutation<MaintenanceWindow, string>(
    (id) => systemSettingsApi.cancelMaintenance(id),
    invalidateWindows,
  );

  const mutations = [createWindow, startWindow, endWindow, extendWindow, cancelWindow];
  const saving = createWindow.isPending;
  const queryErrors = [windowsQuery.error, ...mutations.map((mutation) => mutation.error)];

  const loadData = (): void => {
    void windowsQuery.refetch();
  };

  const closeForm = (): void => {
    setShowCreateModal(false);
    setShowEditModal(false);
    setSelectedMaintenance(null);
    setFormData(defaultForm);
  };

  const handleCreate = async (): Promise<void> => {
    if (!formData.title || !formData.scheduledStart) return;

    const scheduledEnd = new Date(formData.scheduledStart);
    scheduledEnd.setMinutes(scheduledEnd.getMinutes() + formData.estimatedDurationMinutes);

    // Typed by the write contract rather than cast into one. The two casts
    // here narrowed to unions the backend does not have — `type` was cast to
    // `'scheduled' | 'emergency' | 'rolling'` while the dropdown offers
    // `rolling_update`, `database_migration` and `security_patch` and
    // `CreateMaintenanceDto` validates against the five-member enum. The
    // runtime value was right all along; the cast was the lie, and it is what
    // let the drifted contract sit unnoticed. `createdBy` is gone with it: it
    // is not a whitelisted body field, so the platform's
    // `forbidNonWhitelisted` pipe rejects the request that carries it.
    const apiData: CreateMaintenanceWindowInput = {
      title: formData.title,
      description: formData.description,
      scope: formData.scope,
      type: formData.type,
      scheduledStart: formData.scheduledStart,
      scheduledEnd: scheduledEnd.toISOString(),
      estimatedDurationMinutes: formData.estimatedDurationMinutes,
      userMessage: formData.userMessage,
      allowReadOnlyAccess: formData.allowReadOnlyAccess,
      bypassForSuperAdmins: formData.bypassForSuperAdmins,
      affectedServices: [],
    };

    try {
      await createWindow.mutateAsync(apiData);
      setShowCreateModal(false);
      setFormData(defaultForm);
    } catch {
      // `createWindow.error` carries it; the modal stays open.
    }
  };

  const handleStartMaintenance = async (maintenance: MaintenanceWindow): Promise<void> => {
    if (
      !(await confirm({
        title: `Start maintenance "${maintenance.title}" now?`,
        confirmText: 'Start',
        cancelText: 'Cancel',
        variant: 'warning',
      }))
    )
      return;
    try {
      await startWindow.mutateAsync(maintenance.id);
    } catch {
      // Reported through `startWindow.error`.
    }
  };

  const handleEndMaintenance = async (maintenance: MaintenanceWindow): Promise<void> => {
    if (
      !(await confirm({
        title: `End maintenance "${maintenance.title}"?`,
        confirmText: 'End',
        cancelText: 'Cancel',
        variant: 'warning',
      }))
    )
      return;
    try {
      await endWindow.mutateAsync(maintenance.id);
    } catch {
      // Reported through `endWindow.error`.
    }
  };

  const handleExtendMaintenance = async (maintenance: MaintenanceWindow): Promise<void> => {
    const minutes = await prompt({
      title: 'Extend maintenance',
      label: 'Extend by how many minutes?',
      defaultValue: '30',
      confirmText: 'Extend',
      cancelText: 'Cancel',
    });
    if (!minutes) return;
    const additionalMinutes = Number.parseInt(minutes, 10);
    if (!Number.isFinite(additionalMinutes) || additionalMinutes <= 0) return;

    try {
      await extendWindow.mutateAsync({ id: maintenance.id, minutes: additionalMinutes });
    } catch {
      // Reported through `extendWindow.error`.
    }
  };

  const handleCancelMaintenance = async (maintenance: MaintenanceWindow): Promise<void> => {
    if (
      !(await confirm({
        title: `Cancel maintenance "${maintenance.title}"?`,
        confirmText: 'Cancel maintenance',
        cancelText: 'Keep',
        variant: 'danger',
      }))
    )
      return;
    try {
      await cancelWindow.mutateAsync(maintenance.id);
    } catch {
      // Reported through `cancelWindow.error`.
    }
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  const getStatusBadge = (status: string): 'info' | 'warning' | 'success' | 'default' | 'error' => {
    const variants: Record<string, 'info' | 'warning' | 'success' | 'default' | 'error'> = {
      scheduled: 'info',
      in_progress: 'warning',
      completed: 'success',
      cancelled: 'default',
      extended: 'error',
    };
    return variants[status] || 'default';
  };

  const getTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      scheduled: 'bg-blue-100 text-blue-800',
      emergency: 'bg-red-100 text-red-800',
      rolling_update: 'bg-purple-100 text-purple-800',
      database_migration: 'bg-indigo-100 text-indigo-800',
      security_patch: 'bg-orange-100 text-orange-800',
    };
    return colors[type] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200';
  };

  const filteredMaintenance = maintenanceList.filter((m) => {
    if (activeTab === 'upcoming') return m.status === 'scheduled';
    if (activeTab === 'active') return m.status === 'in_progress' || m.status === 'extended';
    return m.status === 'completed' || m.status === 'cancelled';
  });

  const formatDateTime = (date: string) => {
    return new Date(date).toLocaleString('tr-TR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
  };

  const activeMaintenance = maintenanceList.filter(
    (m) => m.status === 'in_progress' || m.status === 'extended',
  );

  const stats = {
    scheduled: maintenanceList.filter((m) => m.status === 'scheduled').length,
    inProgress: activeMaintenance.length,
    completed: maintenanceList.filter((m) => m.status === 'completed').length,
    cancelled: maintenanceList.filter((m) => m.status === 'cancelled').length,
  };

  // ============================================================================
  // Render
  // ============================================================================

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-xl p-6 h-24" />
          ))}
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl p-6 h-96" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Maintenance Mode"
        description="Schedule and manage system maintenance windows"
        actions={
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
            Schedule Maintenance
          </Button>
        }
      />

      {/* A failed read or a rejected maintenance action, named on the page.
          It used to go to a fixed toast in the bottom-right corner, while the
          row it concerned already showed the transition as done. */}
      <QueryFailureNotice
        errors={queryErrors}
        hasContent={windowsQuery.data !== undefined}
        onRetry={loadData}
      />

      {/* Active Maintenance Banner */}
      {activeMaintenance.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse mt-1.5" />
            <div className="flex-1">
              <div className="font-semibold text-yellow-800">
                {activeMaintenance.length} Maintenance{' '}
                {activeMaintenance.length === 1 ? 'Window' : 'Windows'} In Progress
              </div>
              {activeMaintenance.map((m) => (
                <div key={m.id} className="text-sm text-yellow-700 mt-1">
                  <span className="font-medium">{m.title}</span>
                  {m.actualStart && (
                    <span className="ml-2 text-yellow-600">
                      - Started {formatDateTime(m.actualStart)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="text-2xl font-bold text-blue-600">{stats.scheduled}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Scheduled</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.inProgress}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">In Progress</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Completed</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-gray-600 dark:text-gray-400">
            {stats.cancelled}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Cancelled</div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-8">
          {(['upcoming', 'active', 'history'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-3 border-b-2 font-medium text-sm capitalize transition-colors ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500'
              }`}
            >
              {tab}
              {tab === 'active' && activeMaintenance.length > 0 && (
                <span className="ml-2 px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs rounded-full">
                  {activeMaintenance.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Maintenance List */}
      <div className="space-y-4">
        {filteredMaintenance.length === 0 ? (
          <Card className="p-12 text-center">
            <Settings
              className="w-12 h-12 mx-auto text-gray-500 dark:text-gray-400 mb-4"
              aria-hidden="true"
            />
            <p className="text-gray-500 dark:text-gray-400">No {activeTab} maintenance windows</p>
          </Card>
        ) : (
          filteredMaintenance.map((maintenance) => (
            <Card key={maintenance.id} className="p-6">
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                <div className="flex-1">
                  {/* Header */}
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {maintenance.title}
                    </h3>
                    <Badge variant={getStatusBadge(maintenance.status)}>
                      {maintenance.status.replace('_', ' ')}
                    </Badge>
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${getTypeBadge(maintenance.type)}`}
                    >
                      {maintenance.type.replace('_', ' ')}
                    </span>
                    <span className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                      {maintenance.scope}
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-gray-600 dark:text-gray-400 mb-4">{maintenance.description}</p>

                  {/* Timeline */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
                    <div>
                      <div className="text-gray-500 dark:text-gray-400">Scheduled Start</div>
                      <div className="font-medium">
                        {formatDateTime(maintenance.scheduledStart)}
                      </div>
                    </div>
                    {maintenance.scheduledEnd && (
                      <div>
                        <div className="text-gray-500 dark:text-gray-400">Scheduled End</div>
                        <div className="font-medium">
                          {formatDateTime(maintenance.scheduledEnd)}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-gray-500 dark:text-gray-400">Duration</div>
                      <div className="font-medium">
                        {formatDuration(maintenance.estimatedDurationMinutes)}
                      </div>
                    </div>
                    {maintenance.actualStart && (
                      <div>
                        <div className="text-gray-500 dark:text-gray-400">Actual Start</div>
                        <div className="font-medium text-yellow-600">
                          {formatDateTime(maintenance.actualStart)}
                        </div>
                      </div>
                    )}
                    {maintenance.actualEnd && (
                      <div>
                        <div className="text-gray-500 dark:text-gray-400">Actual End</div>
                        <div className="font-medium text-green-600">
                          {formatDateTime(maintenance.actualEnd)}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Affected Services */}
                  {maintenance.affectedServices && maintenance.affectedServices.length > 0 && (
                    <div className="mb-4">
                      <div className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                        Affected Services:
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {maintenance.affectedServices.map((service, idx) => (
                          <span
                            key={idx}
                            className={`px-2 py-1 rounded text-xs font-medium ${
                              service.status === 'unavailable'
                                ? 'bg-red-100 text-red-800'
                                : service.status === 'degraded'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : 'bg-green-100 text-green-800'
                            }`}
                          >
                            {service.name}: {service.status}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* User Message */}
                  {maintenance.userMessage && (
                    <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                        User Message:
                      </div>
                      <div className="text-sm text-gray-700 dark:text-gray-300">
                        {maintenance.userMessage}
                      </div>
                    </div>
                  )}

                  {/* Flags */}
                  <div className="flex flex-wrap gap-3 mt-3 text-xs">
                    {maintenance.allowReadOnlyAccess && (
                      <span className="flex items-center gap-1 text-green-600">
                        <Check className="w-4 h-4" aria-hidden="true" />
                        Read-only access allowed
                      </span>
                    )}
                    {maintenance.bypassForSuperAdmins && (
                      <span className="flex items-center gap-1 text-blue-600">
                        <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                        Super admin bypass
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-row lg:flex-col gap-2">
                  {maintenance.status === 'scheduled' && (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleStartMaintenance(maintenance)}
                      >
                        Start Now
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setSelectedMaintenance(maintenance);
                          setFormData({
                            title: maintenance.title,
                            description: maintenance.description,
                            scope: maintenance.scope,
                            type: maintenance.type,
                            scheduledStart: maintenance.scheduledStart.slice(0, 16),
                            estimatedDurationMinutes: maintenance.estimatedDurationMinutes,
                            userMessage: maintenance.userMessage || '',
                            allowReadOnlyAccess: maintenance.allowReadOnlyAccess,
                            bypassForSuperAdmins: maintenance.bypassForSuperAdmins,
                          });
                          setShowEditModal(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleCancelMaintenance(maintenance)}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                  {(maintenance.status === 'in_progress' || maintenance.status === 'extended') && (
                    <>
                      <Button
                        variant="success"
                        size="sm"
                        onClick={() => handleEndMaintenance(maintenance)}
                      >
                        End Maintenance
                      </Button>
                      <Button
                        variant="warning"
                        size="sm"
                        onClick={() => handleExtendMaintenance(maintenance)}
                      >
                        Extend
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Create/Edit Modal */}
      {(showCreateModal || showEditModal) && (
        <Modal
          isOpen
          onClose={closeForm}
          size="lg"
          title={showEditModal ? 'Edit Maintenance Window' : 'Schedule Maintenance'}
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
                onClick={handleCreate}
                loading={saving}
                disabled={!formData.title || !formData.scheduledStart}
              >
                {showEditModal ? 'Update' : 'Schedule Maintenance'}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Title <span className="text-red-500">*</span>
              </label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Maintenance title"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="What will be done during this maintenance?"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Type
                </label>
                <Select
                  value={formData.type}
                  onChange={(e) =>
                    setFormData({ ...formData, type: e.target.value as MaintenanceForm['type'] })
                  }
                  options={[
                    { value: 'scheduled', label: 'Scheduled' },
                    { value: 'emergency', label: 'Emergency' },
                    { value: 'rolling_update', label: 'Rolling Update' },
                    { value: 'database_migration', label: 'Database Migration' },
                    { value: 'security_patch', label: 'Security Patch' },
                  ]}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Scope
                </label>
                <Select
                  value={formData.scope}
                  onChange={(e) =>
                    setFormData({ ...formData, scope: e.target.value as MaintenanceForm['scope'] })
                  }
                  options={[
                    { value: 'global', label: 'Global' },
                    { value: 'tenant', label: 'Tenant' },
                    { value: 'service', label: 'Service' },
                    { value: 'region', label: 'Region' },
                  ]}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Start Date & Time <span className="text-red-500">*</span>
                </label>
                <Input
                  type="datetime-local"
                  value={formData.scheduledStart}
                  onChange={(e) => setFormData({ ...formData, scheduledStart: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Estimated Duration (minutes)
                </label>
                <Input
                  type="number"
                  value={formData.estimatedDurationMinutes}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      estimatedDurationMinutes: parseInt(e.target.value) || 60,
                    })
                  }
                  placeholder="60"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                User Message
              </label>
              <textarea
                value={formData.userMessage}
                onChange={(e) => setFormData({ ...formData, userMessage: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Message shown to users during maintenance"
              />
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.allowReadOnlyAccess}
                  onChange={(e) =>
                    setFormData({ ...formData, allowReadOnlyAccess: e.target.checked })
                  }
                  className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Allow Read-Only Access
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.bypassForSuperAdmins}
                  onChange={(e) =>
                    setFormData({ ...formData, bypassForSuperAdmins: e.target.checked })
                  }
                  className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Bypass for Super Admins
                </span>
              </label>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default MaintenancePage;
