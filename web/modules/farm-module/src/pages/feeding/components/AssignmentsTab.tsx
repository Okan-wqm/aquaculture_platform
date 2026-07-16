/**
 * AssignmentsTab — Protokol atamaları (Faz 3)
 *
 * Ünite × protokol × güncel yem/band görünümü + operasyonel override editörü:
 *  - Ünite FCR override'ları: protokol varsayılanı yanında gösterilir,
 *    override'lı değer rozetlenir, tek tıkla varsayılana dönülür (R11).
 *  - Sıcaklık sensörü ataması MEVCUT `equipment.temperatureSensorId` kolonuna
 *    yazar (C-3 — üçüncü bağlama yeri yok); seçici EquipmentTab'daki federe
 *    `useSensors` desenini yeniden kullanır.
 *  - Etkin sıcaklık rozeti (SENSÖR / MANUEL / YOK) tek toplu sorgudan gelir;
 *    YOK = taban oran (çarpan 1.0) AÇIKÇA görünür (P-20). "Manuel sıcaklık
 *    gir" kısayolu mevcut water-chemistry giriş ekranına gider — yeni yazma
 *    yolu değil.
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal, useCanMutate, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import {
  useProtocolAssignments,
  useFeedingProtocolsV2,
  useAssignProtocolToUnit,
  useUpdateProtocolAssignment,
  useUnassignProtocolFromUnit,
  useEffectiveUnitTemperatures,
  useTransitionUnitFeed,
  type ProtocolAssignment,
  type ProtocolAssignmentStatus,
  type FeedingProtocolV2,
  type FeedingUnitType,
  type AssignmentOverrides,
  type FcrOverride,
  type EffectiveTemperatureSource,
} from '../../../hooks/useProtocolFeeding';
import { useEquipmentList, useUpdateEquipment } from '../../../hooks/useEquipment';
import { useSensors } from '../../../hooks/useSensors';

// ============================================================================
// HELPERS
// ============================================================================

const UNIT_CATEGORIES = ['TANK', 'POND', 'CAGE'] as const;

// FeedingUnitType bir GraphQL ENUM'udur — input'a AD ('TANK') gönderilir
// (kasa kuralı useProtocolFeeding.ts başında; 'tank' göndermek GraphQL
// doğrulamasında reddedilir).
const CATEGORY_TO_UNIT_TYPE: Record<string, FeedingUnitType> = {
  TANK: 'TANK',
  POND: 'POND',
  CAGE: 'CAGE',
};

const UNIT_TYPE_KEY: Record<FeedingUnitType, MessageKey> = {
  TANK: 'feedingV2.assignments.unitType.tank',
  POND: 'feedingV2.assignments.unitType.pond',
  CAGE: 'feedingV2.assignments.unitType.cage',
};

const ASSIGNMENT_STATUS_KEY: Record<ProtocolAssignmentStatus, MessageKey> = {
  ACTIVE: 'feedingV2.assignments.status.active',
  PAUSED: 'feedingV2.assignments.status.paused',
  ENDED: 'feedingV2.assignments.status.ended',
};

const ASSIGNMENT_STATUS_BADGE: Record<ProtocolAssignmentStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  PAUSED: 'bg-yellow-100 text-yellow-800',
  ENDED: 'bg-gray-100 text-gray-600',
};

const TEMP_SOURCE_KEY: Record<EffectiveTemperatureSource, MessageKey> = {
  sensor: 'feedingV2.assignments.tempSource.sensor',
  manual: 'feedingV2.assignments.tempSource.manual',
  none: 'feedingV2.assignments.tempSource.none',
};

const TEMP_SOURCE_BADGE: Record<EffectiveTemperatureSource, string> = {
  sensor: 'bg-green-100 text-green-800',
  manual: 'bg-blue-100 text-blue-800',
  none: 'bg-amber-100 text-amber-800',
};

/** Backend'in tür-uyumsuzluğu reddi — gerekçe alanını açan ayırt edici metin. */
function isSpeciesMismatchError(message: string): boolean {
  return /tür|species/i.test(message) && /uyum|mismatch|reason|gerekçe/i.test(message);
}

// ============================================================================
// ASSIGN MODAL
// ============================================================================

interface AssignModalProps {
  protocols: FeedingProtocolV2[];
  onClose: () => void;
}

const AssignModal: React.FC<AssignModalProps> = ({ protocols, onClose }) => {
  const { t } = useI18n();
  const [unitId, setUnitId] = useState('');
  const [protocolId, setProtocolId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [mismatchReason, setMismatchReason] = useState('');
  const [needsMismatchReason, setNeedsMismatchReason] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: equipmentData } = useEquipmentList();
  const assignMutation = useAssignProtocolToUnit();

  const units = useMemo(
    () =>
      (equipmentData?.items ?? []).filter((equipment) =>
        UNIT_CATEGORIES.includes(
          (equipment.equipmentType?.category ?? '') as (typeof UNIT_CATEGORIES)[number],
        ),
      ),
    [equipmentData],
  );

  const selectedUnit = units.find((unit) => unit.id === unitId);
  const activeProtocols = protocols.filter((protocol) => protocol.status === 'ACTIVE');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!selectedUnit) return;
    const unitType =
      CATEGORY_TO_UNIT_TYPE[selectedUnit.equipmentType?.category ?? 'TANK'] ?? 'TANK';
    try {
      await assignMutation.mutateAsync({
        unitId,
        unitType,
        protocolId,
        effectiveFrom: effectiveFrom || undefined,
        speciesMismatchReason: mismatchReason.trim() || undefined,
      });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error');
      if (isSpeciesMismatchError(message)) setNeedsMismatchReason(true);
      setError(message);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={t('feedingV2.assignments.assign')} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 whitespace-pre-wrap">
            {error}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700">
            {t('feedingV2.assignments.unit')}
          </label>
          <select
            required
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
          >
            <option value="">{t('feedingV2.assignments.selectUnit')}</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name} ({unit.code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            {t('feedingV2.assignments.protocol')}
          </label>
          <select
            required
            value={protocolId}
            onChange={(e) => setProtocolId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
          >
            <option value="">{t('feedingV2.assignments.selectProtocol')}</option>
            {activeProtocols.map((protocol) => (
              <option key={protocol.id} value={protocol.id}>
                {protocol.name}
                {protocol.speciesName ? ` — ${protocol.speciesName}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            {t('feedingV2.assignments.effectiveFrom')}
          </label>
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
          />
        </div>
        {needsMismatchReason && (
          <div className="rounded-md bg-amber-50 border border-amber-200 p-3">
            <p className="text-sm text-amber-800 mb-2">
              {t('feedingV2.assignments.speciesMismatch')}
            </p>
            <label className="block text-sm font-medium text-gray-700">
              {t('feedingV2.assignments.speciesMismatchReason')}
            </label>
            <input
              maxLength={500}
              value={mismatchReason}
              onChange={(e) => setMismatchReason(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
            />
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={assignMutation.isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {assignMutation.isPending ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// EDIT (OVERRIDES + FCR OVERRIDES + SENSOR) MODAL
// ============================================================================

interface EditModalProps {
  assignment: ProtocolAssignment;
  protocol?: FeedingProtocolV2;
  /** Ünitenin mevcut sensör bağı (equipment.temperatureSensorId). */
  currentSensorId?: string;
  onClose: () => void;
}

const EditAssignmentModal: React.FC<EditModalProps> = ({
  assignment,
  protocol,
  currentSensorId,
  onClose,
}) => {
  const { t } = useI18n();
  const [overrides, setOverrides] = useState<AssignmentOverrides>(assignment.overrides ?? {});
  const [sensorId, setSensorId] = useState(currentSensorId ?? '');
  const [error, setError] = useState<string | null>(null);

  const { sensors } = useSensors();
  const updateAssignment = useUpdateProtocolAssignment();
  const updateEquipment = useUpdateEquipment();
  const canEditEquipment = useCanMutate('updateProtocolAssignment');

  // Protokol bandlarından benzersiz yemler → FCR override satırları.
  const bandFeeds = useMemo(() => {
    const map = new Map<string, { feedId: string; feedName: string; defaultFcr: number }>();
    for (const band of protocol?.bands ?? []) {
      if (!map.has(band.feedId)) {
        map.set(band.feedId, {
          feedId: band.feedId,
          feedName: `${band.feedName} (${band.feedCode})`,
          defaultFcr: band.expectedFcr,
        });
      }
    }
    return [...map.values()];
  }, [protocol]);

  const overrideFor = (feedId: string): FcrOverride | undefined =>
    overrides.fcrOverrides?.find((entry) => entry.feedId === feedId);

  const setFcrOverride = (feedId: string, value: number | null) => {
    setOverrides((prev) => {
      const rest = (prev.fcrOverrides ?? []).filter((entry) => entry.feedId !== feedId);
      const next = value === null ? rest : [...rest, { feedId, expectedFcr: value }];
      return { ...prev, fcrOverrides: next.length > 0 ? next : undefined };
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await updateAssignment.mutateAsync({ assignmentId: assignment.id, overrides });
      if (sensorId !== (currentSensorId ?? '')) {
        // C-3: sensör bağı equipment kolonunda yaşar — atama kaydında DEĞİL.
        await updateEquipment.mutateAsync({
          id: assignment.unitId,
          temperatureSensorId: sensorId || undefined,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  };

  const saving = updateAssignment.isPending || updateEquipment.isPending;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${t('feedingV2.assignments.editTitle')} — ${assignment.unitName}`}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-5 max-h-[70vh] overflow-y-auto p-1">
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* Operasyonel override'lar */}
        <div>
          <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
            {t('feedingV2.assignments.overrides')}
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-600">
                {t('feedingV2.assignments.offset')}
              </label>
              <input
                type="number"
                min={-720}
                max={720}
                value={overrides.mealTimeOffsetMinutes ?? ''}
                onChange={(e) =>
                  setOverrides((prev) => ({
                    ...prev,
                    mealTimeOffsetMinutes:
                      e.target.value === '' ? undefined : Number(e.target.value),
                  }))
                }
                className="mt-1 w-24 rounded-md border-gray-300 shadow-sm text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600">
                {t('feedingV2.assignments.mealsPerDayOverride')}
              </label>
              <input
                type="number"
                min={1}
                max={24}
                value={overrides.mealsPerDayOverride ?? ''}
                onChange={(e) =>
                  setOverrides((prev) => ({
                    ...prev,
                    mealsPerDayOverride: e.target.value === '' ? undefined : Number(e.target.value),
                  }))
                }
                className="mt-1 w-24 rounded-md border-gray-300 shadow-sm text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600">
                {t('feedingV2.assignments.rateAdjustment')}
              </label>
              <input
                type="number"
                min={-50}
                max={50}
                step={0.1}
                value={overrides.rateAdjustmentPercent ?? ''}
                onChange={(e) =>
                  setOverrides((prev) => ({
                    ...prev,
                    rateAdjustmentPercent:
                      e.target.value === '' ? undefined : Number(e.target.value),
                  }))
                }
                className="mt-1 w-24 rounded-md border-gray-300 shadow-sm text-sm"
              />
            </div>
          </div>
        </div>

        {/* Ünite FCR override'ları (R11) */}
        {bandFeeds.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
              {t('feedingV2.assignments.fcrOverrides')}
            </h4>
            <div className="space-y-2">
              {bandFeeds.map((feed) => {
                const override = overrideFor(feed.feedId);
                return (
                  <div key={feed.feedId} className="flex items-center gap-3">
                    <span className="text-sm text-gray-700 w-56 truncate">{feed.feedName}</span>
                    <span className="text-xs text-gray-500 w-44">
                      {t('feedingV2.assignments.fcrOverride.protocolDefault', {
                        value: feed.defaultFcr,
                      })}
                    </span>
                    <input
                      type="number"
                      min={0.5}
                      max={5}
                      step={0.01}
                      value={override?.expectedFcr ?? ''}
                      placeholder={String(feed.defaultFcr)}
                      onChange={(e) =>
                        setFcrOverride(
                          feed.feedId,
                          e.target.value === '' ? null : Number(e.target.value),
                        )
                      }
                      className="w-24 rounded-md border-gray-300 shadow-sm text-sm"
                    />
                    {override && (
                      <>
                        <span className="inline-flex rounded-full bg-purple-100 text-purple-800 px-2 py-0.5 text-xs">
                          {t('feedingV2.assignments.fcrOverride.overridden')}
                        </span>
                        <button
                          type="button"
                          onClick={() => setFcrOverride(feed.feedId, null)}
                          className="text-sm text-blue-600 hover:text-blue-800"
                        >
                          {t('feedingV2.assignments.fcrOverride.reset')}
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Sıcaklık sensörü (equipment.temperatureSensorId — C-3) */}
        {canEditEquipment && (
          <div>
            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-3">
              {t('feedingV2.assignments.tempSensor')}
            </h4>
            <select
              value={sensorId}
              onChange={(e) => setSensorId(e.target.value)}
              className="block w-full sm:w-80 rounded-md border-gray-300 shadow-sm text-sm"
            >
              <option value="">{t('feedingV2.assignments.noSensor')}</option>
              {sensors.map((sensor) => (
                <option key={sensor.id} value={sensor.id}>
                  {sensor.name} ({sensor.type})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-gray-200">
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

interface AssignmentsTabProps {
  siteId?: string;
}

export const AssignmentsTab: React.FC<AssignmentsTabProps> = ({ siteId }) => {
  const { t } = useI18n();
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [editAssignment, setEditAssignment] = useState<ProtocolAssignment | null>(null);

  const { data: assignmentsData, isLoading } = useProtocolAssignments(
    siteId ? { siteId } : undefined,
  );
  const { data: protocolsData } = useFeedingProtocolsV2();
  const { data: equipmentData } = useEquipmentList();
  const updateAssignment = useUpdateProtocolAssignment();
  const unassign = useUnassignProtocolFromUnit();
  const transitionFeed = useTransitionUnitFeed();
  const [transitionAssignment, setTransitionAssignment] = useState<ProtocolAssignment | null>(
    null,
  );

  const canAssign = useCanMutate('assignProtocolToUnit');
  const canTransition = useCanMutate('transitionUnitFeed');
  const canUpdate = useCanMutate('updateProtocolAssignment');
  const canUnassign = useCanMutate('unassignProtocolFromUnit');

  const assignments = useMemo(
    () => (assignmentsData?.items ?? []).filter((a) => a.status !== 'ENDED'),
    [assignmentsData],
  );
  const protocols = protocolsData?.items ?? [];
  const protocolById = useMemo(
    () => new Map(protocols.map((protocol) => [protocol.id, protocol])),
    [protocols],
  );
  const equipmentById = useMemo(
    () => new Map((equipmentData?.items ?? []).map((equipment) => [equipment.id, equipment])),
    [equipmentData],
  );

  // Etkin sıcaklık rozetleri — listelenen üniteler için TEK toplu sorgu (K-11).
  const unitIds = useMemo(() => assignments.map((a) => a.unitId), [assignments]);
  const { data: temperatureMap } = useEffectiveUnitTemperatures(unitIds);

  const currentFeedName = (assignment: ProtocolAssignment): string => {
    const protocol = protocolById.get(assignment.protocolId);
    if (!protocol) return '—';
    if (assignment.currentFeedId) {
      const band = protocol.bands.find((b) => b.feedId === assignment.currentFeedId);
      if (band) return `${band.feedName} (${band.feedCode})`;
    }
    if (assignment.currentBandIndex != null) {
      const band = protocol.bands[assignment.currentBandIndex];
      if (band) return `${band.feedName} (${band.feedCode})`;
    }
    return '—';
  };

  const handleToggleStatus = async (assignment: ProtocolAssignment) => {
    await updateAssignment.mutateAsync({
      assignmentId: assignment.id,
      status: assignment.status === 'ACTIVE' ? 'paused' : 'active',
    });
  };

  const handleUnassign = async (assignment: ProtocolAssignment) => {
    if (!window.confirm(t('feedingV2.assignments.unassignConfirm', { unit: assignment.unitName })))
      return;
    await unassign.mutateAsync(assignment.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {t('feedingV2.assignments.title')}
          </h2>
          <p className="text-sm text-gray-500">{t('feedingV2.assignments.subtitle')}</p>
        </div>
        {canAssign && (
          <button
            onClick={() => setAssignModalOpen(true)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            + {t('feedingV2.assignments.assign')}
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
        </div>
      )}

      {!isLoading && assignments.length === 0 && (
        <div className="bg-white rounded-lg shadow p-12 text-center text-sm text-gray-500">
          {t('feedingV2.assignments.empty')}
        </div>
      )}

      {assignments.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">{t('feedingV2.assignments.unit')}</th>
                <th className="px-4 py-3">{t('feedingV2.assignments.protocol')}</th>
                <th className="px-4 py-3">{t('feedingV2.statusLabel')}</th>
                <th className="px-4 py-3">{t('feedingV2.assignments.currentFeed')}</th>
                <th className="px-4 py-3">{t('feedingV2.assignments.temperature')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {assignments.map((assignment) => {
                const protocol = protocolById.get(assignment.protocolId);
                const temp = temperatureMap?.get(assignment.unitId);
                const overrideCount = assignment.overrides?.fcrOverrides?.length ?? 0;
                return (
                  <tr key={assignment.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{assignment.unitName}</div>
                      <div className="text-xs text-gray-500">
                        {assignment.unitCode} · {t(UNIT_TYPE_KEY[assignment.unitType])}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-900">{protocol?.name ?? assignment.protocolId}</div>
                      {overrideCount > 0 && (
                        <span className="inline-flex rounded-full bg-purple-100 text-purple-800 px-2 py-0.5 text-xs mt-0.5">
                          {t('feedingV2.assignments.fcrOverride.overridden')} ({overrideCount})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ASSIGNMENT_STATUS_BADGE[assignment.status]}`}
                      >
                        {t(ASSIGNMENT_STATUS_KEY[assignment.status])}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{currentFeedName(assignment)}</td>
                    <td className="px-4 py-3">
                      {temp ? (
                        <div>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${TEMP_SOURCE_BADGE[temp.source]}`}
                            title={
                              temp.source === 'none'
                                ? t('feedingV2.assignments.tempNoneHint')
                                : (temp.measuredAt ?? '')
                            }
                          >
                            {t(TEMP_SOURCE_KEY[temp.source])}
                            {temp.celsius != null ? ` · ${temp.celsius.toFixed(1)}°C` : ''}
                          </span>
                          {temp.source === 'none' && (
                            <Link
                              to="/sites/water-chemistry"
                              className="block text-xs text-blue-600 hover:text-blue-800 mt-0.5"
                            >
                              {t('feedingV2.assignments.enterTemperature')}
                            </Link>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {canUpdate && (
                        <>
                          <button
                            onClick={() => setEditAssignment(assignment)}
                            className="text-blue-600 hover:text-blue-800 mr-3"
                          >
                            {t('common.edit')}
                          </button>
                          <button
                            onClick={() => void handleToggleStatus(assignment)}
                            className="text-gray-600 hover:text-gray-800 mr-3"
                          >
                            {assignment.status === 'ACTIVE'
                              ? t('feedingV2.assignments.pause')
                              : t('feedingV2.assignments.resume')}
                          </button>
                        </>
                      )}
                      {canTransition && assignment.status === 'ACTIVE' && (
                        <button
                          onClick={() => setTransitionAssignment(assignment)}
                          className="text-amber-700 hover:text-amber-900 mr-3"
                        >
                          {t('feedingV2.assignments.manualTransition')}
                        </button>
                      )}
                      {canUnassign && (
                        <button
                          onClick={() => void handleUnassign(assignment)}
                          className="text-gray-500 hover:text-red-600"
                        >
                          {t('feedingV2.assignments.unassign')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {assignModalOpen && (
        <AssignModal protocols={protocols} onClose={() => setAssignModalOpen(false)} />
      )}
      {transitionAssignment && (
        <Modal
          isOpen
          onClose={() => setTransitionAssignment(null)}
          title={t('feedingV2.assignments.manualTransition')}
        >
          <div className="space-y-3">
            {(protocolById.get(transitionAssignment.protocolId)?.bands ?? []).map((band) => (
              <button
                key={band.feedId}
                type="button"
                disabled={
                  transitionFeed.isPending || band.feedId === transitionAssignment.currentFeedId
                }
                onClick={() => {
                  const label = `${band.feedName} (${band.feedCode})`;
                  if (
                    !window.confirm(
                      t('feedingV2.assignments.manualTransitionConfirm', {
                        unit: transitionAssignment.unitCode,
                        feed: label,
                      }),
                    )
                  ) {
                    return;
                  }
                  void transitionFeed
                    .mutateAsync({
                      unitId: transitionAssignment.unitId,
                      toFeedId: band.feedId,
                    })
                    .then(() => setTransitionAssignment(null));
                }}
                className="flex w-full items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                <span>
                  {band.feedName} ({band.feedCode})
                </span>
                <span className="text-xs text-gray-500">
                  {band.minWeightG}–{band.maxWeightG} g
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {editAssignment && (
        <EditAssignmentModal
          assignment={editAssignment}
          protocol={protocolById.get(editAssignment.protocolId)}
          currentSensorId={equipmentById.get(editAssignment.unitId)?.temperatureSensorId}
          onClose={() => setEditAssignment(null)}
        />
      )}
    </div>
  );
};
