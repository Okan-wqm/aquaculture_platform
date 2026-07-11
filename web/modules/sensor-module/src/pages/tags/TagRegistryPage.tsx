/**
 * TagRegistryPage — the product surface for the unified tag registry (SP-001).
 *
 * The `unified_tags` registry is the SSoT for tag identity across the SCADA
 * stack: widget bindings, deploy-time resolution, socket subscriptions, and
 * the live-data fan-out all resolve against it. Until this page existed the
 * registry had NO product write path — discover/CRUD mutations and hooks were
 * defined but nothing mounted them, so the registry stayed empty and every
 * binding resolved to "unresolved".
 *
 * Capabilities:
 *  - Discover: pull a selected edge device's I/O configs into registry tags
 *    (`discoverTags`, idempotent + concurrent-safe).
 *  - Browse: search + device-filtered, paginated table of registry tags.
 *  - Edit: display fields, engineering range, alarm limits — and the LIVE
 *    LINK (source.sensorId/channelId) that the ingestion fan-out uses to
 *    route live values onto this tag's FQN (SENSOR-HIGH-046).
 *  - Delete: remove a tag (server-side guards apply).
 */

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey } from '@aquaculture/shared-ui';
import {
  Tags,
  Search,
  RefreshCw,
  Radar,
  Pencil,
  Trash2,
  X,
  Link2,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

import { graphqlFetch } from '../../config/api';
import {
  useUnifiedTags,
  useDiscoverTags,
  useUpdateTag,
  useDeleteTag,
  type UnifiedTag,
  type UpdateTagInput,
} from '../../hooks/useUnifiedTags';
import { useEdgeDevices } from '../../hooks/useEdgeDevices';

// ── Sensor / channel pickers (live-link editor) ──────────────────────────────

const LINK_SENSORS_QUERY = `
  query TagRegistrySensors {
    sensors(pagination: { limit: 200 }) {
      items { id name }
    }
  }
`;

const LINK_CHANNELS_QUERY = `
  query TagRegistryChannels {
    allDataChannels { id sensorId channelKey displayLabel unit }
  }
`;

interface LinkSensor {
  id: string;
  name: string;
}

interface LinkChannel {
  id: string;
  sensorId: string;
  channelKey: string;
  displayLabel?: string;
  unit?: string;
}

function useLinkSensors() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'tagRegistryLinkSensors'),
    queryFn: async () => {
      const data = await graphqlFetch<{ sensors: { items: LinkSensor[] } }>(
        LINK_SENSORS_QUERY,
        {},
      );
      return data.sensors.items;
    },
  });
}

function useLinkChannels() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'tagRegistryLinkChannels'),
    queryFn: async () => {
      const data = await graphqlFetch<{ allDataChannels: LinkChannel[] }>(
        LINK_CHANNELS_QUERY,
        {},
      );
      return data.allDataChannels;
    },
  });
}

// ── Edit modal ────────────────────────────────────────────────────────────────

interface TagEditModalProps {
  tag: UnifiedTag;
  onClose: () => void;
  onSaved: () => void;
}

function numOrUndefined(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const TagEditModal: React.FC<TagEditModalProps> = ({ tag, onClose, onSaved }) => {
  const updateTag = useUpdateTag();
  const { data: sensors } = useLinkSensors();
  const { data: channels } = useLinkChannels();

  const [displayName, setDisplayName] = useState(tag.displayName ?? '');
  const [description, setDescription] = useState(tag.description ?? '');
  const [engUnit, setEngUnit] = useState(tag.engUnit ?? '');
  const [engMin, setEngMin] = useState(tag.engMin != null ? String(tag.engMin) : '');
  const [engMax, setEngMax] = useState(tag.engMax != null ? String(tag.engMax) : '');
  const [alarmHH, setAlarmHH] = useState(tag.alarmHH != null ? String(tag.alarmHH) : '');
  const [alarmH, setAlarmH] = useState(tag.alarmH != null ? String(tag.alarmH) : '');
  const [alarmL, setAlarmL] = useState(tag.alarmL != null ? String(tag.alarmL) : '');
  const [alarmLL, setAlarmLL] = useState(tag.alarmLL != null ? String(tag.alarmLL) : '');
  const [linkSensorId, setLinkSensorId] = useState(
    typeof tag.source?.sensorId === 'string' ? tag.source.sensorId : '',
  );
  const [linkChannelId, setLinkChannelId] = useState(
    typeof tag.source?.channelId === 'string' ? tag.source.channelId : '',
  );
  const [error, setError] = useState<string | null>(null);

  const sensorChannels = useMemo(
    () => (channels ?? []).filter((c) => c.sensorId === linkSensorId),
    [channels, linkSensorId],
  );

  const handleSave = async (): Promise<void> => {
    setError(null);
    // The live link rides in `source` alongside the existing provenance
    // fields; clearing the sensor clears the channel with it.
    const source: Record<string, unknown> = { ...tag.source };
    if (linkSensorId) {
      source.sensorId = linkSensorId;
      if (linkChannelId) source.channelId = linkChannelId;
      else delete source.channelId;
    } else {
      delete source.sensorId;
      delete source.channelId;
    }

    const input: UpdateTagInput = {
      id: tag.id,
      displayName: displayName || undefined,
      description: description || undefined,
      engUnit: engUnit || undefined,
      engMin: numOrUndefined(engMin),
      engMax: numOrUndefined(engMax),
      alarmHH: numOrUndefined(alarmHH),
      alarmH: numOrUndefined(alarmH),
      alarmL: numOrUndefined(alarmL),
      alarmLL: numOrUndefined(alarmLL),
      source,
    };
    try {
      await updateTag.mutateAsync(input);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const numField = (
    label: string,
    value: string,
    set: (v: string) => void,
  ): React.ReactElement => (
    <label className="flex flex-col gap-1 text-xs text-gray-600">
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="px-2 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Tag Düzenle</h2>
            <p className="text-xs text-gray-500 font-mono">{tag.fqn}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Kapat">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Görünen Ad
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Açıklama
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-xs text-gray-600">
              Birim
              <input
                value={engUnit}
                onChange={(e) => setEngUnit(e.target.value)}
                className="px-2 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900"
              />
            </label>
            {numField('Eng Min', engMin, setEngMin)}
            {numField('Eng Max', engMax, setEngMax)}
          </div>

          <div className="grid grid-cols-4 gap-2">
            {numField('Alarm LL', alarmLL, setAlarmLL)}
            {numField('Alarm L', alarmL, setAlarmL)}
            {numField('Alarm H', alarmH, setAlarmH)}
            {numField('Alarm HH', alarmHH, setAlarmHH)}
          </div>

          <div className="border-t border-gray-100 pt-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Link2 className="w-3.5 h-3.5 text-cyan-600" />
              <span className="text-xs font-medium text-gray-700">Canlı Veri Bağlantısı</span>
            </div>
            <p className="text-[11px] text-gray-500 mb-2">
              Bu tag&apos;i bir sensör kanalına bağlayın — gelen ölçümler bu tag&apos;in
              FQN&apos;i altında operatör ekranlarına canlı akar.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs text-gray-600">
                Sensör
                <select
                  value={linkSensorId}
                  onChange={(e) => {
                    setLinkSensorId(e.target.value);
                    setLinkChannelId('');
                  }}
                  className="px-2 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900 bg-white"
                >
                  <option value="">— bağlantı yok —</option>
                  {(sensors ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-600">
                Kanal
                <select
                  value={linkChannelId}
                  onChange={(e) => setLinkChannelId(e.target.value)}
                  disabled={!linkSensorId}
                  className="px-2 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900 bg-white disabled:bg-gray-50 disabled:text-gray-400"
                >
                  <option value="">— tüm kanallar —</option>
                  {sensorChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayLabel || c.channelKey}{c.unit ? ` (${c.unit})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md"
          >
            İptal
          </button>
          <button
            onClick={handleSave}
            disabled={updateTag.isPending}
            className="px-3 py-1.5 text-sm text-white bg-cyan-600 hover:bg-cyan-700 rounded-md disabled:opacity-50 flex items-center gap-1.5"
          >
            {updateTag.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Kaydet
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const TagRegistryPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [page, setPage] = useState(1);
  const [editingTag, setEditingTag] = useState<UnifiedTag | null>(null);
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<UnifiedTag | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const { data: devices } = useEdgeDevices();
  const { tags, total, loading, error, refetch } = useUnifiedTags(
    {
      searchTerm: searchTerm || undefined,
      edgeDeviceId: deviceId || undefined,
    },
    { page, limit: PAGE_SIZE },
  );

  const discover = useDiscoverTags();
  const deleteTag = useDeleteTag();

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleDiscover = async (): Promise<void> => {
    if (!deviceId) return;
    setBanner(null);
    try {
      const result = await discover.mutateAsync(deviceId);
      setBanner({
        kind: 'ok',
        text: `Keşif tamam: ${result.discoveredCount} I/O konfigürasyonu tarandı, ${result.createdCount} yeni tag oluşturuldu.`,
      });
      refetch();
    } catch (e) {
      setBanner({ kind: 'error', text: `Keşif başarısız: ${(e as Error).message}` });
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!confirmDeleteTag) return;
    setBanner(null);
    try {
      await deleteTag.mutateAsync(confirmDeleteTag.id);
      setConfirmDeleteTag(null);
      refetch();
    } catch (e) {
      setConfirmDeleteTag(null);
      setBanner({ kind: 'error', text: `Silme başarısız: ${(e as Error).message}` });
    }
  };

  const linkedBadge = (tag: UnifiedTag): React.ReactElement => {
    const isLinked = typeof tag.source?.sensorId === 'string' && tag.source.sensorId !== '';
    return isLinked ? (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
        <Link2 className="w-3 h-3" /> canlı
      </span>
    ) : (
      <span className="text-[11px] text-gray-400">—</span>
    );
  };

  return (
    <div className="p-4 flex flex-col gap-4 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Tags className="w-5 h-5 text-cyan-600" />
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Tag Registry</h1>
            <p className="text-xs text-gray-500">
              SCADA bağlamalarının, deploy çözümlemesinin ve canlı verinin tek kimlik kaynağı
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={deviceId}
            onChange={(e) => { setDeviceId(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900 bg-white"
            aria-label="Edge cihazı"
          >
            <option value="">Tüm cihazlar</option>
            {(devices?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.deviceCode}</option>
            ))}
          </select>
          <button
            onClick={handleDiscover}
            disabled={!deviceId || discover.isPending}
            title={deviceId ? 'Cihazın I/O konfigürasyonlarından tag keşfet' : 'Önce bir cihaz seçin'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-cyan-600 hover:bg-cyan-700 rounded-md disabled:opacity-50"
          >
            {discover.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Radar className="w-4 h-4" />}
            Tag Keşfet
          </button>
          <button
            onClick={() => refetch()}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md"
            title="Yenile"
            aria-label="Yenile"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Banner */}
      {banner && (
        <div
          className={`text-xs px-3 py-2 rounded-md border ${
            banner.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          value={searchTerm}
          onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
          placeholder="FQN veya ada göre ara..."
          className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded-md text-sm text-gray-900"
        />
      </div>

      {/* Table */}
      <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs text-gray-500 border-b border-gray-200">
              <th className="px-3 py-2 font-medium">FQN</th>
              <th className="px-3 py-2 font-medium">Ad</th>
              <th className="px-3 py-2 font-medium">I/O</th>
              <th className="px-3 py-2 font-medium">Veri Tipi</th>
              <th className="px-3 py-2 font-medium">Yön</th>
              <th className="px-3 py-2 font-medium">Birim</th>
              <th className="px-3 py-2 font-medium">Aralık</th>
              <th className="px-3 py-2 font-medium">Canlı</th>
              <th className="px-3 py-2 font-medium text-right">İşlem</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-400">
                  <Loader2 className="w-5 h-5 animate-spin inline-block" />
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-sm text-red-600">{error}</td>
              </tr>
            )}
            {!loading && !error && tags.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-sm text-gray-400">
                  Kayıtlı tag yok. Bir cihaz seçip <span className="font-medium">Tag Keşfet</span> ile başlayın.
                </td>
              </tr>
            )}
            {!loading && !error && tags.map((tag) => (
              <tr key={tag.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs text-gray-900">{tag.fqn}</td>
                <td className="px-3 py-2 text-gray-700">{tag.displayName || tag.localName}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{tag.ioType}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{tag.dataType}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{tag.direction}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{tag.engUnit ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {tag.engMin != null || tag.engMax != null
                    ? `${tag.engMin ?? '−∞'} … ${tag.engMax ?? '+∞'}`
                    : '—'}
                </td>
                <td className="px-3 py-2">{linkedBadge(tag)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={() => setEditingTag(tag)}
                    className="p-1 text-gray-400 hover:text-cyan-600"
                    title="Düzenle"
                    aria-label={`${tag.fqn} tag'ini düzenle`}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setConfirmDeleteTag(tag)}
                    className="p-1 text-gray-400 hover:text-red-600"
                    title="Sil"
                    aria-label={`${tag.fqn} tag'ini sil`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{total} tag</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40"
          >
            Önceki
          </button>
          <span>{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40"
          >
            Sonraki
          </button>
        </div>
      </div>

      {/* Edit modal */}
      {editingTag && (
        <TagEditModal
          tag={editingTag}
          onClose={() => setEditingTag(null)}
          onSaved={() => {
            setEditingTag(null);
            refetch();
          }}
        />
      )}

      {/* Delete confirm */}
      {confirmDeleteTag && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-4">
            <h2 className="text-sm font-semibold text-gray-900 mb-1">Tag silinsin mi?</h2>
            <p className="text-xs text-gray-500 mb-3">
              <span className="font-mono">{confirmDeleteTag.fqn}</span> kalıcı olarak silinecek.
              Bu tag&apos;e bağlı widget bağlamaları çözülemez hale gelir.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteTag(null)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md"
              >
                İptal
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteTag.isPending}
                className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded-md disabled:opacity-50"
              >
                Sil
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TagRegistryPage;
