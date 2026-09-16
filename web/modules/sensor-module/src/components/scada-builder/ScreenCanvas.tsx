/**
 * ScreenCanvas - ReactFlow-based canvas for SCADA Package Builder
 *
 * Replaces the old CSS Grid canvas with a full ReactFlow canvas supporting:
 * - Drag-and-drop from WidgetPalette (application/reactflow-widget MIME)
 * - Grid snapping (GRID_CELL_W x GRID_CELL_H)
 * - Zoom / pan / minimap
 * - Real widget renderers (not emoji placeholders)
 * - Two-way sync: Store ↔ ReactFlow nodes
 * - Grid ↔ Pixel conversion for edge compatibility
 * - P&ID edge connections between equipment widgets
 */

import React, { useCallback, useRef, useMemo, useEffect, useState } from 'react';
import { ScadaRuntime } from '../../engine/ScadaRuntime';
import { OverlayStack } from '../../engine/views/OverlayStack';
import { ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
  ConnectionLineType,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useShallow } from 'zustand/react/shallow';

import { useScadaPackageStore } from '../../store/scada';
import type { ConnectionPointKey } from '../../types/scada-widget.types';
import { useRealtimeData } from '../../hooks/useRealtimeData';
import { getWidgetTagBinding } from '../../engine/tags';
import type { ScreenWidget } from '../../types/scada-package.types';
import type { ScadaWidgetNodeData, ScadaWidgetType } from '../../types/scada-widget.types';
import type { ScadaEdge, ScadaEdgeType } from '../../types/scada-edge.types';
import ScadaWidgetNode from './nodes/ScadaWidgetNode';
import { processNodeChanges, type NodeChangeLike } from './nodes/dragCommitUtils';
import { edgeTypes } from './edges';
import { EdgeStoreContextProvider } from './EdgeStoreContext';
import { EdgeToolbar } from './EdgeToolbar';
import { CanvasContextMenu } from './CanvasContextMenu';
import { CanvasSettings } from './CanvasSettings';
import { CanvasRuler } from './CanvasRuler';
import { AlignmentToolbar } from './AlignmentToolbar';
import { SmartGuides } from './SmartGuides';
import { PidFaceplate } from './PidFaceplate';
import { getEdgeStyle } from '../../config/connectionTypes';
import type { ConnectionType } from '../../config/connectionTypes';
import { CONNECTION_POINTS } from './equipment-symbols/types';
import {
  GRID_CELL_W,
  GRID_CELL_H,
  SNAP_GRID,
  gridToPixel,
  pixelToGrid,
  getWidgetSize,
} from '../../constants/scada-widget-sizes';

/* ------------------------------------------------------------------ */
/*  Background image node — rendered INSIDE the ReactFlow viewport     */
/*  layer so it pans/zooms with the canvas and sits behind all         */
/*  widgets. Exporting `.react-flow__viewport` therefore includes it.  */
/* ------------------------------------------------------------------ */

const BackgroundImageNode: React.FC<NodeProps<Node<ScadaWidgetNodeData>>> = ({ data }) => {
  const url = data.config?.backgroundImage as string | undefined;
  const opacity = (data.config?.backgroundOpacity as number | undefined) ?? 0.3;
  if (!url) return null;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundImage: `url(${url})`,
        backgroundSize: 'contain',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center',
        opacity,
        pointerEvents: 'none',
      }}
    />
  );
};

/* ------------------------------------------------------------------ */
/*  Node type registry                                                 */
/* ------------------------------------------------------------------ */

const nodeTypes = { scadaWidget: ScadaWidgetNode, scadaBackground: BackgroundImageNode };

const EMPTY_WIDGETS: ScreenWidget[] = [];
const EMPTY_EDGES: ScadaEdge[] = [];
/** Stable empty tag-id list so edit mode subscribes to nothing without a new array each render. */
const EMPTY_TAG_IDS: string[] = [];

/* ------------------------------------------------------------------ */
/*  Helper: generate unique ID                                         */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/*  Animated flow CSS                                                   */
/* ------------------------------------------------------------------ */

/**
 * Animated flow CSS for pipe edges.
 *
 * The .animated-flow class applies a CSS stroke-dashoffset animation that
 * creates the illusion of flowing liquid in a pipe. This is the static
 * fallback used when edges have `animated: true` but no flowConfig.
 *
 * Tag-driven flow uses the same animation but with a dynamic
 * --edge-flow-speed CSS variable (set per-edge by ScreenCanvas) and an
 * optional .flow-reverse modifier that reverses the offset direction.
 */
const ANIMATED_EDGE_CSS = `
  .react-flow__edge.animated-flow .react-flow__edge-path {
    stroke-dasharray: 8 4 !important;
    animation: edge-flow var(--edge-flow-speed, 0.6s) linear infinite;
  }
  .react-flow__edge.animated-flow.flow-reverse .react-flow__edge-path {
    animation-direction: reverse;
  }
  @keyframes edge-flow {
    from { stroke-dashoffset: 0; }
    to { stroke-dashoffset: -12; }
  }
`;

/* ------------------------------------------------------------------ */
/*  Inner canvas (needs ReactFlowProvider ancestor)                    */
/* ------------------------------------------------------------------ */

interface CanvasInnerProps {
  isPreview?: boolean;
}

const CanvasInner: React.FC<CanvasInnerProps> = ({ isPreview = false }) => {
  const rfInstance = useReactFlow();

  // Track whether we're currently syncing FROM store to prevent loops
  const syncingFromStore = useRef(false);

  // Track whether a node drag is currently in progress
  const isDragging = useRef(false);

  // Default edge creation settings
  const [defaultEdgeType, setDefaultEdgeType] = useState<ScadaEdgeType>('orthogonal');
  const [defaultConnectionType, setDefaultConnectionType] = useState<ConnectionType>('process-pipe');

  // Canvas settings
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [currentZoom, setCurrentZoom] = useState(1);

  // Viewport position for CanvasRuler
  const [viewportX, setViewportX] = useState(0);
  const [viewportY, setViewportY] = useState(0);

  // Container dimensions for CanvasRuler
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    target: 'widget' | 'edge' | 'canvas';
  } | null>(null);

  const [faceplateWidget, setFaceplateWidget] = useState<{
    id: string;
    widgetType: string;
    config: Record<string, unknown>;
    position: { col: number; row: number; w: number; h: number };
  } | null>(null);

  // Smart guide drag tracking state
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragSize, setDragSize] = useState<{ w: number; h: number } | null>(null);

  const {
    activeScreenId,
    screens,
    selectedWidgetId,
    selectedWidgetIds,
    selectedEdgeId,
    setSelectedWidget,
    setSelectedEdge,
    toggleWidgetSelection,
    addWidget,
    removeWidget,
    removeWidgets,
    updateWidgetPosition,
    moveWidgets,
    addEdge: storeAddEdge,
    removeEdge: storeRemoveEdge,
    updateEdgeData: storeUpdateEdgeData,
    updateEdgeType: storeUpdateEdgeType,
    saveScreenViewport,
    getScreenViewport,
    updateScreen,
  } = useScadaPackageStore(useShallow((s) => ({
    activeScreenId: s.activeScreenId,
    screens: s.screens,
    selectedWidgetId: s.selectedWidgetId,
    selectedWidgetIds: s.selectedWidgetIds,
    selectedEdgeId: s.selectedEdgeId,
    setSelectedWidget: s.setSelectedWidget,
    setSelectedEdge: s.setSelectedEdge,
    toggleWidgetSelection: s.toggleWidgetSelection,
    addWidget: s.addWidget,
    removeWidget: s.removeWidget,
    removeWidgets: s.removeWidgets,
    updateWidgetPosition: s.updateWidgetPosition,
    moveWidgets: s.moveWidgets,
    addEdge: s.addEdge,
    removeEdge: s.removeEdge,
    updateEdgeData: s.updateEdgeData,
    updateEdgeType: s.updateEdgeType,
    saveScreenViewport: s.saveScreenViewport,
    getScreenViewport: s.getScreenViewport,
    updateScreen: s.updateScreen,
  })));

  const activeScreen = screens.find((s) => s.id === activeScreenId);
  const widgets = activeScreen?.widgets ?? EMPTY_WIDGETS;
  const storeEdges = activeScreen?.edges ?? EMPTY_EDGES;

  // Live data — canonical Layer-B path (single data plane): the same
  // IDataProvider / useRealtimeData chain the operator runtime uses, keyed
  // by the device-local tag id `getWidgetTagBinding` yields. StableModeProvider
  // mounts the matching DataProviderRoot (simulation in edit/simulation modes,
  // live in preview). Only subscribe while previewing/simulating so edit mode
  // opens no socket.
  const liveTagIds = useMemo(
    () =>
      isPreview
        ? widgets
            .map((w) => getWidgetTagBinding(w.config))
            .filter((t): t is string => typeof t === 'string' && t.length > 0)
        : EMPTY_TAG_IDS,
    [isPreview, widgets],
  );
  const { values: liveValues } = useRealtimeData(liveTagIds);

  // Keep a ref of last active screen to detect transitions
  const prevScreenIdRef = useRef(activeScreenId);

  // EdgeStoreContext value: bridges edge components → scadaPackageStore
  // Uses getState() to avoid stale activeScreenId closure
  const edgeStoreValue = useMemo(() => ({
    updateEdgeData: (edgeId: string, data: Record<string, unknown>) => {
      const currentScreenId = useScadaPackageStore.getState().activeScreenId;
      if (currentScreenId) {
        storeUpdateEdgeData(currentScreenId, edgeId, data);
      }
    },
  }), [storeUpdateEdgeData]);

  // onResize commit callback for ScadaWidgetNode
  const handleWidgetResize = useCallback(
    (widgetId: string, width: number, height: number, originDelta?: { x: number; y: number }) => {
      const state = useScadaPackageStore.getState();
      const currentScreenId = state.activeScreenId;
      if (!currentScreenId) return;
      const widget = state.screens
        .find((s) => s.id === currentScreenId)
        ?.widgets.find((w) => w.id === widgetId);
      if (!widget) return;

      // North/west drags shift the origin (SE corner anchored); east/south
      // drags keep it. The origin delta arrives in flow pixels from the node.
      const originX = widget.position.col * GRID_CELL_W + (originDelta?.x ?? 0);
      const originY = widget.position.row * GRID_CELL_H + (originDelta?.y ?? 0);
      const newPos = pixelToGrid(originX, originY, width, height);
      state.updateWidgetPosition(currentScreenId, widgetId, newPos);
    },
    [],
  );

  // Convert store widgets → ReactFlow nodes (source of truth)
  // NOTE: selectedWidgetId is intentionally excluded from deps to prevent
  // selection changes from recomputing nodes (which would overwrite local
  // drag positions). Selection is handled by ReactFlow internally via
  // applyNodeChanges in onNodesChange.
  const storeNodes: Node<ScadaWidgetNodeData>[] = useMemo(() => {
    // Filter out hidden widgets (visible === false) so they don't appear on the canvas.
    // Widgets with visible === undefined or true are shown.
    return widgets.filter((w) => w.visible !== false).map((w) => {
      const px = gridToPixel(w.position);
      // Resolve live tag value in preview/simulation mode — single binding
      // accessor (config.tagRef → legacy keys) shared with the operator
      // runtime, indexed into the Layer-B values map by the same key.
      const tagName = getWidgetTagBinding(w.config);
      let liveValue: number | string | boolean | undefined;
      if (isPreview && tagName) {
        const rawValue = liveValues[tagName]?.value;
        liveValue =
          typeof rawValue === 'string' ||
          typeof rawValue === 'number' ||
          typeof rawValue === 'boolean'
            ? rawValue
            : undefined;
      }
      return {
        id: w.id,
        type: 'scadaWidget',
        position: { x: px.x, y: px.y },
        data: {
          widgetType: w.widgetType as ScadaWidgetType,
          config: w.config,
          screenId: activeScreenId,
          width: px.width,
          height: px.height,
          label: (w.config?.label as string) || w.widgetType,
          tagName,
          liveValue,
          onResize: (_wt: string, newW: number, newH: number) => {
            handleWidgetResize(w.id, newW, newH);
          },
          // Full commit channel: size + NW origin shift for N/W-edge drags.
          // Extra data field (ScadaWidgetNodeData extends Record<string, unknown>).
          onResizeCommit: (newW: number, newH: number, originDelta: { x: number; y: number }) => {
            handleWidgetResize(w.id, newW, newH, originDelta);
          },
          isPreview,
          groupId: w.groupId,
          zIndex: w.zIndex,
        },
        draggable: !w.locked,
        dragHandle: undefined,
      };
    });
     
  }, [widgets, activeScreenId, handleWidgetResize, isPreview, liveValues]);

  /**
   * Convert store edges to ReactFlow edges.
   *
   * Animation strategy:
   * - Edges with flowConfig: the edge component internally calls
   *   useEdgeFlowState() which subscribes to the TagValueBus and
   *   determines whether to animate. The CSS class is NOT set here;
   *   the component applies inline animation styles.
   * - Edges with animated:true but NO flowConfig (backward compat):
   *   the old CSS class approach is used so existing edges keep working.
   * - flowConfig is passed through in edge data for the component to read.
   */
  const rfEdges: Edge[] = useMemo(() => {
    return storeEdges.map((e) => {
      const style = getEdgeStyle(e.data.connectionType);
      const hasFlowConfig = !!e.data.flowConfig?.tagName;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: e.type,
        selected: e.id === selectedEdgeId,
        animated: false, // We use our own animation, not ReactFlow's built-in
        data: {
          ...e.data,
          connectionType: e.data.connectionType,
          flowConfig: e.data.flowConfig,
        },
        style,
        // Only apply the static CSS class for legacy edges (animated:true, no flowConfig).
        // Tag-driven edges handle animation internally via useEdgeFlowState.
        className: (!hasFlowConfig && e.data.animated) ? 'animated-flow' : undefined,
      };
    });
  }, [storeEdges, selectedEdgeId]);

  // Local nodes state for smooth dragging (synced from store)
  const [nodes, setNodes] = useState<Node<ScadaWidgetNodeData>[]>(storeNodes);

  /**
   * Background image as a REAL node inside the transformed viewport layer:
   * pans/zooms with the canvas, sits behind every widget (zIndex -1), and
   * is included in `.react-flow__viewport` captures (ExportDialog).
   */
  const backgroundNode = useMemo<Node<ScadaWidgetNodeData> | null>(() => {
    if (!activeScreen?.backgroundImage) return null;
    const w = (activeScreen.layout?.cols ?? 12) * GRID_CELL_W;
    const h = (activeScreen.layout?.rows ?? 8) * GRID_CELL_H;
    return {
      id: `__background__${activeScreen.id}`,
      type: 'scadaBackground',
      position: { x: 0, y: 0 },
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: -1,
      data: {
        widgetType: 'rasterImage',
        config: {
          backgroundImage: activeScreen.backgroundImage,
          backgroundOpacity: activeScreen.backgroundOpacity ?? 0.3,
        },
        screenId: activeScreen.id,
        width: w,
        height: h,
        label: '',
        isPreview,
      },
    };
  }, [activeScreen, isPreview]);

  const rfNodes = useMemo(
    () => (backgroundNode ? [backgroundNode, ...nodes] : nodes),
    [backgroundNode, nodes],
  );

  // Sync store → local nodes when store changes (not during drag)
  // Smart merge: update data/config for existing nodes but preserve local positions,
  // add new nodes from store, remove deleted nodes.
  useEffect(() => {
    if (syncingFromStore.current) {
      syncingFromStore.current = false;
      return; // Skip this sync cycle — we just pushed to store
    }
    if (isDragging.current) return;

    setNodes((prevNodes) => {
      const prevMap = new Map(prevNodes.map((n) => [n.id, n]));
      const storeIds = new Set(storeNodes.map((n) => n.id));

      return storeNodes.map((sn) => {
        const existing = prevMap.get(sn.id);
        if (existing) {
          // Existing node: keep local position, update data and draggable (lock toggle)
          return { ...existing, data: sn.data, draggable: sn.draggable };
        }
        // New node from store (just dropped from palette): use store position
        return sn;
      });
      // Nodes not in storeIds are implicitly removed (not included in storeNodes.map)
    });
  }, [storeNodes]);

  // Handle screen transitions: save/restore viewport
  useEffect(() => {
    if (prevScreenIdRef.current !== activeScreenId) {
      // Save old viewport
      if (prevScreenIdRef.current && rfInstance) {
        const vp = rfInstance.getViewport();
        saveScreenViewport(prevScreenIdRef.current, { x: vp.x, y: vp.y, zoom: vp.zoom });
      }
      // Restore new viewport
      if (activeScreenId && rfInstance) {
        const saved = getScreenViewport(activeScreenId);
        rfInstance.setViewport(saved, { duration: 200 });
      }
      prevScreenIdRef.current = activeScreenId;
    }
  }, [activeScreenId, rfInstance, saveScreenViewport, getScreenViewport]);

  // Handle node changes (position drag, selection).
  // The pure pipeline (locked filter, group propagation, drag-end commit
  // computation) lives in dragCommitUtils — see its unit tests.
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<ScadaWidgetNodeData>>[]) => {
      const state = useScadaPackageStore.getState();
      const currentScreenId = state.activeScreenId;
      const currentWidgets = currentScreenId
        ? state.screens.find((s) => s.id === currentScreenId)?.widgets ?? []
        : [];

      const result = processNodeChanges({
        changes: changes as unknown as NodeChangeLike[],
        widgets: currentWidgets,
        localNodes: nodes,
      });

      // Batch all changes (original + group propagation) into a single setNodes call
      const allChanges = (result.groupDragChanges.length > 0
        ? [...result.filteredChanges, ...result.groupDragChanges]
        : result.filteredChanges) as NodeChange<Node<ScadaWidgetNodeData>>[];

      setNodes((nds) => applyNodeChanges<Node<ScadaWidgetNodeData>>(allChanges, nds));

      if (result.dragStarted) {
        // Drag in progress -- mark so store-to-local sync is suppressed
        isDragging.current = true;
      }

      if (result.guide) {
        setDraggingNodeId(result.guide.nodeId);
        setDragPosition({ x: result.guide.position.x, y: result.guide.position.y });
        setDragSize({ w: result.guide.size.w, h: result.guide.size.h });
      }

      if (result.dragEnded) {
        isDragging.current = false;
        setDraggingNodeId(null);
        setDragPosition(null);
        setDragSize(null);

        // Commit ALL moved widgets (dragged node + group siblings) in ONE
        // batch action → a 5-widget group drag is a single undo step.
        if (currentScreenId && result.commitUpdates.length > 0) {
          syncingFromStore.current = true;
          state.moveWidgets(currentScreenId, result.commitUpdates);
        }
      }

      for (const id of result.selectedIds) {
        setSelectedWidget(id);
        setSelectedEdge(null);
      }
    },
    [setSelectedWidget, setSelectedEdge, nodes],
  );

  // Handle edge changes (deletion, selection)
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove' && activeScreenId) {
          storeRemoveEdge(activeScreenId, change.id);
        }
        if (change.type === 'select' && change.selected) {
          setSelectedEdge(change.id);
        }
      }
    },
    [activeScreenId, storeRemoveEdge, setSelectedEdge],
  );

  // Handle new connection (edge creation)
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!activeScreenId) return;
      if (!connection.source || !connection.target) return;
      // Prevent self-connections
      if (connection.source === connection.target) return;

      const newEdge: ScadaEdge = {
        id: generateId(),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle || 'outlet',
        targetHandle: connection.targetHandle || 'inlet',
        type: defaultEdgeType,
        data: {
          connectionType: defaultConnectionType,
        },
      };

      storeAddEdge(activeScreenId, newEdge);
    },
    [activeScreenId, defaultEdgeType, defaultConnectionType, storeAddEdge],
  );

  // Connection validation
  const isValidConnection = useCallback(
    // xyflow v12: isValidConnection prop is IsValidConnection<Edge> = (edge: Edge | Connection) => boolean
    (connection: Edge | Connection) => {
      // No self-connections
      if (connection.source === connection.target) return false;

      // Prevent duplicate edges between same source handle → target handle
      const currentEdges = useScadaPackageStore.getState().screens
        .find((s) => s.id === useScadaPackageStore.getState().activeScreenId)?.edges ?? [];
      const duplicate = currentEdges.some(
        (e) =>
          e.source === connection.source &&
          e.target === connection.target &&
          e.sourceHandle === connection.sourceHandle &&
          e.targetHandle === connection.targetHandle,
      );
      if (duplicate) return false;

      // Validate handle direction using CONNECTION_POINTS registry
      const sourceNode = useScadaPackageStore.getState().screens
        .find((s) => s.id === useScadaPackageStore.getState().activeScreenId)
        ?.widgets.find((w) => w.id === connection.source);
      const targetNode = useScadaPackageStore.getState().screens
        .find((s) => s.id === useScadaPackageStore.getState().activeScreenId)
        ?.widgets.find((w) => w.id === connection.target);

      if (sourceNode && targetNode) {
        const srcKey = sourceNode.widgetType === 'equipment'
          ? (sourceNode.config?.equipmentSubType as string) || ''
          : sourceNode.widgetType;
        const tgtKey = targetNode.widgetType === 'equipment'
          ? (targetNode.config?.equipmentSubType as string) || ''
          : targetNode.widgetType;

        const srcPoints =
          srcKey in CONNECTION_POINTS
            ? CONNECTION_POINTS[srcKey as ConnectionPointKey]
            : [];
        const tgtPoints =
          tgtKey in CONNECTION_POINTS
            ? CONNECTION_POINTS[tgtKey as ConnectionPointKey]
            : [];

        // Find the source handle's direction
        const srcHandleId = connection.sourceHandle || '';
        const srcPoint = srcPoints.find((p) => p.id === srcHandleId || `${p.id}-out` === srcHandleId);

        // Find the target handle's direction
        const tgtHandleId = connection.targetHandle || '';
        const tgtPoint = tgtPoints.find((p) => p.id === tgtHandleId || `${p.id}-in` === tgtHandleId);

        // Block if source handle direction is 'in' only (not 'out' or 'inout')
        if (srcPoint && srcPoint.direction === 'in') return false;
        // Block if target handle direction is 'out' only (not 'in' or 'inout')
        if (tgtPoint && tgtPoint.direction === 'out') return false;
      }

      return true;
    },
    [],
  );

  // Edge click → select
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      setSelectedEdge(edge.id);
      setSelectedWidget(null);
    },
    [setSelectedEdge, setSelectedWidget],
  );

  // Click on empty canvas → deselect
  const onPaneClick = useCallback(() => {
    setSelectedWidget(null);
    setSelectedEdge(null);
    setContextMenu(null);
  }, [setSelectedWidget, setSelectedEdge]);

  // Measure canvas container dimensions with ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    ro.observe(el);
    // Set initial size
    setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Track viewport during pan/zoom for CanvasRuler (fires continuously)
  const onMove = useCallback((_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
    setViewportX(viewport.x);
    setViewportY(viewport.y);
    setCurrentZoom(viewport.zoom);
  }, []);

  // Track zoom level for CanvasSettings (fires at end of move)
  const onMoveEnd = useCallback((_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
    setViewportX(viewport.x);
    setViewportY(viewport.y);
    setCurrentZoom(viewport.zoom);
  }, []);

  /**
   * Reactive viewport getter for SmartGuides. Reads a ref mirroring the
   * tracked viewport states (updated on every onMove), so consumers always
   * observe the CURRENT transform without per-widget store subscriptions.
   */
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  viewportRef.current = { x: viewportX, y: viewportY, zoom: currentZoom };
  const getViewport = useCallback(
    (): { x: number; y: number; zoom: number } => viewportRef.current,
    [],
  );

  // Zoom-to-selection: AlignmentToolbar dispatches 'scada-zoom-to-bounds'
  // with flow-space bounds; fitView centres that rect.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        minX: number; minY: number; maxX: number; maxY: number; padding?: number;
      } | undefined;
      if (!detail || !rfInstance) return;
      rfInstance.fitBounds(
        {
          x: detail.minX,
          y: detail.minY,
          width: detail.maxX - detail.minX,
          height: detail.maxY - detail.minY,
        },
        { padding: (detail.padding ?? 50) / 100, duration: 250 },
      );
    };
    window.addEventListener('scada-zoom-to-bounds', handler as EventListener);
    return () => window.removeEventListener('scada-zoom-to-bounds', handler as EventListener);
  }, [rfInstance]);

  // Handle node click for selection (shift+click for multi-select)
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (_event.shiftKey) {
        toggleWidgetSelection(node.id);
      } else {
        // Check if widget is part of a group
        const state = useScadaPackageStore.getState();
        const screen = state.screens.find((s) => s.id === state.activeScreenId);
        const widget = screen?.widgets.find((w) => w.id === node.id);
        if (widget?.groupId && 'selectGroup' in state) {
          (state as any).selectGroup(state.activeScreenId, widget.groupId);
        } else {
          setSelectedWidget(node.id);
        }
        setSelectedEdge(null);
      }
    },
    [setSelectedWidget, setSelectedEdge, toggleWidgetSelection],
  );

  // Right-click context menu
  const onPaneContextMenu = useCallback((e: MouseEvent | React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      target: 'canvas',
    });
  }, []);

  const onNodeContextMenu = useCallback((_e: React.MouseEvent, node: Node) => {
    _e.preventDefault();
    // Preserve multi-selection: only reset if right-clicked widget is NOT in current selection
    const currentIds = useScadaPackageStore.getState().selectedWidgetIds;
    if (!currentIds.includes(node.id)) {
      setSelectedWidget(node.id);
    }
    setSelectedEdge(null);
    setContextMenu({
      position: { x: _e.clientX, y: _e.clientY },
      target: 'widget',
    });
  }, [setSelectedWidget, setSelectedEdge]);

  const onEdgeContextMenu = useCallback((_e: React.MouseEvent, edge: Edge) => {
    _e.preventDefault();
    setSelectedEdge(edge.id);
    setSelectedWidget(null);
    setContextMenu({
      position: { x: _e.clientX, y: _e.clientY },
      target: 'edge',
    });
  }, [setSelectedEdge, setSelectedWidget]);

  const onNodeDoubleClick = useCallback((_e: React.MouseEvent, node: Node<ScadaWidgetNodeData>) => {
    const state = useScadaPackageStore.getState();
    const screen = state.screens.find((s) => s.id === state.activeScreenId);
    if (!screen) return;
    const widget = screen.widgets.find((w) => w.id === node.id);
    if (!widget) return;
    setFaceplateWidget({
      id: widget.id,
      widgetType: widget.widgetType,
      config: widget.config,
      position: widget.position,
    });
  }, []);

  // Delete key handler (ReactFlow callback)
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      if (!activeScreenId) return;
      // Batch removal → single undo entry for the whole gesture
      removeWidgets(activeScreenId, deletedNodes.map((n) => n.id));
    },
    [activeScreenId, removeWidgets],
  );

  // NOTE: Delete/Backspace is handled by useScadaKeyboardShortcuts hook (supports multi-select).
  // ReactFlow's deleteKeyCode is set to null to prevent triple-fire.

  // Edge toolbar handlers
  const handleEdgeTypeChange = useCallback(
    (type: ScadaEdgeType) => {
      setDefaultEdgeType(type);
      // If an edge is selected, atomically change its type (clears stale geometry)
      if (selectedEdgeId && activeScreenId) {
        storeUpdateEdgeType(activeScreenId, selectedEdgeId, type);
      }
    },
    [selectedEdgeId, activeScreenId, storeUpdateEdgeType],
  );

  const handleConnectionTypeChange = useCallback(
    (type: ConnectionType) => {
      setDefaultConnectionType(type);
      // If an edge is selected, update its connection type
      if (selectedEdgeId && activeScreenId) {
        storeUpdateEdgeData(activeScreenId, selectedEdgeId, { connectionType: type });
      }
    },
    [selectedEdgeId, activeScreenId, storeUpdateEdgeData],
  );

  // Drop handler for new widgets from WidgetPalette
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!activeScreenId) return;

      const data = e.dataTransfer.getData('application/reactflow-widget');
      if (!data) return;

      let parsed: { widgetType: string; label: string; defaultWidth: number; defaultHeight: number; defaultConfig?: Record<string, unknown> };
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof parsed.widgetType !== 'string') return;

      // Convert screen coordinates to flow coordinates
      const position = rfInstance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      // Snap to grid
      const snappedX = Math.round(position.x / GRID_CELL_W) * GRID_CELL_W;
      const snappedY = Math.round(position.y / GRID_CELL_H) * GRID_CELL_H;

      // Get default size from constants
      const sizeDef = getWidgetSize(parsed.widgetType, parsed.defaultConfig?.equipmentSubType as string | undefined);

      const gridPos = pixelToGrid(
        snappedX,
        snappedY,
        sizeDef.defaultW * GRID_CELL_W,
        sizeDef.defaultH * GRID_CELL_H,
      );

      const newWidget: ScreenWidget = {
        id: generateId(),
        widgetType: parsed.widgetType,
        position: gridPos,
        config: parsed.defaultConfig || {},
      };

      // Reset sync flags so the store→local useEffect will render the new widget
      syncingFromStore.current = false;
      isDragging.current = false;

      addWidget(activeScreenId, newWidget);
      setSelectedWidget(newWidget.id);
    },
    [activeScreenId, rfInstance, addWidget, setSelectedWidget],
  );

  // B2: Toolbar reflects selected edge's actual values
  const toolbarEdgeType = useMemo(() => {
    if (selectedEdgeId) {
      const edge = storeEdges.find(e => e.id === selectedEdgeId);
      return (edge?.type as ScadaEdgeType) ?? defaultEdgeType;
    }
    return defaultEdgeType;
  }, [selectedEdgeId, storeEdges, defaultEdgeType]);

  const toolbarConnectionType = useMemo(() => {
    if (selectedEdgeId) {
      const edge = storeEdges.find(e => e.id === selectedEdgeId);
      return (edge?.data.connectionType as ConnectionType) ?? defaultConnectionType;
    }
    return defaultConnectionType;
  }, [selectedEdgeId, storeEdges, defaultConnectionType]);

  if (!activeScreen) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Select a screen or add a new one
      </div>
    );
  }

  return (
    <EdgeStoreContextProvider value={edgeStoreValue}>
      <style>{ANIMATED_EDGE_CSS}</style>
      <div ref={containerRef} className="w-full h-full relative" aria-label="SCADA canvas" onDragOver={isPreview ? undefined : onDragOver} onDrop={isPreview ? undefined : onDrop}>
        {/* Edge Toolbar (edit mode only) */}
        {!isPreview && (
          <EdgeToolbar
            selectedEdgeType={toolbarEdgeType}
            selectedConnectionType={toolbarConnectionType}
            onEdgeTypeChange={handleEdgeTypeChange}
            onConnectionTypeChange={handleConnectionTypeChange}
            hasSelectedEdge={!!selectedEdgeId}
          />
        )}

        {/* Alignment toolbar (shown when 2+ widgets selected) */}
        {!isPreview && <AlignmentToolbar />}

        <ReactFlow
          nodes={isPreview ? rfNodes.map((n) => ({ ...n, draggable: false })) : rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={isPreview ? undefined : onNodesChange}
          onEdgesChange={isPreview ? undefined : onEdgesChange}
          onConnect={isPreview ? undefined : onConnect}
          onNodeClick={isPreview ? undefined : onNodeClick}
          onEdgeClick={isPreview ? undefined : onEdgeClick}
          onNodesDelete={isPreview ? undefined : onNodesDelete}
          onPaneClick={isPreview ? undefined : onPaneClick}
          onPaneContextMenu={isPreview ? undefined : onPaneContextMenu}
          onNodeContextMenu={isPreview ? undefined : onNodeContextMenu}
          onEdgeContextMenu={isPreview ? undefined : onEdgeContextMenu}
          onNodeDoubleClick={isPreview ? undefined : onNodeDoubleClick}
          isValidConnection={isValidConnection}
          snapToGrid={!isPreview && snapEnabled}
          snapGrid={SNAP_GRID}
          fitView={false}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          minZoom={0.2}
          maxZoom={2}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={!isPreview}
          nodesConnectable={!isPreview}
          elementsSelectable={!isPreview}
          connectionLineStyle={{ stroke: '#06b6d4', strokeWidth: 2 }}
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionRadius={20}
          onMove={onMove}
          onMoveEnd={onMoveEnd}
        >
          {showGrid && (
            <Background
              variant={BackgroundVariant.Dots}
              gap={GRID_CELL_W}
              size={1.5}
              color="#d1d5db"
            />
          )}
          <Controls
            showInteractive={false}
            position="bottom-right"
          />
          <MiniMap
            nodeColor={(node: Node) => {
              const data = node.data as ScadaWidgetNodeData | undefined;
              if (!data) return '#06b6d4';
              // The canvas background image node renders as a neutral swatch
              if (node.type === 'scadaBackground') return '#e5e7eb';
              const type = data.widgetType;
              // Equipment types get industrial colors
              if (type === 'equipment') return '#f59e0b'; // amber
              if (type === 'gauge') return '#10b981'; // emerald
              if (type === 'alarmBanner' || type === 'alarmList') return '#ef4444'; // red
              if (type === 'trendChart') return '#8b5cf6'; // violet
              if (type === 'screenLink') return '#3b82f6'; // blue
              if (type === 'staticText') return '#6b7280'; // gray
              return '#06b6d4'; // cyan default
            }}
            maskColor="rgba(0,0,0,0.1)"
            position="bottom-left"
            pannable
            zoomable
          />
        </ReactFlow>

        {/* Smart Guides: alignment lines during widget drag (edit mode only) */}
        {!isPreview && (
          <SmartGuides
            draggingWidgetId={draggingNodeId}
            dragPosition={dragPosition}
            dragSize={dragSize}
            getViewport={getViewport}
          />
        )}

        {/* Grid Rulers (edit mode only) */}
        {!isPreview && (
          <CanvasRuler
            viewportX={viewportX}
            viewportY={viewportY}
            zoom={currentZoom}
            canvasWidth={canvasSize.width}
            canvasHeight={canvasSize.height}
          />
        )}

        {/* Canvas Settings */}
        {!isPreview && (
          <CanvasSettings
            snapEnabled={snapEnabled}
            onSnapToggle={setSnapEnabled}
            showGrid={showGrid}
            onGridToggle={setShowGrid}
            zoom={currentZoom}
            onZoomChange={(z) => rfInstance.setViewport({ ...rfInstance.getViewport(), zoom: z })}
            onFitView={() => rfInstance.fitView({ padding: 0.1, duration: 200 })}
            backgroundImage={activeScreen?.backgroundImage}
            backgroundOpacity={activeScreen?.backgroundOpacity}
            onBackgroundImageChange={(dataUrl) => {
              if (activeScreenId) {
                updateScreen(activeScreenId, { backgroundImage: dataUrl });
              }
            }}
            onBackgroundOpacityChange={(opacity) => {
              if (activeScreenId) {
                updateScreen(activeScreenId, { backgroundOpacity: opacity });
              }
            }}
          />
        )}

        {/* Context Menu */}
        {!isPreview && contextMenu && (
          <CanvasContextMenu
            position={contextMenu.position}
            target={contextMenu.target}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* PID Faceplate */}
        {faceplateWidget && (
          <PidFaceplate
            widget={faceplateWidget}
            onClose={() => setFaceplateWidget(null)}
          />
        )}
      </div>
    </EdgeStoreContextProvider>
  );
};

/* ------------------------------------------------------------------ */
/*  Exported component with ReactFlowProvider                          */
/* ------------------------------------------------------------------ */

interface ScreenCanvasProps {
  isPreview?: boolean;
}

export const ScreenCanvas: React.FC<ScreenCanvasProps> = ({ isPreview }) => {
  return (
    <ScadaRuntime>
      <ReactFlowProvider>
        <CanvasInner isPreview={isPreview} />
      </ReactFlowProvider>
      <OverlayStack />
    </ScadaRuntime>
  );
};
