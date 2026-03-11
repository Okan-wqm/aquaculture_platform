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
import ReactFlow, {
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
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useShallow } from 'zustand/react/shallow';

import { useScadaPackageStore } from '../../store/scadaPackageStore';
import type { ScreenWidget } from '../../types/scada-package.types';
import type { ScadaWidgetNodeData, ScadaWidgetType } from '../../types/scada-widget.types';
import type { ScadaEdge, ScadaEdgeType } from '../../types/scada-edge.types';
import ScadaWidgetNode from './nodes/ScadaWidgetNode';
import { edgeTypes } from './edges';
import { EdgeStoreContextProvider } from './EdgeStoreContext';
import { EdgeToolbar } from './EdgeToolbar';
import { getEdgeStyle } from '../../config/connectionTypes';
import type { ConnectionType } from '../../config/connectionTypes';
import {
  GRID_CELL_W,
  GRID_CELL_H,
  SNAP_GRID,
  gridToPixel,
  pixelToGrid,
  getWidgetSize,
} from '../../constants/scada-widget-sizes';

/* ------------------------------------------------------------------ */
/*  Node type registry                                                 */
/* ------------------------------------------------------------------ */

const nodeTypes = { scadaWidget: ScadaWidgetNode };

const EMPTY_WIDGETS: ScreenWidget[] = [];
const EMPTY_EDGES: ScadaEdge[] = [];

/* ------------------------------------------------------------------ */
/*  Helper: generate unique ID                                         */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/*  Animated flow CSS                                                   */
/* ------------------------------------------------------------------ */

const ANIMATED_EDGE_CSS = `
  .react-flow__edge.animated-flow .react-flow__edge-path {
    stroke-dasharray: 8 4 !important;
    animation: edge-flow 0.6s linear infinite;
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

  const {
    activeScreenId,
    screens,
    selectedWidgetId,
    selectedEdgeId,
    setSelectedWidget,
    setSelectedEdge,
    addWidget,
    removeWidget,
    updateWidgetPosition,
    addEdge: storeAddEdge,
    removeEdge: storeRemoveEdge,
    updateEdgeData: storeUpdateEdgeData,
    updateEdgeType: storeUpdateEdgeType,
    saveScreenViewport,
    getScreenViewport,
  } = useScadaPackageStore(useShallow((s) => ({
    activeScreenId: s.activeScreenId,
    screens: s.screens,
    selectedWidgetId: s.selectedWidgetId,
    selectedEdgeId: s.selectedEdgeId,
    setSelectedWidget: s.setSelectedWidget,
    setSelectedEdge: s.setSelectedEdge,
    addWidget: s.addWidget,
    removeWidget: s.removeWidget,
    updateWidgetPosition: s.updateWidgetPosition,
    addEdge: s.addEdge,
    removeEdge: s.removeEdge,
    updateEdgeData: s.updateEdgeData,
    updateEdgeType: s.updateEdgeType,
    saveScreenViewport: s.saveScreenViewport,
    getScreenViewport: s.getScreenViewport,
  })));

  const activeScreen = screens.find((s) => s.id === activeScreenId);
  const widgets = activeScreen?.widgets ?? EMPTY_WIDGETS;
  const storeEdges = activeScreen?.edges ?? EMPTY_EDGES;

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

  // onResize callback for ScadaWidgetNode
  const handleWidgetResize = useCallback(
    (widgetId: string, width: number, height: number) => {
      const state = useScadaPackageStore.getState();
      const currentScreenId = state.activeScreenId;
      if (!currentScreenId) return;
      const widget = state.screens
        .find((s) => s.id === currentScreenId)
        ?.widgets.find((w) => w.id === widgetId);
      if (!widget) return;

      const newPos = pixelToGrid(
        widget.position.col * GRID_CELL_W,
        widget.position.row * GRID_CELL_H,
        width,
        height,
      );
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
    return widgets.map((w) => {
      const px = gridToPixel(w.position);
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
          tagName: w.config?.tagName as string | undefined,
          onResize: (_wt: string, newW: number, newH: number) => {
            handleWidgetResize(w.id, newW, newH);
          },
        },
        dragHandle: undefined,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets, activeScreenId, handleWidgetResize]);

  // Convert store edges → ReactFlow edges
  const rfEdges: Edge[] = useMemo(() => {
    return storeEdges.map((e) => {
      const style = getEdgeStyle(e.data.connectionType);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: e.type,
        selected: e.id === selectedEdgeId,
        animated: false, // We use CSS animation instead
        data: {
          ...e.data,
          // Pass connection type for P&ID styling inside the edge component
          connectionType: e.data.connectionType,
        },
        style,
        className: e.data.animated ? 'animated-flow' : undefined,
      };
    });
  }, [storeEdges, selectedEdgeId]);

  // Local nodes state for smooth dragging (synced from store)
  const [nodes, setNodes] = useState<Node<ScadaWidgetNodeData>[]>(storeNodes);

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
          // Existing node: keep local position, update data (config/label/value changes)
          return { ...existing, data: sn.data };
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

  // Handle node changes (position drag, selection)
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Apply ALL changes locally for smooth visual feedback
      setNodes((nds) => applyNodeChanges(changes, nds));

      for (const change of changes) {
        if (change.type === 'position' && change.dragging === true) {
          // Drag in progress — mark so store→local sync is suppressed
          isDragging.current = true;
        }
        if (change.type === 'position' && change.dragging === false) {
          // Drag ended — always clear isDragging, even if position is missing
          isDragging.current = false;
          if (!change.position) continue;
          const state = useScadaPackageStore.getState();
          const currentScreenId = state.activeScreenId;
          if (!currentScreenId) continue;
          const currentWidgets = state.screens.find((s) => s.id === currentScreenId)?.widgets ?? [];
          const widget = currentWidgets.find((w) => w.id === change.id);
          if (!widget) continue;
          const px = gridToPixel(widget.position);
          const newGrid = pixelToGrid(
            change.position.x,
            change.position.y,
            px.width,
            px.height,
          );
          // Only push to store if grid position actually changed
          const posChanged =
            newGrid.col !== widget.position.col ||
            newGrid.row !== widget.position.row;
          if (posChanged) {
            syncingFromStore.current = true;
            state.updateWidgetPosition(currentScreenId, change.id, newGrid);
          }
        }
        if (change.type === 'select' && change.selected) {
          setSelectedWidget(change.id);
          setSelectedEdge(null);
        }
      }
    },
    [setSelectedWidget, setSelectedEdge],
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
    (connection: Connection) => {
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

      // Validate handle direction: source handle should end with '-out' or be an 'out'/'inout' port,
      // target handle should end with '-in' or be an 'in'/'inout' port
      const sh = connection.sourceHandle || '';
      const th = connection.targetHandle || '';
      // Block connecting two '-in' handles or two '-out' handles
      if (sh.endsWith('-in') && !sh.endsWith('-out')) return false;
      if (th.endsWith('-out') && !th.endsWith('-in')) return false;

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
  }, [setSelectedWidget, setSelectedEdge]);

  // Handle node click for selection
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setSelectedWidget(node.id);
      setSelectedEdge(null);
    },
    [setSelectedWidget, setSelectedEdge],
  );

  // Delete key handler (ReactFlow callback)
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      if (!activeScreenId) return;
      for (const node of deletedNodes) {
        removeWidget(activeScreenId, node.id);
      }
    },
    [activeScreenId, removeWidget],
  );

  // Keyboard Delete/Backspace handler for selected widget
  useEffect(() => {
    if (isPreview) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedWidgetId && activeScreenId) {
          e.preventDefault();
          removeWidget(activeScreenId, selectedWidgetId);
        } else if (selectedEdgeId && activeScreenId) {
          e.preventDefault();
          storeRemoveEdge(activeScreenId, selectedEdgeId);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPreview, selectedWidgetId, selectedEdgeId, activeScreenId, removeWidget, storeRemoveEdge]);

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
      const sizeDef = getWidgetSize(parsed.widgetType);

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
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Ekran seçin veya yeni ekran ekleyin
      </div>
    );
  }

  return (
    <EdgeStoreContextProvider value={edgeStoreValue}>
      <style>{ANIMATED_EDGE_CSS}</style>
      <div className="w-full h-full relative" aria-label="SCADA tasarim alani" onDragOver={isPreview ? undefined : onDragOver} onDrop={isPreview ? undefined : onDrop}>
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

        <ReactFlow
          nodes={isPreview ? nodes.map((n) => ({ ...n, draggable: false })) : nodes}
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
          isValidConnection={isValidConnection}
          snapToGrid={!isPreview}
          snapGrid={SNAP_GRID}
          fitView={false}
          deleteKeyCode={isPreview ? null : 'Delete'}
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
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={GRID_CELL_W}
            size={1.5}
            color="#d1d5db"
          />
          <Controls
            showInteractive={false}
            position="bottom-right"
          />
          <MiniMap
            nodeColor="#06b6d4"
            maskColor="rgba(0,0,0,0.1)"
            position="bottom-left"
            pannable
            zoomable
          />
        </ReactFlow>
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
    <ReactFlowProvider>
      <CanvasInner isPreview={isPreview} />
    </ReactFlowProvider>
  );
};
