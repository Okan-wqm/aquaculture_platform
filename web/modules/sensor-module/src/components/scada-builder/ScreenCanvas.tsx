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
  type Node,
  type NodeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useShallow } from 'zustand/react/shallow';

import { useScadaPackageStore } from '../../store/scadaPackageStore';
import type { ScreenWidget } from '../../types/scada-package.types';
import type { ScadaWidgetNodeData } from '../../types/scada-widget.types';
import ScadaWidgetNode from '../process-editor/nodes/ScadaWidgetNode';
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

/* ------------------------------------------------------------------ */
/*  Helper: generate unique ID                                         */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

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

  const {
    activeScreenId,
    screens,
    selectedWidgetId,
    setSelectedWidget,
    addWidget,
    removeWidget,
    updateWidgetPosition,
    saveScreenViewport,
    getScreenViewport,
  } = useScadaPackageStore(useShallow((s) => ({
    activeScreenId: s.activeScreenId,
    screens: s.screens,
    selectedWidgetId: s.selectedWidgetId,
    setSelectedWidget: s.setSelectedWidget,
    addWidget: s.addWidget,
    removeWidget: s.removeWidget,
    updateWidgetPosition: s.updateWidgetPosition,
    saveScreenViewport: s.saveScreenViewport,
    getScreenViewport: s.getScreenViewport,
  })));

  const activeScreen = screens.find((s) => s.id === activeScreenId);
  const widgets = activeScreen?.widgets ?? EMPTY_WIDGETS;

  // Keep a ref of last active screen to detect transitions
  const prevScreenIdRef = useRef(activeScreenId);

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
  const storeNodes: Node<ScadaWidgetNodeData>[] = useMemo(() => {
    return widgets.map((w) => {
      const px = gridToPixel(w.position);
      return {
        id: w.id,
        type: 'scadaWidget',
        position: { x: px.x, y: px.y },
        selected: w.id === selectedWidgetId,
        data: {
          widgetType: w.widgetType,
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
  }, [widgets, activeScreenId, handleWidgetResize]);

  // Local nodes state for smooth dragging (synced from store)
  const [nodes, setNodes] = useState<Node<ScadaWidgetNodeData>[]>(storeNodes);

  // Sync store → local nodes when store changes (not during drag)
  useEffect(() => {
    if (!syncingFromStore.current) {
      setNodes(storeNodes);
    }
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
        if (change.type === 'position' && change.dragging === false && change.position) {
          // Drag ended → commit position to store in grid units
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
          syncingFromStore.current = true;
          state.updateWidgetPosition(currentScreenId, change.id, newGrid);
          requestAnimationFrame(() => { syncingFromStore.current = false; });
        }
        if (change.type === 'select' && change.selected) {
          setSelectedWidget(change.id);
        }
      }
    },
    [setSelectedWidget],
  );

  // Click on empty canvas → deselect
  const onPaneClick = useCallback(() => {
    setSelectedWidget(null);
  }, [setSelectedWidget]);

  // Handle node click for selection
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setSelectedWidget(node.id);
    },
    [setSelectedWidget],
  );

  // Delete key handler
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      if (!activeScreenId) return;
      if (!window.confirm('Bu widget\'i silmek istediginize emin misiniz?')) return;
      for (const node of deletedNodes) {
        removeWidget(activeScreenId, node.id);
      }
    },
    [activeScreenId, removeWidget],
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

      addWidget(activeScreenId, newWidget);
      setSelectedWidget(newWidget.id);
    },
    [activeScreenId, rfInstance, addWidget, setSelectedWidget],
  );

  if (!activeScreen) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Ekran seçin veya yeni ekran ekleyin
      </div>
    );
  }

  return (
    <div className="w-full h-full" aria-label="SCADA tasarim alani" onDragOver={isPreview ? undefined : onDragOver} onDrop={isPreview ? undefined : onDrop}>
      <ReactFlow
        nodes={isPreview ? nodes.map((n) => ({ ...n, draggable: false })) : nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={isPreview ? undefined : onNodesChange}
        onNodeClick={isPreview ? undefined : onNodeClick}
        onNodesDelete={isPreview ? undefined : onNodesDelete}
        onPaneClick={isPreview ? undefined : onPaneClick}
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
