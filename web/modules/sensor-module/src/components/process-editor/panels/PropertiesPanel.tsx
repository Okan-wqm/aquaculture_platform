/**
 * Properties Panel Component
 * Right sidebar for viewing/editing selected node or edge properties
 * Enhanced with equipment linking functionality
 */

import React, { useState } from 'react';
import { X, Settings, Link2, Trash2, Info, Unlink, Edit3, Activity, Radio, Wifi, RotateCcw } from 'lucide-react';
import { useProcessStore, EquipmentNodeData, SensorNodeData, SensorWidgetNodeData } from '../../../store/processStore';
import { CONNECTION_TYPES, getConnectionTypeConfig, normalizeConnectionType, ConnectionType } from '../../../config/connectionTypes';
import { getEquipmentIcon } from '../../equipment-icons';
import { useAttachableEquipment, AttachableEquipment } from '../../../hooks/useAttachableEquipment';
import { useLinkableSensors, getSensorTypeLabel } from '../../../hooks/useLinkableSensors';
import { EquipmentLinkDialog } from '../dialogs/EquipmentLinkDialog';
import { SensorConfigDialog } from '../dialogs/SensorConfigDialog';

export const PropertiesPanel: React.FC = () => {
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
  const [selectedEquipmentForLink, setSelectedEquipmentForLink] = useState<AttachableEquipment | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');

  // Sensor config dialog state
  const [isSensorConfigDialogOpen, setIsSensorConfigDialogOpen] = useState(false);

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

  // Get unlinked equipment for dropdown
  const unlinkedEquipment = equipment.filter((eq) => !eq.isLinked);

  // No selection
  if (!selectedNode && !selectedEdge) {
    return (
      <div className="properties-panel w-72 bg-white border-l border-gray-200 flex flex-col h-full">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Properties</h3>
        </div>

        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center text-gray-500">
            <Settings className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p className="text-sm">Select a node or connection to view properties</p>
          </div>
        </div>
      </div>
    );
  }

  // Node selected
  if (selectedNode) {
    const Icon = getEquipmentIcon(selectedNode.data.equipmentType || selectedNode.type || 'default');

    return (
      <div className="properties-panel w-72 bg-white border-l border-gray-200 flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Equipment</h3>
          <button
            onClick={() => selectNode(null)}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Icon and Name */}
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
            <div className="p-2 bg-white rounded-lg shadow-sm">
              <Icon size={32} className="text-gray-700" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-medium text-gray-900 truncate">
                {selectedNode.data.equipmentName || selectedNode.data.label || 'New Node'}
              </h4>
              <p className="text-sm text-gray-500">
                {selectedNode.data.equipmentCode || (selectedNode.data.equipmentType?.replace(/-|_/g, ' ')) || 'Template Node'}
              </p>
            </div>
          </div>

          {/* Details */}
          <div className="space-y-3">
            {selectedNode.data.equipmentType && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 w-20">Type:</span>
                <span className="text-gray-900 capitalize">
                  {selectedNode.data.equipmentType.replace(/-/g, ' ')}
                </span>
              </div>
            )}

            {selectedNode.data.equipmentCategory && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 w-20">Category:</span>
                <span className="text-gray-900 capitalize">
                  {selectedNode.data.equipmentCategory.replace(/_/g, ' ')}
                </span>
              </div>
            )}

            {selectedNode.data.status && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 w-20">Status:</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  selectedNode.data.status === 'operational' || selectedNode.data.status === 'active'
                    ? 'bg-green-100 text-green-700'
                    : selectedNode.data.status === 'maintenance'
                    ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-gray-100 text-gray-700'
                }`}>
                  {selectedNode.data.status.charAt(0).toUpperCase() +
                    selectedNode.data.status.slice(1).replace('_', ' ')}
                </span>
              </div>
            )}

            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500 w-20">Node ID:</span>
              <span className="text-gray-600 font-mono text-xs">{selectedNode.id}</span>
            </div>
          </div>

          {/* Specifications */}
          {selectedNode.data.specifications && Object.keys(selectedNode.data.specifications).length > 0 && (
            <div className="pt-3 border-t border-gray-200">
              <h5 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
                <Info className="w-4 h-4" />
                Specifications
              </h5>
              <div className="space-y-2 text-sm">
                {Object.entries(selectedNode.data.specifications).slice(0, 5).map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2">
                    <span className="text-gray-500 capitalize min-w-[80px]">
                      {key.replace(/([A-Z])/g, ' $1').trim()}:
                    </span>
                    <span className="text-gray-900">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Equipment Linking Section */}
          <div className="pt-3 border-t border-gray-200">
            <h5 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
              <Link2 className="w-4 h-4" />
              Equipment Link
            </h5>

            {selectedNode.data.equipmentId ? (
              // Linked state
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-cyan-50 rounded-lg border border-cyan-200">
                  <span className="text-sm text-cyan-700 font-medium">Linked</span>
                  <button
                    onClick={handleUnlink}
                    className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1 px-2 py-1 hover:bg-red-50 rounded transition-colors"
                  >
                    <Unlink className="w-3 h-3" />
                    Unlink
                  </button>
                </div>

                {/* Inline Name Edit */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Name:</span>
                  {isEditingName ? (
                    <div className="flex-1 flex items-center gap-1">
                      <input
                        type="text"
                        value={editedName}
                        onChange={(e) => setEditedName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleNameSave();
                          if (e.key === 'Escape') setIsEditingName(false);
                        }}
                        onBlur={handleNameSave}
                        autoFocus
                        className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                      />
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-between">
                      <span className="text-sm text-gray-900">
                        {selectedNode.data.equipmentName}
                      </span>
                      <button
                        onClick={handleNameEdit}
                        className="p-1 hover:bg-gray-100 rounded transition-colors"
                        title="Edit Name"
                      >
                        <Edit3 className="w-4 h-4 text-gray-400 hover:text-gray-600" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              // Unlinked state - show dropdown
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-amber-50 rounded-lg border border-amber-200">
                  <span className="text-sm text-amber-700 font-medium">Unlinked</span>
                  <span className="text-xs text-amber-600">Select equipment below</span>
                </div>
                <select
                  onChange={(e) => {
                    const eq = unlinkedEquipment.find((eq) => eq.id === e.target.value);
                    if (eq) handleEquipmentSelect(eq);
                  }}
                  value=""
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 bg-white"
                >
                  <option value="">Select Equipment...</option>
                  {unlinkedEquipment.map((eq) => (
                    <option key={eq.id} value={eq.id}>
                      {eq.name} ({eq.code})
                    </option>
                  ))}
                </select>
                {unlinkedEquipment.length === 0 && (
                  <p className="text-xs text-gray-500 mt-2">
                    No linkable equipment found. Enable "Show in Sensor Module" in equipment settings.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* SensorWidget Configuration Section */}
          {selectedNode.type === 'sensorWidget' && (
            <div className="pt-3 border-t border-gray-200">
              <h5 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
                <Radio className="w-4 h-4" />
                Widget Configuration
              </h5>
              <div className="space-y-3">
                {/* Data Mode */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Data Mode</label>
                  <select
                    value={(selectedNode.data as SensorWidgetNodeData).mode || ''}
                    onChange={(e) =>
                      updateNodeData(selectedNode.id, {
                        mode: e.target.value as 'push' | 'poll' | 'onChange' | undefined,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  >
                    <option value="">Static (manual)</option>
                    <option value="push">MQTT Push (WebSocket)</option>
                    <option value="poll">HTTP Poll (Interval)</option>
                    <option value="onChange">HTTP onChange (ETag)</option>
                  </select>
                </div>

                {/* MQTT Settings */}
                {(selectedNode.data as SensorWidgetNodeData).mode === 'push' && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        <Wifi className="w-3 h-3 inline mr-1" />
                        MQTT Broker URL
                      </label>
                      <input
                        type="text"
                        placeholder="ws://localhost:9001"
                        value={(selectedNode.data as SensorWidgetNodeData).mqttUrl || ''}
                        onChange={(e) =>
                          updateNodeData(selectedNode.id, { mqttUrl: e.target.value })
                        }
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">MQTT Topic</label>
                      <input
                        type="text"
                        placeholder="sensors/temperature"
                        value={(selectedNode.data as SensorWidgetNodeData).mqttTopic || ''}
                        onChange={(e) =>
                          updateNodeData(selectedNode.id, { mqttTopic: e.target.value })
                        }
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                      />
                    </div>
                  </>
                )}

                {/* HTTP Settings */}
                {((selectedNode.data as SensorWidgetNodeData).mode === 'poll' ||
                  (selectedNode.data as SensorWidgetNodeData).mode === 'onChange') && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">HTTP URL</label>
                      <input
                        type="text"
                        placeholder="https://api.example.com/sensor/1"
                        value={(selectedNode.data as SensorWidgetNodeData).httpUrl || ''}
                        onChange={(e) =>
                          updateNodeData(selectedNode.id, { httpUrl: e.target.value })
                        }
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        <RotateCcw className="w-3 h-3 inline mr-1" />
                        Poll Interval (seconds)
                      </label>
                      <input
                        type="number"
                        min="1"
                        placeholder={(selectedNode.data as SensorWidgetNodeData).mode === 'onChange' ? '10' : '5'}
                        value={(selectedNode.data as SensorWidgetNodeData).pollInterval || ''}
                        onChange={(e) =>
                          updateNodeData(selectedNode.id, {
                            pollInterval: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                      />
                    </div>
                  </>
                )}

                {/* Display Settings */}
                <div className="pt-2 border-t border-gray-100">
                  <label className="block text-xs text-gray-500 mb-1">Widget Name</label>
                  <input
                    type="text"
                    placeholder="Temperature"
                    value={(selectedNode.data as SensorWidgetNodeData).widgetName || (selectedNode.data as SensorWidgetNodeData).label || ''}
                    onChange={(e) =>
                      updateNodeData(selectedNode.id, {
                        widgetName: e.target.value,
                        label: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Unit</label>
                    <input
                      type="text"
                      placeholder="°C"
                      value={(selectedNode.data as SensorWidgetNodeData).unit || ''}
                      onChange={(e) =>
                        updateNodeData(selectedNode.id, { unit: e.target.value })
                      }
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Scale Max</label>
                    <input
                      type="number"
                      placeholder="100"
                      value={(selectedNode.data as SensorWidgetNodeData).scaleMax || ''}
                      onChange={(e) =>
                        updateNodeData(selectedNode.id, {
                          scaleMax: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Low Threshold (%)</label>
                    <input
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
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">High Threshold (%)</label>
                    <input
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
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                </div>

                {/* Manual Value (for static mode) */}
                {!(selectedNode.data as SensorWidgetNodeData).mode && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Static Value</label>
                    <input
                      type="number"
                      placeholder="0"
                      value={(selectedNode.data as SensorWidgetNodeData).value || ''}
                      onChange={(e) =>
                        updateNodeData(selectedNode.id, {
                          value: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Sensor Linking Section */}
          <div className="pt-3 border-t border-gray-200">
            <h5 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
              <Activity className="w-4 h-4" />
              Sensor Link
            </h5>

            {selectedNode.data.sensorId ? (
              // Linked state
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-green-50 rounded-lg border border-green-200">
                  <div>
                    <span className="text-sm text-green-700 font-medium">Linked</span>
                    <p className="text-xs text-green-600 mt-0.5">
                      {selectedNode.data.customName || selectedNode.data.sensorName}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleOpenSensorConfig}
                      className="text-xs text-green-600 hover:text-green-700 flex items-center gap-1 px-2 py-1 hover:bg-green-100 rounded transition-colors"
                      title="Düzenle"
                    >
                      <Edit3 className="w-3 h-3" />
                      Edit
                    </button>
                    <button
                      onClick={handleSensorUnlink}
                      className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1 px-2 py-1 hover:bg-red-50 rounded transition-colors"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Sensor Details */}
                <div className="space-y-2 text-sm">
                  {selectedNode.data.sensorType && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 w-16">Type:</span>
                      <span className="text-gray-900">
                        {getSensorTypeLabel(selectedNode.data.sensorType)}
                      </span>
                    </div>
                  )}
                  {selectedNode.data.displayType && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 w-16">Display:</span>
                      <span className="text-gray-900 capitalize">
                        {selectedNode.data.displayType}
                      </span>
                    </div>
                  )}
                  {(selectedNode.data.minValue !== undefined || selectedNode.data.maxValue !== undefined) && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 w-16">Range:</span>
                      <span className="text-gray-900">
                        {selectedNode.data.minValue} - {selectedNode.data.maxValue} {selectedNode.data.displayUnit || ''}
                      </span>
                    </div>
                  )}
                  {selectedNode.data.dataPath && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 w-16">Path:</span>
                      <span className="text-gray-900 font-mono text-xs">
                        {selectedNode.data.dataPath}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              // Unlinked state - show button to open dialog
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-amber-50 rounded-lg border border-amber-200">
                  <span className="text-sm text-amber-700 font-medium">No sensor linked</span>
                </div>
                <button
                  onClick={handleOpenSensorConfig}
                  className="w-full px-3 py-2.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Activity className="w-4 h-4" />
                  Link Sensor...
                </button>
              </div>
            )}
          </div>
        </div>

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
        <div className="p-4 border-t border-gray-200">
          <button
            onClick={() => {
              removeNode(selectedNode.id);
            }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 border border-red-200 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Remove from Process
          </button>
        </div>
      </div>
    );
  }

  // Edge selected
  if (selectedEdge) {
    // Get normalized connection type for backwards compatibility
    const currentConnectionType = normalizeConnectionType(selectedEdge.data?.connectionType || 'process-pipe');
    const currentConfig = getConnectionTypeConfig(currentConnectionType);

    return (
      <div className="properties-panel w-72 bg-white border-l border-gray-200 flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Connection</h3>
          <button
            onClick={() => selectEdge(null)}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Connection Preview */}
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
            <div className="p-2 bg-white rounded-lg shadow-sm">
              <svg width="32" height="16" className="flex-shrink-0">
                <line
                  x1="4" y1="8" x2="28" y2="8"
                  stroke={currentConfig.color}
                  strokeWidth={currentConfig.strokeWidth}
                  strokeDasharray={currentConfig.strokeDasharray}
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div>
              <h4 className="font-medium text-gray-900">{currentConfig.label}</h4>
              <p className="text-xs text-gray-500">{currentConfig.description}</p>
            </div>
          </div>

          {/* Connection Type - P&ID Standard Types */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Connection Type (P&ID)
            </label>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {CONNECTION_TYPES.map((type) => (
                <button
                  key={type.id}
                  onClick={() =>
                    updateEdgeData(selectedEdge.id, { connectionType: type.id })
                  }
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                    currentConnectionType === type.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {/* SVG Line Preview */}
                  <svg width="32" height="12" className="flex-shrink-0">
                    <line
                      x1="2" y1="6" x2="30" y2="6"
                      stroke={type.color}
                      strokeWidth={type.strokeWidth}
                      strokeDasharray={type.strokeDasharray}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="flex-1 text-left min-w-0">
                    <span className="text-sm text-gray-700 block truncate">{type.label}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Connection Details */}
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-500 w-16">From:</span>
              <span className="text-gray-900 font-mono text-xs">{selectedEdge.source}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 w-16">To:</span>
              <span className="text-gray-900 font-mono text-xs">{selectedEdge.target}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 w-16">Edge ID:</span>
              <span className="text-gray-600 font-mono text-xs truncate">{selectedEdge.id}</span>
            </div>
          </div>

          {/* Flow Rate (for pipe/steam/hydraulic connections) */}
          {(currentConnectionType === 'process-pipe' || currentConnectionType === 'steam' || currentConnectionType === 'hydraulic') && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Flow Rate (optional)
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="0"
                  value={selectedEdge.data?.flowRate || ''}
                  onChange={(e) =>
                    updateEdgeData(selectedEdge.id, {
                      flowRate: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <select
                  value={selectedEdge.data?.flowUnit || 'L/min'}
                  onChange={(e) =>
                    updateEdgeData(selectedEdge.id, { flowUnit: e.target.value })
                  }
                  className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="L/min">L/min</option>
                  <option value="m3/h">m³/h</option>
                  <option value="kg/h">kg/h</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-gray-200">
          <button
            onClick={() => {
              removeEdge(selectedEdge.id);
            }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 border border-red-200 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Remove Connection
          </button>
        </div>
      </div>
    );
  }

  return null;
};

export default PropertiesPanel;
