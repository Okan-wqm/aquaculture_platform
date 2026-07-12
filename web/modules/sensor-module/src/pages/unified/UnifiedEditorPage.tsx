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
import { useParams, Link, useSearchParams } from 'react-router-dom';
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
  Settings,
  Paperclip,
  Play,
  Square,
  X,
} from 'lucide-react';

import type { Edge } from '@xyflow/react';

import { useEditorModeStore, type EditorMode } from '../../store/editorModeStore';
import { useProcessStore, EquipmentNodeData, ProcessEdgeData } from '../../store/processStore';
import { isCanvasMessage } from '../../types/canvas-messages';
import { useScadaPackageStore } from '../../store/scada';
import { useProcess, type ProcessNode } from '../../hooks/useProcess';
import { useEdgeDevices } from '../../hooks/useEdgeDevices';
import { useUnifiedTags } from '../../hooks/useUnifiedTags';
import { useScadaKeyboardShortcuts } from '../../hooks/useScadaKeyboardShortcuts';
import {
  useScadaPackages,
  useCreateScadaPackage,
  useUpdateScadaPackage,
  useDeployScadaBundle,
} from '../../hooks/useScadaPackage';
import { useDeployProcessToEdge } from '../../hooks/useDeployProcess';
import { EquipmentPanel } from '../../components/process-editor/panels/EquipmentPanel';
import { NodeTemplate } from '../../components/process-editor/panels/EquipmentPanel';
import ModeTabBar from '../../components/unified-editor/ModeTabBar';
import { UnifiedPropertiesPanel } from '../../components/unified-editor/UnifiedPropertiesPanel';
import { HmiPropertiesPanel } from '../../components/unified-editor/HmiPropertiesPanel';
import { AttachmentsPanel } from '../../components/process-editor/panels/AttachmentsPanel';
import { UnifiedLeftPanel } from '../../components/scada-builder/UnifiedLeftPanel';
import { ScreenCanvas } from '../../components/scada-builder/ScreenCanvas';
import { StableModeProvider } from '../../components/scada-builder/StableModeProvider';
import { SimulationSidebar } from '../../components/scada-builder/SimulationSidebar';
import { DeployToEdgeDialog } from '../../components/deploy/DeployToEdgeDialog';
import { DeployAutomationModal } from '../../components/deploy/DeployAutomationModal';
import { ScadaPackagePreview } from '../../components/deploy/ScadaPackagePreview';
import { WidgetConfigModal } from '../../components/process-editor/WidgetConfigModal';
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

import {
  CANVAS_SOURCE,
  HOST_SOURCE,
  PROCESS_EDITOR_CANVAS_URL,
} from '../../canvas-contract';
const UnifiedEditorPage: React.FC = () => {
  // The route is `unified-editor/:processId` (Module.tsx) — the param name
  // here MUST match it. Reading a wrong key silently yields undefined and the
  // editor degrades to "new" for every existing process (SENSOR-CRITICAL-001);
  // UnifiedEditorPage.routeParam.test.tsx pins this against the real router.
  const { processId: id } = useParams<{ processId: string }>();
  const [searchParams] = useSearchParams();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Editor mode
  const mode = useEditorModeStore((s) => s.mode);
  const setMode = useEditorModeStore((s) => s.setMode);
  const previousMode = useEditorModeStore((s) => s.previousMode);
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
  // Ready-state ref for the load effect (WF-004): keeping isCanvasReady OUT
  // of that effect's deps is the point — with it, the effect re-ran when the
  // handshake landed and re-hydrated the store mid-session. The 'ready'
  // replay in the message handler covers the ready-after-load ordering.
  const isCanvasReadyRef = useRef(isCanvasReady);
  useEffect(() => { isCanvasReadyRef.current = isCanvasReady; }, [isCanvasReady]);
  // Mode ref for the message handler: the iframe stays mounted (hidden) across
  // modes, so a stray canvas message outside P&ID must not dirty the process.
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Device selector — the deploy target lives in the scada store so it
  // serializes to meta.edgeDeviceId and rehydrates on load (a local useState
  // never reached the store, so the choice was lost on save — UI-006).
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  const targetDeviceId = useScadaPackageStore((s) => s.targetDeviceId);
  const setTargetDeviceId = useScadaPackageStore((s) => s.setTargetDeviceId);
  const { data: deviceConnection } = useEdgeDevices({ limit: 50 });
  const devices = deviceConnection?.items || [];
  const selectedDevice = useMemo(
    () => devices.find((d) => d.id === targetDeviceId) || null,
    [devices, targetDeviceId],
  );

  // Edge devices bound to this process via P&ID equipment nodes — the target
  // set for automation-program deploy (6c parity with ProcessEditorPage).
  const boundDevices = useMemo(() => {
    const byId = new Map<string, { id: string; code: string; name?: string }>();
    for (const n of canvasNodes) {
      const deviceId = n.data?.edgeDeviceId;
      if (typeof deviceId === 'string' && deviceId) {
        const code = n.data?.edgeDeviceCode || deviceId;
        byId.set(deviceId, { id: deviceId, code, name: code });
      }
    }
    return Array.from(byId.values());
  }, [canvasNodes]);

  // Deploy dropdown + canonical deploy dialog target (6b)
  const [showDeployMenu, setShowDeployMenu] = useState(false);
  const [deployTarget, setDeployTarget] = useState<'process' | 'scada' | null>(null);
  // Automation-program deploy modal (6c parity with ProcessEditorPage)
  const [isAutomationDeployOpen, setIsAutomationDeployOpen] = useState(false);
  // Right-panel mode in P&ID: properties vs equipment attachments (6c parity)
  const [rightPanelMode, setRightPanelMode] = useState<'properties' | 'attachments'>('properties');
  // Data-channel widget config modal, opened by the canvas (6c parity)
  const [widgetConfigModal, setWidgetConfigModal] = useState<{
    isOpen: boolean;
    nodeId: string | null;
    data: Record<string, unknown> | null;
  }>({ isOpen: false, nodeId: null, data: null });

  // SCADA package identity for this process (dual-target save + deploy, 6b)
  const [scadaPackageId, setScadaPackageId] = useState<string | null>(null);

  // Save error surfaced to the user (no silent console.error — project no-console)
  const [saveError, setSaveError] = useState<string | null>(null);

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
    loadProcess,
    startNewProcess,
    setIsSaving,
    markClean,
    markDirty,
  } = useProcessStore();

  const { createProcess, updateProcess, getProcess } = useProcess();

  // Canonical package persist + deploy mutations (6b)
  const createPkg = useCreateScadaPackage();
  const updatePkg = useUpdateScadaPackage();
  // GAP-3A: SCADA deploys go through the ATOMIC bundle path — package + bound
  // automation programs as one signed release bundle, PUBLISHED only on the
  // edge's two-phase confirmation (no half-deploy window).
  const deployPkg = useDeployScadaBundle();
  const deployProc = useDeployProcessToEdge();
  // Existing SCADA package for THIS process (filter by processId) — used to
  // hydrate the HMI canvas on load and to pick create-vs-update on save.
  // DISABLED without a real process id: an unfiltered fetch would return the
  // whole tenant list and the hydration below could adopt (and a later save
  // overwrite) an unrelated package (SENSOR-CRITICAL-002).
  const hasRealProcessId = Boolean(id && id !== 'new');
  const { packages: linkedPackages } = useScadaPackages(
    hasRealProcessId ? { processId: id } : undefined,
    { enabled: hasRealProcessId },
  );

  // SCADA package store — serialize / hydrate / identity for dual-target
  // save + deploy (6b). The HMI canvas is now the real <ScreenCanvas>, which
  // mutates the store directly; the unified shell no longer needs the
  // per-widget overlay selectors the retired iframe-overlay path used.
  const scadaToJSON = useScadaPackageStore((s) => s.toScadaPackageJSON);
  const scadaLoadFromJSON = useScadaPackageStore((s) => s.loadFromJSON);
  const scadaSetPackageId = useScadaPackageStore((s) => s.setPackageId);
  const scadaPackageName = useScadaPackageStore((s) => s.packageName);
  const scadaDirty = useScadaPackageStore((s) => s.isDirty);
  const scadaMarkClean = useScadaPackageStore((s) => s.markClean);
  const scadaReset = useScadaPackageStore((s) => s.reset);

  // HMI undo/redo — the real history lives in the scada store; the toolbar
  // buttons route here in HMI mode instead of the (undo-less) P&ID iframe.
  const scadaUndo = useScadaPackageStore((s) => s.undo);
  const scadaRedo = useScadaPackageStore((s) => s.redo);
  const scadaCanUndo = useScadaPackageStore((s) => s.canUndo());
  const scadaCanRedo = useScadaPackageStore((s) => s.canRedo());

  // HMI simulation ("play the process") — flips the store's simulationMode so
  // the SimulationSidebar drives sim tag values and ScreenCanvas renders them
  // live (isPreview) without deploying to a device (FUXA-style in-app run).
  const simulationMode = useScadaPackageStore((s) => s.simulationMode);
  const setSimulationMode = useScadaPackageStore((s) => s.setSimulationMode);

  // Editor identity follows the route param. The scada store is a module
  // singleton shared with the standalone Builder, and this component instance
  // is REUSED when navigating unified-editor/A → unified-editor/B — without a
  // reset, A's package id + screens would leak into B (or into a fresh "new"
  // session) and the next save would write B's content into A's package
  // (SENSOR-HIGH-005). Reset makes cross-identity leakage impossible.
  useEffect(() => {
    setScadaPackageId(null);
    scadaReset();
  }, [id, scadaReset]);

  // Send message to iframe
  const sendToCanvas = useCallback((type: string, data?: unknown) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type, data, source: HOST_SOURCE },
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
      // `nodeId` rides at the top level of the openWidgetConfig message.
      const nodeId = (event.data as { nodeId?: string }).nodeId;
      if (source !== CANVAS_SOURCE) return;

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
        case 'canvasEdited':
          // USER gesture on the P&ID plane (WF-004) — the only echo-free edit
          // signal the iframe emits. Guarded by mode: the iframe stays mounted
          // (hidden) in other modes and their edits belong to other stores.
          if (modeRef.current === 'pid') {
            markDirty();
          }
          break;
        case 'nodeAdded':
        case 'edgeAdded': {
          // Palette drops / new connections are edits too — but scadaWidget
          // overlay drops belong to the SCADA store's own dirty tracking.
          const addedType = (data as { type?: string } | null)?.type;
          if (modeRef.current === 'pid' && addedType !== 'scadaWidget') {
            markDirty();
          }
          break;
        }
        case 'nodeSelected': {
          const node = data as CanvasNode;
          setSelectedNodeId(node?.id || null);
          selectNode(node);
          // Selecting a node is a request to inspect it — bring the
          // properties tab forward (parity with ProcessEditorPage).
          setRightPanelMode('properties');
          break;
        }
        case 'edgeSelected':
          // `data` is unknown at this trust boundary; a single assertion to
          // the store's edge type is the narrowest honest conversion.
          selectEdge(data as Edge<ProcessEdgeData>);
          break;
        case 'selectionCleared':
          setSelectedNodeId(null);
          selectNode(null);
          selectEdge(null);
          break;
        case 'openWidgetConfig':
          setWidgetConfigModal({
            isOpen: true,
            nodeId: typeof nodeId === 'string' ? nodeId : null,
            data: data as Record<string, unknown>,
          });
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [sendToCanvas, selectNode, selectEdge, markDirty]);

  // Load process on mount / param change. Hydration is ONE store transaction
  // (loadProcess) that ends CLEAN — per-field setters marked the freshly
  // loaded process dirty (WF-004). isCanvasReady rides in a ref: with it in
  // the deps this effect re-ran on the handshake and re-hydrated mid-session
  // (the 'ready' replay in the message handler covers ready-after-load).
  // BUG-004: abort guard so a stale getProcess can't clobber a param change.
  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      if (id && id !== 'new') {
        const existingProcess = await getProcess(id);
        if (controller.signal.aborted) return;
        if (existingProcess) {
          loadProcess(existingProcess);
          setCanvasNodes(existingProcess.nodes as CanvasNode[]);
          setCanvasEdges(existingProcess.edges as CanvasEdge[]);
          if (isCanvasReadyRef.current) {
            sendToCanvas('setNodes', existingProcess.nodes);
            sendToCanvas('setEdges', existingProcess.edges);
          }
        } else {
          startNewProcess('New Project');
        }
        return;
      }

      // New process. If a template was requested (ProcessTemplatesPage's
      // "Use This Template" → ?template=<id>), seed the canvas from the
      // template's diagram — the process itself is only created on Save.
      const templateId = searchParams.get('template');
      if (templateId) {
        const template = await getProcess(templateId);
        if (controller.signal.aborted) return;
        if (template) {
          startNewProcess(template.name);
          // Deliberately dirty: the seeded diagram is real unsaved work —
          // the process only comes into existence when the user saves it.
          markDirty();
          setCanvasNodes(template.nodes as CanvasNode[]);
          setCanvasEdges(template.edges as CanvasEdge[]);
          if (isCanvasReadyRef.current) {
            sendToCanvas('setNodes', template.nodes);
            sendToCanvas('setEdges', template.edges);
          }
          return;
        }
      }
      startNewProcess('New Project');
    };
    load();
    return () => controller.abort();
  }, [id, searchParams, loadProcess, startNewProcess, markDirty, getProcess, sendToCanvas]);

  // Hydrate the HMI canvas from the SCADA package linked to this process —
  // once, on first arrival, so it doesn't clobber unsaved edits (6b). The
  // adopted package MUST belong to this process: the query is already scoped
  // by processId, but a package whose linkage disagrees is never adopted —
  // adopting a foreign package would let a later save overwrite it
  // (SENSOR-CRITICAL-002 belt-and-braces).
  useEffect(() => {
    if (scadaPackageId) return;
    if (!hasRealProcessId) return;
    // Never adopt over unsaved HMI work: the linked-package query resolves
    // asynchronously, so if the user already started editing while it was in
    // flight, loadFromJSON would silently wipe those edits and reset isDirty
    // (SENSOR-HIGH-033). scadaDirty is the pristine signal.
    if (scadaDirty) return;
    const pkg = linkedPackages[0];
    if (!pkg) return;
    if (pkg.processId !== id) return;
    setScadaPackageId(pkg.id);
    scadaSetPackageId(pkg.id);
    scadaLoadFromJSON(pkg.packageData);
  }, [linkedPackages, scadaPackageId, hasRealProcessId, id, scadaDirty, scadaSetPackageId, scadaLoadFromJSON]);

  // Sync editor mode to iframe canvas — when mode changes, send setEditorMode
  useEffect(() => {
    if (isCanvasReady) {
      sendToCanvas('setEditorMode', { mode });
    }
  }, [mode, isCanvasReady, sendToCanvas]);

  // Simulation is an HMI-only run state; stop it when leaving HMI so it never
  // leaks into P&ID/PLC/runtime/debug (where the sim sidebar is not mounted).
  useEffect(() => {
    if (mode !== 'hmi' && simulationMode) {
      setSimulationMode(false);
    }
  }, [mode, simulationMode, setSimulationMode]);

  // Equipment drag
  const handleEquipmentDragStart = useCallback(
    (event: React.DragEvent, template: NodeTemplate) => {
      event.dataTransfer.setData('application/equipment', JSON.stringify(template));
      event.dataTransfer.effectAllowed = 'move';
    },
    [],
  );

  // HMI widget drops are handled natively by the real <ScreenCanvas> (6b);
  // the legacy iframe-overlay drop path has been removed.

  // Zoom & delete
  const handleZoomIn = () => sendToCanvas('zoomIn');
  const handleZoomOut = () => sendToCanvas('zoomOut');
  const handleFitView = () => sendToCanvas('fitView');

  const handleDeleteNode = useCallback(() => {
    if (selectedNodeId) {
      sendToCanvas('removeNode', selectedNodeId);
      setSelectedNodeId(null);
      selectNode(null);
      // Host-initiated removal goes through programmatic setNodes in the
      // iframe, which never fires ReactFlow's interaction callbacks — the
      // edit signal must originate here (WF-004).
      markDirty();
    }
  }, [selectedNodeId, sendToCanvas, selectNode, markDirty]);

  // Save
  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      // The P&ID canvas is the authoritative source at save time. On a
      // getState timeout we FAIL the save rather than persisting the possibly
      // stale ref mirror — a non-responding canvas masked as a successful save
      // would silently ship an out-of-date P&ID (SENSOR-HIGH-034).
      const currentState = await new Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>((resolve, reject) => {
        const controller = new AbortController();
        const handler = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          const { type, data, source } = event.data || {};
          if (source === CANVAS_SOURCE && type === 'state') {
            controller.abort();
            resolve(data as { nodes: CanvasNode[]; edges: CanvasEdge[] });
          }
        };
        window.addEventListener('message', handler, { signal: controller.signal });
        sendToCanvas('getState');
        const timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error('Canvas yanıt vermedi — kaydetme iptal edildi, lütfen tekrar deneyin'));
        }, 3000);
        controller.signal.addEventListener('abort', () => clearTimeout(timeoutId));
      });

      // Create-vs-update is driven ONLY by the persisted identity. The route
      // param `id` is NOT included: window.history.replaceState below rewrites
      // the URL without notifying the router, so useParams().processId stays
      // 'new' for the whole session — including it here made every save after
      // the first re-run createProcess and spawn duplicate processes
      // (SENSOR-HIGH-035).
      const isNewProcess = !storeProcessId || storeProcessId === 'new';

      // 1. Persist the P&ID process — FAIL CLOSED: the mutations report
      // rejection via { success: false } without throwing, so an unchecked
      // failure here would silently skip feedback and still run the package
      // leg (SENSOR-HIGH-004). On failure: surface the error, abort the save.
      let resolvedProcessId: string | null = storeProcessId ?? null;
      if (isNewProcess) {
        const result = await createProcess({
          name: processName,
          nodes: currentState.nodes as ProcessNode[],
          edges: currentState.edges,
        });
        if (!result.success || !result.process) {
          setSaveError(result.message || 'Proses kaydedilemedi');
          return;
        }
        resolvedProcessId = result.process.id;
        setProcessId(result.process.id);
        window.history.replaceState(null, '', `/sensor/unified-editor/${result.process.id}`);
      } else {
        const result = await updateProcess({
          processId: storeProcessId,
          name: processName,
          nodes: currentState.nodes as ProcessNode[],
          edges: currentState.edges,
        });
        if (!result.success) {
          setSaveError(result.message || 'Proses güncellenemedi');
          return;
        }
      }

      // 2. Persist the HMI SCADA package (6b — dual-target save). The unified
      // editor owns BOTH artifacts; the package is linked to the process so it
      // reloads with it. Create-vs-update by the tracked packageId.
      if (resolvedProcessId) {
        const packageData = scadaToJSON();
        if (scadaPackageId) {
          await updatePkg.mutateAsync({
            id: scadaPackageId,
            input: { packageData, processId: resolvedProcessId },
          });
        } else {
          const created = await createPkg.mutateAsync({
            name: `${processName} HMI`,
            processId: resolvedProcessId,
            packageData,
          });
          setScadaPackageId(created.id);
          scadaSetPackageId(created.id);
        }
        // Atomic dual-target: only NOW, with BOTH the process and the package
        // persisted, do we mark either store clean. Marking the process clean
        // inside its own leg (before the package leg, which can throw on the
        // 1 MB cap or validation) left the process clean while the package
        // stayed dirty and unsaved (SENSOR-HIGH-036).
        markClean();
        scadaMarkClean();
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Kaydetme başarısız');
    } finally {
      setIsSaving(false);
    }
  };

  // HMI keyboard shortcuts (undo/redo/copy/paste/cut/delete + Ctrl+S). Bound
  // ONLY in HMI mode — the hook mutates the scada store, and Delete/Ctrl+Z in
  // P&ID mode must not reach through to the hidden HMI canvas. isPreview drives
  // the hook's early-return, so it attaches listeners solely in HMI.
  useScadaKeyboardShortcuts({ onSave: handleSave, isPreview: mode !== 'hmi' || simulationMode });

  // Data-channel widget config modal handlers (6c parity). Save pushes the
  // updated widget data back to the canvas node; no console (no-console).
  const handleWidgetConfigClose = useCallback(() => {
    setWidgetConfigModal({ isOpen: false, nodeId: null, data: null });
  }, []);

  const handleWidgetConfigSave = useCallback(
    (updatedData: Record<string, unknown>) => {
      if (widgetConfigModal.nodeId) {
        sendToCanvas('updateNodeData', { nodeId: widgetConfigModal.nodeId, data: updatedData });
      }
      setWidgetConfigModal({ isOpen: false, nodeId: null, data: null });
    },
    [widgetConfigModal.nodeId, sendToCanvas],
  );

  // Canvas URL — canonical SSoT constant (dev+prod identical base; canvas-contract.ts).

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

          {(isDirty || scadaDirty) && (
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
          {mode === 'hmi' && (
            <>
              <button
                onClick={() => setSimulationMode(!simulationMode)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  simulationMode
                    ? 'text-white bg-red-500 hover:bg-red-600'
                    : 'text-white bg-green-600 hover:bg-green-700'
                }`}
                title={simulationMode ? 'Stop simulation' : 'Run the process in simulation (no device deploy)'}
              >
                {simulationMode ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {simulationMode ? 'Stop' : 'Run'}
              </button>
              <div className="h-5 w-px bg-gray-300 mx-1" />
            </>
          )}
          <button
            onClick={() => (mode === 'hmi' ? scadaUndo() : sendToCanvas('undo'))}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Undo"
            disabled={mode === 'hmi' ? simulationMode || !scadaCanUndo : !isCanvasReady || !isCanvasEditable}
          >
            <Undo className="w-4 h-4" />
          </button>
          <button
            onClick={() => (mode === 'hmi' ? scadaRedo() : sendToCanvas('redo'))}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
            title="Redo"
            disabled={mode === 'hmi' ? simulationMode || !scadaCanRedo : !isCanvasReady || !isCanvasEditable}
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
          {saveError && (
            <span
              role="alert"
              className="text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded max-w-[220px] truncate"
              title={saveError}
            >
              {saveError}
            </span>
          )}
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
                <div className="absolute right-0 mt-1 w-52 bg-white rounded-lg shadow-lg border border-gray-200 z-40 py-1">
                  <button
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => { setShowDeployMenu(false); setDeployTarget('process'); }}
                  >
                    Proses (P&amp;ID) → Edge
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => { setShowDeployMenu(false); setDeployTarget('scada'); }}
                  >
                    SCADA Paketi → Edge
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => { setShowDeployMenu(false); setIsAutomationDeployOpen(true); }}
                  >
                    Otomasyon Programı → Edge
                  </button>
                </div>
              </>
            )}
          </div>

          <button
            onClick={handleSave}
            disabled={isSaving || !(isDirty || scadaDirty) || !isCanvasReady}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs text-white rounded-lg transition-colors ${
              isSaving || !(isDirty || scadaDirty) || !isCanvasReady
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
        {/* Left Panel. HMI mounts the full builder left panel (palette + FUXA
            browser + scene tree + layers + search) which owns its own width +
            border; other modes share the fixed 256px wrapper. */}
        {leftPanelVisible && (
          mode === 'hmi' ? (
            <UnifiedLeftPanel />
          ) : (
            <div className="w-64 flex flex-col border-r border-gray-200 bg-white overflow-hidden">
              {mode === 'pid' && (
                <EquipmentPanel onDragStart={handleEquipmentDragStart} />
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
          )
        )}

        {/* Center - Canvas + Bottom Panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Screen Tab Bar */}
          <ScreenManager iframeRef={iframeRef} isCanvasReady={isCanvasReady} />

          {/* Canvas — P&ID/PLC/runtime/debug use the ReactFlow iframe; HMI uses
              the real <ScreenCanvas> on the canonical Layer-B data plane. The
              iframe stays mounted but hidden in HMI so its P&ID state survives
              mode switches; HMI widget drops are handled natively by ScreenCanvas. */}
          <div className="flex-1 bg-gray-50 relative">
            {!isCanvasReady && mode !== 'hmi' && mode !== 'runtime' && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-8 h-8 text-cyan-600 animate-spin" />
                  <p className="text-gray-600 text-sm">Loading Canvas...</p>
                </div>
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={PROCESS_EDITOR_CANVAS_URL}
              className={`w-full h-full border-0 ${mode === 'hmi' || mode === 'runtime' ? 'hidden' : ''}`}
              title="Process Editor Canvas"
              sandbox="allow-scripts allow-same-origin"
            />
            {mode === 'hmi' && (
              <div className="absolute inset-0 flex flex-col">
                {/* StableModeProvider stays mode="edit" (no remount); the
                    store's simulationMode flag toggles the sim data plane, and
                    isPreview locks editing + renders live sim values. */}
                <StableModeProvider mode="edit">
                  <ScreenCanvas isPreview={simulationMode} />
                </StableModeProvider>
              </div>
            )}
            {mode === 'runtime' && (
              <div className="absolute inset-0 flex flex-col">
                {/* Runtime = the live operator view of THIS package: the same
                    ScreenCanvas, read-only, on the live data plane. mode
                    "preview" selects the LiveDeviceDataProvider, so widgets
                    read real values from the tenant-fenced /scada socket —
                    the same Layer-B chain the operator runtime uses
                    (SENSOR-HIGH-047). Previously this mode showed only the
                    frozen P&ID iframe and never a live value. */}
                <StableModeProvider mode="preview">
                  <ScreenCanvas isPreview />
                </StableModeProvider>
              </div>
            )}
          </div>

          {/* Bottom Panel — generic output. The ST editor is a POPUP in PLC
              mode (see the overlay below), not a bottom dock. */}
          {(
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

        {/* Right Panel — P&ID adds a Properties/Equipment toggle (6c parity with
            ProcessEditorPage); other modes show the mode-aware properties panel. */}
        {rightPanelVisible && (
          <div className="w-72 flex flex-col border-l border-gray-200 bg-white overflow-hidden">
            {mode === 'pid' ? (
              <>
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
                    {selectedNodeId && <span className="w-2 h-2 rounded-full bg-cyan-500" />}
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
                <div className="flex-1 overflow-hidden">
                  {rightPanelMode === 'attachments' ? (
                    <AttachmentsPanel className="h-full" />
                  ) : (
                    <UnifiedPropertiesPanel />
                  )}
                </div>
              </>
            ) : mode === 'hmi' ? (
              simulationMode ? <SimulationSidebar /> : <HmiPropertiesPanel />
            ) : (
              <UnifiedPropertiesPanel />
            )}
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

      {/* PLC mode: the ST editor opens as a floating POPUP over the canvas
          instead of docking to the page bottom. Closing it returns to the
          previous editor mode (programs persist server-side, nothing is
          lost on close). */}
      {mode === 'plc' && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-6xl h-[85vh] bg-gray-900 rounded-xl shadow-2xl border border-gray-700 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700 flex-shrink-0">
              <span className="text-sm font-medium text-gray-200">ST Program Editörü (PLC)</span>
              <button
                onClick={() => setMode(previousMode && previousMode !== 'plc' ? previousMode : 'pid')}
                className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                title="Kapat"
                aria-label="ST editörünü kapat"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <StEditorPanel floating onDeploy={() => setIsAutomationDeployOpen(true)} />
          </div>
        </div>
      )}

      {/* Deploy dialogs (6b) — the unified editor owns BOTH artifacts, so one
          canonical DeployToEdgeDialog is bound per artifact, each with its own
          mutation. Gated on deployTarget so the SCADA preview only serializes
          the package when its dialog is actually open. */}
      {deployTarget === 'process' && (
        <DeployToEdgeDialog
          title="Prosesi Edge'e Dağıt"
          artifactLabel="Proses (P&ID)"
          artifactName={processName}
          accent="cyan"
          isOpen
          onClose={() => setDeployTarget(null)}
          onDeploy={async (deviceId) => {
            if (!storeProcessId || storeProcessId === 'new') {
              return { success: false, message: 'Önce prosesi kaydedin.' };
            }
            // Dirty-gate (WF-004): deploy ships the SERVER's saved process, so
            // deploying with unsaved P&ID edits would silently push the stale
            // version — mirror of the SCADA leg's gate (SENSOR-HIGH-044).
            if (isDirty) {
              return {
                success: false,
                message: 'Kaydedilmemiş proses değişiklikleri var — önce kaydedin, sonra dağıtın.',
              };
            }
            return deployProc.mutateAsync({ processId: storeProcessId, deviceId });
          }}
        />
      )}
      {deployTarget === 'scada' && (
        <DeployToEdgeDialog
          title="SCADA Paketini Edge'e Dağıt"
          artifactLabel="SCADA Package"
          artifactName={scadaPackageName || `${processName} HMI`}
          accent="purple"
          preview={<ScadaPackagePreview packageData={scadaToJSON()} />}
          isOpen
          onClose={() => setDeployTarget(null)}
          onDeploy={async (deviceId) => {
            if (!scadaPackageId) {
              return { success: false, message: 'Önce HMI paketini kaydedin.' };
            }
            // Dirty-gate: deploy ships the SERVER's saved package, so deploying
            // with unsaved HMI edits would silently push the stale version
            // (SENSOR-HIGH-044). Refuse until the package is saved.
            if (scadaDirty) {
              return {
                success: false,
                message: 'Kaydedilmemiş HMI değişiklikleri var — önce kaydedin, sonra dağıtın.',
              };
            }
            const result = await deployPkg.mutateAsync({ packageId: scadaPackageId, deviceId });
            if (result.success) {
              return { success: true, message: result.message ?? 'Bundle staged — cihaz onayı bekleniyor.' };
            }
            // Compose an honest failure: name the failing leg(s).
            const failedPrograms = result.automationResults
              .filter((r) => !r.success)
              .map((r) => `program ${r.programId}: ${r.message ?? 'failed'}`);
            const scadaMsg =
              result.scadaResult && !result.scadaResult.success
                ? [`SCADA: ${result.scadaResult.message ?? 'failed'}`]
                : [];
            return {
              success: false,
              message: [result.message, ...scadaMsg, ...failedPrograms].filter(Boolean).join(' | ') || 'Bundle deploy başarısız.',
            };
          }}
        />
      )}

      {/* Automation-program deploy (6c parity) — targets the edge devices bound
          to this process's equipment nodes. */}
      <DeployAutomationModal
        isOpen={isAutomationDeployOpen}
        onClose={() => setIsAutomationDeployOpen(false)}
        boundDevices={boundDevices}
      />

      {/* Data-channel widget config (6c parity) — opened by the P&ID canvas. */}
      {widgetConfigModal.isOpen && (
        <WidgetConfigModal
          nodeId={widgetConfigModal.nodeId}
          data={widgetConfigModal.data}
          onClose={handleWidgetConfigClose}
          onSave={handleWidgetConfigSave}
        />
      )}
    </div>
  );
};

export default UnifiedEditorPage;
