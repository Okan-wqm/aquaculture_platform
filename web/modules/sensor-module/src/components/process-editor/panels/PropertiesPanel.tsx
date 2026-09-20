/**
 * Properties Panel Component
 * Right sidebar for viewing/editing selected node or edge properties
 * Enhanced with equipment linking functionality
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Button, Input, Modal, Select, ToggleButton, useI18n } from '@aquaculture/shared-ui';
import {
  X,
  Settings,
  Link2,
  Trash2,
  Info,
  Unlink,
  Edit3,
  Activity,
  Radio,
  Wifi,
  RotateCcw,
  Cpu,
  ToggleLeft,
  ToggleRight,
  Zap,
  AlertTriangle,
  Play,
  Square,
  AlertCircle,
} from 'lucide-react';
import {
  useProcessStore,
  EquipmentNodeData,
  SensorNodeData,
  SensorWidgetNodeData,
  IoBinding,
} from '../../../store/processStore';
import {
  CONNECTION_TYPES,
  getConnectionTypeConfig,
  normalizeConnectionType,
  ConnectionType,
} from '../../../config/connectionTypes';
import { getEquipmentIcon } from '../../equipment-icons';
import { useAttachableEquipment, AttachableEquipment } from '../../../hooks/useAttachableEquipment';
import { useLinkableSensors, getSensorTypeLabel } from '../../../hooks/useLinkableSensors';
import {
  useEdgeDevices,
  useEdgeDevice,
  useSetDigitalOutput,
  IoType,
  DeviceLifecycleState,
} from '../../../hooks/useEdgeDevices';
import { EquipmentLinkDialog } from '../dialogs/EquipmentLinkDialog';
import { SensorConfigDialog } from '../dialogs/SensorConfigDialog';

export const PropertiesPanel: React.FC = () => {
  const { t } = useI18n();
  const {
    selectedNode,
    selectedEdge,
    selectNode,
    selectEdge,
    removeNode,
    removeEdge,
    updateEdgeData,
    updateNodeData,
    linkEquipmentToNode,
    unlinkEquipmentFromNode,
    linkSensorToNode,
    unlinkSensorFromNode,
  } = useProcessStore();

  // Equipment linking state
  const [isLinkDialogOpen, setIsLinkDialogOpen] = useState(false);
  const [selectedEquipmentForLink, setSelectedEquipmentForLink] =
    useState<AttachableEquipment | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');

  // Sensor config dialog state
  const [isSensorConfigDialogOpen, setIsSensorConfigDialogOpen] = useState(false);

  // -----------------------------------------------------------------------
  // Edge Device Binding State (Kemik Yapı — Faz A)
  // Equipment node'larına fiziksel edge device bağlamak için.
  // Device seçilince o device'ın I/O tag listesi yüklenir.
  // -----------------------------------------------------------------------
  const [selectedEdgeDeviceId, setSelectedEdgeDeviceId] = useState<string | null>(
    selectedNode?.data?.edgeDeviceId || null,
  );

  // FIX: selectedEdgeDeviceId senkronizasyonu — selectedNode değiştiğinde
  // state'i güncelle. useState initializer sadece ilk mount'ta çalışır,
  // farklı node seçildiğinde eski device ID kalıyordu (stale state bug).
  useEffect(() => {
    setSelectedEdgeDeviceId(selectedNode?.data?.edgeDeviceId || null);
  }, [selectedNode?.id, selectedNode?.data?.edgeDeviceId]);

  // DO toggle onay dialogu state'i (Faz C — güvenlik)
  // edgeDeviceId'yi dialog state'inde yakala — closure üzerinden değil,
  // böylece dialog açıkken node değişse bile doğru device'a komut gider
  const [doConfirmDialog, setDoConfirmDialog] = useState<{
    isOpen: boolean;
    tagName: string;
    ioConfigId: string;
    newValue: boolean;
    edgeDeviceId: string;
  } | null>(null);

  // DO toggle hatalarını kullanıcıya göstermek için inline error state
  const [doToggleError, setDoToggleError] = useState<string | null>(null);

  // TanStack Query mutation hook — raw graphqlRequest yerine
  // Bu hook otomatik loading/error state yönetimi sağlar
  const setDigitalOutput = useSetDigitalOutput();

  // Edge device listesini çek — decommissioned cihazları filtrele
  // Decommissioned cihazlar artık aktif değil, dropdown'da gösterilmemeli
  const {
    data: edgeDevicesData,
    isLoading: isEdgeDevicesLoading,
    error: edgeDevicesError,
  } = useEdgeDevices({ limit: 100 });
  const edgeDevices = (edgeDevicesData?.items || []).filter(
    (d) => d.lifecycleState !== DeviceLifecycleState.DECOMMISSIONED,
  );

  // Seçili device'ın detaylarını çek (I/O config dahil)
  const { data: selectedDeviceDetail, isLoading: isDeviceDetailLoading } = useEdgeDevice(
    selectedEdgeDeviceId || selectedNode?.data?.edgeDeviceId || '',
  );

  // Fetch attachable equipment
  const { equipment } = useAttachableEquipment();

  // Handler: Open sensor config dialog
  const handleOpenSensorConfig = () => {
    setIsSensorConfigDialogOpen(true);
  };

  // Handler: Confirm sensor config (from dialog)
  const handleSensorConfigConfirm = (config: SensorNodeData) => {
    if (!selectedNode || !config.sensorId) return;
    linkSensorToNode(selectedNode.id, config.sensorId, config);
    setIsSensorConfigDialogOpen(false);
  };

  // Handler: Unlink sensor
  const handleSensorUnlink = () => {
    if (!selectedNode) return;
    unlinkSensorFromNode(selectedNode.id);
  };

  // Handler: Select equipment to link
  const handleEquipmentSelect = (eq: AttachableEquipment) => {
    setSelectedEquipmentForLink(eq);
    setIsLinkDialogOpen(true);
  };

  // Handler: Confirm equipment link
  const handleLinkConfirm = (customName: string) => {
    if (!selectedNode || !selectedEquipmentForLink) return;

    const equipmentData: Partial<EquipmentNodeData> = {
      equipmentName: customName,
      equipmentCode: selectedEquipmentForLink.code,
      equipmentType: selectedEquipmentForLink.equipmentType?.code || 'default',
      equipmentCategory: selectedEquipmentForLink.equipmentType?.category || 'other',
      status: selectedEquipmentForLink.status,
      specifications: selectedEquipmentForLink.specifications as Record<string, unknown>,
      // Also update label for specialized nodes (FishTank, DrumFilter, etc.)
      label: customName,
    };

    linkEquipmentToNode(selectedNode.id, selectedEquipmentForLink.id, equipmentData);
    setIsLinkDialogOpen(false);
    setSelectedEquipmentForLink(null);
  };

  // Handler: Unlink equipment
  const handleUnlink = () => {
    if (!selectedNode) return;
    unlinkEquipmentFromNode(selectedNode.id);
  };

  // Handler: Start editing name
  const handleNameEdit = () => {
    if (!selectedNode) return;
    setEditedName(selectedNode.data.equipmentName || '');
    setIsEditingName(true);
  };

  // Handler: Save edited name
  const handleNameSave = () => {
    if (!selectedNode || !editedName.trim()) {
      setIsEditingName(false);
      return;
    }
    // Update both equipmentName and label for specialized nodes
    updateNodeData(selectedNode.id, {
      equipmentName: editedName.trim(),
      label: editedName.trim(),
    });
    setIsEditingName(false);
  };

  // -----------------------------------------------------------------------
  // Edge Device Binding Handler (Kemik Yapı — Faz A)
  // Device seçildiğinde node data'ya edgeDeviceId/Code kaydeder.
  // Böylece node fiziksel bir cihaza bağlanmış olur.
  // -----------------------------------------------------------------------
  const handleEdgeDeviceSelect = useCallback(
    (deviceId: string) => {
      if (!selectedNode) return;
      const device = edgeDevices.find((d) => d.id === deviceId);
      if (!device) return;

      setSelectedEdgeDeviceId(deviceId);
      // Node data'ya edge device bilgilerini kaydet
      updateNodeData(selectedNode.id, {
        edgeDeviceId: device.id,
        edgeDeviceCode: device.deviceCode,
        // Device değiştiğinde eski I/O binding'leri temizle
        ioBindings: [],
      });
    },
    [selectedNode, edgeDevices, updateNodeData],
  );

  // Edge device bağlantısını kaldır
  const handleEdgeDeviceUnlink = useCallback(() => {
    if (!selectedNode) return;
    setSelectedEdgeDeviceId(null);
    updateNodeData(selectedNode.id, {
      edgeDeviceId: undefined,
      edgeDeviceCode: undefined,
      ioBindings: [],
    });
  }, [selectedNode, updateNodeData]);

  // -----------------------------------------------------------------------
  // I/O Tag Binding Handler (Kemik Yapı — Faz A)
  // Bir I/O tag'i node'a bağlar veya çıkarır.
  // ioBindings array'i node data'da tutulur.
  // -----------------------------------------------------------------------
  const handleIoTagToggle = useCallback(
    (ioConfig: { id: string; tagName: string; ioType: string; dataType: string }) => {
      if (!selectedNode) return;
      const currentBindings: IoBinding[] = selectedNode.data.ioBindings || [];
      const exists = currentBindings.some((b) => b.ioConfigId === ioConfig.id);

      let newBindings: IoBinding[];
      if (exists) {
        // Binding'i kaldır
        newBindings = currentBindings.filter((b) => b.ioConfigId !== ioConfig.id);
      } else {
        // Yeni binding ekle
        newBindings = [
          ...currentBindings,
          {
            ioConfigId: ioConfig.id,
            tagName: ioConfig.tagName,
            ioType: ioConfig.ioType as IoBinding['ioType'],
            dataType: ioConfig.dataType as IoBinding['dataType'],
          },
        ];
      }

      updateNodeData(selectedNode.id, { ioBindings: newBindings });
    },
    [selectedNode, updateNodeData],
  );

  // -----------------------------------------------------------------------
  // DO (Digital Output) Toggle Handler (Kemik Yapı — Faz C)
  // Onay dialogu açar, onaylandığında setDigitalOutput mutation çağırır.
  // Güvenlik: her DO değişikliği kullanıcı onayı gerektirir.
  // -----------------------------------------------------------------------
  const handleDoToggleRequest = useCallback(
    (tagName: string, ioConfigId: string, newValue: boolean) => {
      // edgeDeviceId'yi dialog state'inde yakala — closure üzerinden değil
      const edgeDeviceId = selectedNode?.data?.edgeDeviceId;
      if (!edgeDeviceId) return;
      setDoToggleError(null); // Önceki hatayı temizle
      setDoConfirmDialog({ isOpen: true, tagName, ioConfigId, newValue, edgeDeviceId });
    },
    [selectedNode?.data?.edgeDeviceId],
  );

  const handleDoToggleConfirm = useCallback(async () => {
    if (!doConfirmDialog) return;
    setDoToggleError(null);

    try {
      // TanStack Query mutateAsync — otomatik retry, error boundary desteği
      const result = await setDigitalOutput.mutateAsync({
        deviceId: doConfirmDialog.edgeDeviceId,
        ioConfigId: doConfirmDialog.ioConfigId,
        value: doConfirmDialog.newValue,
      });

      if (!result.success) {
        // Backend'den dönen hata mesajını kullanıcıya göster
        setDoToggleError(result.error || 'Unknown error occurred');
      }
    } catch (error) {
      // Network/GraphQL hatası — kullanıcıya anlaşılır mesaj göster
      const msg = error instanceof Error ? error.message : 'Failed to send command';
      setDoToggleError(msg);
    } finally {
      setDoConfirmDialog(null);
    }
  }, [doConfirmDialog, setDigitalOutput]);

  // Get unlinked equipment for dropdown
  const unlinkedEquipment = equipment.filter((eq) => !eq.isLinked);

  // No selection
  if (!selectedNode && !selectedEdge) {
    return (
      <div className="properties-panel w-72 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col h-full">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Properties</h3>
        </div>

        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center text-gray-500 dark:text-gray-400">
            <Settings className="w-12 h-12 mx-auto mb-3 text-gray-500 dark:text-gray-400" />
            <p className="text-sm">Select a node or connection to view properties</p>
          </div>
        </div>
      </div>
    );
  }

  // Node selected
  if (selectedNode) {
    const Icon = getEquipmentIcon(
      selectedNode.data.equipmentType || selectedNode.type || 'default',
    );

    return (
      <div className="properties-panel w-72 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Equipment</h3>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close"
            onClick={() => selectNode(null)}
          >
            <X className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Icon and Name */}
          <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <div className="p-2 bg-white dark:bg-gray-900 rounded-lg shadow-sm">
              <Icon size={32} className="text-gray-700 dark:text-gray-300" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-medium text-gray-900 dark:text-gray-100 truncate">
                {selectedNode.data.equipmentName || selectedNode.data.label || 'New Node'}
              </h4>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {selectedNode.data.equipmentCode ||
                  selectedNode.data.equipmentType?.replace(/-|_/g, ' ') ||
                  'Template Node'}
              </p>
            </div>
          </div>

          {/* Details */}
          <div className="space-y-3">
            {selectedNode.data.equipmentType && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 dark:text-gray-400 w-20">Type:</span>
                <span className="text-gray-900 dark:text-gray-100 capitalize">
                  {selectedNode.data.equipmentType.replace(/-/g, ' ')}
                </span>
              </div>
            )}

            {selectedNode.data.equipmentCategory && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 dark:text-gray-400 w-20">Category:</span>
                <span className="text-gray-900 dark:text-gray-100 capitalize">
                  {selectedNode.data.equipmentCategory.replace(/_/g, ' ')}
                </span>
              </div>
            )}

            {selectedNode.data.status && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 dark:text-gray-400 w-20">Status:</span>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    selectedNode.data.status === 'operational' ||
                    selectedNode.data.status === 'active'
                      ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
                      : selectedNode.data.status === 'maintenance'
                        ? 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {selectedNode.data.status.charAt(0).toUpperCase() +
                    selectedNode.data.status.slice(1).replace('_', ' ')}
                </span>
              </div>
            )}

            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500 dark:text-gray-400 w-20">Node ID:</span>
              <span className="text-gray-600 dark:text-gray-400 font-mono text-xs">
                {selectedNode.id}
              </span>
            </div>
          </div>

          {/* Specifications */}
          {selectedNode.data.specifications &&
            Object.keys(selectedNode.data.specifications).length > 0 && (
              <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1">
                  <Info className="w-4 h-4" />
                  Specifications
                </h5>
                <div className="space-y-2 text-sm">
                  {Object.entries(selectedNode.data.specifications)
                    .slice(0, 5)
                    .map(([key, value]) => (
                      <div key={key} className="flex items-start gap-2">
                        <span className="text-gray-500 dark:text-gray-400 capitalize min-w-[80px]">
                          {key.replace(/([A-Z])/g, ' $1').trim()}:
                        </span>
                        <span className="text-gray-900 dark:text-gray-100">
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

          {/* Equipment Linking Section */}
          <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
            <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1">
              <Link2 className="w-4 h-4" />
              Equipment Link
            </h5>

            {selectedNode.data.equipmentId ? (
              // Linked state
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-info-50 dark:bg-info-900/20 rounded-lg border border-info-200 dark:border-info-800">
                  <span className="text-sm text-info-700 dark:text-info-300 font-medium">
                    Linked
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    leftIcon={<Unlink className="w-3 h-3" />}
                    onClick={handleUnlink}
                  >
                    Unlink
                  </Button>
                </div>

                {/* Inline Name Edit */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500 dark:text-gray-400">Name:</span>
                  {isEditingName ? (
                    <div className="flex-1 flex items-center gap-1">
                      <Input
                        type="text"
                        value={editedName}
                        onChange={(e) => setEditedName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleNameSave();
                          if (e.key === 'Escape') setIsEditingName(false);
                        }}
                        onBlur={handleNameSave}
                        autoFocus
                      />
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-between">
                      <span className="text-sm text-gray-900 dark:text-gray-100">
                        {selectedNode.data.equipmentName}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Edit Name"
                        onClick={handleNameEdit}
                        title="Edit Name"
                      >
                        <Edit3 className="w-4 h-4 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              // Unlinked state - show dropdown
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-warning-50 dark:bg-warning-900/20 rounded-lg border border-warning-200 dark:border-warning-800">
                  <span className="text-sm text-warning-700 dark:text-warning-300 font-medium">
                    Unlinked
                  </span>
                  <span className="text-xs text-warning-600 dark:text-warning-400">
                    Select equipment below
                  </span>
                </div>
                <Select
                  onChange={(e) => {
                    const eq = unlinkedEquipment.find((eq) => eq.id === e.target.value);
                    if (eq) handleEquipmentSelect(eq);
                  }}
                  value=""
                  placeholder="Select Equipment..."
                  options={unlinkedEquipment.map((eq) => ({
                    value: eq.id,
                    label: `${eq.name}(${eq.code})`,
                  }))}
                />
                {unlinkedEquipment.length === 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    No linkable equipment found. Enable "Show in Sensor Module" in equipment
                    settings.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* SensorWidget Configuration Section */}
          {selectedNode.type === 'sensorWidget' && (
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
              <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1">
                <Radio className="w-4 h-4" />
                Widget Configuration
              </h5>
              <div className="space-y-3">
                {/* Data Mode */}
                <Select
                  label="Data Mode"
                  fullWidth
                  options={[
                    { value: '', label: 'Static (manual)' },
                    { value: 'push', label: 'MQTT Push (WebSocket)' },
                    { value: 'poll', label: 'HTTP Poll (Interval)' },
                    { value: 'onChange', label: 'HTTP onChange (ETag)' },
                  ]}
                  value={(selectedNode.data as SensorWidgetNodeData).mode || ''}
                  onChange={(e) =>
                    updateNodeData(selectedNode.id, {
                      mode: e.target.value as 'push' | 'poll' | 'onChange' | undefined,
                    })
                  }
                />

                {/* MQTT Settings */}
                {(selectedNode.data as SensorWidgetNodeData).mode === 'push' && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                        <Wifi className="w-3 h-3 inline mr-1" />
                        MQTT Broker URL
                      </label>
                      <Input
                        fullWidth
                        type="text"
                        placeholder="ws://localhost:9001"
                        value={(selectedNode.data as SensorWidgetNodeData).mqttUrl || ''}
                        onChange={(e) =>
                          updateNodeData(selectedNode.id, { mqttUrl: e.target.value })
                        }
                      />
                    </div>
                    <Input
                      label="MQTT Topic"
                      fullWidth
                      type="text"
                      placeholder="sensors/temperature"
                      value={(selectedNode.data as SensorWidgetNodeData).mqttTopic || ''}
                      onChange={(e) =>
                        updateNodeData(selectedNode.id, { mqttTopic: e.target.value })
                      }
                    />
                  </>
                )}

                {/* HTTP Settings */}
                {((selectedNode.data as SensorWidgetNodeData).mode === 'poll' ||
                  (selectedNode.data as SensorWidgetNodeData).mode === 'onChange') && (
                  <>
                    <Input
                      label="HTTP URL"
                      fullWidth
                      type="text"
                      placeholder="https://api.example.com/sensor/1"
                      value={(selectedNode.data as SensorWidgetNodeData).httpUrl || ''}
                      onChange={(e) => updateNodeData(selectedNode.id, { httpUrl: e.target.value })}
                    />
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                        <RotateCcw className="w-3 h-3 inline mr-1" />
                        Poll Interval (seconds)
                      </label>
                      <Input
                        fullWidth
                        type="number"
                        min="1"
                        placeholder={
                          (selectedNode.data as SensorWidgetNodeData).mode === 'onChange'
                            ? '10'
                            : '5'
                        }
                        value={(selectedNode.data as SensorWidgetNodeData).pollInterval || ''}
                        onChange={(e) =>
                          updateNodeData(selectedNode.id, {
                            pollInterval: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />
                    </div>
                  </>
                )}

                {/* Display Settings */}
                <Input
                  label="Widget Name"
                  className="pt-2 border-t border-gray-100 dark:border-gray-700"
                  fullWidth
                  type="text"
                  placeholder="Temperature"
                  value={
                    (selectedNode.data as SensorWidgetNodeData).widgetName ||
                    (selectedNode.data as SensorWidgetNodeData).label ||
                    ''
                  }
                  onChange={(e) =>
                    updateNodeData(selectedNode.id, {
                      widgetName: e.target.value,
                      label: e.target.value,
                    })
                  }
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    label="Unit"
                    fullWidth
                    type="text"
                    placeholder="°C"
                    value={(selectedNode.data as SensorWidgetNodeData).unit || ''}
                    onChange={(e) => updateNodeData(selectedNode.id, { unit: e.target.value })}
                  />
                  <Input
                    label="Scale Max"
                    fullWidth
                    type="number"
                    placeholder="100"
                    value={(selectedNode.data as SensorWidgetNodeData).scaleMax || ''}
                    onChange={(e) =>
                      updateNodeData(selectedNode.id, {
                        scaleMax: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    label="Low Threshold (%)"
                    fullWidth
                    type="number"
                    min="0"
                    max="100"
                    placeholder="25"
                    value={(selectedNode.data as SensorWidgetNodeData).lowThreshold || ''}
                    onChange={(e) =>
                      updateNodeData(selectedNode.id, {
                        lowThreshold: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                  <Input
                    label="High Threshold (%)"
                    fullWidth
                    type="number"
                    min="0"
                    max="100"
                    placeholder="75"
                    value={(selectedNode.data as SensorWidgetNodeData).highThreshold || ''}
                    onChange={(e) =>
                      updateNodeData(selectedNode.id, {
                        highThreshold: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                </div>

                {/* Manual Value (for static mode) */}
                {!(selectedNode.data as SensorWidgetNodeData).mode && (
                  <Input
                    label="Static Value"
                    fullWidth
                    type="number"
                    placeholder="0"
                    value={(selectedNode.data as SensorWidgetNodeData).value || ''}
                    onChange={(e) =>
                      updateNodeData(selectedNode.id, {
                        value: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                )}
              </div>
            </div>
          )}

          {/* Sensor Linking Section */}
          <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
            <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1">
              <Activity className="w-4 h-4" />
              Sensor Link
            </h5>

            {selectedNode.data.sensorId ? (
              // Linked state
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-success-50 dark:bg-success-900/20 rounded-lg border border-success-200 dark:border-success-800">
                  <div>
                    <span className="text-sm text-success-700 dark:text-success-300 font-medium">
                      Linked
                    </span>
                    <p className="text-xs text-success-600 dark:text-success-400 mt-0.5">
                      {selectedNode.data.customName || selectedNode.data.sensorName}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      leftIcon={<Edit3 className="w-3 h-3" />}
                      onClick={handleOpenSensorConfig}
                      title="Düzenle"
                    >
                      Edit
                    </Button>
                    <button
                      aria-label={t('a11y.unlinkSensor')}
                      onClick={handleSensorUnlink}
                      className="text-xs text-error-600 dark:text-error-400 hover:text-error-700 dark:hover:text-error-200 flex items-center gap-1 px-2 py-1 hover:bg-error-50 dark:hover:bg-error-900/30 rounded transition-colors"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Sensor Details */}
                <div className="space-y-2 text-sm">
                  {selectedNode.data.sensorType && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 dark:text-gray-400 w-16">Type:</span>
                      <span className="text-gray-900 dark:text-gray-100">
                        {getSensorTypeLabel(selectedNode.data.sensorType)}
                      </span>
                    </div>
                  )}
                  {selectedNode.data.displayType && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 dark:text-gray-400 w-16">Display:</span>
                      <span className="text-gray-900 dark:text-gray-100 capitalize">
                        {selectedNode.data.displayType}
                      </span>
                    </div>
                  )}
                  {(selectedNode.data.minValue !== undefined ||
                    selectedNode.data.maxValue !== undefined) && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 dark:text-gray-400 w-16">Range:</span>
                      <span className="text-gray-900 dark:text-gray-100">
                        {selectedNode.data.minValue} - {selectedNode.data.maxValue}{' '}
                        {selectedNode.data.displayUnit || ''}
                      </span>
                    </div>
                  )}
                  {selectedNode.data.dataPath && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 dark:text-gray-400 w-16">Path:</span>
                      <span className="text-gray-900 dark:text-gray-100 font-mono text-xs">
                        {selectedNode.data.dataPath}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              // Unlinked state - show button to open dialog
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-warning-50 dark:bg-warning-900/20 rounded-lg border border-warning-200 dark:border-warning-800">
                  <span className="text-sm text-warning-700 dark:text-warning-300 font-medium">
                    No sensor linked
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="justify-center"
                  leftIcon={<Activity className="w-4 h-4" />}
                  onClick={handleOpenSensorConfig}
                >
                  Link Sensor...
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ===============================================================
          Edge Device Binding (Kemik Yapı — Faz A)
          Equipment node'una fiziksel edge device bağlama bölümü.
          Device seçildiğinde o device'ın I/O tag listesi görünür.
          Tag'ler checkbox ile node'a bind edilir.
          =============================================================== */}
        <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
          <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1">
            <Cpu className="w-4 h-4" />
            Edge Device Binding
          </h5>

          {selectedNode.data.edgeDeviceId ? (
            // Bağlı durumu — device bilgisi + unlink butonu
            <div className="space-y-3">
              <div className="flex items-center justify-between p-2 bg-primary-50 dark:bg-primary-900/20 rounded-lg border border-primary-200 dark:border-primary-800">
                <div>
                  <span className="text-sm text-primary-700 dark:text-primary-300 font-medium">
                    {edgeDevices.find((d) => d.id === selectedNode.data.edgeDeviceId)?.deviceName ||
                      selectedNode.data.edgeDeviceCode ||
                      'Connected'}
                  </span>
                  <p className="text-xs text-primary-500">{selectedNode.data.edgeDeviceCode}</p>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  leftIcon={<Unlink className="w-3 h-3" />}
                  onClick={handleEdgeDeviceUnlink}
                >
                  Unbind
                </Button>
              </div>

              {/* -------------------------------------------------------
                  I/O Tag Listesi (Faz A devamı)
                  Device'ın tüm I/O tag'lerini checkbox ile göster.
                  Seçilenler node'un ioBindings array'ine eklenir.
                  ------------------------------------------------------- */}
              {selectedDeviceDetail?.ioConfig && selectedDeviceDetail.ioConfig.length > 0 && (
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                    I/O Tags — bind to node:
                  </label>
                  <div className="max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-700">
                    {selectedDeviceDetail.ioConfig
                      .filter((io) => io.isActive)
                      .map((io) => {
                        const isBound = (selectedNode.data.ioBindings || []).some(
                          (b: IoBinding) => b.ioConfigId === io.id,
                        );
                        return (
                          <label
                            key={io.id}
                            className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors text-sm ${
                              isBound
                                ? 'bg-primary-50 dark:bg-primary-900/20'
                                : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isBound}
                              onChange={() =>
                                handleIoTagToggle({
                                  id: io.id,
                                  tagName: io.tagName,
                                  ioType: io.ioType,
                                  dataType: io.dataType,
                                })
                              }
                              className="text-primary-600 dark:text-primary-400 rounded focus:ring-primary-500"
                            />
                            <span
                              className={`inline-block w-6 text-center text-[10px] font-bold rounded px-1 ${
                                io.ioType === 'DI'
                                  ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
                                  : io.ioType === 'DO'
                                    ? 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300'
                                    : io.ioType === 'AI'
                                      ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                                      : 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300'
                              }`}
                            >
                              {io.ioType}
                            </span>
                            <span className="flex-1 truncate text-gray-700 dark:text-gray-300">
                              {io.tagName}
                            </span>
                            {io.engUnit && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {io.engUnit}
                              </span>
                            )}
                          </label>
                        );
                      })}
                  </div>
                </div>
              )}

              {selectedDeviceDetail?.ioConfig &&
                selectedDeviceDetail.ioConfig.filter((io) => io.isActive).length === 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    No active I/O tags on this device. Configure I/O in device settings.
                  </p>
                )}
            </div>
          ) : (
            // Bağlanmamış durumu — device dropdown
            <div className="space-y-2">
              {isEdgeDevicesLoading ? (
                <p className="text-xs text-gray-500 dark:text-gray-400 animate-pulse">
                  Loading devices...
                </p>
              ) : edgeDevicesError ? (
                <p className="text-xs text-error-500">Failed to load devices</p>
              ) : (
                <>
                  <Select
                    onChange={(e) => {
                      if (e.target.value) handleEdgeDeviceSelect(e.target.value);
                    }}
                    value=""
                    placeholder="Select Edge Device..."
                    options={edgeDevices.map((device) => ({
                      value: device.id,
                      label: `${device.deviceName}(${device.deviceCode})${device.isOnline ? ' ●' : ' ○'}`,
                    }))}
                  />
                  {edgeDevices.length === 0 && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      No edge devices registered. Add devices in Edge Device Management.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ===============================================================
            Control Section (Kemik Yapı — Faz C)
            Bağlı I/O tag'leri için kontrol butonları:
            - DO tag'leri → ON/OFF toggle switch
            - VFD bağlı ise → Start/Stop + hız slider
            Her DO değişikliği onay dialogu gerektirir (güvenlik).
            =============================================================== */}
        {selectedNode.data.ioBindings && selectedNode.data.ioBindings.length > 0 && (
          <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
            <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1">
              <Zap className="w-4 h-4" />
              Output Controls
            </h5>

            {/* DO toggle hata mesajı — kullanıcıya inline gösterim
                  Console.error yerine UI'da gösterilir, 5 saniye sonra otomatik kaybolur */}
            {doToggleError && (
              <div className="flex items-start gap-2 p-2 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-xs text-error-700 dark:text-error-300 mb-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">Output command failed</p>
                  <p className="mt-0.5">{doToggleError}</p>
                </div>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Close"
                  onClick={() => setDoToggleError(null)}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}

            <div className="space-y-2">
              {/* DO tag'leri için ON/OFF toggle butonları */}
              {selectedNode.data.ioBindings
                .filter((b: IoBinding) => b.ioType === 'DO')
                .map((binding: IoBinding) => (
                  <div
                    key={binding.ioConfigId}
                    className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded-lg"
                  >
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-6 text-center text-[10px] font-bold rounded px-1 bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
                        DO
                      </span>
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {binding.tagName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* OFF butonu */}
                      <button
                        onClick={() =>
                          handleDoToggleRequest(binding.tagName, binding.ioConfigId, false)
                        }
                        className="px-2 py-1 text-xs rounded transition-colors bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300 hover:bg-error-200 dark:hover:bg-error-800/60"
                        title={`${binding.tagName} OFF`}
                      >
                        <Square className="w-3 h-3 inline mr-0.5" />
                        OFF
                      </button>
                      {/* ON butonu */}
                      <button
                        onClick={() =>
                          handleDoToggleRequest(binding.tagName, binding.ioConfigId, true)
                        }
                        className="px-2 py-1 text-xs rounded transition-colors bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300 hover:bg-success-200 dark:hover:bg-success-800/60"
                        title={`${binding.tagName} ON`}
                      >
                        <Play className="w-3 h-3 inline mr-0.5" />
                        ON
                      </button>
                    </div>
                  </div>
                ))}

              {/* AI/AO tag'leri bilgi gösterimi (sadece okunur) */}
              {selectedNode.data.ioBindings.filter(
                (b: IoBinding) => b.ioType === 'AI' || b.ioType === 'AO',
              ).length > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Analog tags are read-only in process editor.
                </p>
              )}
            </div>
          </div>
        )}

        {/* DO Toggle Onay Dialogu (Kemik Yapı — Faz C — Güvenlik)
            Kullanıcı bir DO tag'ini ON/OFF yapmak istediğinde
            onay dialogu gösterilir. Yanlışlıkla aktüatör çalıştırmayı önler. */}
        {doConfirmDialog?.isOpen && (
          <Modal
            isOpen
            onClose={() => setDoConfirmDialog(null)}
            size="sm"
            showCloseButton={!setDigitalOutput.isPending}
            closeOnEscape={!setDigitalOutput.isPending}
            closeOnOverlayClick={!setDigitalOutput.isPending}
            title={
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-warning-500" />
                <span>Output Control</span>
              </span>
            }
            bodyClassName="p-6"
            footer={
              <>
                <button
                  onClick={() => setDoConfirmDialog(null)}
                  className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDoToggleConfirm}
                  disabled={setDigitalOutput.isPending}
                  className={`px-3 py-1.5 text-sm text-white rounded ${
                    doConfirmDialog.newValue
                      ? 'bg-success-600 hover:bg-success-700'
                      : 'bg-error-600 hover:bg-error-700'
                  } disabled:opacity-50`}
                >
                  {setDigitalOutput.isPending ? 'Sending...' : 'Confirm'}
                </button>
              </>
            }
          >
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Set <strong>{doConfirmDialog.tagName}</strong> to{' '}
              <strong
                className={
                  doConfirmDialog.newValue
                    ? 'text-success-600 dark:text-success-400'
                    : 'text-error-600 dark:text-error-400'
                }
              >
                {doConfirmDialog.newValue ? 'ON' : 'OFF'}
              </strong>
              ?
            </p>
          </Modal>
        )}

        {/* Equipment Link Dialog */}
        <EquipmentLinkDialog
          isOpen={isLinkDialogOpen}
          equipment={selectedEquipmentForLink}
          onClose={() => {
            setIsLinkDialogOpen(false);
            setSelectedEquipmentForLink(null);
          }}
          onConfirm={handleLinkConfirm}
        />

        {/* Sensor Config Dialog */}
        <SensorConfigDialog
          isOpen={isSensorConfigDialogOpen}
          onClose={() => setIsSensorConfigDialogOpen(false)}
          onConfirm={handleSensorConfigConfirm}
          initialConfig={selectedNode?.data.sensorId ? selectedNode.data : undefined}
        />

        {/* Actions */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <Button
            variant="secondary"
            className="justify-center"
            leftIcon={<Trash2 className="w-4 h-4" />}
            onClick={() => {
              removeNode(selectedNode.id);
            }}
          >
            Remove from Process
          </Button>
        </div>
      </div>
    );
  }

  // Edge selected
  if (selectedEdge) {
    // Get normalized connection type for backwards compatibility
    const currentConnectionType = normalizeConnectionType(
      selectedEdge.data?.connectionType || 'process-pipe',
    );
    const currentConfig = getConnectionTypeConfig(currentConnectionType);

    return (
      <div className="properties-panel w-72 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Connection</h3>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close"
            onClick={() => selectEdge(null)}
          >
            <X className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Connection Preview */}
          <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <div className="p-2 bg-white dark:bg-gray-900 rounded-lg shadow-sm">
              <svg width="32" height="16" className="flex-shrink-0">
                <line
                  x1="4"
                  y1="8"
                  x2="28"
                  y2="8"
                  stroke={currentConfig.color}
                  strokeWidth={currentConfig.strokeWidth}
                  strokeDasharray={currentConfig.strokeDasharray}
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div>
              <h4 className="font-medium text-gray-900 dark:text-gray-100">
                {currentConfig.label}
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {currentConfig.description}
              </p>
            </div>
          </div>

          {/* Connection Type - P&ID Standard Types */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Connection Type (P&ID)
            </label>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {CONNECTION_TYPES.map((type) => (
                <ToggleButton
                  key={type.id}
                  onClick={() => updateEdgeData(selectedEdge.id, { connectionType: type.id })}
                  pressed={currentConnectionType === type.id}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors"
                  pressedClassName="border-info-500 bg-info-50 dark:bg-info-900/20"
                  idleClassName="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {/* SVG Line Preview */}
                  <svg width="32" height="12" className="flex-shrink-0">
                    <line
                      x1="2"
                      y1="6"
                      x2="30"
                      y2="6"
                      stroke={type.color}
                      strokeWidth={type.strokeWidth}
                      strokeDasharray={type.strokeDasharray}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="flex-1 text-left min-w-0">
                    <span className="text-sm text-gray-700 dark:text-gray-300 block truncate">
                      {type.label}
                    </span>
                  </div>
                </ToggleButton>
              ))}
            </div>
          </div>

          {/* Connection Details */}
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-500 dark:text-gray-400 w-16">From:</span>
              <span className="text-gray-900 dark:text-gray-100 font-mono text-xs">
                {selectedEdge.source}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 dark:text-gray-400 w-16">To:</span>
              <span className="text-gray-900 dark:text-gray-100 font-mono text-xs">
                {selectedEdge.target}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 dark:text-gray-400 w-16">Edge ID:</span>
              <span className="text-gray-600 dark:text-gray-400 font-mono text-xs truncate">
                {selectedEdge.id}
              </span>
            </div>
          </div>

          {/* Flow Rate (for pipe/steam/hydraulic connections) */}
          {(currentConnectionType === 'process-pipe' ||
            currentConnectionType === 'steam' ||
            currentConnectionType === 'hydraulic') && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Flow Rate (optional)
              </label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="0"
                  value={selectedEdge.data?.flowRate || ''}
                  onChange={(e) =>
                    updateEdgeData(selectedEdge.id, {
                      flowRate: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
                <Select
                  options={[
                    { value: 'L/min', label: 'L/min' },
                    { value: 'm3/h', label: 'm³/h' },
                    { value: 'kg/h', label: 'kg/h' },
                  ]}
                  value={selectedEdge.data?.flowUnit || 'L/min'}
                  onChange={(e) => updateEdgeData(selectedEdge.id, { flowUnit: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <Button
            variant="secondary"
            className="justify-center"
            leftIcon={<Trash2 className="w-4 h-4" />}
            onClick={() => {
              removeEdge(selectedEdge.id);
            }}
          >
            Remove Connection
          </Button>
        </div>
      </div>
    );
  }

  return null;
};

export default PropertiesPanel;
