/**
 * UnifiedEditorPage - Unified SCADA Editor shell
 *
 * Extends ProcessEditorPage pattern with 5-mode support:
 * P&ID, HMI, PLC, Runtime, Debug
 *
 * Layout:
 *   Toolbar (top)  - ModeTabBar, project name, device selector, save, deploy, controls
 *   Left panel     - mode-dependent content (equipment palette, widget palette, etc.)
 *   Center         - ReactFlow canvas iframe (same as ProcessEditorPage)
 *   Right panel    - mode-dependent properties
 *   Bottom panel   - collapsible (PLC ST editor placeholder)
 *   Status bar     - mode, node count, connection status
 */

import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Undo,
  Redo,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Monitor,
  Wifi,
  WifiOff,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';

import { useEditorModeStore, type EditorMode } from '../../store/editorModeStore';
import { useProcessStore, EquipmentNodeData } from '../../store/processStore';
import { isCanvasMessage } from '../../types/canvas-messages';
import { useScadaPackageStore } from '../../store/scada';
import { useProcess } from '../../hooks/useProcess';
import { useEdgeDevices } from '../../hooks/useEdgeDevices';
import { useUnifiedTags } from '../../hooks/useUnifiedTags';
import { EquipmentPanel } from '../../components/process-editor/panels/EquipmentPanel';
import { NodeTemplate } from '../../components/process-editor/panels/EquipmentPanel';
import ModeTabBar from '../../components/unified-editor/ModeTabBar';
import { UnifiedPropertiesPanel } from '../../components/unified-editor/UnifiedPropertiesPanel';
import { WidgetPalette } from '../../components/scada-builder/WidgetPalette';
import { parseWidgetDropData, createScadaWidgetNode } from '../../components/unified-editor/WidgetDropHandler';
import ScreenManager from '../../components/unified-editor/ScreenManager';
import StEditorPanel from '../../components/unified-editor/StEditorPanel';

// Canvas message types (same as ProcessEditorPage)
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
  data?: Record<string, unknown>;
}

// ============================================================================
// Live Tags Panel (used in runtime mode left sidebar)
// ============================================================================

const LiveTagsPanel: React.FC = () => {
  const [search, setSearch] = React.useState('');
  const { tags, loading, error, refetch } = useUnifiedTags(
    search ? { searchTerm: search } : undefined,
    { limit: 100 },
  );

  const IO_TYPE_COLOR: Record<string, string> = {
    AI: 'bg-blue-100 text-blue-700',
    AO: 'bg-orange-100 text-orange-700',
    DI: 'bg-green-100 text-green-700',
    DO: 'bg-red-100 text-red-700',
    CALC: 'bg-purple-100 text-purple-700',
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Live Tags</h3>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tag ara..."
          className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-hidden focus:ring-1 focus:ring-cyan-500"
        />
      </div>

      {loading && (
        <div className="flex items-center justify-center p-4">
          <Loader2 className="w-5 h-5 text-cyan-500 animate-spin" />
        </div>
      )}

      {error && (
        <div className="p-3 text-xs text-red-600 bg-red-50 border-b border-red-100">
          <span className="block mb-1">{error}</span>
          <button onClick={refetch} className="text-red-700 underline">Tekrar Dene</button>
        </div>
      )}

      {!loading && !error && tags.length === 0 && (
        <div className="p-3 text-xs text-gray-400 text-center">
          {search ? 'Eslesen tag bulunamadi' : 'Tag bulunamadi'}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {tags.map((tag) => (
          <div
            key={tag.id}
            className="px-3 py-2 border-b border-gray-100 hover:bg-gray-50 cursor-default"
          >
            <div className="flex items-center justify-between gap-1 mb-0.5">
              <span className="text-xs font-medium text-gray-900 truncate flex-1">{tag.displayName || tag.localName}</span>
              {tag.ioType && (
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${IO_TYPE_COLOR[tag.ioType] || 'bg-gray-100 text-gray-600'}`}>
                  {tag.ioType}
                </span>
              )}
            </div>
            <p className="text-[10px] text-gray-400 font-mono truncate">{tag.fqn}</p>
            {tag.engUnit && (
              <p className="text-[10px] text-gray-500">{tag.engUnit}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// Unified Editor Page
// ============================================================================

const UnifiedEditorPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Editor mode
  const mode = useEditorModeStore((s) => s.mode);
  const isCanvasEditable = useEditorModeStore((s) => s.isCanvasEditable);
  const isBottomPanelOpen = useEditorModeStore((s) => s.isBottomPanelOpen);
  const toggleBottomPanel = useEditorModeStore((s) => s.toggleBottomPanel);
  const leftPanelVisible = useEditorModeStore((s) => s.leftPanelVisible);
  const rightPanelVisible = useEditorModeStore((s) => s.rightPanelVisible);
  const toggleLeftPanel = useEditorModeStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = useEditorModeStore((s) => s.toggleRightPanel);

  // Canvas state
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<CanvasEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Refs for stable access inside message handler (avoids stale closure)
  const canvasNodesRef = useRef(canvasNodes);
  const canvasEdgesRef = useRef(canvasEdges);
  useEffect(() => { canvasNodesRef.current = canvasNodes; }, [canvasNodes]);
  useEffect(() => { canvasEdgesRef.current = canvasEdges; }, [canvasEdges]);

  // Device selector
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null);
  const { data: deviceConnection } = useEdgeDevices({ limit: 50 });
  const devices = deviceConnection?.items || [];
  const selectedDevice = useMemo(
    () => devices.find((d) => d.id === targetDeviceId) || null,
    [devices, targetDeviceId],
  );

  // Deploy dropdown
  const [showDeployMenu, setShowDeployMenu] = useState(false);

  // Store
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

  const { createProcess, updateProcess, getProcess } = useProcess();

  // SCADA package store — for overlay widget management
  const scadaSetSelectedWidget = useScadaPackageStore((s) => s.setSelectedWidget);
  const scadaActiveScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const scadaAddWidget = useScadaPackageStore((s) => s.addWidget);
  const scadaRemoveWidget = useScadaPackageStore((s) => s.removeWidget);
  const scadaUpdateWidgetPosition = useScadaPackageStore((s) => s.updateWidgetPosition);
  const scadaUpdateWidget = useScadaPackageStore((s) => s.updateWidget);
  const scadaScreens = useScadaPackageStore((s) => s.screens);

  // Send message to iframe
  const sendToCanvas = useCallback((type: string, data?: unknown) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type, data, source: 'process-editor-host' },
        window.location.origin,
      );
    }
  }, []);

  // Handle messages from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!isCanvasMessage(event.data)) return;
      const { type, data, source } = event.data;
      if (source !== 'process-editor-canvas') return;

      switch (type) {
        case 'ready':
          setIsCanvasReady(true);
          if (canvasNodesRef.current.length > 0) {
            sendToCanvas('setNodes', canvasNodesRef.current);
            sendToCanvas('setEdges', canvasEdgesRef.current);
          }
          break;
        case 'nodesChange':
          setCanvasNodes(data as CanvasNode[]);
          break;
        case 'edgesChange':
          setCanvasEdges(data as CanvasEdge[]);
          break;
        case 'nodeSelected': {
          const node = data as CanvasNode;
          setSelectedNodeId(node?.id || null);
          selectNode(node);
          break;
        }
        case 'edgeSelected':
          selectEdge(data as CanvasEdge as any);
          break;
        case 'selectionCleared':
          setSelectedNodeId(null);
          selectNode(null);
          selectEdge(null);
          scadaSetSelectedWidget(null);
          break;

        // ============================================
        // SCADA Overlay Messages (iframe -> Parent)
        // ============================================
        case 'overlayNodeSelected': {
          const overlayData = data as { nodeId: string; nodeData: Record<string, unknown> };
          if (overlayData?.nodeId) {
            scadaSetSelectedWidget(overlayData.nodeId);
          }
          break;
        }
        case 'overlayNodeMoved': {
          const moveData = data as { nodeId: string; position: { x: number; y: number } };
          if (moveData?.nodeId && scadaActiveScreenId) {
            // Preserve existing widget dimensions from store
            const activeScreen = scadaScreens.find((s) => s.id === scadaActiveScreenId);
            const existingWidget = activeScreen?.widgets.find((w) => w.id === moveData.nodeId);
            scadaUpdateWidgetPosition(scadaActiveScreenId, moveData.nodeId, {
              col: Math.round(moveData.position.x / 15),
              row: Math.round(moveData.position.y / 15),
              w: existingWidget?.position?.w ?? 4,
              h: existingWidget?.position?.h ?? 3,
            });
          }
          break;
        }
        case 'overlayNodeResized': {
          const resizeData = data as { nodeId: string; width: number; height: number };
          if (resizeData?.nodeId && scadaActiveScreenId) {
            // Preserve existing widget position from store
            const activeScreen = scadaScreens.find((s) => s.id === scadaActiveScreenId);
            const existingWidget = activeScreen?.widgets.find((w) => w.id === resizeData.nodeId);
            scadaUpdateWidget(scadaActiveScreenId, resizeData.nodeId, {
              position: {
                col: existingWidget?.position?.col ?? 0,
                row: existingWidget?.position?.row ?? 0,
                w: Math.round(resizeData.width / 15),
                h: Math.round(resizeData.height / 15),
              },
            });
          }
          break;
        }
        case 'overlayNodeDropped': {
          const dropData = data as { widgetType: string; position: { x: number; y: number }; widgetData?: Record<string, unknown> };
          if (dropData?.widgetType && scadaActiveScreenId) {
            const widgetId = `sw-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
            scadaAddWidget(scadaActiveScreenId, {
              id: widgetId,
              widgetType: dropData.widgetType,
              position: {
                col: Math.round(dropData.position.x / 15),
                row: Math.round(dropData.position.y / 15),
                w: 4,
                h: 3,
              },
              config: dropData.widgetData || {},
            });
            sendToCanvas('addOverlayNode', {
              node: {
                id: widgetId,
                type: 'scadaWidget',
                position: dropData.position,
                data: {
                  widgetType: dropData.widgetType,
                  config: dropData.widgetData || {},
                  screenId: scadaActiveScreenId,
                  width: 240,
                  height: 200,
                },
              },
            });
          }
          break;
        }
        case 'overlayNodeDeleted': {
          const deleteData = data as { nodeId: string };
          if (deleteData?.nodeId && scadaActiveScreenId) {
            scadaRemoveWidget(scadaActiveScreenId, deleteData.nodeId);
          }
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [sendToCanvas, selectNode, selectEdge, scadaSetSelectedWidget, scadaActiveScreenId, scadaScreens, scadaAddWidget, scadaRemoveWidget, scadaUpdateWidgetPosition, scadaUpdateWidget]);

  // Load process on mount
  useEffect(() => {
    const loadProcess = async () => {
      if (id && id !== 'new') {
        const existingProcess = await getProcess(id);
        if (existingProcess) {
          setProcessId(existingProcess.id);
          setProcessName(existingProcess.name);
          setCanvasNodes(existingProcess.nodes as CanvasNode[]);
          setCanvasEdges(existingProcess.edges as CanvasEdge[]);
          if (isCanvasReady) {
            sendToCanvas('setNodes', existingProcess.nodes);
            sendToCanvas('setEdges', existingProcess.edges);
          }
        } else {
          resetStore();
          setProcessName('New Project');
        }
      } else {
        resetStore();
        setProcessName('New Project');
      }
    };
    loadProcess();
  }, [id, setProcessId, setProcessName, resetStore, getProcess, isCanvasReady, sendToCanvas]);

  // Sync editor mode to iframe canvas — when mode changes, send setEditorMode
  useEffect(() => {
    if (isCanvasReady) {
      sendToCanvas('setEditorMode', { mode });
    }
  }, [mode, isCanvasReady, sendToCanvas]);

  // Equipment drag
  const handleEquipmentDragStart = useCallback(
    (event: React.DragEvent, template: NodeTemplate) => {
      event.dataTransfer.setData('application/equipment', JSON.stringify(template));
      event.dataTransfer.effectAllowed = 'move';
    },
    [],
  );

  // Widget drop handler (HMI mode)
  const handleWidgetDragOver = useCallback((e: React.DragEvent) => {
    if (mode !== 'hmi') return;
    if (!e.dataTransfer.types.includes('application/reactflow-widget')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [mode]);

  const handleWidgetDrop = useCallback((e: React.DragEvent) => {
    if (mode !== 'hmi') return;
    const payload = parseWidgetDropData(e);
    if (!payload) return;
    e.preventDefault();

    // Calculate position relative to the canvas container
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const node = createScadaWidgetNode(payload, x, y, scadaActiveScreenId ?? undefined);

    // Register in SCADA store
    if (scadaActiveScreenId) {
      scadaAddWidget(scadaActiveScreenId, {
        id: node.id,
        widgetType: payload.widgetType || 'unknown',
        position: {
          col: Math.round(x / 15),
          row: Math.round(y / 15),
          w: 4,
          h: 3,
        },
        config: payload as unknown as Record<string, unknown>,
      });
    }

    // Send to iframe canvas as overlay node
    sendToCanvas('addOverlayNode', { node });
  }, [mode, sendToCanvas, scadaActiveScreenId, scadaAddWidget]);

  // Zoom & delete
  const handleZoomIn = () => sendToCanvas('zoomIn');
  const handleZoomOut = () => sendToCanvas('zoomOut');
  const handleFitView = () => sendToCanvas('fitView');

  const handleDeleteNode = useCallback(() => {
    if (selectedNodeId) {
      sendToCanvas('removeNode', selectedNodeId);
      setSelectedNodeId(null);
      selectNode(null);
    }
  }, [selectedNodeId, sendToCanvas, selectNode]);

  // Save
  const handleSave = async () => {
    setIsSaving(true);
    try {
      const currentState = await new Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>((resolve) => {
        const controller = new AbortController();
        const handler = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          const { type, data, source } = event.data || {};
          if (source === 'process-editor-canvas' && type === 'state') {
            controller.abort();
            resolve(data as { nodes: CanvasNode[]; edges: CanvasEdge[] });
          }
        };
        window.addEventListener('message', handler, { signal: controller.signal });
        sendToCanvas('getState');
        const timeoutId = setTimeout(() => {
          controller.abort();
          resolve({ nodes: canvasNodesRef.current, edges: canvasEdgesRef.current });
        }, 2000);
        controller.signal.addEventListener('abort', () => clearTimeout(timeoutId));
      });

      const isNewProcess = !storeProcessId || storeProcessId === 'new' || id === 'new';

      if (isNewProcess) {
        const result = await createProcess({
          name: processName,
          nodes: currentState.nodes as any,
          edges: currentState.edges,
        });
        if (result.success && result.process) {
          setProcessId(result.process.id);
          markClean();
          window.history.replaceState(null, '', `/sensor/unified-editor/${result.process.id}`);
        }
      } else {
        const result = await updateProcess({
          processId: storeProcessId,
          name: processName,
          nodes: currentState.nodes as any,
          edges: currentState.edges,
        });
        if (result.success) {
          markClean();
        }
      }
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Canvas URL
  const getCanvasUrl = () => {
    const isLocalDev =
      window.location.hostname === 'localhost' && window.location.port === '3006';
    return isLocalDev
      ? '/process-editor-canvas.html'
      : '/remotes/sensor-module/process-editor-canvas.html';
  };

  // Mode labels for status bar
  const MODE_LABELS: Record<EditorMode, string> = {
    pid: 'P&ID Design',
    hmi: 'HMI Layout',
    plc: 'PLC Logic',
    runtime: 'Runtime',
    debug: 'Debug',
  };

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-white border-b border-gray-200 shadow-sm">
        {/* Left Section */}
        <div className="flex items-center gap-3">
          <Link
            to="/sensor/processes"
            className="flex items-center gap-1.5 text-gray-600 hover:text-gray-900 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>

          <div className="h-5 w-px bg-gray-300" />

          <input
            type="text"
            value={processName}
            onChange={(e) => setProcessName(e.target.value)}
            placeholder="Project Name"
            className="text-base font-medium text-gray-900 border-none bg-transparent focus:outline-hidden focus:ring-0 w-48"
          />

          {isDirty && (
            <span className="text-xs text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded">
              Unsaved
            </span>
          )}

          <div className="h-5 w-px bg-gray-300" />

          {/* Mode Tab Bar */}
          <ModeTabBar />

          {/* Device Selector */}
          <div className="h-5 w-px bg-gray-300" />
          <div className="relative">
            <button
              onClick={() => setShowDeviceDropdown(!showDeviceDropdown)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-700 bg-gray-50 border border-gray-300 rounded-lg hover:bg-gray-100"
            >
              <Monitor className="w-3.5 h-3.5 text-gray-500" />
              {selectedDevice ? (
                <span className="flex items-center gap-1">
                  <span className="truncate max-w-[100px]">{selectedDevice.deviceName}</span>
                  {selectedDevice.isOnline ? (
                    <Wifi className="w-3 h-3 text-green-500" />
                  ) : (
                    <WifiOff className="w-3 h-3 text-gray-500" />
                  )}
                </span>
              ) : (
                <span className="text-gray-500">Device</span>
              )}
              <ChevronDown className="w-3 h-3 text-gray-500" />
            </button>

            {showDeviceDropdown && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowDeviceDropdown(false)} />
                <div className="absolute left-0 mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-40 py-1 max-h-60 overflow-y-auto">
                  <button
                    onClick={() => { setTargetDeviceId(null); setShowDeviceDropdown(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
                  >
                    No device
                  </button>
                  {devices.map((device) => (
                    <button
                      key={device.id}
                      onClick={() => { setTargetDeviceId(device.id); setShowDeviceDropdown(false); }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${
                        targetDeviceId === device.id ? 'bg-cyan-50 text-cyan-700' : 'text-gray-700'
                      }`}
                    >
                      <span className="truncate">{device.deviceName}</span>
                      <span className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                        <span className="text-xs text-gray-500">{device.deviceCode}</span>
                        {device.isOnline ? (
                          <span className="w-2 h-2 rounded-full bg-green-500" />
                        ) : (
                          <span className="w-2 h-2 rounded-full bg-gray-300" />
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Center Controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => sendToCanvas('undo')}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Undo"
            disabled={!isCanvasReady || !isCanvasEditable}
          >
            <Undo className="w-4 h-4" />
          </button>
          <button
            onClick={() => sendToCanvas('redo')}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Redo"
            disabled={!isCanvasReady || !isCanvasEditable}
          >
            <Redo className="w-4 h-4" />
          </button>
          <div className="h-5 w-px bg-gray-300 mx-1" />
          <button onClick={handleZoomOut} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50" title="Zoom Out" disabled={!isCanvasReady}>
            <ZoomOut className="w-4 h-4" />
          </button>
          <button onClick={handleZoomIn} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50" title="Zoom In" disabled={!isCanvasReady}>
            <ZoomIn className="w-4 h-4" />
          </button>
          <button onClick={handleFitView} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50" title="Fit View" disabled={!isCanvasReady}>
            <Maximize2 className="w-4 h-4" />
          </button>
          {selectedNodeId && isCanvasEditable && (
            <>
              <div className="h-5 w-px bg-gray-300 mx-1" />
              <button onClick={handleDeleteNode} className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg" title="Delete Selected">
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}

          {/* Panel toggles */}
          <div className="h-5 w-px bg-gray-300 mx-1" />
          <button onClick={toggleLeftPanel} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg" title="Toggle Left Panel">
            {leftPanelVisible ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>
          <button onClick={toggleRightPanel} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg" title="Toggle Right Panel">
            {rightPanelVisible ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
          </button>
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-2">
          {/* Deploy dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowDeployMenu(!showDeployMenu)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              Deploy
              <ChevronDown className="w-3 h-3" />
            </button>
            {showDeployMenu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowDeployMenu(false)} />
                <div className="absolute right-0 mt-1 w-44 bg-white rounded-lg shadow-lg border border-gray-200 z-40 py-1">
                  <button className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" onClick={() => setShowDeployMenu(false)}>
                    Edge Device
                  </button>
                  <button className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" onClick={() => setShowDeployMenu(false)}>
                    Cloud Publish
                  </button>
                </div>
              </>
            )}
          </div>

          <button
            onClick={handleSave}
            disabled={isSaving || !isDirty || !isCanvasReady}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs text-white rounded-lg transition-colors ${
              isSaving || !isDirty || !isCanvasReady
                ? 'bg-cyan-400 cursor-not-allowed'
                : 'bg-cyan-600 hover:bg-cyan-700'
            }`}
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel */}
        {leftPanelVisible && (
          <div className="w-64 flex flex-col border-r border-gray-200 bg-white overflow-hidden">
            {mode === 'pid' && (
              <EquipmentPanel onDragStart={handleEquipmentDragStart} />
            )}
            {mode === 'hmi' && (
              <WidgetPalette />
            )}
            {mode === 'plc' && (
              <div className="p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">PLC Blocks</h3>
                <p className="text-xs text-gray-500">Function blocks - coming soon</p>
              </div>
            )}
            {mode === 'runtime' && (
              <LiveTagsPanel />
            )}
            {mode === 'debug' && (
              <div className="p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Debug</h3>
                <p className="text-xs text-gray-500">Watch variables - coming soon</p>
              </div>
            )}
          </div>
        )}

        {/* Center - Canvas + Bottom Panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Screen Tab Bar */}
          <ScreenManager iframeRef={iframeRef} isCanvasReady={isCanvasReady} />

          {/* Canvas */}
          <div
            className="flex-1 bg-gray-50 relative"
            onDragOver={handleWidgetDragOver}
            onDrop={handleWidgetDrop}
          >
            {!isCanvasReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-8 h-8 text-cyan-600 animate-spin" />
                  <p className="text-gray-600 text-sm">Loading Canvas...</p>
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

          {/* Bottom Panel - ST Editor in PLC mode, generic output otherwise */}
          {mode === 'plc' ? (
            <StEditorPanel />
          ) : (
            <>
              {isBottomPanelOpen && (
                <div className="h-48 border-t border-gray-200 bg-white flex flex-col">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-200">
                    <span className="text-xs font-medium text-gray-600">
                      {mode === 'debug' ? 'Console' : 'Output'}
                    </span>
                    <button onClick={toggleBottomPanel} className="p-0.5 text-gray-500 hover:text-gray-600">
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex-1 p-3 overflow-auto">
                    <p className="text-xs text-gray-500 font-mono">
                      Output will appear here...
                    </p>
                  </div>
                </div>
              )}
              {!isBottomPanelOpen && (
                <button
                  onClick={toggleBottomPanel}
                  className="flex items-center justify-center gap-1 px-2 py-0.5 bg-gray-50 border-t border-gray-200 text-xs text-gray-500 hover:bg-gray-100"
                >
                  <ChevronUp className="w-3 h-3" />
                  Output
                </button>
              )}
            </>
          )}
        </div>

        {/* Right Panel */}
        {rightPanelVisible && (
          <div className="w-72 flex flex-col border-l border-gray-200 bg-white overflow-hidden">
            <UnifiedPropertiesPanel />
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-4 py-1 bg-white border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-4">
          <span className="font-medium text-cyan-700">{MODE_LABELS[mode]}</span>
          <span>{canvasNodes.length} nodes</span>
          <span>{canvasEdges.length} connections</span>
          {!isCanvasEditable && (
            <span className="text-yellow-600">Read-only</span>
          )}
          {selectedDevice && (
            <span className="flex items-center gap-1">
              <Monitor className="w-3 h-3" />
              {selectedDevice.deviceName}
            </span>
          )}
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
    </div>
  );
};

export default UnifiedEditorPage;
