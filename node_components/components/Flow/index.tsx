import React, {
  useState,
  useCallback,
  useMemo,
  KeyboardEvent,
} from 'react';
import ReactFlow, {
  ReactFlowProvider,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type OnConnect,
  type NodeDragHandler,
  type OnSelectionChangeFunc,
  ConnectionMode,
  BackgroundVariant,
  MarkerType,
} from 'reactflow';

import RotateMenu  from '../RotateMenu';
import Toolbox     from './Toolbox';
import Inspector   from '../Inspector';
import { nodeTypes, edgeTypes } from './types';
import type { FlowNodeData, FlowEdgeData } from './types';

import 'reactflow/dist/style.css';
import './FlowOverlay.css';

const getId = () => `node_${Date.now()}`;

export default function Flow() {
  /* ─── React-Flow state ─────────────────────────────── */
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdgeData>([]);

  /* ─── UI state ─────────────────────────────────────── */
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [sidebarOpen,    setSidebarOpen]      = useState(false);
  const inspectorOpen = selectedNodeIds.length > 0;
  const [showGrid, setShowGrid]               = useState(false);

  /* ─── Toolbox controls ─────────────────────────────── */
  const iconNames = useMemo(() => Object.keys(nodeTypes), []);
  const [selectedNodeType, setSelectedNodeType] = useState(iconNames[0] || '');
  const [selectedEdgeType, setSelectedEdgeType] =
    useState<'multiHandle' | 'draggable'>('multiHandle');

  const addNode = useCallback(() => {
    if (!selectedNodeType) return;
    setNodes((nds) => [
      ...nds,
      {
        id: getId(),
        type: selectedNodeType,
        position: { x: 100, y: 100 },
        data: {},
      } as Node<FlowNodeData>,
    ]);
  }, [selectedNodeType, setNodes]);

  /* ─── Edge / selection / delete ────────────────────── */
  const onConnect: OnConnect = useCallback(
    (params) =>
      setEdges((es) =>
        addEdge(
          {
            ...params,
            type: selectedEdgeType,
            markerEnd: { type: MarkerType.ArrowClosed },
            data: { label: '' },
          },
          es,
        ),
      ),
    [selectedEdgeType, setEdges],
  );

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: nn, edges: ee }) => {
      setSelectedNodeIds(nn.map((n) => n.id));
      setSelectedEdgeIds(ee.map((e) => e.id));
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Delete') {
        setNodes((ns) => ns.filter((n) => !selectedNodeIds.includes(n.id)));
        setEdges((es) => es.filter((e) => !selectedEdgeIds.includes(e.id)));
      }
    },
    [selectedNodeIds, selectedEdgeIds, setNodes, setEdges],
  );

  const onNodeDragStop: NodeDragHandler = useCallback(
    (_e, node) =>
      setNodes((ns) =>
        ns.map((n) => (n.id === node.id ? { ...n, position: node.position } : n)),
      ),
    [setNodes],
  );

  /* ─── Selected highlight ───────────────────────────── */
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        style: selectedNodeIds.includes(n.id)
          ? { border: '2px solid red', background: '#222', ...(n.style || {}) }
          : n.style || {},
      })),
    [nodes, selectedNodeIds],
  );
  const displayEdges = useMemo(
    () =>
      edges.map((e) =>
        selectedEdgeIds.includes(e.id)
          ? { ...e, style: { stroke: 'cyan', ...e.style } }
          : e,
      ),
    [edges, selectedEdgeIds],
  );

  /* ─── Rotate helper (↻ button) ─────────────────────── */
  const rotateSelectedNodes = useCallback(() => {
    setNodes((curr) =>
      curr.map((n) =>
        selectedNodeIds.includes(n.id)
          ? {
              ...n,
              data: { ...n.data, rotation: ((n.data?.rotation || 0) + 90) % 360 },
            }
          : n,
      ),
    );
  }, [selectedNodeIds, setNodes]);

  /* ─── JSX ───────────────────────────────────────────── */
  return (
    <ReactFlowProvider>
      <div className="flow-wrapper" tabIndex={0} onKeyDown={onKeyDown}>
        {/* Canvas */}
        <div className="flow-container">
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={onSelectionChange}
            connectionMode={ConnectionMode.Strict}
            fitView
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            className="reactflow-canvas"
            style={{ backgroundColor: '#000' }}
          >
            {showGrid && (
              <Background variant={BackgroundVariant.Lines} gap={10} />
            )}
            <Controls />
            {/* İç node handle döndürme menüsü */}
            {/*<RotateMenu setNodes={setNodes} selectedNodeIds={selectedNodeIds} />*/}
          </ReactFlow>
        </div>

        {/* Overlay katmanı */}
        <div className="flow-overlay">
          {/* ─── Toolbox panel & toggle ─── */}
          <div className={`toolbox-panel ${sidebarOpen ? 'open' : ''}`}>
            <div
              className="panel-toggle toolbox-toggle"
              onClick={() => setSidebarOpen((o) => !o)}
            >
              {sidebarOpen ? '«' : '»'}
            </div>
            <div className="toolbox-body">
              <Toolbox
                isOpen={sidebarOpen}
                toggleOpen={() => setSidebarOpen((o) => !o)}
                iconNames={iconNames}
                selectedNodeType={selectedNodeType}
                setSelectedNodeType={setSelectedNodeType}
                selectedEdgeType={selectedEdgeType}
                setSelectedEdgeType={setSelectedEdgeType}
                addNode={addNode}
                showGrid={showGrid}
                setShowGrid={setShowGrid}
                projects={[]}
                selectedProjectId=""
                projectName=""
                setSelectedProjectId={() => {}}
                setProjectName={() => {}}
                loadProject={() => {}}
                saveProject={() => {}}
                deleteProject={() => {}}
                onRunFlow={() => {}}
              />
            </div>
          </div>

          {/* ─── Inspector panel & toggle ─── */}
          <div className={`inspector-panel ${inspectorOpen ? 'open' : ''}`}>
            <div
              className="panel-toggle inspector-toggle"
              onClick={() => setSelectedNodeIds([])}
            >
              {inspectorOpen ? '»' : '«'}
            </div>
            <div className="inspector-body">
              <Inspector
                editingNode={
                  (nodes.find((n) => n.id === selectedNodeIds[0]) as
                    | Node<FlowNodeData>
                    | undefined) ?? null
                }
                edges={edges as Edge<FlowEdgeData>[]}
                setNodes={setNodes}
                createWidgetForSensor={() => {}}
              />
            </div>
          </div>

          {/* ─── Rotate button ─── */}
          <button
            className="rotate-button"
            onClick={rotateSelectedNodes}
            title="Rotate selected nodes"
          >
            ↻
          </button>
        </div>
      </div>
    </ReactFlowProvider>
  );
}
