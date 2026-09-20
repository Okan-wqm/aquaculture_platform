/**
 * LoRa cihaz yonetim paneli
 * Cihaz listesi, ekleme/silme/downlink diyaloglari.
 * Tum UI Tailwind + HTML + Lucide ile olusturulmustur (MUI yok).
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  ConfirmModal,
  DataTable,
  Modal,
  Select,
  Spinner,
  ToggleButton,
  type DataTableColumn,
} from '@aquaculture/shared-ui';
import {
  Plus,
  Trash2,
  Send,
  AlertTriangle,
  Radio,
  Eye,
  EyeOff,
  Signal,
  SignalLow,
  SignalMedium,
  SignalHigh,
} from 'lucide-react';
import {
  useLoRaDevices,
  useAddLoRaDevice,
  useRemoveLoRaDevice,
  useSendLoRaDownlink,
  type LoRaDevice,
  type AddLoRaDeviceInput,
} from '../../hooks/useLoRaDevices';

// ============================================================================
// Yardimci fonksiyonlar
// ============================================================================

/** Relative time formatter — Turkce (orn: "2 sn once", "5 dk once") */
function formatRelativeTime(dateStr: string | undefined): string {
  if (!dateStr) return 'Hic';
  const diff = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return 'Simdi';
  if (sec < 60) return `${sec} sn once`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} dk once`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} sa once`;
  const day = Math.floor(hr / 24);
  return `${day} gun once`;
}

/** RSSI sinyal guc gostergesi — renk kodlu */
function RssiIndicator({ rssi }: { rssi?: number }) {
  if (rssi == null) return <span className="text-gray-500 dark:text-gray-400">--</span>;

  let color: string;
  let Icon: typeof Signal;
  if (rssi > -90) {
    color = 'text-success-600 dark:text-success-400';
    Icon = SignalHigh;
  } else if (rssi > -110) {
    color = 'text-warning-600 dark:text-warning-400';
    Icon = SignalMedium;
  } else {
    color = 'text-error-600 dark:text-error-400';
    Icon = SignalLow;
  }

  return (
    <span className={`flex items-center gap-1 ${color}`}>
      <Icon className="w-4 h-4" />
      <span className="text-xs font-mono">{rssi} dBm</span>
    </span>
  );
}

/** Hex string dogrulama */
function isValidHex(value: string, length: number): boolean {
  const regex = new RegExp(`^[0-9a-fA-F]{${length}}$`);
  return regex.test(value);
}

// ============================================================================
// Cihaz Ekle Diyalogu
// ============================================================================

interface AddDeviceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: AddLoRaDeviceInput) => void;
  isSubmitting: boolean;
  submitError?: string | null;
}

const AddDeviceDialog: React.FC<AddDeviceDialogProps> = ({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting,
  submitError,
}) => {
  const [devEui, setDevEui] = useState('');
  const [appKey, setAppKey] = useState('');
  const [name, setName] = useState('');
  const [tagPrefix, setTagPrefix] = useState('');
  const [activationMode, setActivationMode] = useState<'OTAA' | 'ABP'>('OTAA');
  const [deviceClass, setDeviceClass] = useState<'A' | 'C'>('A');
  const [codec, setCodec] = useState('CayenneLPP');
  const [showAppKey, setShowAppKey] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Reset form on open
  useEffect(() => {
    if (isOpen) {
      setDevEui('');
      setAppKey('');
      setName('');
      setTagPrefix('');
      setActivationMode('OTAA');
      setDeviceClass('A');
      setCodec('CayenneLPP');
      setShowAppKey(false);
      setValidationError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!isValidHex(devEui, 16)) {
      setValidationError('DevEUI 16 haneli hexadecimal olmalidir (orn: 0011223344556677)');
      return;
    }
    if (!isValidHex(appKey, 32)) {
      setValidationError('AppKey 32 haneli hexadecimal olmalidir');
      return;
    }
    if (!name.trim()) {
      setValidationError('Cihaz adi bos olamaz');
      return;
    }

    onSubmit({
      devEui: devEui.toUpperCase(),
      appKey: appKey.toUpperCase(),
      name: name.trim(),
      tagPrefix:
        tagPrefix.trim().toUpperCase() ||
        name.trim().toUpperCase().replace(/\s+/g, '_').slice(0, 30),
      activationMode,
      deviceClass,
      codec,
    });
  };

  const inputCls =
    'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden';
  const labelCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title="LoRa Cihaz Ekle"
      showCloseButton={!isSubmitting}
      closeOnEscape={!isSubmitting}
      closeOnOverlayClick={!isSubmitting}
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto"
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        {(validationError || submitError) && (
          <div className="p-3 rounded-lg bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-error-600 dark:text-error-400 mt-0.5 shrink-0" />
            <span className="text-sm text-error-800 dark:text-error-200">
              {validationError || submitError}
            </span>
          </div>
        )}

        {/* DevEUI */}
        <div>
          <label className={labelCls}>DevEUI *</label>
          <input
            className={`${inputCls} font-mono uppercase`}
            value={devEui}
            onChange={(e) => setDevEui(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 16))}
            placeholder="0011223344556677"
            maxLength={16}
            required
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {devEui.length}/16 hex karakter
          </p>
        </div>

        {/* AppKey */}
        <div>
          <label className={labelCls}>AppKey *</label>
          <div className="relative">
            <input
              type={showAppKey ? 'text' : 'password'}
              className={`${inputCls} font-mono uppercase pr-10`}
              value={appKey}
              onChange={(e) => setAppKey(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 32))}
              placeholder="00112233445566778899AABBCCDDEEFF"
              maxLength={32}
              required
            />
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-2 top-1/2"
              type="button"
              onClick={() => setShowAppKey(!showAppKey)}
              aria-label={showAppKey ? 'Gizle' : 'Goster'}
            >
              {showAppKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {appKey.length}/32 hex karakter
          </p>
        </div>

        {/* Cihaz Adi + Tag Prefix */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Cihaz Adi *</label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 50))}
              placeholder="Su Kalite Sensoru"
              maxLength={50}
              required
            />
          </div>
          <div>
            <label className={labelCls}>Tag Prefix</label>
            <input
              className={`${inputCls} uppercase`}
              value={tagPrefix}
              onChange={(e) => setTagPrefix(e.target.value.toUpperCase().slice(0, 30))}
              placeholder="LORA_WQ_01"
              maxLength={30}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Bos birakilirsa isimden uretilir
            </p>
          </div>
        </div>

        {/* Aktivasyon Modu */}
        <div>
          <label className={labelCls}>Aktivasyon Modu</label>
          <div className="flex gap-2 mt-1">
            {(['OTAA', 'ABP'] as const).map((mode) => (
              <ToggleButton
                key={mode}
                type="button"
                onClick={() => setActivationMode(mode)}
                pressed={activationMode === mode}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors"
                pressedClassName="bg-info-50 dark:bg-info-900/20 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300"
                idleClassName="bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {mode}
              </ToggleButton>
            ))}
          </div>
        </div>

        {/* Cihaz Sinifi */}
        <div>
          <label className={labelCls}>Cihaz Sinifi</label>
          <div className="flex gap-2 mt-1">
            {(['A', 'C'] as const).map((cls) => (
              <ToggleButton
                key={cls}
                type="button"
                onClick={() => setDeviceClass(cls)}
                pressed={deviceClass === cls}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors"
                pressedClassName="bg-info-50 dark:bg-info-900/20 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300"
                idleClassName="bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Class {cls}
              </ToggleButton>
            ))}
          </div>
        </div>

        {/* Codec */}
        <Select
          label="Codec"
          value={codec}
          onChange={(e) => setCodec(e.target.value)}
          options={[
            { value: 'CayenneLPP', label: 'CayenneLPP' },
            { value: 'RawBinary', label: 'Raw Binary' },
            { value: 'Custom', label: 'Custom' },
          ]}
        />

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Iptal
          </Button>
          <Button variant="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting && <Spinner size="sm" color="inherit" />}
            Ekle
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Silme Onay Diyalogu
// ============================================================================

interface DeleteDialogProps {
  isOpen: boolean;
  deviceName: string;
  devEui: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
}

const DeleteDialog: React.FC<DeleteDialogProps> = ({
  isOpen,
  deviceName,
  devEui,
  onConfirm,
  onCancel,
  isDeleting,
}) => {
  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onCancel}
      onConfirm={onConfirm}
      title="LoRa Cihaz Sil"
      message={
        <>
          <strong>{deviceName}</strong> (
          <code className="text-xs font-mono bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">
            {devEui}
          </code>
          ) cihazini silmek istediginizden emin misiniz? Cihaz ile iliskili tum tag verileri
          kaybolacaktir. Bu islem geri alinamaz.
        </>
      }
      confirmText="Sil"
      cancelText="Iptal"
      variant="danger"
      isLoading={isDeleting}
      loadingText="Siliniyor..."
    />
  );
};

// ============================================================================
// Downlink Gonderme Diyalogu
// ============================================================================

interface DownlinkDialogProps {
  isOpen: boolean;
  deviceName: string;
  onClose: () => void;
  onSend: (payload: string, fPort: number) => void;
  isSending: boolean;
  sendError?: string | null;
}

const DownlinkDialog: React.FC<DownlinkDialogProps> = ({
  isOpen,
  deviceName,
  onClose,
  onSend,
  isSending,
  sendError,
}) => {
  const [payload, setPayload] = useState('');
  const [fPort, setFPort] = useState('1');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPayload('');
      setFPort('1');
      setValidationError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!/^[0-9a-fA-F]*$/.test(payload) || payload.length === 0 || payload.length % 2 !== 0) {
      setValidationError('Payload cift sayida hex karakter olmalidir (orn: AABB01)');
      return;
    }

    const port = parseInt(fPort, 10);
    if (isNaN(port) || port < 1 || port > 223) {
      setValidationError('fPort 1-223 arasinda olmalidir');
      return;
    }

    onSend(payload.toUpperCase(), port);
  };

  const inputCls =
    'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden';

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title="Downlink Gonder"
      description={
        <>
          <strong>{deviceName}</strong> cihazina downlink mesaji gonder
        </>
      }
      showCloseButton={!isSending}
      closeOnEscape={!isSending}
      closeOnOverlayClick={!isSending}
      bodyClassName="p-6"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {(validationError || sendError) && (
          <div className="p-3 rounded-lg bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-error-600 dark:text-error-400 mt-0.5 shrink-0" />
            <span className="text-sm text-error-800 dark:text-error-200">
              {validationError || sendError}
            </span>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Hex Payload *
          </label>
          <input
            className={`${inputCls} font-mono uppercase`}
            value={payload}
            onChange={(e) => setPayload(e.target.value.replace(/[^0-9a-fA-F]/g, ''))}
            placeholder="AABB0102"
            required
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            fPort *
          </label>
          <input
            type="number"
            className={inputCls}
            value={fPort}
            onChange={(e) => setFPort(e.target.value)}
            min={1}
            max={223}
            required
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Iptal
          </Button>
          <Button variant="primary" type="submit" disabled={isSending}>
            {isSending && <Spinner size="sm" color="inherit" />}
            <Send className="w-4 h-4" />
            Gonder
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Ana Panel
// ============================================================================

/** Sabit bos dizi referansi — her renderda yeni referans olusmasini engeller */
const EMPTY_DEVICES: LoRaDevice[] = [];

interface LoRaDevicesPanelProps {
  edgeDeviceId: string;
}

const LoRaDevicesPanel: React.FC<LoRaDevicesPanelProps> = ({ edgeDeviceId }) => {
  const { data: devices = EMPTY_DEVICES, isLoading } = useLoRaDevices(edgeDeviceId);
  const addMutation = useAddLoRaDevice();
  const removeMutation = useRemoveLoRaDevice();
  const downlinkMutation = useSendLoRaDownlink();

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LoRaDevice | null>(null);
  const [downlinkTarget, setDownlinkTarget] = useState<LoRaDevice | null>(null);

  /** Dialog kapatildiginda mutation hata durumunu temizle */
  const handleCloseAddDialog = useCallback(() => {
    setAddDialogOpen(false);
    addMutation.reset();
  }, [addMutation]);

  const handleCloseDeleteDialog = useCallback(() => {
    setDeleteTarget(null);
    removeMutation.reset();
  }, [removeMutation]);

  const handleCloseDownlinkDialog = useCallback(() => {
    setDownlinkTarget(null);
    downlinkMutation.reset();
  }, [downlinkMutation]);

  const handleAdd = useCallback(
    (input: AddLoRaDeviceInput) => {
      addMutation.mutate({ edgeDeviceId, input }, { onSuccess: () => setAddDialogOpen(false) });
    },
    [addMutation, edgeDeviceId],
  );

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    removeMutation.mutate(
      { edgeDeviceId, loraDeviceId: deleteTarget.id },
      { onSuccess: () => setDeleteTarget(null) },
    );
  }, [deleteTarget, removeMutation, edgeDeviceId]);

  const handleDownlink = useCallback(
    (payload: string, fPort: number) => {
      if (!downlinkTarget) return;
      downlinkMutation.mutate(
        { edgeDeviceId, loraDeviceId: downlinkTarget.id, input: { payload, fPort } },
        { onSuccess: () => setDownlinkTarget(null) },
      );
    },
    [downlinkTarget, downlinkMutation, edgeDeviceId],
  );

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center justify-center py-12">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  // Bos durum: henuz cihaz eklenmemis
  if (devices.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="text-center py-12">
          <div className="w-16 h-16 rounded-full bg-info-50 dark:bg-info-900/20 flex items-center justify-center mx-auto mb-4">
            <Radio className="w-8 h-8 text-info-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
            Henuz LoRa cihaz eklenmemis
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-sm mx-auto">
            LoRaWAN end-device ekleyerek kablosuz sensor verilerini toplamaya baslayabilirsiniz.
          </p>
          <Button
            variant="primary"
            size="lg"
            leftIcon={<Plus className="w-4 h-4" />}
            onClick={() => setAddDialogOpen(true)}
          >
            Cihaz Ekle
          </Button>
        </div>

        <AddDeviceDialog
          isOpen={addDialogOpen}
          onClose={handleCloseAddDialog}
          onSubmit={handleAdd}
          isSubmitting={addMutation.isPending}
          submitError={addMutation.error instanceof Error ? addMutation.error.message : null}
        />
      </div>
    );
  }

  const loRaDeviceColumns: DataTableColumn<LoRaDevice>[] = [
    {
      key: 'deveui',
      header: 'DevEUI',
      render: (_value, dev) => (
        <code className="text-xs font-mono text-gray-900 dark:text-gray-100">{dev.devEui}</code>
      ),
    },
    {
      key: 'isim',
      header: 'Isim',
      render: (_value, dev) => (
        <div>
          <span className="font-medium text-gray-900 dark:text-gray-100">{dev.name}</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {dev.tagPrefix} | Class {dev.deviceClass} | {dev.codec}
          </span>
        </div>
      ),
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, dev) => (
        <>
          {dev.isJoined ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200">
              Joined
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200">
              Bekliyor
            </span>
          )}
        </>
      ),
    },
    {
      key: 'rssi',
      header: 'RSSI',
      render: (_value, dev) => <RssiIndicator rssi={dev.lastRssi} />,
    },
    {
      key: 'snr',
      header: 'SNR',
      render: (_value, dev) => <>{dev.lastSnr != null ? `${dev.lastSnr.toFixed(1)} dB` : '--'}</>,
    },
    {
      key: 'sonGorulme',
      header: 'Son Gorulme',
      render: (_value, dev) => formatRelativeTime(dev.lastSeenAt),
    },
    {
      key: 'islem',
      header: 'Islem',
      align: 'right',
      render: (_value, dev) => (
        <div className="flex items-center justify-end gap-1">
          {/* Downlink gonder */}
          {dev.isJoined && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => setDownlinkTarget(dev)}
              title="Downlink gonder"
              aria-label={`${dev.name} cihazina downlink gonder`}
            >
              <Send className="w-3.5 h-3.5" />
            </Button>
          )}
          {/* Sil */}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => setDeleteTarget(dev)}
            title="Sil"
            aria-label={`${dev.name} cihazini sil`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">LoRa Cihazlar</h3>
          <span className="text-sm text-gray-500 dark:text-gray-400">{devices.length} cihaz</span>
        </div>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="w-4 h-4" />}
          onClick={() => setAddDialogOpen(true)}
        >
          Cihaz Ekle
        </Button>
      </div>

      {/* Cihaz tablosu */}
      <DataTable<LoRaDevice>
        data={devices}
        columns={loRaDeviceColumns}
        keyExtractor={(dev) => dev.id}
        loading={isLoading}
        emptyMessage="Henüz LoRa cihazı yok"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        rowClassName={() => 'group'}
      />

      {/* Diyaloglar */}
      <AddDeviceDialog
        isOpen={addDialogOpen}
        onClose={handleCloseAddDialog}
        onSubmit={handleAdd}
        isSubmitting={addMutation.isPending}
        submitError={addMutation.error instanceof Error ? addMutation.error.message : null}
      />
      <DeleteDialog
        isOpen={!!deleteTarget}
        deviceName={deleteTarget?.name || ''}
        devEui={deleteTarget?.devEui || ''}
        onConfirm={handleDelete}
        onCancel={handleCloseDeleteDialog}
        isDeleting={removeMutation.isPending}
      />
      <DownlinkDialog
        isOpen={!!downlinkTarget}
        deviceName={downlinkTarget?.name || ''}
        onClose={handleCloseDownlinkDialog}
        onSend={handleDownlink}
        isSending={downlinkMutation.isPending}
        sendError={downlinkMutation.error instanceof Error ? downlinkMutation.error.message : null}
      />
    </div>
  );
};

export default LoRaDevicesPanel;
