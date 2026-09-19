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
import {
  ConfirmModal,
  Modal,
  useTenantQuery,
  DataTable,
  type DataTableColumn,
  Spinner,
  Button,
  Input,
} from '@aquaculture/shared-ui';
import {
  Tags,
  Search,
  RefreshCw,
  Radar,
  Pencil,
  Trash2,
  Archive,
  Link2,
  AlertTriangle,
} from 'lucide-react';

import { graphqlFetch } from '../../config/api';
import {
  useUnifiedTags,
  useDiscoverTags,
  useUpdateTag,
  useDeleteTag,
  useRetireTag,
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

// useTenantQuery is the SSoT for tenant-scoped fetches (key prefix + auth
// enabled-gate baked in) — hand-rolling useQuery + createTenantQueryKey is
// ratcheted by web-usetenantquery-adoption-ratchet.spec.ts.
function useLinkSensors() {
  return useTenantQuery(['tagRegistryLinkSensors'], async () => {
    const data = await graphqlFetch<{ sensors: { items: LinkSensor[] } }>(LINK_SENSORS_QUERY, {});
    return data.sensors.items;
  });
}

function useLinkChannels() {
  return useTenantQuery(['tagRegistryLinkChannels'], async () => {
    const data = await graphqlFetch<{ allDataChannels: LinkChannel[] }>(LINK_CHANNELS_QUERY, {});
    return data.allDataChannels;
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

  const numField = (label: string, value: string, set: (v: string) => void): React.ReactElement => (
    <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
      {label}
      <Input type="number" value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title="Tag Düzenle"
      description={<span className="font-mono">{tag.fqn}</span>}
      showCloseButton={!updateTag.isPending}
      closeOnEscape={!updateTag.isPending}
      closeOnOverlayClick={!updateTag.isPending}
      className="max-h-[85vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            İptal
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={updateTag.isPending}>
            {updateTag.isPending && <Spinner size="sm" color="inherit" />}
            Kaydet
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
        Görünen Ad
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
        Açıklama
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
          Birim
          <Input value={engUnit} onChange={(e) => setEngUnit(e.target.value)} />
        </label>
        {numField('Eng Min', engMin, setEngMin)}
        {numField('Eng Max', engMax, setEngMax)}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {numField('Alarm LL', alarmLL, setAlarmLL)}
        {numField('Alarm L', alarmL, setAlarmL)}
        {numField('Alarm H', alarmH, setAlarmH)}
        {numField('Alarm HH', alarmHH, setAlarmHH)}
      </div>

      <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Link2 className="w-3.5 h-3.5 text-info-600 dark:text-info-400" />
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Canlı Veri Bağlantısı
          </span>
        </div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
          Bu tag&apos;i bir sensör kanalına bağlayın — gelen ölçümler bu tag&apos;in FQN&apos;i
          altında operatör ekranlarına canlı akar.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
            Sensör
            <select
              value={linkSensorId}
              onChange={(e) => {
                setLinkSensorId(e.target.value);
                setLinkChannelId('');
              }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-md text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900"
            >
              <option value="">— bağlantı yok —</option>
              {(sensors ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
            Kanal
            <select
              value={linkChannelId}
              onChange={(e) => setLinkChannelId(e.target.value)}
              disabled={!linkSensorId}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-md text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-400 dark:disabled:text-gray-500"
            >
              <option value="">— tüm kanallar —</option>
              {sensorChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayLabel || c.channelKey}
                  {c.unit ? ` (${c.unit})` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-error-600 dark:text-error-400 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-md px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {error}
        </div>
      )}
    </Modal>
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
  const [confirmRetireTag, setConfirmRetireTag] = useState<UnifiedTag | null>(null);
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
  const retireTag = useRetireTag();

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

  const handleRetire = async (): Promise<void> => {
    if (!confirmRetireTag) return;
    setBanner(null);
    try {
      await retireTag.mutateAsync(confirmRetireTag.id);
      setConfirmRetireTag(null);
      refetch();
    } catch (e) {
      setConfirmRetireTag(null);
      setBanner({ kind: 'error', text: `Emeklilik başarısız: ${(e as Error).message}` });
    }
  };

  const statusBadge = (status: string): React.ReactElement => {
    const styles: Record<string, string> = {
      draft:
        'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700',
      active:
        'bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300 border-info-200 dark:border-info-800',
      retired:
        'bg-warning-50 dark:bg-warning-900/20 text-warning-700 dark:text-warning-300 border-warning-200 dark:border-warning-800',
    };
    return (
      <span
        className={`inline-block px-1.5 py-0.5 text-[11px] rounded border ${styles[status] ?? styles.draft}`}
      >
        {status}
      </span>
    );
  };

  const linkedBadge = (tag: UnifiedTag): React.ReactElement => {
    const isLinked = typeof tag.source?.sensorId === 'string' && tag.source.sensorId !== '';
    return isLinked ? (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 border border-success-200 dark:border-success-800">
        <Link2 className="w-3 h-3" /> canlı
      </span>
    ) : (
      <span className="text-[11px] text-gray-400 dark:text-gray-500">—</span>
    );
  };

  const unifiedTagColumns: DataTableColumn<UnifiedTag>[] = [
    {
      key: 'fqn',
      header: 'FQN',
      render: (_value, tag) => tag.fqn,
    },
    {
      key: 'ad',
      header: 'Ad',
      render: (_value, tag) => tag.displayName || tag.localName,
    },
    {
      key: 'iO',
      header: 'I/O',
      render: (_value, tag) => tag.ioType,
    },
    {
      key: 'veriTipi',
      header: 'Veri Tipi',
      render: (_value, tag) => tag.dataType,
    },
    {
      key: 'yN',
      header: 'Yön',
      render: (_value, tag) => tag.direction,
    },
    {
      key: 'birim',
      header: 'Birim',
      render: (_value, tag) => tag.engUnit ?? '—',
    },
    {
      key: 'aralK',
      header: 'Aralık',
      render: (_value, tag) => (
        <>
          {tag.engMin != null || tag.engMax != null
            ? `${tag.engMin ?? '−∞'} … ${tag.engMax ?? '+∞'}`
            : '—'}
        </>
      ),
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, tag) => statusBadge(tag.status),
    },
    {
      key: 'canl',
      header: 'Canlı',
      render: (_value, tag) => linkedBadge(tag),
    },
    {
      key: 'lem',
      header: 'İşlem',
      align: 'right',
      render: (_value, tag) => (
        <>
          {tag.status !== 'retired' && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => setEditingTag(tag)}
              title="Düzenle"
              aria-label={`${tag.fqn} tag'ini düzenle`}
            >
              <Pencil className="w-4 h-4" />
            </Button>
          )}
          {/* Lifecycle: hard delete exists only while DRAFT; anything
              past DRAFT can only be retired (server-enforced). */}
          {tag.status === 'draft' ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => setConfirmDeleteTag(tag)}
              title="Sil"
              aria-label={`${tag.fqn} tag'ini sil`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          ) : tag.status !== 'retired' ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => setConfirmRetireTag(tag)}
              title="Emekli et"
              aria-label={`${tag.fqn} tag'ini emekli et`}
            >
              <Archive className="w-4 h-4" />
            </Button>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <div className="p-4 flex flex-col gap-4 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Tags className="w-5 h-5 text-info-600 dark:text-info-400" />
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Tag Registry</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              SCADA bağlamalarının, deploy çözümlemesinin ve canlı verinin tek kimlik kaynağı
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              setPage(1);
            }}
            className="px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-md text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900"
            aria-label="Edge cihazı"
          >
            <option value="">Tüm cihazlar</option>
            {(devices?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.deviceCode}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            onClick={handleDiscover}
            disabled={!deviceId || discover.isPending}
            title={
              deviceId ? 'Cihazın I/O konfigürasyonlarından tag keşfet' : 'Önce bir cihaz seçin'
            }
          >
            {discover.isPending ? (
              <Spinner size="sm" color="inherit" />
            ) : (
              <Radar className="w-4 h-4" />
            )}
            Tag Keşfet
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => refetch()}
            title="Yenile"
            aria-label="Yenile"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Banner */}
      {banner && (
        <div
          className={`text-xs px-3 py-2 rounded-md border ${
            banner.kind === 'ok'
              ? 'bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 border-success-200 dark:border-success-800'
              : 'bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300 border-error-200 dark:border-error-800'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="w-4 h-4 text-gray-400 dark:text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <Input
          fullWidth
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setPage(1);
          }}
          placeholder="FQN veya ada göre ara..."
        />
      </div>

      {/* Table */}
      {!loading && error && (
        <p className="rounded-lg border border-error-200 dark:border-error-800 bg-error-50 dark:bg-error-900/20 px-3 py-2 text-sm text-error-600 dark:text-error-400">
          {error}
        </p>
      )}
      <DataTable<UnifiedTag>
        data={tags}
        columns={unifiedTagColumns}
        keyExtractor={(tag) => tag.id}
        loading={loading}
        emptyMessage={
          <>
            Kayıtlı tag yok. Bir cihaz seçip <span className="font-medium">Tag Keşfet</span> ile
            başlayın.
          </>
        }
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>{total} tag</span>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Önceki
          </Button>
          <span>
            {page} / {totalPages}
          </span>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Sonraki
          </Button>
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

      {/* Retire confirm */}
      {confirmRetireTag && (
        <ConfirmModal
          isOpen
          onClose={() => setConfirmRetireTag(null)}
          onConfirm={handleRetire}
          title="Tag emekli edilsin mi?"
          message={
            <>
              <span className="font-mono">{confirmRetireTag.fqn}</span> emekli edilecek: kayıt
              denetim için kalır, ama bağlamalar artık çözülmez ve canlı veri akmaz. Bu işlem geri
              alınamaz.
            </>
          }
          confirmText="Emekli Et"
          cancelText="İptal"
          variant="warning"
          isLoading={retireTag.isPending}
          loadingText="Emekli ediliyor..."
        />
      )}

      {/* Delete confirm */}
      {confirmDeleteTag && (
        <ConfirmModal
          isOpen
          onClose={() => setConfirmDeleteTag(null)}
          onConfirm={handleDelete}
          title="Tag silinsin mi?"
          message={
            <>
              <span className="font-mono">{confirmDeleteTag.fqn}</span> kalıcı olarak silinecek. Bu
              tag'e bağlı widget bağlamaları çözülemez hale gelir.
            </>
          }
          confirmText="Sil"
          cancelText="İptal"
          variant="danger"
          isLoading={deleteTag.isPending}
          loadingText="Siliniyor..."
        />
      )}
    </div>
  );
};

export default TagRegistryPage;
