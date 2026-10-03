import { DynamicMeasurementForm } from '@aquaculture/farm-shared';
import type { ParameterFieldConfig } from '@aquaculture/farm-shared';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { useQuery } from '@tanstack/react-query';
import { gql } from 'graphql-tag';
import { Droplets, AlertCircle } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AlreadyRecordedNotice } from '@/components/AlreadyRecordedNotice';
import { AppHeader } from '@/components/AppHeader';
import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { Card, DataState, EmptyState, Select } from '@/components/ui';
import type {
  EquipmentListQuery,
  EquipmentListQueryVariables,
  EquipmentParametersQuery,
  EquipmentParametersQueryVariables,
} from '@/generated/graphql';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { QueuedPayload } from '@/types';
import { toLoadable } from '@/utils/loadable';
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
const EQUIPMENT_LIST_QUERY: TypedDocumentNode<EquipmentListQuery, EquipmentListQueryVariables> =
  gql`
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

const EQUIPMENT_PARAMS_QUERY: TypedDocumentNode<
  EquipmentParametersQuery,
  EquipmentParametersQueryVariables
> = gql`
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

  const [selectedEquipmentId, setSelectedEquipmentId] = useState(routeEquipmentId || '');
  // Two-phase success UX (C7): the badge tracks the queued op's real sync
  // status; a deduped double-tap renders "Already recorded" (FE-HIGH-050).
  const [queuedOperationId, setQueuedOperationId] = useState('');
  const [wasDuplicate, setWasDuplicate] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (routeEquipmentId) setSelectedEquipmentId(routeEquipmentId);
  }, [routeEquipmentId]);

  // -- Equipment list --------------------------------------------------------
  // Uses isActive filter to include ALL active equipment (tanks, sensors, pumps)
  // regardless of operational status. This matches the web RecordTab behavior.
  const equipmentQuery = useQuery<EquipmentItem[]>({
    queryKey: createTenantQueryKey(tenantId, 'equipment-list', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest(EQUIPMENT_LIST_QUERY, { filter: { isActive: true } });
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
      const result = await graphqlRequest(EQUIPMENT_PARAMS_QUERY, {
        equipmentId: selectedEquipmentId,
      });
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

  // -- Submit handler --------------------------------------------------------
  const handleSubmit = useCallback(
    async (values: Record<string, FieldValue>, notes: string, weatherConditions?: string) => {
      setSubmitError(null);
      const dynamicParameters = Object.fromEntries(
        Object.entries(values).map(([parameterCode, value]) => [parameterCode, value]),
      ) as Record<string, number | string | boolean>;
      const input: QueuedPayload<'createWaterQuality'> = {
        equipmentId: selectedEquipmentId,
        measuredAt: new Date().toISOString(),
        source: 'MANUAL',
        idempotencyKey: crypto.randomUUID(),
        dynamicParameters,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(weatherConditions?.trim() ? { weatherConditions: weatherConditions.trim() } : {}),
      };
      setIsSubmitting(true);
      try {
        // Queue-first (MOB-CRITICAL-021): the queue is the platform's single
        // write path. Online, addToQueue drains immediately; offline, the
        // record waits for reconnect. Either way the success screen shows the
        // op's REAL sync status instead of a green "recorded" for a payload
        // that may never have reached the server.
        const result = await addToQueue('createWaterQuality', input);
        addMRU(selectedEquipmentId);
        setQueuedOperationId(result.id);
        setWasDuplicate(result.status === 'duplicate');
        setTimeout(() => navigate('/'), 2000);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Failed to record measurement');
      } finally {
        setIsSubmitting(false);
      }
    },
    [selectedEquipmentId, addToQueue, navigate],
  );

  const handleEquipmentChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedEquipmentId(e.target.value);
    setSubmitError(null);
  }, []);

  // -- Success screen: honest sync status, never an unconditional green ------
  if (queuedOperationId !== '') {
    return (
      // No page tint: the ground belongs to <body>; the receipt carries the colour.
      <div className="flex flex-col items-center justify-center min-h-screen">
        {wasDuplicate ? (
          <AlreadyRecordedNotice />
        ) : (
          <QueuedStatusBadge operationId={queuedOperationId} />
        )}
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
              <Select
                label="Select Equipment"
                value={selectedEquipmentId}
                onChange={handleEquipmentChange}
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
              </Select>
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
                isSubmitting={isSubmitting}
                error={submitError}
                showWeather
              />
            )}
          </DataState>
        </div>
      )}

      {/* Offline indicator */}
      {!isOnline && (
        <Card className="fixed bottom-nav-gap left-4 right-4 p-3 text-center border-warn">
          <span className="text-warn text-body font-medium">
            You are offline. Measurements will be synced when connected.
          </span>
        </Card>
      )}
    </div>
  );
}
