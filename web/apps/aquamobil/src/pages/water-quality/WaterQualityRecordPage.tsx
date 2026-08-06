import { DynamicMeasurementForm } from '@aquaculture/farm-shared';
import type { ParameterFieldConfig } from '@aquaculture/farm-shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gql } from 'graphql-tag';
import { Droplets, CheckCircle, AlertCircle } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Card, DataState, EmptyState } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { CreateWaterQualityInput } from '@/types';
import { toLoadable } from '@/utils/loadable';
import { isRecoverableNetworkError } from '@/utils/network-error';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// ============================================================================
// TYPES
// ============================================================================

interface EquipmentItem {
  id: string;
  name: string;
  code: string;
  equipmentType: { category: string; name: string } | null;
}

interface EquipmentParameterConfig {
  parameterConfig: {
    id: string;
    code: string;
    name: string;
    unit: string;
    dataType: 'NUMBER' | 'ENUM' | 'BOOLEAN';
    precision: number;
    group: string;
    optimalMin: number | null;
    optimalMax: number | null;
    warningMin: number | null;
    warningMax: number | null;
    criticalMin: number | null;
    criticalMax: number | null;
    enumValues: string[] | null;
    displayOrder: number;
    isRequired: boolean;
    chartColor: string;
  };
}

type FieldValue = number | string | boolean;

// ============================================================================
// GRAPHQL
// ============================================================================

/**
 * Fetch all active equipment using the equipmentList query.
 * Uses { isActive: true } filter to match the web RecordTab behavior,
 * ensuring non-tank equipment (sensors, pumps, filters) with
 * status='operational' are included alongside tank equipment (status='active').
 */
const EQUIPMENT_LIST_QUERY = gql`
  query EquipmentList($filter: EquipmentFilterInput) {
    equipmentList(filter: $filter) {
      items {
        id
        name
        code
        equipmentType {
          category
          name
        }
      }
    }
  }
`;

const EQUIPMENT_PARAMS_QUERY = gql`
  query EquipmentParameters($equipmentId: ID!) {
    equipmentParameters(equipmentId: $equipmentId) {
      parameterConfig {
        id
        code
        name
        unit
        dataType
        precision
        group
        optimalMin
        optimalMax
        warningMin
        warningMax
        criticalMin
        criticalMax
        enumValues
        displayOrder
        isRequired
        chartColor
      }
    }
  }
`;

const CREATE_WQ_MUTATION = gql`
  mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!) {
    createWaterQualityMeasurement(input: $input) {
      id
      overallStatus
      hasAlarm
    }
  }
`;

// ============================================================================
// MRU (Most Recently Used)
// ============================================================================

const MRU_KEY = 'aquamobil-wq-mru';

function getMRU(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MRU_KEY) || '[]') as string[];
  } catch {
    return [];
  }
}

function addMRU(id: string): void {
  const mru = getMRU().filter((x) => x !== id);
  mru.unshift(id);
  localStorage.setItem(MRU_KEY, JSON.stringify(mru.slice(0, 3)));
}

// ============================================================================
// COMPONENT
// ============================================================================

export function WaterQualityRecordPage(): JSX.Element {
  const navigate = useNavigate();
  const { equipmentId: routeEquipmentId } = useParams<{ equipmentId?: string }>();
  const { accessToken, tenantId, isAuthenticated } = useAuth();
  const { isOnline, addToQueue } = useOfflineQueue();
  const queryClient = useQueryClient();

  const [selectedEquipmentId, setSelectedEquipmentId] = useState(routeEquipmentId || '');
  const [showSuccess, setShowSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isQueueSubmitting, setIsQueueSubmitting] = useState(false);

  useEffect(() => {
    if (routeEquipmentId) setSelectedEquipmentId(routeEquipmentId);
  }, [routeEquipmentId]);

  // -- Equipment list --------------------------------------------------------
  // Uses isActive filter to include ALL active equipment (tanks, sensors, pumps)
  // regardless of operational status. This matches the web RecordTab behavior.
  const equipmentQuery = useQuery<EquipmentItem[]>({
    queryKey: createTenantQueryKey(tenantId, 'equipment-list', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{ equipmentList: { items: EquipmentItem[] } }>(
        EQUIPMENT_LIST_QUERY,
        { filter: { isActive: true } },
      );
      return result.equipmentList?.items ?? [];
    },
    // Offline-capable: React Query serves stale cache when offline (gcTime: 1h).
    // Removing isOnline from enabled ensures the form is usable at remote cage
    // sites with intermittent connectivity — equipment list loads from cache.
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
  const equipment = useMemo(() => equipmentQuery.data ?? [], [equipmentQuery.data]);
  // The picker is the load-bearing control on this screen: it decides WHICH
  // equipment the reading is written against. A failed fetch used to leave the
  // <select> holding nothing but its placeholder, i.e. "this tenant has no
  // equipment" — a different claim from "we could not read the list", and the
  // one that makes a worker walk away. Loadable makes the error arm unskippable.
  const equipmentView = toLoadable(equipmentQuery);

  // -- MRU-sorted + grouped equipment for <select> ---------------------------
  const mruIds = useMemo(() => getMRU(), []);

  const groupedEquipment = useMemo(() => {
    const groups: Record<string, Array<{ id: string; name: string; code: string }>> = {};
    const mruItems = mruIds
      .map((id) => equipment.find((eq) => eq.id === id))
      .filter((eq): eq is EquipmentItem => eq != null);
    if (mruItems.length > 0) {
      groups['Recently Used'] = mruItems.map((eq) => ({ id: eq.id, name: eq.name, code: eq.code }));
    }
    equipment.forEach((eq) => {
      const cat = eq.equipmentType?.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      if (!mruIds.includes(eq.id) || cat !== 'Recently Used') {
        groups[cat].push({ id: eq.id, name: eq.name, code: eq.code });
      }
    });
    return groups;
  }, [equipment, mruIds]);

  // -- Parameter configs for selected equipment ------------------------------
  const parametersQuery = useQuery<ParameterFieldConfig[]>({
    queryKey: createTenantQueryKey(tenantId, 'equipment-params', selectedEquipmentId, tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{ equipmentParameters: EquipmentParameterConfig[] }>(
        EQUIPMENT_PARAMS_QUERY,
        { equipmentId: selectedEquipmentId },
      );
      return (result.equipmentParameters ?? [])
        .map((ep) => {
          const pc = ep.parameterConfig;
          return {
            code: pc.code,
            name: pc.name,
            unit: pc.unit,
            dataType: pc.dataType,
            precision: pc.precision,
            enumValues: pc.enumValues,
            isRequired: pc.isRequired,
            group: pc.group,
            displayOrder: pc.displayOrder,
            chartColor: pc.chartColor,
            limits: {
              optimalMin: pc.optimalMin,
              optimalMax: pc.optimalMax,
              warningMin: pc.warningMin,
              warningMax: pc.warningMax,
              criticalMin: pc.criticalMin,
              criticalMax: pc.criticalMax,
            },
          } satisfies ParameterFieldConfig;
        })
        .sort((a, b) => a.displayOrder - b.displayOrder);
    },
    // Offline-capable: parameter configs served from React Query cache when offline.
    enabled: !!selectedEquipmentId && isAuthenticated && !!accessToken,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });
  // Same reason as the picker, one step further in: a failed parameter fetch
  // rendered NOTHING AT ALL under the selector — no form, no message — which
  // reads as "this equipment has nothing to measure". The three states are now
  // separately drawn, and only the ready one reaches the form.
  const parametersView = toLoadable(parametersQuery);

  // -- Create mutation -------------------------------------------------------
  const { mutateAsync: createMeasurement, isPending: isSubmitting } = useMutation({
    mutationFn: async (input: CreateWaterQualityInput) =>
      graphqlRequest<{
        createWaterQualityMeasurement: { id: string; overallStatus: string; hasAlarm: boolean };
      }>(CREATE_WQ_MUTATION, { input }),
    onSuccess: async () => {
      if (tenantId) {
        await invalidateSyncedOperationQueries(queryClient, tenantId, ['createWaterQuality']);
      }
    },
  });

  // -- Submit handler --------------------------------------------------------
  const handleSubmit = useCallback(
    async (values: Record<string, FieldValue>, notes: string, weatherConditions?: string) => {
      setSubmitError(null);
      const dynamicParameters = Object.fromEntries(
        Object.entries(values).map(([parameterCode, value]) => [parameterCode, value]),
      ) as Record<string, number | string | boolean>;
      const input: CreateWaterQualityInput = {
        equipmentId: selectedEquipmentId,
        measuredAt: new Date().toISOString(),
        source: 'MANUAL',
        idempotencyKey: crypto.randomUUID(),
        // `parameters` was sent here as an empty object for a field the schema does
        // not declare. GraphQL rejects unknown input fields, so every reading this
        // page produced was invalid — and offline it failed on replay, after the
        // worker had been told it was saved. Readings travel in dynamicParameters.
        dynamicParameters,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(weatherConditions?.trim() ? { weatherConditions: weatherConditions.trim() } : {}),
      };
      setIsQueueSubmitting(true);
      try {
        if (isOnline) {
          await createMeasurement(input);
        } else {
          await addToQueue('createWaterQuality', input);
        }
        addMRU(selectedEquipmentId);
        setShowSuccess(true);
        setTimeout(() => navigate('/'), 1500);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to record measurement';
        if (isRecoverableNetworkError(error)) {
          try {
            await addToQueue('createWaterQuality', input);
            addMRU(selectedEquipmentId);
            setShowSuccess(true);
            setTimeout(() => navigate('/'), 1500);
            return;
          } catch (queueError) {
            setSubmitError(
              queueError instanceof Error ? queueError.message : 'Failed to queue measurement',
            );
            return;
          }
        }
        setSubmitError(message);
      } finally {
        setIsQueueSubmitting(false);
      }
    },
    [selectedEquipmentId, isOnline, createMeasurement, addToQueue, navigate],
  );

  const handleEquipmentChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedEquipmentId(e.target.value);
    setSubmitError(null);
  }, []);

  // -- Success screen --------------------------------------------------------
  if (showSuccess) {
    return (
      // No page tint: the ground belongs to <body>, so the confirmation mark and
      // its headline are the only things carrying colour — and green means the
      // same thing here as everywhere else in the app.
      <div className="flex flex-col items-center justify-center min-h-screen">
        <div className="w-20 h-20 bg-surface-2 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-ok" />
        </div>
        <h2 className="text-head font-bold text-ok">Measurement Recorded!</h2>
        <p className="text-ink-2 text-body mt-1">Returning to home...</p>
      </div>
    );
  }

  // -- Main render -----------------------------------------------------------
  return (
    <div className="min-h-screen">
      {/* v4: the cyan→blue gradient bar becomes the app's one header. The water
          hue survives on the Droplets mark, which is what identified the screen;
          the gradient only cost contrast in daylight. */}
      <AppHeader
        title="Water Quality"
        subtitle="Record measurements"
        onBack={() => navigate(-1)}
        showAvatar={false}
        actions={<Droplets size={20} className="text-type-water" aria-hidden />}
      />

      {/* Error Banner */}
      {submitError && (
        <Card className="mx-4 mt-3 p-3 flex items-center gap-2 border-crit" role="alert">
          <AlertCircle size={18} className="text-crit flex-shrink-0" />
          <span className="text-crit text-body">{submitError}</span>
        </Card>
      )}

      {/* Equipment Selector — the write path's SSoT (ORPHAN-CRITICAL-581): the
          reading is stored against whatever is chosen here, so this control is
          load-bearing, not chrome. */}
      {!routeEquipmentId && (
        <div className="px-4 mt-4">
          <DataState
            value={equipmentView}
            label="the equipment list"
            skeleton="row"
            skeletonCount={1}
            empty={
              <EmptyState
                icon={<Droplets size={22} />}
                title="No equipment"
                description="No active equipment is assigned to this tenant yet."
              />
            }
          >
            {() => (
              /* The Konsta block title above the list was a heading pointing at
                 nothing; it is now the select's own caption, so the control is
                 named rather than merely preceded by a title. */
              <label className="block">
                <span className="block text-body font-semibold text-ink-1 mb-2">
                  Select Equipment
                </span>
                <select
                  value={selectedEquipmentId}
                  onChange={handleEquipmentChange}
                  className="w-full min-h-touch px-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body focus:outline-none focus:ring-2 focus:ring-acc"
                >
                  <option value="">-- Select Equipment --</option>
                  {Object.entries(groupedEquipment).map(([category, items]) => (
                    <optgroup key={category} label={category}>
                      {items.map((eq) => (
                        <option key={eq.id} value={eq.id}>
                          {eq.name} ({eq.code})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            )}
          </DataState>
        </div>
      )}

      {/* Dynamic Measurement Form — the parameter set is the equipment's own
          ParameterFieldConfig, so it can be loading, absent, or unreadable, and
          those are three different things. */}
      {selectedEquipmentId && (
        <div className="px-4 mt-4 pb-safe-bottom pb-8">
          <DataState
            value={parametersView}
            label="this equipment's parameters"
            skeleton="row"
            skeletonCount={4}
            empty={
              <EmptyState
                icon={<AlertCircle size={22} />}
                title="No parameters configured"
                description="This equipment has no water quality parameters assigned."
              />
            }
          >
            {(parameters) => (
              <DynamicMeasurementForm
                variant="mobile"
                parameters={parameters}
                onSubmit={(values, notes, weatherConditions) => {
                  void handleSubmit(values, notes, weatherConditions);
                }}
                isSubmitting={isSubmitting || isQueueSubmitting}
                error={submitError}
                showWeather
              />
            )}
          </DataState>
        </div>
      )}

      {/* Offline indicator */}
      {!isOnline && (
        <Card className="fixed bottom-20 left-4 right-4 p-3 text-center border-warn">
          <span className="text-warn text-body font-medium">
            You are offline. Measurements will be synced when connected.
          </span>
        </Card>
      )}
    </div>
  );
}
