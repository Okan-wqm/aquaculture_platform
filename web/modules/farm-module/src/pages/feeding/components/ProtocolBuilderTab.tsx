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
import { Modal, useCanMutate, useI18n, type MessageKey } from '@aquaculture/shared-ui';
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
  DRAFT: 'bg-yellow-100 text-yellow-800',
  ACTIVE: 'bg-green-100 text-green-800',
  ARCHIVED: 'bg-gray-100 text-gray-600',
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
        <label className="text-sm text-gray-600">{t('feedingV2.mealSchedule.mealsPerDay')}</label>
        <input
          type="number"
          min={1}
          max={24}
          value={schedule.mealsPerDay}
          onChange={(e) => setMealsPerDay(Number(e.target.value))}
          className="w-20 rounded-md border-gray-300 shadow-sm text-sm"
        />
        <button
          type="button"
          onClick={() => onChange(distributeMeals(schedule.mealsPerDay))}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          {t('feedingV2.mealSchedule.distribute')}
        </button>
        <span className={`text-sm ${sumOk ? 'text-gray-500' : 'text-red-600 font-medium'}`}>
          {t('feedingV2.mealSchedule.sum', { sum: Math.round(sum * 100) / 100 })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {schedule.entries.map((entry, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="time"
              value={entry.time}
              onChange={(e) => setEntry(i, 'time', e.target.value)}
              className="rounded-md border-gray-300 shadow-sm text-sm"
              aria-label={t('feedingV2.mealSchedule.time')}
            />
            <input
              type="number"
              min={0.01}
              max={100}
              step={0.01}
              value={entry.percentOfDaily}
              onChange={(e) => setEntry(i, 'percentOfDaily', e.target.value)}
              className="w-16 rounded-md border-gray-300 shadow-sm text-sm"
              aria-label={t('feedingV2.mealSchedule.percent')}
            />
            <span className="text-xs text-gray-400">%</span>
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
    onChange({ ...matrix, temperatures: matrix.temperatures.map((v, i) => (i === ti ? value : v)) });
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
    const lastRow = matrix.fcrValues[matrix.fcrValues.length - 1] ?? matrix.temperatures.map(() => 1.2);
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
            <th className="p-1 text-left text-xs text-gray-500">g \ °C</th>
            {matrix.temperatures.map((temp, ti) => (
              <th key={ti} className="p-1">
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={temp}
                    onChange={(e) => setTemp(ti, Number(e.target.value))}
                    className="w-16 rounded border-gray-300 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => removeTemp(ti)}
                    className="text-gray-400 hover:text-red-600"
                    aria-label={t('feedingV2.band.remove')}
                  >
                    ×
                  </button>
                </div>
              </th>
            ))}
            <th className="p-1">
              <button type="button" onClick={addTemp} className="text-blue-600 text-xs">
                + {t('feedingV2.fcrMatrix.addTemp')}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {matrix.weights.map((weight, wi) => (
            <tr key={wi}>
              <td className="p-1">
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={weight}
                    onChange={(e) => setWeight(wi, Number(e.target.value))}
                    className="w-20 rounded border-gray-300 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => removeWeight(wi)}
                    className="text-gray-400 hover:text-red-600"
                    aria-label={t('feedingV2.band.remove')}
                  >
                    ×
                  </button>
                </div>
              </td>
              {matrix.temperatures.map((_, ti) => (
                <td key={ti} className="p-1">
                  <input
                    type="number"
                    min={0.5}
                    max={5}
                    step={0.01}
                    value={matrix.fcrValues[wi]?.[ti] ?? 1.2}
                    onChange={(e) => setCell(wi, ti, Number(e.target.value))}
                    className="w-16 rounded border-gray-300 text-xs"
                  />
                </td>
              ))}
              <td />
            </tr>
          ))}
          <tr>
            <td className="p-1">
              <button type="button" onClick={addWeight} className="text-blue-600 text-xs">
                + {t('feedingV2.fcrMatrix.addWeight')}
              </button>
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

  return (
    <Modal isOpen onClose={onClose} title={protocol ? t('feedingV2.editProtocol') : t('feedingV2.newProtocol')} size="xl">
      <form onSubmit={handleSubmit} className="space-y-6 max-h-[75vh] overflow-y-auto p-1">
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* Kimlik */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">{t('feedingV2.name')}</label>
            <input
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">{t('feedingV2.species')}</label>
            <select
              value={form.speciesId}
              onChange={(e) => setForm((prev) => ({ ...prev, speciesId: e.target.value }))}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
            >
              <option value="">{t('feedingV2.speciesAny')}</option>
              {speciesList.map((species) => (
                <option key={species.id} value={species.id}>
                  {species.commonName}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700">
              {t('feedingV2.description')}
            </label>
            <textarea
              rows={2}
              maxLength={2000}
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
            />
          </div>
          <div className="flex items-center gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                {t('feedingV2.statusLabel')}
              </label>
              <select
                value={form.status}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    status: e.target.value as FeedingProtocolV2Status,
                  }))
                }
                className="mt-1 rounded-md border-gray-300 shadow-sm text-sm"
              >
                <option value="DRAFT">{t('feedingV2.status.draft')}</option>
                <option value="ACTIVE">{t('feedingV2.status.active')}</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-5">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm((prev) => ({ ...prev, isDefault: e.target.checked }))}
                className="rounded border-gray-300 text-blue-600"
              />
              {t('feedingV2.isDefault')}
            </label>
          </div>
        </div>

        {/* Bandlar */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
            {t('feedingV2.bands')}
          </h4>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="p-1">{t('feedingV2.band.minWeight')}</th>
                  <th className="p-1">{t('feedingV2.band.maxWeight')}</th>
                  <th className="p-1">{t('feedingV2.band.feed')}</th>
                  <th className="p-1">{t('feedingV2.band.rate')}</th>
                  <th className="p-1">{t('feedingV2.band.fcr')}</th>
                  <th className="p-1">{t('feedingV2.band.meals')}</th>
                  <th className="p-1" />
                </tr>
              </thead>
              <tbody>
                {form.bands.map((band, i) => (
                  <React.Fragment key={i}>
                    <tr>
                      <td className="p-1">
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          value={band.minWeightG}
                          onChange={(e) => setBand(i, { minWeightG: Number(e.target.value) })}
                          className="w-24 rounded-md border-gray-300 shadow-sm text-sm"
                        />
                      </td>
                      <td className="p-1">
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          value={band.maxWeightG}
                          onChange={(e) => setBand(i, { maxWeightG: Number(e.target.value) })}
                          className="w-24 rounded-md border-gray-300 shadow-sm text-sm"
                        />
                      </td>
                      <td className="p-1">
                        <select
                          required
                          value={band.feedId}
                          onChange={(e) => setBand(i, { feedId: e.target.value })}
                          className="w-44 rounded-md border-gray-300 shadow-sm text-sm"
                        >
                          <option value="">{t('feedingV2.band.selectFeed')}</option>
                          {feeds.map((feed) => (
                            <option key={feed.id} value={feed.id}>
                              {feed.name} ({feed.code})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-1">
                        <input
                          type="number"
                          min={0}
                          max={15}
                          step={0.01}
                          value={band.feedingRatePercent}
                          onChange={(e) =>
                            setBand(i, { feedingRatePercent: Number(e.target.value) })
                          }
                          className="w-20 rounded-md border-gray-300 shadow-sm text-sm"
                        />
                      </td>
                      <td className="p-1">
                        <input
                          type="number"
                          min={0.5}
                          max={5}
                          step={0.01}
                          value={band.expectedFcr}
                          onChange={(e) => setBand(i, { expectedFcr: Number(e.target.value) })}
                          className="w-20 rounded-md border-gray-300 shadow-sm text-sm"
                        />
                      </td>
                      <td className="p-1">
                        <button
                          type="button"
                          onClick={() => setBandScheduleOpen(bandScheduleOpen === i ? null : i)}
                          className="text-sm text-blue-600 hover:text-blue-800"
                        >
                          {band.mealSchedule
                            ? t('feedingV2.band.mealsCustom', {
                                count: band.mealSchedule.mealsPerDay,
                              })
                            : t('feedingV2.band.mealsDefault')}
                        </button>
                      </td>
                      <td className="p-1">
                        {form.bands.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeBand(i)}
                            className="text-gray-400 hover:text-red-600"
                            aria-label={t('feedingV2.band.remove')}
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                    {bandScheduleOpen === i && (
                      <tr>
                        <td colSpan={7} className="p-2 bg-gray-50 rounded">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <p className="text-xs text-gray-500 mb-2">
                                {t('feedingV2.band.customSchedule')}
                              </p>
                              <MealScheduleEditor
                                schedule={band.mealSchedule ?? form.defaultMealSchedule}
                                onChange={(schedule) => setBand(i, { mealSchedule: schedule })}
                              />
                            </div>
                            {band.mealSchedule && (
                              <button
                                type="button"
                                onClick={() => setBand(i, { mealSchedule: undefined })}
                                className="text-sm text-blue-600 hover:text-blue-800 whitespace-nowrap"
                              >
                                {t('feedingV2.band.mealsDefault')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={addBand}
            disabled={form.bands.length >= 50}
            className="mt-2 text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
          >
            + {t('feedingV2.band.add')}
          </button>
        </div>

        {/* Varsayılan öğün planı */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
            {t('feedingV2.mealSchedule.title')}
          </h4>
          <MealScheduleEditor
            schedule={form.defaultMealSchedule}
            onChange={(schedule) => setForm((prev) => ({ ...prev, defaultMealSchedule: schedule }))}
          />
        </div>

        {/* Sıcaklık ayarlamaları */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
            {t('feedingV2.tempAdjustments.title')}
          </h4>
          {form.temperatureAdjustments.map((adj, i) => (
            <div key={i} className="flex items-center gap-2 mb-2">
              <input
                type="number"
                min={-10}
                max={50}
                value={adj.minC}
                onChange={(e) => setAdjustment(i, { minC: Number(e.target.value) })}
                className="w-20 rounded-md border-gray-300 shadow-sm text-sm"
                aria-label={t('feedingV2.tempAdjustments.minC')}
              />
              <span className="text-gray-400">–</span>
              <input
                type="number"
                min={-10}
                max={50}
                value={adj.maxC}
                onChange={(e) => setAdjustment(i, { maxC: Number(e.target.value) })}
                className="w-20 rounded-md border-gray-300 shadow-sm text-sm"
                aria-label={t('feedingV2.tempAdjustments.maxC')}
              />
              <span className="text-xs text-gray-500">°C ×</span>
              <input
                type="number"
                min={0.1}
                max={2}
                step={0.01}
                value={adj.rateMultiplier}
                onChange={(e) => setAdjustment(i, { rateMultiplier: Number(e.target.value) })}
                className="w-20 rounded-md border-gray-300 shadow-sm text-sm"
                aria-label={t('feedingV2.tempAdjustments.multiplier')}
              />
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    temperatureAdjustments: prev.temperatureAdjustments.filter(
                      (_, idx) => idx !== i,
                    ),
                  }))
                }
                className="text-gray-400 hover:text-red-600"
                aria-label={t('feedingV2.band.remove')}
              >
                ×
              </button>
            </div>
          ))}
          <button
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
            className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
          >
            + {t('feedingV2.tempAdjustments.add')}
          </button>
        </div>

        {/* Ayarlar */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
            {t('feedingV2.settings.title')}
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.settings.autoTransition}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    settings: { ...prev.settings, autoTransition: e.target.checked },
                  }))
                }
                className="rounded border-gray-300 text-blue-600"
              />
              {t('feedingV2.settings.autoTransition')}
            </label>
            <div>
              <label className="block text-sm text-gray-600">
                {t('feedingV2.settings.transitionBufferG')}
              </label>
              <input
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
                className="mt-1 w-24 rounded-md border-gray-300 shadow-sm text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600">
                {t('feedingV2.settings.growthMode')}
              </label>
              <select
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
                className="mt-1 rounded-md border-gray-300 shadow-sm text-sm"
              >
                <option value="per_meal">{t('feedingV2.settings.growthMode.perMeal')}</option>
                <option value="daily">{t('feedingV2.settings.growthMode.daily')}</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600">
                {t('feedingV2.settings.underfeedThreshold')}
              </label>
              <input
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
                className="mt-1 w-24 rounded-md border-gray-300 shadow-sm text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600">
                {t('feedingV2.settings.fcrSource')}
              </label>
              <select
                value={form.settings.fcrSource}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    settings: {
                      ...prev.settings,
                      fcrSource: e.target.value as ProtocolSettings['fcrSource'],
                    },
                    fcrMatrix:
                      e.target.value === 'matrix' ? (prev.fcrMatrix ?? ensureMatrix()) : prev.fcrMatrix,
                  }))
                }
                className="mt-1 rounded-md border-gray-300 shadow-sm text-sm"
              >
                <option value="band">{t('feedingV2.settings.fcrSource.band')}</option>
                <option value="matrix">{t('feedingV2.settings.fcrSource.matrix')}</option>
                <option value="feed">{t('feedingV2.settings.fcrSource.feed')}</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600">{t('feedingV2.settings.minDO')}</label>
              <input
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
                className="mt-1 w-24 rounded-md border-gray-300 shadow-sm text-sm"
              />
            </div>
          </div>
        </div>

        {/* FCR matrisi (yalnız fcrSource=matrix) */}
        {form.settings.fcrSource === 'matrix' && (
          <div>
            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
              {t('feedingV2.fcrMatrix.title')}
            </h4>
            <p className="text-xs text-gray-500 mb-2">{t('feedingV2.fcrMatrix.required')}</p>
            <FcrMatrixEditor
              matrix={form.fcrMatrix ?? ensureMatrix()}
              onChange={(matrix) => setForm((prev) => ({ ...prev, fcrMatrix: matrix }))}
            />
          </div>
        )}

        {/* Aksiyonlar */}
        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? t('common.loading') : t('common.save')}
          </button>
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

  const handleArchive = async (protocol: FeedingProtocolV2) => {
    if (!window.confirm(t('feedingV2.archiveConfirm', { name: protocol.name }))) return;
    await archiveMutation.mutateAsync(protocol.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t('feedingV2.builderTab.title')}</h2>
          <p className="text-sm text-gray-500">{t('feedingV2.builderTab.subtitle')}</p>
        </div>
        {canCreate && (
          <button
            onClick={() => setModalProtocol('new')}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            + {t('feedingV2.newProtocol')}
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
        </div>
      )}
      {isError && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-sm text-red-700">
          {t('feedingV2.loadError')}
        </div>
      )}

      {!isLoading && !isError && protocols.length === 0 && (
        <div className="bg-white rounded-lg shadow p-12 text-center text-sm text-gray-500">
          {t('feedingV2.empty')}
        </div>
      )}

      {protocols.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">{t('feedingV2.name')}</th>
                <th className="px-4 py-3">{t('feedingV2.species')}</th>
                <th className="px-4 py-3">{t('feedingV2.statusLabel')}</th>
                <th className="px-4 py-3">{t('feedingV2.bands')}</th>
                <th className="px-4 py-3">{t('feedingV2.mealSchedule.mealsPerDay')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {protocols.map((protocol) => (
                <tr key={protocol.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{protocol.name}</div>
                    {protocol.migrationNote && (
                      <div className="text-xs text-amber-600 mt-0.5">
                        {t('feedingV2.migrationNote')}: {protocol.migrationNote}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {protocol.speciesName ?? t('feedingV2.speciesAny')}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[protocol.status]}`}
                    >
                      {t(STATUS_KEY[protocol.status])}
                    </span>
                    {protocol.isDefault && (
                      <span className="ml-2 inline-flex rounded-full bg-blue-100 text-blue-800 px-2 py-0.5 text-xs">
                        {t('feedingV2.isDefault')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{protocol.bands.length}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {protocol.defaultMealSchedule.mealsPerDay}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {canUpdate && protocol.status !== 'ARCHIVED' && (
                      <button
                        onClick={() => setModalProtocol(protocol)}
                        className="text-blue-600 hover:text-blue-800 mr-3"
                      >
                        {t('common.edit')}
                      </button>
                    )}
                    {canArchive && protocol.status !== 'ARCHIVED' && (
                      <button
                        onClick={() => void handleArchive(protocol)}
                        className="text-gray-500 hover:text-red-600"
                      >
                        {t('feedingV2.archive')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
