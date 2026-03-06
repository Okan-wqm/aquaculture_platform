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

/* ------------------------------------------------------------------ */
/*  Helper: generate unique ID                                         */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/*  Inner canvas (needs ReactFlowProvider ancestor)                    */
/* ------------------------------------------------------------------ */

const CanvasInner: React.FC = () => {
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
  const widgets = activeScreen?.widgets ?? [];

  // Keep a ref of last active screen to detect transitions
  const prevScreenIdRef = useRef(activeScreenId);

  // onResize callback for ScadaWidgetNode
  const handleWidgetResize = useCallback(
    (widgetId: string, width: number, height: number) => {
      if (!activeScreenId) return;
      const widget = useScadaPackageStore.getState().screens
        .find((s) => s.id === activeScreenId)
        ?.widgets.find((w) => w.id === widgetId);
      if (!widget) return;

      const newPos = pixelToGrid(
        widget.position.col * GRID_CELL_W,
        widget.position.row * GRID_CELL_H,
        width,
        height,
      );
      updateWidgetPosition(activeScreenId, widgetId, newPos);
    },
    [activeScreenId, updateWidgetPosition],
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
  }, [widgets, selectedWidgetId, activeScreenId, handleWidgetResize]);

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
          if (!activeScreenId) continue;
          const widget = widgets.find((w) => w.id === change.id);
          if (!widget) continue;
          const px = gridToPixel(widget.position);
          const newGrid = pixelToGrid(
            change.position.x,
            change.position.y,
            px.width,
            px.height,
          );
          syncingFromStore.current = true;
          updateWidgetPosition(activeScreenId, change.id, newGrid);
          requestAnimationFrame(() => { syncingFromStore.current = false; });
        }
        if (change.type === 'select') {
          if (change.selected) {
            setSelectedWidget(change.id);
          }
        }
      }
    },
    [activeScreenId, widgets, updateWidgetPosition, setSelectedWidget],
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

      const parsed = JSON.parse(data) as {
        widgetType: string;
        label: string;
        defaultWidth: number;
        defaultHeight: number;
        defaultConfig?: Record<string, unknown>;
      };

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
        Ekran secin veya yeni ekran ekleyin
      </div>
    );
  }

  return (
    <div className="flex-1" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodesDelete={onNodesDelete}
        onPaneClick={onPaneClick}
        snapToGrid
        snapGrid={SNAP_GRID}
        fitView={false}
        deleteKeyCode="Delete"
        multiSelectionKeyCode={null}
        minZoom={0.2}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={'dots' as any}
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

export const ScreenCanvas: React.FC = () => {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
};
