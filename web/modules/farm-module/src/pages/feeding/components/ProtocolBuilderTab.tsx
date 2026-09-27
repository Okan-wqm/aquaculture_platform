/**
 * ProtocolBuilderTab — Birleşik yemleme protokolü (v2) kurucusu (Faz 3)
 *
 * Band tablosu (ağırlık | yem | oran % | beklenen FCR | öğün planı), sıcaklık
 * ayar tablosu, varsayılan öğün planı editörü ve opsiyonel FCR matrisi.
 * Geometri/toplam doğrulaması backend ProtocolValidationService'te koşar (tek
 * doğrulama SSoT'si); bu yüzey hataları olduğu gibi gösterir.
 *
 * v1 ProtocolsTab cutover'a (Faz 8) kadar v1 protokollerine hizmet etmeye
 * devam eder — bu sekme YALNIZ v2 modelini düzenler.
 */
import React, { useState } from 'react';
import {
  Modal,
  useCanMutate,
  useI18n,
  type MessageKey,
  useConfirm,
  DataTable,
  type DataTableColumn,
  Spinner,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import {
  useFeedingProtocolsV2,
  useCreateFeedingProtocolV2,
  useUpdateFeedingProtocolV2,
  useArchiveFeedingProtocolV2,
  type FeedingProtocolV2,
  type FeedingProtocolV2Status,
  type CreateFeedingProtocolV2Input,
  type ProtocolBandInput,
  type MealSchedule,
  type TemperatureAdjustment,
  type FcrMatrix,
  type ProtocolSettings,
} from '../../../hooks/useProtocolFeeding';
import { useFeedList } from '../../../hooks/useFeeds';
import { useSpeciesList } from '../../../hooks/useSpecies';

// ============================================================================
// HELPERS
// ============================================================================

// Anahtarlar tel değerleridir: GraphQL enum'ları AD serileştirir (kasa kuralı
// useProtocolFeeding.ts başında).
const STATUS_BADGE: Record<FeedingProtocolV2Status, string> = {
  DRAFT: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  ACTIVE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  ARCHIVED: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
};

/** t() tipli anahtar ister — dinamik string kabul etmez; durum → anahtar eşlemesi. */
const STATUS_KEY: Record<FeedingProtocolV2Status, MessageKey> = {
  DRAFT: 'feedingV2.status.draft',
  ACTIVE: 'feedingV2.status.active',
  ARCHIVED: 'feedingV2.status.archived',
};

/** mealsPerDay değişince saatleri 08:00–18:00 penceresine eşit dağıt, yüzdeleri eşitle. */
function distributeMeals(mealsPerDay: number): MealSchedule {
  const count = Math.max(1, Math.min(24, mealsPerDay));
  const startMinutes = 8 * 60;
  const endMinutes = 18 * 60;
  const step = count === 1 ? 0 : (endMinutes - startMinutes) / (count - 1);
  const basePercent = Math.floor((100 / count) * 100) / 100;
  const entries = Array.from({ length: count }, (_, i) => {
    const total = Math.round(startMinutes + step * i);
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    // Son öğün kalan yüzdeyi alır ki toplam tam 100 olsun.
    const percent =
      i === count - 1 ? Math.round((100 - basePercent * (count - 1)) * 100) / 100 : basePercent;
    return { time: `${hh}:${mm}`, percentOfDaily: percent };
  });
  return { mealsPerDay: count, entries };
}

function emptyBand(): ProtocolBandInput {
  return { minWeightG: 0, maxWeightG: 100, feedId: '', feedingRatePercent: 3, expectedFcr: 1.2 };
}

const DEFAULT_SETTINGS: ProtocolSettings = {
  autoTransition: true,
  transitionBufferG: 5,
  growthApplicationMode: 'per_meal',
  underfeedAlertThresholdPercent: 15,
  fcrSource: 'band',
};

// ============================================================================
// MEAL SCHEDULE EDITOR (varsayılan plan + banda özel plan aynı editörü kullanır)
// ============================================================================

interface MealScheduleEditorProps {
  schedule: MealSchedule;
  onChange: (schedule: MealSchedule) => void;
}

export const MealScheduleEditor: React.FC<MealScheduleEditorProps> = ({ schedule, onChange }) => {
  const { t } = useI18n();
  const sum = schedule.entries.reduce((acc, e) => acc + (e.percentOfDaily || 0), 0);
  const sumOk = Math.abs(sum - 100) <= 0.01;

  const setMealsPerDay = (count: number) => {
    if (!Number.isFinite(count) || count < 1 || count > 24) return;
    onChange(distributeMeals(count));
  };

  const setEntry = (index: number, field: 'time' | 'percentOfDaily', value: string) => {
    const entries = schedule.entries.map((entry, i) =>
      i === index
        ? { ...entry, [field]: field === 'percentOfDaily' ? Number(value) : value }
        : entry,
    );
    onChange({ ...schedule, entries });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-600 dark:text-gray-400">
          {t('feedingV2.mealSchedule.mealsPerDay')}
        </label>
        <Input
          type="number"
          min={1}
          max={24}
          value={schedule.mealsPerDay}
          onChange={(e) => setMealsPerDay(Number(e.target.value))}
        />
        <Button
          variant="ghost"
          type="button"
          onClick={() => onChange(distributeMeals(schedule.mealsPerDay))}
        >
          {t('feedingV2.mealSchedule.distribute')}
        </Button>
        <span
          className={`text-sm ${sumOk ? 'text-gray-500 dark:text-gray-400' : 'text-error-600 dark:text-error-400 font-medium'}`}
        >
          {t('feedingV2.mealSchedule.sum', { sum: Math.round(sum * 100) / 100 })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {schedule.entries.map((entry, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input
              type="time"
              value={entry.time}
              onChange={(e) => setEntry(i, 'time', e.target.value)}
              aria-label={t('feedingV2.mealSchedule.time')}
            />
            <Input
              type="number"
              min={0.01}
              max={100}
              step={0.01}
              value={entry.percentOfDaily}
              onChange={(e) => setEntry(i, 'percentOfDaily', e.target.value)}
              aria-label={t('feedingV2.mealSchedule.percent')}
            />
            <span className="text-xs text-gray-400 dark:text-gray-500">%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// FCR MATRIX EDITOR
// ============================================================================
// v1 FeedingMatrixEditor oran-öncelikli (rates zorunlu) — v2 protokolde oran
// bandlardan gelir, matris YALNIZ FCR taşır. Oran gridini zorlamak yerine
// FcrMatrix şeklini doğrudan düzenleyen sade grid.

interface FcrMatrixEditorProps {
  matrix: FcrMatrix;
  onChange: (matrix: FcrMatrix) => void;
}

const FcrMatrixEditor: React.FC<FcrMatrixEditorProps> = ({ matrix, onChange }) => {
  const { t } = useI18n();

  const setCell = (wi: number, ti: number, value: number) => {
    const fcrValues = matrix.fcrValues.map((row, w) =>
      row.map((cell, tIdx) => (w === wi && tIdx === ti ? value : cell)),
    );
    onChange({ ...matrix, fcrValues });
  };

  const setTemp = (ti: number, value: number) => {
    onChange({
      ...matrix,
      temperatures: matrix.temperatures.map((v, i) => (i === ti ? value : v)),
    });
  };

  const setWeight = (wi: number, value: number) => {
    onChange({ ...matrix, weights: matrix.weights.map((v, i) => (i === wi ? value : v)) });
  };

  const addTemp = () => {
    if (matrix.temperatures.length >= 20) return;
    const last = matrix.temperatures[matrix.temperatures.length - 1] ?? 16;
    onChange({
      ...matrix,
      temperatures: [...matrix.temperatures, last + 2],
      fcrValues: matrix.fcrValues.map((row) => [...row, row[row.length - 1] ?? 1.2]),
    });
  };

  const addWeight = () => {
    if (matrix.weights.length >= 30) return;
    const last = matrix.weights[matrix.weights.length - 1] ?? 100;
    const lastRow =
      matrix.fcrValues[matrix.fcrValues.length - 1] ?? matrix.temperatures.map(() => 1.2);
    onChange({
      ...matrix,
      weights: [...matrix.weights, last * 2],
      fcrValues: [...matrix.fcrValues, [...lastRow]],
    });
  };

  const removeTemp = (ti: number) => {
    if (matrix.temperatures.length <= 1) return;
    onChange({
      ...matrix,
      temperatures: matrix.temperatures.filter((_, i) => i !== ti),
      fcrValues: matrix.fcrValues.map((row) => row.filter((_, i) => i !== ti)),
    });
  };

  const removeWeight = (wi: number) => {
    if (matrix.weights.length <= 1) return;
    onChange({
      ...matrix,
      weights: matrix.weights.filter((_, i) => i !== wi),
      fcrValues: matrix.fcrValues.filter((_, i) => i !== wi),
    });
  };

  return (
    <div className="overflow-x-auto">
      <table className="text-sm border-collapse">
        <thead>
          <tr>
            <th className="p-1 text-left text-xs text-gray-500 dark:text-gray-400">g \ °C</th>
            {matrix.temperatures.map((temp, ti) => (
              <th key={ti} className="p-1">
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    value={temp}
                    onChange={(e) => setTemp(ti, Number(e.target.value))}
                  />
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => removeTemp(ti)}
                    aria-label={t('feedingV2.band.remove')}
                  >
                    ×
                  </Button>
                </div>
              </th>
            ))}
            <th className="p-1">
              <Button variant="ghost" size="xs" type="button" onClick={addTemp}>
                + {t('feedingV2.fcrMatrix.addTemp')}
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {matrix.weights.map((weight, wi) => (
            <tr key={wi}>
              <td className="p-1">
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    value={weight}
                    onChange={(e) => setWeight(wi, Number(e.target.value))}
                  />
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => removeWeight(wi)}
                    aria-label={t('feedingV2.band.remove')}
                  >
                    ×
                  </Button>
                </div>
              </td>
              {matrix.temperatures.map((_, ti) => (
                <td key={ti} className="p-1">
                  <Input
                    type="number"
                    min={0.5}
                    max={5}
                    step={0.01}
                    value={matrix.fcrValues[wi]?.[ti] ?? 1.2}
                    onChange={(e) => setCell(wi, ti, Number(e.target.value))}
                  />
                </td>
              ))}
              <td />
            </tr>
          ))}
          <tr>
            <td className="p-1">
              <Button variant="ghost" size="xs" type="button" onClick={addWeight}>
                + {t('feedingV2.fcrMatrix.addWeight')}
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

// ============================================================================
// PROTOCOL FORM MODAL
// ============================================================================

interface ProtocolFormState {
  name: string;
  description: string;
  speciesId: string;
  status: FeedingProtocolV2Status;
  isDefault: boolean;
  bands: ProtocolBandInput[];
  temperatureAdjustments: TemperatureAdjustment[];
  defaultMealSchedule: MealSchedule;
  fcrMatrix?: FcrMatrix;
  settings: ProtocolSettings;
}

function initialFormState(protocol?: FeedingProtocolV2): ProtocolFormState {
  if (!protocol) {
    return {
      name: '',
      description: '',
      speciesId: '',
      status: 'DRAFT',
      isDefault: false,
      bands: [emptyBand()],
      temperatureAdjustments: [],
      defaultMealSchedule: distributeMeals(3),
      settings: { ...DEFAULT_SETTINGS },
    };
  }
  return {
    name: protocol.name,
    description: protocol.description ?? '',
    speciesId: protocol.speciesId ?? '',
    status: protocol.status,
    isDefault: protocol.isDefault,
    bands: protocol.bands.map((band) => ({
      minWeightG: band.minWeightG,
      maxWeightG: band.maxWeightG,
      feedId: band.feedId,
      feedingRatePercent: band.feedingRatePercent,
      expectedFcr: band.expectedFcr,
      mealSchedule: band.mealSchedule,
      notes: band.notes,
    })),
    temperatureAdjustments: protocol.temperatureAdjustments ?? [],
    defaultMealSchedule: protocol.defaultMealSchedule,
    fcrMatrix: protocol.fcrMatrix,
    settings: protocol.settings,
  };
}

interface ProtocolFormModalProps {
  protocol?: FeedingProtocolV2;
  onClose: () => void;
}

const ProtocolFormModal: React.FC<ProtocolFormModalProps> = ({ protocol, onClose }) => {
  const { t } = useI18n();
  const [form, setForm] = useState<ProtocolFormState>(() => initialFormState(protocol));
  const [error, setError] = useState<string | null>(null);
  const [bandScheduleOpen, setBandScheduleOpen] = useState<number | null>(null);

  const { data: feedsData } = useFeedList({ isActive: true });
  const { data: speciesData } = useSpeciesList({ isActive: true, limit: 100 });
  const createMutation = useCreateFeedingProtocolV2();
  const updateMutation = useUpdateFeedingProtocolV2();
  const saving = createMutation.isPending || updateMutation.isPending;

  const feeds = feedsData?.items ?? [];
  const speciesList = speciesData?.items ?? [];

  const setBand = (index: number, patch: Partial<ProtocolBandInput>) => {
    setForm((prev) => ({
      ...prev,
      bands: prev.bands.map((band, i) => (i === index ? { ...band, ...patch } : band)),
    }));
  };

  const addBand = () => {
    setForm((prev) => {
      const last = prev.bands[prev.bands.length - 1];
      const nextBand = last
        ? { ...emptyBand(), minWeightG: last.maxWeightG, maxWeightG: last.maxWeightG * 2 }
        : emptyBand();
      return { ...prev, bands: [...prev.bands, nextBand] };
    });
  };

  const removeBand = (index: number) => {
    setForm((prev) => ({ ...prev, bands: prev.bands.filter((_, i) => i !== index) }));
  };

  const setAdjustment = (index: number, patch: Partial<TemperatureAdjustment>) => {
    setForm((prev) => ({
      ...prev,
      temperatureAdjustments: prev.temperatureAdjustments.map((adj, i) =>
        i === index ? { ...adj, ...patch } : adj,
      ),
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const input: CreateFeedingProtocolV2Input = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      speciesId: form.speciesId || undefined,
      bands: form.bands,
      temperatureAdjustments:
        form.temperatureAdjustments.length > 0 ? form.temperatureAdjustments : undefined,
      defaultMealSchedule: form.defaultMealSchedule,
      fcrMatrix: form.settings.fcrSource === 'matrix' ? form.fcrMatrix : undefined,
      settings: form.settings,
      isDefault: form.isDefault,
      status: form.status,
    };
    try {
      if (protocol) {
        await updateMutation.mutateAsync({ ...input, id: protocol.id });
      } else {
        await createMutation.mutateAsync(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  };

  const ensureMatrix = (): FcrMatrix =>
    form.fcrMatrix ?? {
      temperatures: [12, 14, 16, 18],
      weights: [10, 50, 100, 500],
      fcrValues: [
        [1.0, 1.05, 1.1, 1.15],
        [1.1, 1.15, 1.2, 1.25],
        [1.15, 1.2, 1.25, 1.3],
        [1.2, 1.25, 1.3, 1.4],
      ],
    };

  // A band's custom meal schedule opens under its row; the page owns which band is open.
  type BandRow = { band: (typeof form.bands)[number]; index: number };
  const bandRows: BandRow[] = form.bands.map((band, index) => ({ band, index }));
  const bandColumns: DataTableColumn<BandRow>[] = [
    {
      key: 'minWeightG',
      header: t('feedingV2.band.minWeight'),
      render: (_value, { band, index }) => (
        <Input
          type="number"
          min={0}
          max={100000}
          value={band.minWeightG}
          onChange={(e) => setBand(index, { minWeightG: Number(e.target.value) })}
        />
      ),
    },
    {
      key: 'maxWeightG',
      header: t('feedingV2.band.maxWeight'),
      render: (_value, { band, index }) => (
        <Input
          type="number"
          min={0}
          max={100000}
          value={band.maxWeightG}
          onChange={(e) => setBand(index, { maxWeightG: Number(e.target.value) })}
        />
      ),
    },
    {
      key: 'feedId',
      header: t('feedingV2.band.feed'),
      render: (_value, { band, index }) => (
        <Select
          aria-label={t('feedingV2.band.feed')}
          required
          fullWidth={false}
          size="sm"
          className="w-44"
          placeholder={t('feedingV2.band.selectFeed')}
          value={band.feedId}
          onChange={(e) => setBand(index, { feedId: e.target.value })}
          options={feeds.map((feed) => ({
            value: feed.id,
            label: `${feed.name} (${feed.code})`,
          }))}
        />
      ),
    },
    {
      key: 'feedingRatePercent',
      header: t('feedingV2.band.rate'),
      render: (_value, { band, index }) => (
        <Input
          type="number"
          min={0}
          max={15}
          step={0.01}
          value={band.feedingRatePercent}
          onChange={(e) => setBand(index, { feedingRatePercent: Number(e.target.value) })}
        />
      ),
    },
    {
      key: 'expectedFcr',
      header: t('feedingV2.band.fcr'),
      render: (_value, { band, index }) => (
        <Input
          type="number"
          min={0.5}
          max={5}
          step={0.01}
          value={band.expectedFcr}
          onChange={(e) => setBand(index, { expectedFcr: Number(e.target.value) })}
        />
      ),
    },
    {
      key: 'mealSchedule',
      header: t('feedingV2.band.meals'),
      render: (_value, { band, index }) => (
        <Button
          variant="ghost"
          type="button"
          onClick={() => setBandScheduleOpen(bandScheduleOpen === index ? null : index)}
        >
          {band.mealSchedule
            ? t('feedingV2.band.mealsCustom', { count: band.mealSchedule.mealsPerDay })
            : t('feedingV2.band.mealsDefault')}
        </Button>
      ),
    },
    {
      key: 'remove',
      header: '',
      render: (_value, { index }) =>
        form.bands.length > 1 ? (
          <Button
            variant="ghost"
            type="button"
            onClick={() => removeBand(index)}
            aria-label={t('feedingV2.band.remove')}
          >
            ×
          </Button>
        ) : null,
    },
  ];

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={protocol ? t('feedingV2.editProtocol') : t('feedingV2.newProtocol')}
      size="xl"
    >
      <form onSubmit={handleSubmit} className="space-y-6 max-h-[75vh] overflow-y-auto p-1">
        {error && (
          <div className="rounded-md bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 p-3 text-sm text-error-700 dark:text-error-300 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* Kimlik */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('feedingV2.name')}
            </label>
            <Input
              fullWidth
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>
          <Select
            label={t('feedingV2.species')}
            value={form.speciesId}
            onChange={(e) => setForm((prev) => ({ ...prev, speciesId: e.target.value }))}
            options={[
              { value: '', label: t('feedingV2.speciesAny') },
              ...speciesList.map((species) => ({
                value: species.id,
                label: species.commonName,
              })),
            ]}
          />
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('feedingV2.description')}
            </label>
            <Textarea
              fullWidth
              rows={2}
              maxLength={2000}
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-6">
            <Select
              label={t('feedingV2.statusLabel')}
              fullWidth={false}
              value={form.status}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  status: e.target.value as FeedingProtocolV2Status,
                }))
              }
              options={[
                { value: 'DRAFT', label: t('feedingV2.status.draft') },
                { value: 'ACTIVE', label: t('feedingV2.status.active') },
              ]}
            />
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 mt-5">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm((prev) => ({ ...prev, isDefault: e.target.checked }))}
                className="rounded border-gray-300 dark:border-gray-600 text-info-600"
              />
              {t('feedingV2.isDefault')}
            </label>
          </div>
        </div>

        {/* Bandlar */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-3">
            {t('feedingV2.bands')}
          </h4>
          <DataTable<BandRow>
            data={bandRows}
            columns={bandColumns}
            keyExtractor={(row) => String(row.index)}
            expandable
            expandToggle={false}
            expandedRowIds={bandScheduleOpen === null ? [] : [String(bandScheduleOpen)]}
            onExpandedChange={(ids) =>
              setBandScheduleOpen(ids.length > 0 ? Number(ids[ids.length - 1]) : null)
            }
            renderExpandedRow={(row) => (
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t('feedingV2.band.customSchedule')}
                  </p>
                  <MealScheduleEditor
                    schedule={row.band.mealSchedule ?? form.defaultMealSchedule}
                    onChange={(schedule) => setBand(row.index, { mealSchedule: schedule })}
                  />
                </div>
                {row.band.mealSchedule && (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setBand(row.index, { mealSchedule: undefined })}
                  >
                    {t('feedingV2.band.mealsDefault')}
                  </Button>
                )}
              </div>
            )}
            emptyMessage={t('feedingV2.bands')}
            searchable={false}
            sortable={false}
            stickyHeader={false}
            compact
            className="border-0 rounded-none shadow-none"
          />
          <Button
            variant="ghost"
            className="mt-2"
            type="button"
            onClick={addBand}
            disabled={form.bands.length >= 50}
          >
            + {t('feedingV2.band.add')}
          </Button>
        </div>

        {/* Varsayılan öğün planı */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-3">
            {t('feedingV2.mealSchedule.title')}
          </h4>
          <MealScheduleEditor
            schedule={form.defaultMealSchedule}
            onChange={(schedule) => setForm((prev) => ({ ...prev, defaultMealSchedule: schedule }))}
          />
        </div>

        {/* Sıcaklık ayarlamaları */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-3">
            {t('feedingV2.tempAdjustments.title')}
          </h4>
          {form.temperatureAdjustments.map((adj, i) => (
            <div key={i} className="flex items-center gap-2 mb-2">
              <Input
                type="number"
                min={-10}
                max={50}
                value={adj.minC}
                onChange={(e) => setAdjustment(i, { minC: Number(e.target.value) })}
                aria-label={t('feedingV2.tempAdjustments.minC')}
              />
              <span className="text-gray-400 dark:text-gray-500">–</span>
              <Input
                type="number"
                min={-10}
                max={50}
                value={adj.maxC}
                onChange={(e) => setAdjustment(i, { maxC: Number(e.target.value) })}
                aria-label={t('feedingV2.tempAdjustments.maxC')}
              />
              <span className="text-xs text-gray-500 dark:text-gray-400">°C ×</span>
              <Input
                type="number"
                min={0.1}
                max={2}
                step={0.01}
                value={adj.rateMultiplier}
                onChange={(e) => setAdjustment(i, { rateMultiplier: Number(e.target.value) })}
                aria-label={t('feedingV2.tempAdjustments.multiplier')}
              />
              <Button
                variant="ghost"
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    temperatureAdjustments: prev.temperatureAdjustments.filter(
                      (_, idx) => idx !== i,
                    ),
                  }))
                }
                aria-label={t('feedingV2.band.remove')}
              >
                ×
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            type="button"
            onClick={() =>
              setForm((prev) => ({
                ...prev,
                temperatureAdjustments: [
                  ...prev.temperatureAdjustments,
                  { minC: 10, maxC: 15, rateMultiplier: 0.8 },
                ],
              }))
            }
            disabled={form.temperatureAdjustments.length >= 20}
          >
            + {t('feedingV2.tempAdjustments.add')}
          </Button>
        </div>

        {/* Ayarlar */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-3">
            {t('feedingV2.settings.title')}
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={form.settings.autoTransition}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    settings: { ...prev.settings, autoTransition: e.target.checked },
                  }))
                }
                className="rounded border-gray-300 dark:border-gray-600 text-info-600"
              />
              {t('feedingV2.settings.autoTransition')}
            </label>
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400">
                {t('feedingV2.settings.transitionBufferG')}
              </label>
              <Input
                type="number"
                min={0}
                max={1000}
                value={form.settings.transitionBufferG}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    settings: { ...prev.settings, transitionBufferG: Number(e.target.value) },
                  }))
                }
              />
            </div>
            <Select
              label={t('feedingV2.settings.growthMode')}
              fullWidth={false}
              size="sm"
              value={form.settings.growthApplicationMode}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  settings: {
                    ...prev.settings,
                    growthApplicationMode: e.target.value as 'per_meal' | 'daily',
                  },
                }))
              }
              options={[
                { value: 'per_meal', label: t('feedingV2.settings.growthMode.perMeal') },
                { value: 'daily', label: t('feedingV2.settings.growthMode.daily') },
              ]}
            />
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400">
                {t('feedingV2.settings.underfeedThreshold')}
              </label>
              <Input
                type="number"
                min={1}
                max={100}
                value={form.settings.underfeedAlertThresholdPercent}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    settings: {
                      ...prev.settings,
                      underfeedAlertThresholdPercent: Number(e.target.value),
                    },
                  }))
                }
              />
            </div>
            <Select
              label={t('feedingV2.settings.fcrSource')}
              fullWidth={false}
              size="sm"
              value={form.settings.fcrSource}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  settings: {
                    ...prev.settings,
                    fcrSource: e.target.value as ProtocolSettings['fcrSource'],
                  },
                  fcrMatrix:
                    e.target.value === 'matrix'
                      ? (prev.fcrMatrix ?? ensureMatrix())
                      : prev.fcrMatrix,
                }))
              }
              options={[
                { value: 'band', label: t('feedingV2.settings.fcrSource.band') },
                { value: 'matrix', label: t('feedingV2.settings.fcrSource.matrix') },
                { value: 'feed', label: t('feedingV2.settings.fcrSource.feed') },
              ]}
            />
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400">
                {t('feedingV2.settings.minDO')}
              </label>
              <Input
                type="number"
                min={0}
                max={20}
                step={0.1}
                value={form.settings.minDissolvedOxygen ?? ''}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    settings: {
                      ...prev.settings,
                      minDissolvedOxygen:
                        e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  }))
                }
              />
            </div>
          </div>
        </div>

        {/* FCR matrisi (yalnız fcrSource=matrix) */}
        {form.settings.fcrSource === 'matrix' && (
          <div>
            <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-3">
              {t('feedingV2.fcrMatrix.title')}
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              {t('feedingV2.fcrMatrix.required')}
            </p>
            <FcrMatrixEditor
              matrix={form.fcrMatrix ?? ensureMatrix()}
              onChange={(matrix) => setForm((prev) => ({ ...prev, fcrMatrix: matrix }))}
            />
          </div>
        )}

        {/* Aksiyonlar */}
        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// TAB
// ============================================================================

export const ProtocolBuilderTab: React.FC = () => {
  const { t } = useI18n();
  const [modalProtocol, setModalProtocol] = useState<FeedingProtocolV2 | 'new' | null>(null);

  const { data, isLoading, isError } = useFeedingProtocolsV2();
  const archiveMutation = useArchiveFeedingProtocolV2();

  const canCreate = useCanMutate('createFeedingProtocolV2');
  const canUpdate = useCanMutate('updateFeedingProtocolV2');
  const canArchive = useCanMutate('archiveFeedingProtocolV2');

  const protocols = data?.items ?? [];

  const confirm = useConfirm();
  const handleArchive = async (protocol: FeedingProtocolV2) => {
    if (
      !(await confirm({
        title: t('feedingV2.archiveConfirm', { name: protocol.name }),
        variant: 'warning',
      }))
    )
      return;
    await archiveMutation.mutateAsync(protocol.id);
  };

  type ProtocolRow = (typeof protocols)[number];
  const protocolRowColumns: DataTableColumn<ProtocolRow>[] = [
    {
      key: 'tFeedingv2Name',
      header: t('feedingV2.name'),
      render: (_value, protocol) => (
        <>
          <div className="font-medium text-gray-900 dark:text-gray-100">{protocol.name}</div>
          {protocol.migrationNote && (
            <div className="text-xs text-warning-600 dark:text-warning-400 mt-0.5">
              {t('feedingV2.migrationNote')}: {protocol.migrationNote}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'tFeedingv2Species',
      header: t('feedingV2.species'),
      render: (_value, protocol) => protocol.speciesName ?? t('feedingV2.speciesAny'),
    },
    {
      key: 'tFeedingv2Statuslabel',
      header: t('feedingV2.statusLabel'),
      render: (_value, protocol) => (
        <>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[protocol.status]}`}
          >
            {t(STATUS_KEY[protocol.status])}
          </span>
          {protocol.isDefault && (
            <span className="ml-2 inline-flex rounded-full bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200 px-2 py-0.5 text-xs">
              {t('feedingV2.isDefault')}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'tFeedingv2Bands',
      header: t('feedingV2.bands'),
      render: (_value, protocol) => protocol.bands.length,
    },
    {
      key: 'tFeedingv2MealscheduleMealsperday',
      header: t('feedingV2.mealSchedule.mealsPerDay'),
      render: (_value, protocol) => protocol.defaultMealSchedule.mealsPerDay,
    },
    {
      key: 'col',
      header: '',
      render: (_value, protocol) => (
        <>
          {canUpdate && protocol.status !== 'ARCHIVED' && (
            <Button variant="ghost" className="mr-3" onClick={() => setModalProtocol(protocol)}>
              {t('common.edit')}
            </Button>
          )}
          {canArchive && protocol.status !== 'ARCHIVED' && (
            <Button variant="ghost" onClick={() => void handleArchive(protocol)}>
              {t('feedingV2.archive')}
            </Button>
          )}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('feedingV2.builderTab.title')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('feedingV2.builderTab.subtitle')}
          </p>
        </div>
        {canCreate && (
          <Button variant="primary" onClick={() => setModalProtocol('new')}>
            + {t('feedingV2.newProtocol')}
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <Spinner size="xl" />
        </div>
      )}
      {isError && (
        <div className="rounded-md bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 p-4 text-sm text-error-700 dark:text-error-300">
          {t('feedingV2.loadError')}
        </div>
      )}

      {!isLoading && !isError && protocols.length === 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-12 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('feedingV2.empty')}
        </div>
      )}

      {protocols.length > 0 && (
        <DataTable<ProtocolRow>
          data={protocols}
          columns={protocolRowColumns}
          keyExtractor={(protocol) => protocol.id}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      )}

      {modalProtocol && (
        <ProtocolFormModal
          protocol={modalProtocol === 'new' ? undefined : modalProtocol}
          onClose={() => setModalProtocol(null)}
        />
      )}
    </div>
  );
};
