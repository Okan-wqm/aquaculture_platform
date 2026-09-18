/**
 * RecordTab — Water quality measurement recording
 *
 * Allows the user to select equipment and record water quality measurements
 * using the DynamicMeasurementForm component from @aquaculture/farm-shared.
 *
 * Features:
 * - System filter (optional) to narrow equipment list
 * - Equipment selector with MRU (most recently used) stored in localStorage
 * - DynamicMeasurementForm driven by equipment's mapped parameter configs
 * - Recent entries panel showing last 5 measurements
 * - Client-side idempotencyKey via crypto.randomUUID()
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { DynamicMeasurementForm } from '@aquaculture/farm-shared';
import { useAuth, useTenantScopedStorage } from '@aquaculture/shared-ui';
import { useEquipmentParameterConfigs } from '../../../hooks/useEquipmentParameters';
import { useSystemList } from '../../../hooks/useSystems';
import { useEquipmentList } from '../../../hooks/useEquipment';
import { useCreateWaterQuality, useWaterQualityList } from '../../../hooks/useWaterQuality';
import type { Equipment } from '../../../hooks/useEquipment';
import type { System } from '../../../hooks/useSystems';

// ============================================================================
// CONSTANTS
// ============================================================================

// Base key for the per-tenant MRU equipment list. The real localStorage key is
// namespaced + tenant-scoped by useTenantScopedStorage, so it can never leak
// across tenants on a shared browser and is swept on logout.
const MRU_BASE_KEY = 'wq-mru-equipment';
const MAX_MRU = 5;
const RECENT_ENTRIES_LIMIT = 5;

// ============================================================================
// COMPONENT
// ============================================================================

type FieldValue = number | string | boolean;

export const RecordTab: React.FC = () => {
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Per-tenant MRU equipment list (namespaced + tenant-scoped + logout-swept).
  const { tenantId } = useAuth();
  const mruStorage = useTenantScopedStorage<string[]>(MRU_BASE_KEY, tenantId);

  // ----- Data hooks -----
  const systemsQuery = useSystemList();
  // BUG-FIX: Previously used { status: 'ACTIVE' } which only returns tank equipment
  // (EquipmentStatus.ACTIVE is tank-specific = "has fish"). Non-tank equipment
  // like sensors, pumps, filters have status = 'operational' and were excluded.
  // Using { isActive: true } returns ALL active equipment regardless of status,
  // matching the EquipmentMappingPanel (parameters tab) behavior.
  const equipmentQuery = useEquipmentList(
    selectedSystemId
      ? { isActive: true, systemId: selectedSystemId }
      : { isActive: true },
  );
  const parameterConfigs = useEquipmentParameterConfigs(selectedEquipmentId);
  const createMutation = useCreateWaterQuality();

  // Recent entries for selected equipment
  const recentEntriesQuery = useWaterQualityList(
    selectedEquipmentId
      ? { tankId: selectedEquipmentId, limit: RECENT_ENTRIES_LIMIT }
      : undefined,
  );

  // ----- Derived data -----
  const systems: readonly System[] = systemsQuery.data?.items ?? [];

  // System filtering is now done server-side via { systemId } in the query filter
  // (see equipmentQuery above), so no client-side filter needed.
  const filteredEquipment: readonly Equipment[] = useMemo(
    () => equipmentQuery.data?.items ?? [],
    [equipmentQuery.data],
  );

  // Sort equipment: MRU first
  const sortedEquipment = useMemo(() => {
    const mru = mruStorage.read() ?? [];
    return [...filteredEquipment].sort((a, b) => {
      const aIdx = mru.indexOf(a.id);
      const bIdx = mru.indexOf(b.id);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [filteredEquipment, mruStorage]);

  // Auto-select MRU equipment on mount
  useEffect(() => {
    if (selectedEquipmentId) return;
    const mru = mruStorage.read() ?? [];
    if (mru.length > 0 && filteredEquipment.some((eq) => eq.id === mru[0])) {
      setSelectedEquipmentId(mru[0]);
    }
  }, [filteredEquipment, selectedEquipmentId, mruStorage]);

  // ----- Handlers -----
  const handleEquipmentChange = useCallback(
    (id: string) => {
      setSelectedEquipmentId(id || null);
      setSubmitError(null);
      if (id) {
        const next = (mruStorage.read() ?? []).filter((v) => v !== id);
        next.unshift(id);
        mruStorage.write(next.slice(0, MAX_MRU));
      }
    },
    [mruStorage],
  );

  const handleSystemChange = useCallback((id: string) => {
    setSelectedSystemId(id || null);
    setSelectedEquipmentId(null);
    setSubmitError(null);
  }, []);

  const handleSubmit = useCallback(
    (values: Record<string, FieldValue>, notes: string, weatherConditions?: string) => {
      if (!selectedEquipmentId) return;

      const idempotencyKey = crypto.randomUUID();

      // SINGLE-INGRESS (Tier-1): the form `values` are already keyed by the
      // equipment's tenant-configured parameter codes (from
      // useEquipmentParameterConfigs), so they ARE the dynamicParameters
      // payload. Preserve number/string/boolean field types (enum + boolean
      // configs would be corrupted by a blanket parseFloat). Empty strings are
      // dropped — an unfilled optional field must not become NaN or "".
      const dynamicParameters: Record<string, number | string | boolean> = {};
      for (const [key, val] of Object.entries(values)) {
        if (typeof val === 'number') {
          if (!Number.isNaN(val)) dynamicParameters[key] = val;
        } else if (typeof val === 'boolean') {
          dynamicParameters[key] = val;
        } else if (typeof val === 'string' && val !== '') {
          dynamicParameters[key] = val;
        }
      }

      setSubmitError(null);

      createMutation.mutate(
        {
          equipmentId: selectedEquipmentId,
          tankId: selectedEquipmentId,
          measuredAt: new Date().toISOString(),
          source: 'MANUAL' as const,
          dynamicParameters,
          notes: notes || undefined,
          weatherConditions: weatherConditions || undefined,
          idempotencyKey,
        },
        {
          onError: (error: Error) => {
            setSubmitError(error.message || 'Failed to save measurement');
          },
        },
      );
    },
    [selectedEquipmentId, createMutation],
  );

  // ----- Render helpers -----
  const selectedEquipmentName = filteredEquipment.find(
    (eq) => eq.id === selectedEquipmentId,
  )?.name;

  const recentEntries = recentEntriesQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      {/* Selectors Row */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* System selector (optional) */}
          <div>
            <label
              htmlFor="record-system-select"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              System (optional)
            </label>
            <select
              id="record-system-select"
              value={selectedSystemId ?? ''}
              onChange={(e) => handleSystemChange(e.target.value)}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
            >
              <option value="">All Systems</option>
              {systems.map((sys) => (
                <option key={sys.id} value={sys.id}>
                  {sys.name} ({sys.code})
                </option>
              ))}
            </select>
          </div>

          {/* Equipment selector */}
          <div>
            <label
              htmlFor="record-equipment-select"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Equipment
            </label>
            <select
              id="record-equipment-select"
              value={selectedEquipmentId ?? ''}
              onChange={(e) => handleEquipmentChange(e.target.value)}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
            >
              <option value="">Select equipment...</option>
              {sortedEquipment.map((eq) => (
                <option key={eq.id} value={eq.id}>
                  {eq.name} ({eq.code})
                  {eq.equipmentType ? ` — ${eq.equipmentType.name}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Empty state: no equipment selected */}
      {!selectedEquipmentId && (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            Select equipment to start recording
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Choose a system and equipment above to record water quality measurements.
          </p>
        </div>
      )}

      {/* Empty state: no parameters mapped */}
      {selectedEquipmentId &&
        !parameterConfigs.isLoading &&
        (parameterConfigs.data?.length ?? 0) === 0 && (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <svg
              className="mx-auto h-12 w-12 text-yellow-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              No parameters configured for this equipment
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Go to the Parameters tab to configure and map parameters to{' '}
              <strong>{selectedEquipmentName}</strong>.
            </p>
          </div>
        )}

      {/* Loading state */}
      {selectedEquipmentId && parameterConfigs.isLoading && (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto" />
          <p className="mt-2 text-sm text-gray-500">Loading parameter configuration...</p>
        </div>
      )}

      {/* Measurement Form */}
      {selectedEquipmentId &&
        !parameterConfigs.isLoading &&
        (parameterConfigs.data?.length ?? 0) > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-base font-semibold text-gray-900 mb-4">
              Record Measurement — {selectedEquipmentName}
            </h3>
            <DynamicMeasurementForm
              variant="desktop"
              parameters={parameterConfigs.data ?? []}
              onSubmit={handleSubmit}
              isSubmitting={createMutation.isPending}
              error={submitError}
              showWeather
              translations={{
                submit: 'Save Measurement',
                notes: 'Notes',
                weather: 'Weather Conditions',
                required: 'Required',
                noParameters: 'No parameters configured for this equipment.',
              }}
            />
            {createMutation.isSuccess && (
              <div className="mt-3 rounded-md bg-green-50 p-3">
                <p className="text-sm text-green-800">Measurement saved successfully.</p>
              </div>
            )}
          </div>
        )}

      {/* Recent Entries Panel */}
      {selectedEquipmentId && recentEntries.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">
              Recent Entries — {selectedEquipmentName}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Source</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recentEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-900">
                      {new Date(entry.measuredAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-600">
                      {entry.source}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          entry.overallStatus === 'OPTIMAL'
                            ? 'bg-green-100 text-green-800'
                            : entry.overallStatus === 'WARNING'
                              ? 'bg-yellow-100 text-yellow-800'
                              : entry.overallStatus === 'CRITICAL'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {entry.overallStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 truncate max-w-[200px]">
                      {entry.notes || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
