import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BlockTitle, List, ListInput } from 'konsta/react';
import { ArrowLeft, Droplets, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { DynamicMeasurementForm } from '@aquaculture/farm-shared';
import type { ParameterFieldConfig } from '@aquaculture/farm-shared';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
    id: string; code: string; name: string; unit: string;
    dataType: 'NUMBER' | 'ENUM' | 'BOOLEAN'; precision: number; group: string;
    optimalMin: number | null; optimalMax: number | null;
    warningMin: number | null; warningMax: number | null;
    criticalMin: number | null; criticalMax: number | null;
    enumValues: string[] | null; displayOrder: number; isRequired: boolean; chartColor: string;
  };
}

type FieldValue = number | string | boolean;

/**
 * Measurement entry for a single parameter in a water quality record.
 * The backend accepts these as dynamic parameters keyed by parameterCode.
 */
interface MeasurementEntry {
  parameterCode: string;
  value: number | string;
}

/**
 * Typed input for the CreateWaterQualityMeasurement mutation.
 * Replaces Record<string, unknown> to ensure compile-time safety.
 */
interface CreateWqMeasurementInput {
  equipmentId: string;
  measuredAt: string;
  idempotencyKey: string;
  measurements: MeasurementEntry[];
  notes?: string;
  weatherConditions?: string;
}

// ============================================================================
// GRAPHQL
// ============================================================================

/**
 * Fetch all active equipment using the equipmentList query.
 * Uses { isActive: true } filter to match the web RecordTab behavior,
 * ensuring non-tank equipment (sensors, pumps, filters) with
 * status='operational' are included alongside tank equipment (status='active').
 */
const EQUIPMENT_LIST_QUERY = `
  query EquipmentList($filter: EquipmentFilterInput) {
    equipmentList(filter: $filter) { items { id name code equipmentType { category name } } }
  }
`;

const EQUIPMENT_PARAMS_QUERY = `
  query EquipmentParameters($equipmentId: ID!) {
    equipmentParameters(equipmentId: $equipmentId) {
      parameterConfig {
        id code name unit dataType precision group
        optimalMin optimalMax warningMin warningMax criticalMin criticalMax
        enumValues displayOrder isRequired chartColor
      }
    }
  }
`;

const CREATE_WQ_MUTATION = `
  mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!) {
    createWaterQualityMeasurement(input: $input) { id overallStatus hasAlarm }
  }
`;

// ============================================================================
// MRU (Most Recently Used)
// ============================================================================

const MRU_KEY = 'aquamobil-wq-mru';

function getMRU(): string[] {
  try { return JSON.parse(localStorage.getItem(MRU_KEY) || '[]') as string[]; }
  catch { return []; }
}

function addMRU(id: string): void {
  const mru = getMRU().filter((x) => x !== id);
  mru.unshift(id);
  localStorage.setItem(MRU_KEY, JSON.stringify(mru.slice(0, 3)));
}

// ============================================================================
// COMPONENT
// ============================================================================

export function WaterQualityRecordPage() {
  const navigate = useNavigate();
  const { equipmentId: routeEquipmentId } = useParams<{ equipmentId?: string }>();
  const { accessToken, tenantId, isAuthenticated } = useAuth();
  const { isOnline } = useOfflineQueue();
  const queryClient = useQueryClient();

  const [selectedEquipmentId, setSelectedEquipmentId] = useState(routeEquipmentId || '');
  const [showSuccess, setShowSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (routeEquipmentId) setSelectedEquipmentId(routeEquipmentId);
  }, [routeEquipmentId]);

  // -- Equipment list --------------------------------------------------------
  // Uses isActive filter to include ALL active equipment (tanks, sensors, pumps)
  // regardless of operational status. This matches the web RecordTab behavior.
  const { data: equipmentData, isLoading: equipmentLoading } = useQuery<EquipmentItem[]>({
    queryKey: ['equipment-list', tenantId],
    queryFn: async () => {
      const result = await graphqlRequest<{ equipmentList: { items: EquipmentItem[] } }>(
        EQUIPMENT_LIST_QUERY, { filter: { isActive: true } },
      );
      return result.equipmentList?.items ?? [];
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId && isOnline,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
  const equipment = equipmentData ?? [];

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
  const { data: parameterConfigs, isLoading: paramsLoading } = useQuery<ParameterFieldConfig[]>({
    queryKey: ['equipment-params', selectedEquipmentId, tenantId],
    queryFn: async () => {
      const result = await graphqlRequest<{ equipmentParameters: EquipmentParameterConfig[] }>(
        EQUIPMENT_PARAMS_QUERY, { equipmentId: selectedEquipmentId },
      );
      return (result.equipmentParameters ?? [])
        .map((ep) => {
          const pc = ep.parameterConfig;
          return {
            code: pc.code, name: pc.name, unit: pc.unit, dataType: pc.dataType,
            precision: pc.precision, enumValues: pc.enumValues, isRequired: pc.isRequired,
            group: pc.group, displayOrder: pc.displayOrder, chartColor: pc.chartColor,
            limits: {
              optimalMin: pc.optimalMin, optimalMax: pc.optimalMax,
              warningMin: pc.warningMin, warningMax: pc.warningMax,
              criticalMin: pc.criticalMin, criticalMax: pc.criticalMax,
            },
          } satisfies ParameterFieldConfig;
        })
        .sort((a, b) => a.displayOrder - b.displayOrder);
    },
    enabled: !!selectedEquipmentId && isAuthenticated && !!accessToken && isOnline,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });

  // -- Create mutation -------------------------------------------------------
  const { mutateAsync: createMeasurement, isPending: isSubmitting } = useMutation({
    mutationFn: async (input: CreateWqMeasurementInput) =>
      graphqlRequest<{ createWaterQualityMeasurement: { id: string; overallStatus: string; hasAlarm: boolean } }>(
        CREATE_WQ_MUTATION, { input },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['equipment-params', selectedEquipmentId] });
    },
  });

  // -- Submit handler --------------------------------------------------------
  const handleSubmit = useCallback(
    async (values: Record<string, FieldValue>, notes: string, weatherConditions?: string) => {
      setSubmitError(null);
      const measurements: MeasurementEntry[] = Object.entries(values).map(([parameterCode, value]) => ({
        parameterCode,
        value: typeof value === 'boolean' ? String(value) : value,
      }));
      const input: CreateWqMeasurementInput = {
        equipmentId: selectedEquipmentId,
        measuredAt: new Date().toISOString(),
        idempotencyKey: crypto.randomUUID(),
        measurements,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(weatherConditions?.trim() ? { weatherConditions: weatherConditions.trim() } : {}),
      };
      try {
        await createMeasurement(input);
        addMRU(selectedEquipmentId);
        setShowSuccess(true);
        setTimeout(() => navigate('/'), 1500);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to record measurement';
        setSubmitError(message);
      }
    },
    [selectedEquipmentId, createMeasurement, navigate],
  );

  const handleEquipmentChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedEquipmentId(e.target.value);
      setSubmitError(null);
    },
    [],
  );

  // -- Success screen --------------------------------------------------------
  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-green-50 dark:bg-green-900/10">
        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-green-600" />
        </div>
        <h2 className="text-xl font-bold text-green-700 dark:text-green-300">Measurement Recorded!</h2>
        <p className="text-green-600 dark:text-green-400 text-sm mt-1">Returning to home...</p>
      </div>
    );
  }

  // -- Main render -----------------------------------------------------------
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Gradient Header */}
      <div className="bg-gradient-to-r from-cyan-600 to-blue-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <Droplets size={22} />
            <div>
              <h1 className="text-lg font-bold">Water Quality</h1>
              <p className="text-xs text-white/80">Record measurements</p>
            </div>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {submitError && (
        <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <span className="text-red-600 dark:text-red-300 text-sm">{submitError}</span>
        </div>
      )}

      {/* Equipment Selector */}
      {!routeEquipmentId && (
        <>
          <BlockTitle>Select Equipment</BlockTitle>
          <List strongIos insetIos>
            <ListInput type="select" value={selectedEquipmentId} onChange={handleEquipmentChange}>
              <option value="">-- Select Equipment --</option>
              {Object.entries(groupedEquipment).map(([category, items]) => (
                <optgroup key={category} label={category}>
                  {items.map((eq) => (
                    <option key={eq.id} value={eq.id}>{eq.name} ({eq.code})</option>
                  ))}
                </optgroup>
              ))}
            </ListInput>
          </List>
        </>
      )}

      {/* Loading states */}
      {equipmentLoading && !routeEquipmentId && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={28} className="animate-spin text-cyan-600" />
          <span className="ml-2 text-gray-500 text-sm">Loading equipment...</span>
        </div>
      )}
      {selectedEquipmentId && paramsLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={28} className="animate-spin text-cyan-600" />
          <span className="ml-2 text-gray-500 text-sm">Loading parameters...</span>
        </div>
      )}

      {/* No parameters warning */}
      {selectedEquipmentId && !paramsLoading && parameterConfigs && parameterConfigs.length === 0 && (
        <div className="mx-4 mt-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
          <p className="text-amber-700 dark:text-amber-300 font-medium">No parameters configured</p>
          <p className="text-amber-600 dark:text-amber-400 text-sm mt-1">
            This equipment has no water quality parameters assigned.
          </p>
        </div>
      )}

      {/* Dynamic Measurement Form */}
      {selectedEquipmentId && parameterConfigs && parameterConfigs.length > 0 && (
        <div className="px-4 mt-4 pb-safe-bottom pb-8">
          <DynamicMeasurementForm
            variant="mobile"
            parameters={parameterConfigs}
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
            error={submitError}
            showWeather
          />
        </div>
      )}

      {/* Offline indicator */}
      {!isOnline && (
        <div className="fixed bottom-20 left-4 right-4 bg-amber-500 text-white rounded-xl p-3 text-center text-sm font-medium shadow-lg">
          You are offline. Measurements will be synced when connected.
        </div>
      )}
    </div>
  );
}
