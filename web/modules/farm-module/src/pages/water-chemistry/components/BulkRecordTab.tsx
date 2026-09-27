/**
 * BulkRecordTab — Tier 3 #6 (Scope C PR-6)
 *
 * Bulk water quality entry surface. Operator picks N equipment items
 * (1..50, the backend's transactional cap), shares one `measuredAt`
 * and one `source`, fills per-row dynamic parameters (driven by each
 * equipment's mapped parameter configs) + an optional per-row note,
 * and submits a single transactional batch:
 *
 *   `createBatchWaterQualityMeasurements`
 *   apps/farm-service/src/water-quality/water-quality.resolver.ts:209
 *
 * Architectural notes
 * -------------------
 * 1) Field rendering is the SHARED `DynamicParameterFields` exported
 *    from `@aquaculture/farm-shared`. The single-row RecordTab uses
 *    `DynamicMeasurementForm` (which now wraps the same component
 *    internally) — no parallel implementations, threshold colouring +
 *    ARIA + group ordering stay consistent across surfaces.
 * 2) Each row keeps its own `rawValues` / `boolValues` map keyed by
 *    parameter code. The `idempotencyKey` is minted ONCE when the row
 *    is added to the selection (UUID via crypto.randomUUID) and
 *    PRESERVED across edits — a duplicate submit (network retry,
 *    double-click) maps to the same server-side row instead of
 *    creating a second one.
 * 3) Parameter configs are fetched per equipment via
 *    `useEquipmentParameterConfigs(equipmentId)`. Each row's hook
 *    invocation is a separate query (TanStack caches per equipment),
 *    so adding/removing rows costs a single network round-trip per
 *    new selection — repeated selections within the cache TTL hit
 *    the cache.
 * 4) Permission gate: the tab itself is hidden when the user lacks
 *    `createBatchWaterQualityMeasurements`. Defense-in-depth at the
 *    backend (resolver `@Roles`) catches anything that slips past.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { DynamicParameterFields, collectDynamicValues } from '@aquaculture/farm-shared';
import type { ParameterFieldConfig } from '@aquaculture/farm-shared';
import {
  formatErrorForToast,
  useToast,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';

import { useEquipmentList } from '../../../hooks/useEquipment';
import { useSystemList } from '../../../hooks/useSystems';
import { useEquipmentParameterConfigs } from '../../../hooks/useEquipmentParameters';
import {
  type BatchMeasurementItemInput,
  type CreateBatchWaterQualityInput,
  type MeasurementSource,
  useCreateBatchWaterQuality,
} from '../../../hooks/useWaterQuality';
import type { Equipment } from '../../../hooks/useEquipment';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_BATCH_SIZE = 50;
const NOTES_MAX = 500;

// ============================================================================
// PER-ROW STATE
// ============================================================================

interface BulkRow {
  equipmentId: string;
  idempotencyKey: string;
  rawValues: Record<string, string>;
  boolValues: Record<string, boolean>;
  notes: string;
}

function createRow(equipmentId: string): BulkRow {
  return {
    equipmentId,
    idempotencyKey: crypto.randomUUID(),
    rawValues: {},
    boolValues: {},
    notes: '',
  };
}

// ============================================================================
// PER-ROW SUB-COMPONENT
// ============================================================================
//
// Lives inline (not a separate file) because the fields-in-a-row
// pattern only exists on this surface. Parameter configs are fetched
// here so each row makes its own query — selection of equipment "B"
// doesn't block render while equipment "A"'s configs still load.

interface BulkRowEditorProps {
  row: BulkRow;
  equipment: Equipment;
  onChange: (next: BulkRow) => void;
  onRemove: () => void;
}

const BulkRowEditor: React.FC<BulkRowEditorProps> = ({ row, equipment, onChange, onRemove }) => {
  const configsQuery = useEquipmentParameterConfigs(row.equipmentId);
  const parameters: ParameterFieldConfig[] = configsQuery.data ?? [];

  const handleStringChange = useCallback(
    (code: string, raw: string) => {
      onChange({
        ...row,
        rawValues: { ...row.rawValues, [code]: raw },
      });
    },
    [row, onChange],
  );

  const handleBoolChange = useCallback(
    (code: string, checked: boolean) => {
      onChange({
        ...row,
        boolValues: { ...row.boolValues, [code]: checked },
      });
    },
    [row, onChange],
  );

  const handleNotesChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange({ ...row, notes: e.target.value });
    },
    [row, onChange],
  );

  const missingRequired = useMemo(() => {
    return parameters
      .filter((p) => p.isRequired)
      .filter((p) => {
        if (p.dataType === 'BOOLEAN') return false;
        const v = row.rawValues[p.code];
        return v == null || v === '';
      })
      .map((p) => p.name);
  }, [parameters, row.rawValues]);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-white dark:bg-gray-900 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">{equipment.name}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {equipment.code}
            {equipment.equipmentType?.name && ` · ${equipment.equipmentType.name}`}
            {equipment.department?.name && ` · ${equipment.department.name}`}
          </p>
        </div>
        <Button
          variant="ghost"
          type="button"
          onClick={onRemove}
          aria-label={`${equipment.name} ekipmanını gruptan çıkar`}
        >
          Çıkar
        </Button>
      </div>

      {configsQuery.isLoading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Parametre yapılandırması yükleniyor…
        </p>
      ) : configsQuery.isError ? (
        <p className="text-sm text-error-600 dark:text-error-400">
          Parametre yapılandırması yüklenemedi.
        </p>
      ) : parameters.length === 0 ? (
        <p className="text-sm text-warning-700 dark:text-warning-300 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded p-2">
          Bu ekipmana atanmış parametre yok — Parametreler sekmesinden bir konfigürasyon eşlemesi
          yapın.
        </p>
      ) : (
        <DynamicParameterFields
          variant="desktop"
          parameters={parameters}
          rawValues={row.rawValues}
          boolValues={row.boolValues}
          onStringChange={handleStringChange}
          onBoolChange={handleBoolChange}
        />
      )}

      <div>
        <label
          htmlFor={`bulk-notes-${row.idempotencyKey}`}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Notlar
        </label>
        <Textarea
          fullWidth
          id={`bulk-notes-${row.idempotencyKey}`}
          value={row.notes}
          onChange={handleNotesChange}
          maxLength={NOTES_MAX}
          rows={2}
        />
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          {row.notes.length} / {NOTES_MAX}
        </p>
      </div>

      {missingRequired.length > 0 && (
        <p className="text-xs text-error-600 dark:text-error-400">
          Eksik zorunlu alan: {missingRequired.join(', ')}
        </p>
      )}
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

function toLocalDateTimeInputValue(d: Date): string {
  // <Input type="datetime-local" /> uses YYYY-MM-DDTHH:mm in *local* time.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const BulkRecordTab: React.FC = () => {
  const { toast } = useToast();
  const createBatch = useCreateBatchWaterQuality();

  const systemsQuery = useSystemList();
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);

  const equipmentQuery = useEquipmentList(
    selectedSystemId ? { isActive: true, systemId: selectedSystemId } : { isActive: true },
  );
  const equipment: readonly Equipment[] = useMemo(
    () => equipmentQuery.data?.items ?? [],
    [equipmentQuery.data],
  );

  // Shared header values
  const [measuredAtLocal, setMeasuredAtLocal] = useState<string>(() =>
    toLocalDateTimeInputValue(new Date()),
  );
  const [source, setSource] = useState<MeasurementSource>('MANUAL');

  // Per-row state — keyed insertion-ordered by equipmentId
  const [rows, setRows] = useState<BulkRow[]>([]);

  // Equipment available for adding (not already in rows)
  const usedEquipmentIds = useMemo(() => new Set(rows.map((r) => r.equipmentId)), [rows]);
  const availableEquipment = useMemo(
    () => equipment.filter((e) => !usedEquipmentIds.has(e.id)),
    [equipment, usedEquipmentIds],
  );
  const equipmentById = useMemo(() => {
    const map = new Map<string, Equipment>();
    for (const eq of equipment) map.set(eq.id, eq);
    return map;
  }, [equipment]);

  const handleAddEquipment = useCallback((equipmentId: string) => {
    if (!equipmentId) return;
    setRows((prev) => {
      if (prev.some((r) => r.equipmentId === equipmentId)) return prev;
      if (prev.length >= MAX_BATCH_SIZE) return prev;
      return [...prev, createRow(equipmentId)];
    });
  }, []);

  const handleAddAllVisible = useCallback(() => {
    setRows((prev) => {
      const existing = new Set(prev.map((r) => r.equipmentId));
      const next = [...prev];
      for (const eq of availableEquipment) {
        if (next.length >= MAX_BATCH_SIZE) break;
        if (!existing.has(eq.id)) {
          next.push(createRow(eq.id));
          existing.add(eq.id);
        }
      }
      return next;
    });
  }, [availableEquipment]);

  const handleRowChange = useCallback((equipmentId: string, next: BulkRow) => {
    setRows((prev) => prev.map((r) => (r.equipmentId === equipmentId ? next : r)));
  }, []);

  const handleRowRemove = useCallback((equipmentId: string) => {
    setRows((prev) => prev.filter((r) => r.equipmentId !== equipmentId));
  }, []);

  const handleClear = useCallback(() => {
    setRows([]);
  }, []);

  // -----  Submit  -----------------------------------------------------------
  // Each row already holds its own raw-string values and boolean values.
  // The editor doesn't expose its loaded parameter configs back up to the
  // parent — that would couple the parent to per-row query state. We coerce
  // values here using inline rules that match `collectDynamicValues` in
  // farm-shared: numeric-looking strings → Number(), bools pass through,
  // empty strings drop out. The backend's `WaterQualityValidationService`
  // is the authoritative gate that re-checks each value against the
  // equipment's mapped configs (strict mode rejects unknown keys + wrong
  // types), so this client-side coercion is a UX optimisation, not the
  // type-safety boundary.
  const buildPayload = useCallback((): CreateBatchWaterQualityInput | string => {
    if (rows.length === 0) {
      return 'En az bir ekipman seçin.';
    }
    if (rows.length > MAX_BATCH_SIZE) {
      return `Tek seferde en fazla ${MAX_BATCH_SIZE} ekipman gönderilebilir (şu an ${rows.length}).`;
    }
    const measuredAt = new Date(measuredAtLocal);
    if (Number.isNaN(measuredAt.getTime())) {
      return 'Ölçüm tarihi geçersiz.';
    }

    const measurements: BatchMeasurementItemInput[] = rows.map((row) => {
      // Numeric coercion per row — the editor's local rawValues do not
      // remember the parameter dataType, so we mint Number() for any
      // raw string that parses cleanly, leaving the rest as strings.
      // Booleans flow through `boolValues`. The server's
      // dynamic-parameters validator is the strict gate.
      const dyn: Record<string, number | string | boolean> = {};
      for (const [code, raw] of Object.entries(row.rawValues)) {
        if (raw === '' || raw == null) continue;
        const n = Number(raw);
        dyn[code] = Number.isFinite(n) && raw.trim() !== '' ? n : raw;
      }
      for (const [code, checked] of Object.entries(row.boolValues)) {
        dyn[code] = checked;
      }
      return {
        equipmentId: row.equipmentId,
        idempotencyKey: row.idempotencyKey,
        dynamicParameters: dyn,
        ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
      };
    });

    return {
      measuredAt: measuredAt.toISOString(),
      source,
      measurements,
    };
  }, [rows, measuredAtLocal, source]);

  const handleSubmit = useCallback(async () => {
    const payload = buildPayload();
    if (typeof payload === 'string') {
      toast({
        title: 'Gönderim engellendi',
        description: payload,
        variant: 'error',
      });
      return;
    }
    try {
      const created = await createBatch.mutateAsync(payload);
      toast({
        title: 'Toplu ölçüm kaydedildi',
        description: `${created.length} ölçüm tek transaction'da yazıldı.`,
        variant: 'success',
      });
      setRows([]);
    } catch (err) {
      toast({
        title: 'Toplu kayıt başarısız',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  }, [buildPayload, createBatch, toast]);

  const isSubmitting = createBatch.isPending;

  // -----  Render  -----------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Shared header */}
      <section className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <Select
            label="Sistem (filtre)"
            value={selectedSystemId ?? ''}
            onChange={(e) => setSelectedSystemId(e.target.value || null)}
            options={[
              { value: '', label: 'Tümü' },
              ...(systemsQuery.data?.items ?? []).map((sys) => ({
                value: sys.id,
                label: sys.name,
              })),
            ]}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Ölçüm Tarihi/Saati
          </label>
          <Input
            fullWidth
            type="datetime-local"
            value={measuredAtLocal}
            onChange={(e) => setMeasuredAtLocal(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Kaynak
          </label>
          <Select
            fullWidth
            options={[
              { value: 'MANUAL', label: 'Manuel' },
              { value: 'LAB_ANALYSIS', label: 'Laboratuvar' },
              { value: 'SENSOR_AUTOMATIC', label: 'Sensör (otomatik)' },
              { value: 'SENSOR_TRIGGERED', label: 'Sensör (tetikli)' },
              { value: 'CALIBRATION', label: 'Kalibrasyon' },
            ]}
            value={source}
            onChange={(e) => setSource(e.target.value as MeasurementSource)}
          />
        </div>
      </section>

      {/* Equipment picker */}
      <section className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[260px]">
            <Select
              label="Ekipman ekle"
              value=""
              onChange={(e) => handleAddEquipment(e.target.value)}
              disabled={availableEquipment.length === 0 || rows.length >= MAX_BATCH_SIZE}
              options={[
                {
                  value: '',
                  label:
                    availableEquipment.length === 0
                      ? 'Eklenebilecek ekipman yok'
                      : 'Bir ekipman seç…',
                },
                ...availableEquipment.map((eq) => ({
                  value: eq.id,
                  label: `${eq.name} (${eq.code})`,
                })),
              ]}
            />
          </div>
          <button
            type="button"
            onClick={handleAddAllVisible}
            disabled={availableEquipment.length === 0 || rows.length >= MAX_BATCH_SIZE}
            className="px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 border border-gray-300 dark:border-gray-600 rounded-md disabled:opacity-50"
          >
            Görünür hepsini ekle
          </button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={handleClear}
            disabled={rows.length === 0}
          >
            Temizle
          </Button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {rows.length} / {MAX_BATCH_SIZE} ekipman seçildi · Tüm satırlar tek transaction'da
          yazılır.
        </p>
      </section>

      {/* Rows */}
      <section className="space-y-3">
        {rows.map((row) => {
          const eq = equipmentById.get(row.equipmentId);
          if (!eq) {
            return (
              <div
                key={row.equipmentId}
                className="border border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 rounded-lg p-3 text-sm text-warning-800 dark:text-warning-200"
              >
                Ekipman bulunamadı: {row.equipmentId} —{' '}
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => handleRowRemove(row.equipmentId)}
                >
                  satırı çıkar
                </Button>
              </div>
            );
          }
          return (
            <BulkRowEditor
              key={row.equipmentId}
              row={row}
              equipment={eq}
              onChange={(next) => handleRowChange(row.equipmentId, next)}
              onRemove={() => handleRowRemove(row.equipmentId)}
            />
          );
        })}
      </section>

      {/* Submit */}
      <section className="flex justify-end gap-3 pb-8">
        <Button
          variant="primary"
          size="lg"
          type="button"
          onClick={handleSubmit}
          disabled={rows.length === 0 || isSubmitting}
        >
          {isSubmitting
            ? `Kaydediliyor… (${rows.length})`
            : `${rows.length} Ölçümü Tek Transaction'da Gönder`}
        </Button>
      </section>
    </div>
  );
};

export default BulkRecordTab;
