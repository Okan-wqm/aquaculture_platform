/**
 * Process Editor Page
 * Visual editor for creating equipment connection diagrams
 *
 * ARCHITECTURE:
 * ReactFlow runs in an isolated iframe to avoid Module Federation React conflicts.
 * Communication between host and iframe happens via postMessage API.
 *
 * Benefits:
 * - ReactFlow has its own React instance (no hook conflicts)
 * - Full ReactFlow functionality preserved (Controls, MiniMap, Background)
 * - Type-safe message passing between host and iframe
 * - Seamless integration with existing MF architecture
 */

import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Play,
  Undo,
  Redo,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Trash2,
  Loader2,
  Settings,
  Paperclip,
  X,
  ChevronRight,
  ChevronDown,
  Upload,
  Cpu,
  CheckCircle,
  AlertCircle,
  Monitor,
} from 'lucide-react';

import { useProcessStore, EquipmentNodeData, ProcessEdgeData } from '../../store/processStore';
import { graphqlFetch } from '../../config/api';
import type { Edge } from '@xyflow/react';
import { AUTOMATION_PROGRAMS_QUERY, DEPLOY_PROGRAM_MUTATION } from '../../graphql/automation.queries';
import { useAuth } from '@aquaculture/shared-ui';
import { EquipmentPanel } from '../../components/process-editor/panels/EquipmentPanel';
import { PropertiesPanel } from '../../components/process-editor/panels/PropertiesPanel';
import { AttachmentsPanel } from '../../components/process-editor/panels/AttachmentsPanel';
import { NodeTemplate } from '../../components/process-editor/panels/EquipmentPanel';
import { useProcess, type ProcessNode } from '../../hooks/useProcess';
import { useDataChannelList, DataChannel } from '../../hooks/useDataChannelList';
import { WIDGET_TYPES, TIME_RANGES, REFRESH_INTERVALS, WidgetType } from '../../components/dashboard/types';
import { DeployToEdgeDialog } from '../../components/deploy/DeployToEdgeDialog';
import { useDeployProcessToEdge } from '../../hooks/useDeployProcess';

// Message types for iframe communication
interface IframeMessage {
  type: string;
  data?: unknown;
  source: 'process-editor-canvas' | 'process-editor-host';
}

interface CanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: EquipmentNodeData;
}

interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type?: string;
  data?: {
    connectionType?: string;
    midX1?: number | null;
    midY?: number | null;
    midX2?: number | null;
    [key: string]: unknown;
  };
}

// Right panel mode type
type RightPanelMode = 'properties' | 'attachments';

// Widget types suitable for process editor (single data channel visualizations)
const PROCESS_WIDGET_TYPES = WIDGET_TYPES.filter(
  (t) => !['process-view', 'table', 'heatmap', 'multi-line'].includes(t.type)
);

// Widget type icons (emoji-based for simplicity)
const WIDGET_ICONS: Record<string, string> = {
  gauge: '🎯',
  'radial-gauge': '⭕',
  'line-chart': '📈',
  'area-chart': '📊',
  'bar-chart': '📶',
  sparkline: '〰️',
  'stat-card': '🔢',
  alert: '⚠️',
};

// Widget Config Modal Component - 2-Step Form
interface WidgetConfigModalProps {
  nodeId: string | null;
  data: Record<string, unknown> | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
}

const WidgetConfigModal: React.FC<WidgetConfigModalProps> = ({ nodeId, data, onClose, onSave }) => {
  // Step state: 'type' for widget type selection, 'config' for data channel selection
  const [step, setStep] = useState<'type' | 'config'>(data?.widgetType ? 'config' : 'type');

  // Form state
  const [selectedType, setSelectedType] = useState<WidgetType | null>(
    (data?.widgetType as WidgetType) || null
  );
  const [title, setTitle] = useState((data?.title as string) || '');
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    (data?.dataChannelId as string) || null
  );
  const [timeRange, setTimeRange] = useState((data?.timeRange as string) || 'live');
  const [refreshInterval, setRefreshInterval] = useState(
    (data?.refreshInterval as number) || 10000
  );
  const [expandedSensors, setExpandedSensors] = useState<Set<string>>(new Set());

  // Y-axis range settings (for charts)
  const [yAxisMin, setYAxisMin] = useState<string>(
    data?.yAxisMin !== undefined ? String(data.yAxisMin) : ''
  );
  const [yAxisMax, setYAxisMax] = useState<string>(
    data?.yAxisMax !== undefined ? String(data.yAxisMax) : ''
  );

  // Fetch data channels
  const { groupedBySensor, loading, error } = useDataChannelList();

  // Auto-expand first sensor when data loads
  useEffect(() => {
    if (groupedBySensor.length > 0 && expandedSensors.size === 0) {
      setExpandedSensors(new Set([groupedBySensor[0].sensorId]));
    }
  }, [groupedBySensor, expandedSensors.size]);

  // Handle widget type selection
  const handleTypeSelect = (type: WidgetType) => {
    setSelectedType(type);
    setStep('config');
  };

  // Handle channel selection
  const handleChannelSelect = (channel: DataChannel) => {
    setSelectedChannelId(channel.id);
    // Auto-set title from channel name if empty
    if (!title) {
      setTitle(channel.displayLabel);
    }
  };

  // Toggle sensor expansion
  const toggleSensor = (sensorId: string) => {
    const next = new Set(expandedSensors);
    if (next.has(sensorId)) {
      next.delete(sensorId);
    } else {
      next.add(sensorId);
    }
    setExpandedSensors(next);
  };

  // Handle save
  const handleSave = () => {
    if (!selectedType || !selectedChannelId) return;

    // Find the selected channel to get full info
    const selectedChannel = groupedBySensor
      .flatMap((g) => g.channels)
      .find((c) => c.id === selectedChannelId);

    onSave({
      widgetType: selectedType,
      title: title || selectedChannel?.displayLabel || 'Widget',
      dataChannelId: selectedChannelId,
      selectedChannel: selectedChannel
        ? {
            channelId: selectedChannel.id,
            sensorId: selectedChannel.sensorId,
            channelKey: selectedChannel.channelKey,
            displayLabel: selectedChannel.displayLabel,
            unit: selectedChannel.unit,
            minValue: selectedChannel.minValue,
            maxValue: selectedChannel.maxValue,
          }
        : null,
      timeRange,
      refreshInterval,
      // Y-axis range (parse as numbers, undefined if empty)
      yAxisMin: yAxisMin !== '' ? parseFloat(yAxisMin) : undefined,
      yAxisMax: yAxisMax !== '' ? parseFloat(yAxisMax) : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Widget Configuration</h3>
            <button
              onClick={onClose}
              className="p-1 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {step === 'type' ? 'Step 1: Select widget type' : 'Step 2: Configure data source'}
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Step 1: Widget Type Selection */}
          {step === 'type' && (
            <div className="grid grid-cols-2 gap-3">
              {PROCESS_WIDGET_TYPES.map((wt) => (
                <button
                  key={wt.type}
                  onClick={() => handleTypeSelect(wt.type)}
                  className={`p-4 border rounded-lg text-left transition-all hover:border-cyan-500 hover:shadow-md ${
                    selectedType === wt.type
                      ? 'border-cyan-500 bg-cyan-50 ring-2 ring-cyan-200'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="text-2xl mb-2">{WIDGET_ICONS[wt.type] || '📊'}</div>
                  <div className="font-medium text-gray-900">{wt.label}</div>
                  <div className="text-xs text-gray-500 mt-1">{wt.description}</div>
                </button>
              ))}
            </div>
          )}

          {/* Step 2: Data Channel Selection & Configuration */}
          {step === 'config' && (
            <div className="space-y-4">
              {/* Widget Type Badge */}
              <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
                <span className="text-xl">
                  {WIDGET_ICONS[selectedType || 'line-chart'] || '📊'}
                </span>
                <span className="font-medium text-gray-700">
                  {PROCESS_WIDGET_TYPES.find((t) => t.type === selectedType)?.label || 'Widget'}
                </span>
                <button
                  onClick={() => setStep('type')}
                  className="ml-auto text-xs text-cyan-600 hover:underline"
                >
                  Change
                </button>
              </div>

              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                  placeholder="Widget title (auto-fills from channel)"
                />
              </div>

              {/* Data Channel Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Data Channel
                </label>

                {loading && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 text-cyan-600 animate-spin" />
                    <span className="ml-2 text-gray-500">Loading channels...</span>
                  </div>
                )}

                {error && (
                  <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>
                )}

                {!loading && !error && groupedBySensor.length === 0 && (
                  <div className="p-4 bg-gray-50 text-gray-500 rounded-lg text-sm text-center">
                    No data channels available. Register sensors first.
                  </div>
                )}

                {!loading && !error && groupedBySensor.length > 0 && (
                  <div className="border border-gray-200 rounded-lg divide-y divide-gray-200 max-h-64 overflow-y-auto">
                    {groupedBySensor.map((group) => (
                      <div key={group.sensorId}>
                        {/* Sensor Header - Collapsible */}
                        <button
                          onClick={() => toggleSensor(group.sensorId)}
                          className="w-full px-3 py-2 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            {expandedSensors.has(group.sensorId) ? (
                              <ChevronDown className="w-4 h-4 text-gray-500" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-gray-500" />
                            )}
                            <span className="font-medium text-sm text-gray-700">
                              {group.sensorName}
                            </span>
                            {group.sensorType && (
                              <span className="text-xs text-gray-500">({group.sensorType})</span>
                            )}
                          </div>
                          <span className="text-xs text-gray-500">
                            {group.channels.length} channel
                            {group.channels.length !== 1 ? 's' : ''}
                          </span>
                        </button>

                        {/* Channel List */}
                        {expandedSensors.has(group.sensorId) && (
                          <div className="divide-y divide-gray-100">
                            {group.channels.map((channel) => (
                              <label
                                key={channel.id}
                                className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${
                                  selectedChannelId === channel.id
                                    ? 'bg-cyan-50'
                                    : 'hover:bg-gray-50'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="dataChannel"
                                  checked={selectedChannelId === channel.id}
                                  onChange={() => handleChannelSelect(channel)}
                                  className="text-cyan-600 focus:ring-cyan-500"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-gray-900 truncate">
                                    {channel.displayLabel}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    {channel.channelKey}
                                    {channel.unit && ` • ${channel.unit}`}
                                  </div>
                                </div>
                                {!channel.isEnabled && (
                                  <span className="text-xs text-yellow-600 bg-yellow-50 px-1.5 py-0.5 rounded">
                                    Disabled
                                  </span>
                                )}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Time Range */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
                <select
                  value={timeRange}
                  onChange={(e) => setTimeRange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                >
                  {TIME_RANGES.map((tr) => (
                    <option key={tr.value} value={tr.value}>
                      {tr.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Refresh Interval */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Refresh Interval
                </label>
                <select
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                >
                  {REFRESH_INTERVALS.map((ri) => (
                    <option key={ri.value} value={ri.value}>
                      {ri.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Y-Axis Range Settings - only for chart types */}
              {selectedType && ['line-chart', 'area-chart', 'bar-chart', 'sparkline', 'gauge', 'radial-gauge'].includes(selectedType) && (
                <div className="pt-3 border-t border-gray-200">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Y-Axis Range (optional)
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Min Value</label>
                      <input
                        type="number"
                        value={yAxisMin}
                        onChange={(e) => setYAxisMin(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent text-sm"
                        placeholder="Auto"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Max Value</label>
                      <input
                        type="number"
                        value={yAxisMax}
                        onChange={(e) => setYAxisMax(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent text-sm"
                        placeholder="Auto"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Leave empty for automatic range based on data
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 flex justify-between items-center bg-gray-50">
          {step === 'config' && (
            <button
              onClick={() => setStep('type')}
              className="text-sm text-cyan-600 hover:text-cyan-700 hover:underline"
            >
              ← Change widget type
            </button>
          )}
          {step === 'type' && <div />}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            {step === 'config' && (
              <button
                onClick={handleSave}
                disabled={!selectedType || !selectedChannelId}
                className={`px-4 py-2 text-white rounded-lg transition-colors ${
                  !selectedType || !selectedChannelId
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-cyan-600 hover:bg-cyan-700'
                }`}
              >
                Save Widget
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// =====================================================================
// Deploy Automation Modal (Kemik Yapı — Faz D)
// =====================================================================
// Process diyagramından direkt automation program deploy edebilme.
// NASIL ÇALIŞIR:
//   1. Toolbar'daki "Deploy" butonuna tıklanır
//   2. Modal açılır: mevcut programlar listelenir
//   3. Hedef device seçilir (process'teki bağlı cihazlardan)
//   4. Deploy butonu → DEPLOY_PROGRAM_MUTATION çağrılır
//   5. Sonuç toast notification ile gösterilir
// =====================================================================

interface DeployModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Process'teki equipment node'larından çıkarılan bağlı device listesi */
  boundDevices: Array<{ id: string; code: string; name?: string }>;
}

const DeployAutomationModal: React.FC<DeployModalProps> = ({ isOpen, onClose, boundDevices }) => {
  const graphqlRequest = useCallback(
    (query: string, variables?: Record<string, unknown>) => graphqlFetch<Record<string, unknown>>(query, variables),
    [],
  );
  const [programs, setPrograms] = useState<Array<{
    id: string; programCode: string; programName: string; status: string;
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Modal açıldığında program listesini çek
  useEffect(() => {
    if (!isOpen) return;
    setDeployResult(null);
    setLoading(true);

    graphqlRequest(AUTOMATION_PROGRAMS_QUERY, {
      filter: { status: 'APPROVED' },
      limit: 50,
    })
      .then((data: Record<string, unknown>) => {
        const items = data?.automationPrograms as Array<{
          id: string; programCode: string; programName: string; status: string;
        }> || [];
        setPrograms(items);
      })
      .catch((err: Error) => {
        console.error('Failed to fetch programs:', err);
        setPrograms([]);
      })
      .finally(() => setLoading(false));
  }, [isOpen, graphqlRequest]);

  // Otomatik olarak ilk device'ı seç
  useEffect(() => {
    if (boundDevices.length > 0 && !selectedDeviceId) {
      setSelectedDeviceId(boundDevices[0].id);
    }
  }, [boundDevices, selectedDeviceId]);

  // Deploy butonuna tıklanınca
  const handleDeploy = async () => {
    if (!selectedProgramId || !selectedDeviceId) return;
    setDeploying(true);
    setDeployResult(null);

    try {
      const result = await graphqlRequest(DEPLOY_PROGRAM_MUTATION, {
        input: {
          programId: selectedProgramId,
          deviceId: selectedDeviceId,
        },
      });

      const deployData = result?.deployProgram as { success: boolean; error?: string } | undefined;
      if (deployData?.success) {
        setDeployResult({ success: true });
      } else {
        setDeployResult({ success: false, error: deployData?.error || 'Unknown error' });
      }
    } catch (error) {
      setDeployResult({ success: false, error: (error as Error).message });
    } finally {
      setDeploying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Upload className="w-5 h-5 text-indigo-600" />
            Deploy Automation
          </h3>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Deploy sonucu — başarı veya hata */}
          {deployResult && (
            <div className={`p-3 rounded-lg flex items-center gap-2 ${
              deployResult.success
                ? 'bg-green-50 text-green-700 border border-green-200'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}>
              {deployResult.success ? (
                <>
                  <CheckCircle className="w-5 h-5" />
                  <span className="text-sm font-medium">Program deployed successfully!</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-5 h-5" />
                  <span className="text-sm">{deployResult.error}</span>
                </>
              )}
            </div>
          )}

          {/* Program seçimi */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Automation Program
            </label>
            {loading ? (
              <div className="flex items-center gap-2 py-2 text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading programs...</span>
              </div>
            ) : (
              <select
                value={selectedProgramId}
                onChange={(e) => setSelectedProgramId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">Select program...</option>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.programName} ({p.programCode})
                  </option>
                ))}
              </select>
            )}
            {!loading && programs.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">
                No approved programs found. Create and approve a program first.
              </p>
            )}
          </div>

          {/* Target device seçimi */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Target Device
            </label>
            <select
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="">Select device...</option>
              {boundDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name || d.code} ({d.code})
                </option>
              ))}
            </select>
            {boundDevices.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">
                No devices bound to this process. Bind edge devices to equipment nodes first.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2 bg-gray-50 rounded-b-lg">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {deployResult?.success ? 'Close' : 'Cancel'}
          </button>
          {!deployResult?.success && (
            <button
              onClick={handleDeploy}
              disabled={!selectedProgramId || !selectedDeviceId || deploying}
              className={`px-4 py-2 text-sm text-white rounded-lg transition-colors flex items-center gap-2 ${
                !selectedProgramId || !selectedDeviceId || deploying
                  ? 'bg-indigo-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              {deploying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Deploy
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const ProcessEditorPage: React.FC = () => {
  const { processId } = useParams<{ processId: string }>();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Iframe state
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<CanvasEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Right panel mode - properties by default
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('properties');

  // Deploy Automation modal state (Kemik Yapı — Faz D)
  const [isDeployModalOpen, setIsDeployModalOpen] = useState(false);

  // Edge Deploy dialog state (SCADA process deploy)
  const [isEdgeDeployOpen, setIsEdgeDeployOpen] = useState(false);
  const edgeDeployMutation = useDeployProcessToEdge();

  // Deploy menüsü — otomasyon programı, proses diyagramı ve SCADA paketi
  // girişleri tek toolbar menüsünde toplanır (üç ayrı buton yerine)
  const [isDeployMenuOpen, setIsDeployMenuOpen] = useState(false);
  const deployMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isDeployMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (deployMenuRef.current && !deployMenuRef.current.contains(e.target as Node)) {
        setIsDeployMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isDeployMenuOpen]);

  // Memoized bound devices — canvasNodes değişmedikçe yeniden hesaplanmaz.
  // Her render'da Array.from(new Map(...)) oluşturmak gereksiz GC baskısı yaratır.
  // DeployAutomationModal'a prop olarak geçirilir, referans stabilitesi önemli.
  const boundDevices = useMemo(() => {
    return Array.from(
      new Map(
        canvasNodes
          .filter((n) => n.data?.edgeDeviceId)
          .map((n) => [
            n.data.edgeDeviceId,
            {
              id: n.data.edgeDeviceId!,
              code: n.data.edgeDeviceCode || n.data.edgeDeviceId!,
              name: n.data.edgeDeviceCode || n.data.edgeDeviceId!,
            },
          ])
      ).values()
    );
  }, [canvasNodes]);

  // Widget config modal state
  const [widgetConfigModal, setWidgetConfigModal] = useState<{
    isOpen: boolean;
    nodeId: string | null;
    data: Record<string, unknown> | null;
  }>({ isOpen: false, nodeId: null, data: null });

  // Store state and actions
  const {
    processName,
    processId: storeProcessId,
    isDirty,
    isSaving,
    selectNode,
    selectEdge,
    setProcessName,
    setProcessId,
    resetStore,
    setIsSaving,
    markClean,
  } = useProcessStore();

  // API hook for process CRUD operations
  const { createProcess, updateProcess, getProcess, loading: apiLoading } = useProcess();

  // Send message to iframe
  const sendToCanvas = useCallback((type: string, data?: unknown) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type, data, source: 'process-editor-host' },
        window.location.origin
      );
    }
  }, []);

  // Handle messages from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // SEC-002: validate origin before processing any payload content
      if (event.origin !== window.location.origin) return;
      const message = event.data || {};
      const { type, data, source, nodeId } = message;
      if (source !== 'process-editor-canvas') return;

      switch (type) {
        case 'ready':
          setIsCanvasReady(true);
          // Load existing process data if available
          if (canvasNodes.length > 0) {
            sendToCanvas('setNodes', canvasNodes);
            sendToCanvas('setEdges', canvasEdges);
          }
          break;

        case 'nodesChange':
          setCanvasNodes(data as CanvasNode[]);
          break;

        case 'edgesChange':
          setCanvasEdges(data as CanvasEdge[]);
          break;

        case 'nodeSelected':
          const node = data as CanvasNode;
          setSelectedNodeId(node?.id || null);
          selectNode(node);
          // Switch to properties panel when node is selected
          if (node) {
            setRightPanelMode('properties');
          }
          break;

        case 'edgeSelected':
          selectEdge(data as CanvasEdge as unknown as Edge<ProcessEdgeData>);
          break;

        case 'selectionCleared':
          setSelectedNodeId(null);
          selectNode(null);
          selectEdge(null);
          break;

        case 'nodeAdded':
          // Node already added via nodesChange, just log
          console.log('Node added:', data);
          break;

        case 'openWidgetConfig':
          // Open widget config modal - nodeId comes at top level of message
          console.log('Opening widget config for:', nodeId, 'with data:', data);
          setWidgetConfigModal({
            isOpen: true,
            nodeId: nodeId as string,
            data: data as Record<string, unknown>,
          });
          break;

        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [canvasNodes, canvasEdges, sendToCanvas, selectNode, selectEdge]);

  // Initialize store based on route
  useEffect(() => {
    // BUG-004: AbortController so async API call is cancelled on unmount / dep change
    const controller = new AbortController();

    const loadProcess = async () => {
      if (processId && processId !== 'new') {
        // Load existing process from API
        const existingProcess = await getProcess(processId);
        // Guard: if the effect was cleaned up while the fetch was in-flight, do nothing
        if (controller.signal.aborted) return;
        if (existingProcess) {
          setProcessId(existingProcess.id);
          setProcessName(existingProcess.name);
          setCanvasNodes(existingProcess.nodes as CanvasNode[]);
          setCanvasEdges(existingProcess.edges as CanvasEdge[]);
          // Send to canvas if ready
          if (isCanvasReady) {
            sendToCanvas('setNodes', existingProcess.nodes);
            sendToCanvas('setEdges', existingProcess.edges);
          }
        } else {
          // Process not found, reset to new
          resetStore();
          setProcessName('New Process');
        }
      } else {
        resetStore();
        setProcessName('New Process');
      }
    };
    loadProcess();

    return () => controller.abort();
  }, [processId, setProcessId, setProcessName, resetStore, getProcess, isCanvasReady, sendToCanvas]);

  // Handle node template drag start from panel
  const handleEquipmentDragStart = useCallback(
    (event: React.DragEvent, template: NodeTemplate) => {
      // Set drag data that will be read by iframe
      event.dataTransfer.setData('application/equipment', JSON.stringify(template));
      event.dataTransfer.effectAllowed = 'move';
    },
    []
  );

  // Zoom controls
  const handleZoomIn = () => sendToCanvas('zoomIn');
  const handleZoomOut = () => sendToCanvas('zoomOut');
  const handleFitView = () => sendToCanvas('fitView');

  // Delete selected node
  const handleDeleteNode = useCallback(() => {
    if (selectedNodeId) {
      sendToCanvas('removeNode', selectedNodeId);
      setSelectedNodeId(null);
      selectNode(null);
    }
  }, [selectedNodeId, sendToCanvas, selectNode]);

  // Handle save
  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Request current state from canvas AND WAIT for response
      // BUG-004: use AbortController so the listener is always cleaned up, even on timeout
      const currentState = await new Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>((resolve) => {
        const controller = new AbortController();
        const handler = (event: MessageEvent) => {
          // SEC-002: validate origin (already validated in main listener, but guard here too)
          if (event.origin !== window.location.origin) return;
          const { type, data, source } = event.data || {};
          if (source === 'process-editor-canvas' && type === 'state') {
            controller.abort();
            resolve(data as { nodes: CanvasNode[]; edges: CanvasEdge[] });
          }
        };
        window.addEventListener('message', handler, { signal: controller.signal });
        sendToCanvas('getState');

        // Timeout fallback - use current state if canvas doesn't respond
        const timeoutId = setTimeout(() => {
          controller.abort();
          resolve({ nodes: canvasNodes, edges: canvasEdges });
        }, 2000);

        // Clean up timeout if promise resolves early
        controller.signal.addEventListener('abort', () => clearTimeout(timeoutId));
      });

      console.log('[handleSave] Got current state from canvas:', {
        nodes: currentState.nodes.length,
        edges: currentState.edges.length,
        edgeDataSample: currentState.edges[0]?.data,
      });

      // Determine if this is a new process or an update
      const isNewProcess = !storeProcessId || storeProcessId === 'new' || processId === 'new';

      if (isNewProcess) {
        // Create new process with current canvas state
        const result = await createProcess({
          name: processName,
          nodes: currentState.nodes as unknown as ProcessNode[],
          edges: currentState.edges,
        });

        if (result.success && result.process) {
          // Update local state with new ID
          setProcessId(result.process.id);
          markClean();
          // Update URL without reload to reflect new process ID
          window.history.replaceState(null, '', `/sensor/process/${result.process.id}`);
          console.log('Process created:', result.process.id);
        } else {
          console.error('Failed to create process:', result.message);
        }
      } else {
        // Update existing process with current canvas state
        const result = await updateProcess({
          processId: storeProcessId,
          name: processName,
          nodes: currentState.nodes as unknown as ProcessNode[],
          edges: currentState.edges,
        });

        if (result.success) {
          markClean();
          console.log('Process updated:', storeProcessId);
        } else {
          console.error('Failed to update process:', result.message);
        }
      }
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Get iframe URL - environment-aware, mirrors ScadaViewer logic (BUG-017)
  const getCanvasUrl = () => {
    const isLocalDev =
      window.location.hostname === 'localhost' && window.location.port === '3006';
    return isLocalDev
      ? '/process-editor-canvas.html'
      : '/remotes/sensor-module/process-editor-canvas.html';
  };

  // Widget config modal handlers
  const handleWidgetConfigClose = useCallback(() => {
    setWidgetConfigModal({ isOpen: false, nodeId: null, data: null });
  }, []);

  const handleWidgetConfigSave = useCallback((updatedData: Record<string, unknown>) => {
    console.log('[host] Widget config save - nodeId:', widgetConfigModal.nodeId, 'data:', updatedData);
    if (widgetConfigModal.nodeId) {
      console.log('[host] Sending updateNodeData to canvas');
      sendToCanvas('updateNodeData', {
        nodeId: widgetConfigModal.nodeId,
        data: updatedData,
      });
    } else {
      console.warn('[host] No nodeId found, cannot update widget');
    }
    setWidgetConfigModal({ isOpen: false, nodeId: null, data: null });
  }, [widgetConfigModal.nodeId, sendToCanvas]);

  return (
    <div className="process-editor-container flex flex-col h-screen bg-gray-100">
      {/* Toolbar */}
      <div className="toolbar flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 shadow-sm">
        {/* Left Section */}
        <div className="flex items-center gap-4">
          <Link
            to="/sensor/processes"
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </Link>

          <div className="h-6 w-px bg-gray-300" />

          <input
            type="text"
            value={processName}
            onChange={(e) => setProcessName(e.target.value)}
            placeholder="Process Name"
            className="text-lg font-medium text-gray-900 border-none bg-transparent focus:outline-hidden focus:ring-0 w-64"
          />

          {isDirty && (
            <span className="text-xs text-yellow-600 bg-yellow-50 px-2 py-1 rounded">
              Unsaved changes
            </span>
          )}
        </div>

        {/* Center Section - Controls */}
        <div className="flex items-center gap-2">
          <button
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Undo"
            disabled={!isCanvasReady}
            onClick={() => sendToCanvas('undo')}
          >
            <Undo className="w-4 h-4" />
          </button>
          <button
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Redo"
            disabled={!isCanvasReady}
            onClick={() => sendToCanvas('redo')}
          >
            <Redo className="w-4 h-4" />
          </button>
          <div className="h-6 w-px bg-gray-300 mx-2" />
          <button
            onClick={handleZoomOut}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Zoom Out"
            disabled={!isCanvasReady}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={handleZoomIn}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Zoom In"
            disabled={!isCanvasReady}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={handleFitView}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Fit View"
            disabled={!isCanvasReady}
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          {selectedNodeId && (
            <>
              <div className="h-6 w-px bg-gray-300 mx-2" />
              <button
                onClick={handleDeleteNode}
                className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg"
                title="Delete Selected"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-3">
          <button
            className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            disabled={!isCanvasReady}
          >
            <Play className="w-4 h-4" />
            Test
          </button>

          {/* Deploy menüsü — otomasyon programı, proses diyagramı ve SCADA
              paketi girişleri tek yerde */}
          <div className="relative" ref={deployMenuRef}>
            <button
              onClick={() => setIsDeployMenuOpen((open) => !open)}
              className="flex items-center gap-2 px-4 py-2 text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50 transition-colors"
              disabled={!isCanvasReady}
              title="Deploy secenekleri"
            >
              <Upload className="w-4 h-4" />
              Deploy
              <ChevronDown className="w-4 h-4" />
            </button>
            {isDeployMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-30 py-1">
                <button
                  onClick={() => {
                    setIsDeployMenuOpen(false);
                    setIsDeployModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-indigo-50 text-left"
                  title="Deploy automation program to edge device"
                >
                  <Cpu className="w-4 h-4 text-indigo-600" />
                  Otomasyon Programi Deploy Et
                </button>
                <button
                  onClick={() => {
                    setIsDeployMenuOpen(false);
                    setIsEdgeDeployOpen(true);
                  }}
                  disabled={!processId || processId === 'new'}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-cyan-50 text-left disabled:opacity-50 disabled:cursor-not-allowed"
                  title="SCADA proses diyagramini edge device'a deploy et"
                >
                  <Monitor className="w-4 h-4 text-cyan-600" />
                  Edge'e Deploy
                </button>
                <div className="my-1 border-t border-gray-100" />
                <button
                  onClick={() => {
                    setIsDeployMenuOpen(false);
                    navigate(
                      `/sensor/scada-builder/new${processId && processId !== 'new' ? `?processId=${processId}` : ''}`,
                    );
                  }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-purple-50 text-left"
                  title="SCADA Paketi Olustur"
                >
                  <Monitor className="w-4 h-4 text-purple-600" />
                  SCADA Paketi Olustur
                </button>
              </div>
            )}
          </div>

          <button
            onClick={handleSave}
            disabled={isSaving || !isDirty || !isCanvasReady}
            className={`flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors ${
              isSaving || !isDirty || !isCanvasReady
                ? 'bg-blue-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            <Save className="w-4 h-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Equipment */}
        <EquipmentPanel onDragStart={handleEquipmentDragStart} />

        {/* Center - Canvas (iframe) */}
        <div className="flex-1 bg-gray-50 relative">
          {!isCanvasReady && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                <p className="text-gray-600">Loading Process Editor...</p>
              </div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={getCanvasUrl()}
            className="w-full h-full border-0"
            title="Process Editor Canvas"
            sandbox="allow-scripts allow-same-origin"
          />
        </div>

        {/* Right Panel - Properties / Equipment */}
        <div className="w-80 flex flex-col border-l border-gray-200 bg-white">
          {/* Panel Tabs */}
          <div className="flex border-b border-gray-200">
            <button
              onClick={() => setRightPanelMode('properties')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                rightPanelMode === 'properties'
                  ? 'text-cyan-600 border-b-2 border-cyan-600 bg-cyan-50'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Settings className="w-4 h-4" />
              Properties
              {selectedNodeId && (
                <span className="w-2 h-2 rounded-full bg-cyan-500" />
              )}
            </button>
            <button
              onClick={() => setRightPanelMode('attachments')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                rightPanelMode === 'attachments'
                  ? 'text-cyan-600 border-b-2 border-cyan-600 bg-cyan-50'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Paperclip className="w-4 h-4" />
              Equipment
            </button>
          </div>

          {/* Panel Content */}
          <div className="flex-1 overflow-hidden">
            {rightPanelMode === 'attachments' ? (
              <AttachmentsPanel className="h-full" />
            ) : (
              <PropertiesPanel />
            )}
          </div>
        </div>
      </div>

      {/* Status Bar */}
      <div className="px-4 py-1 bg-white border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-4">
          <span>{canvasNodes.length} nodes</span>
          <span>{canvasEdges.length} connections</span>
        </div>
        <div className="flex items-center gap-2">
          {isCanvasReady ? (
            <>
              <span className="w-2 h-2 rounded-full bg-green-500" />
              <span>Ready</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
              <span>Initializing...</span>
            </>
          )}
        </div>
      </div>

      {/* Widget Config Modal */}
      {widgetConfigModal.isOpen && (
        <WidgetConfigModal
          nodeId={widgetConfigModal.nodeId}
          data={widgetConfigModal.data}
          onClose={handleWidgetConfigClose}
          onSave={handleWidgetConfigSave}
        />
      )}

      {/* Deploy Automation Modal (Kemik Yapı — Faz D)
          Process'teki equipment node'larından bağlı device'ları otomatik çıkarır
          ve deploy hedefi olarak gösterir.
          Conditional render — modal kapalıyken DOM'a mount etme, gereksiz render önlenir */}
      {isDeployModalOpen && (
        <DeployAutomationModal
          isOpen={isDeployModalOpen}
          onClose={() => setIsDeployModalOpen(false)}
          boundDevices={boundDevices}
        />
      )}

      {/* Edge Deploy Dialog — SCADA process'i edge device'a deploy et */}
      {isEdgeDeployOpen && processId && processId !== 'new' && (
        <DeployToEdgeDialog
          title="Edge Device'a Deploy Et"
          artifactLabel="Proses"
          artifactName={processName}
          accent="cyan"
          isOpen={isEdgeDeployOpen}
          onClose={() => setIsEdgeDeployOpen(false)}
          onDeploy={(deviceId) => edgeDeployMutation.mutateAsync({ processId, deviceId })}
        />
      )}
    </div>
  );
};

export default ProcessEditorPage;
