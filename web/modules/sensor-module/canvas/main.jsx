// Process Editor Canvas — bundled Vite entry (SENSOR-MEDIUM-004).
// Deps resolve from the repo's node_modules at build time (React 19, xyflow,
// recharts, @aquaculture/node-components) — NO CDN <script> tags, no jsx-runtime
// shim, no hand-managed global graph, no public/->dist stale-copy path. A
// missing dep is a BUILD error, not a cryptic runtime crash.
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactFlowNS from '@xyflow/react';
import * as AquacultureNodes from '@aquaculture/node-components';
import * as Recharts from 'recharts';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import { CANVAS_SOURCE, HOST_SOURCE } from '../src/canvas-contract';

// The ported classic-React app reads a few module namespaces as bare/window
// identifiers; bind them locally from the bundled imports (was: CDN globals).
const ReactDOM = { createRoot: ReactDOMClient.createRoot };
    const { createElement: h, useState, useCallback, useRef, useEffect, useMemo } = React;
    const { createRoot } = ReactDOM;
    const {
      ReactFlow,
      ReactFlowProvider,
      useNodesState,
      useEdgesState,
      useReactFlow,
      useUpdateNodeInternals,
      addEdge,
      Controls,
      Background,
      MiniMap,
      Handle,
      Position,
      MarkerType,
    } = ReactFlowNS;

    // ============================================
    // Import from UMD Bundle (@aquaculture/node-components)
    // ============================================
    const {
      // Node components
      BlowerNode,
      DrumFilterNode,
      UVUnitNode,
      RadialSettlerNode,
      FishTankNode,
      ConnectionPointNode,
      TankInletNode,
      SensorNode,
      AlgaeBagNode,
      DemandFeederNode,
      AutomaticFeederNode,
      UltrafiltrationNode,
      DualDrainTankNode,
      CleanWaterTankNode,
      DirtyWaterTankNode,
      WaterSupplyNode,
      WaterDischargeNode,
      MBBRNode,
      HEPAFilterNode,
      DosingPumpNode,
      HeaterNode,
      ShellTubeHeatExchangerNode,
      PlateHeatExchangerNode,
      ChillerNode,
      GasGeneratorNode,
      DieselGeneratorNode,
      EquipmentNode,
      PumpNode,
      ValveNode,
      OzoneGeneratorNode,
      OxygenGeneratorNode,
      // Edge types
      edgeTypes: baseEdgeTypes,
      // Config
      getEdgeStyle,
      CONNECTION_TYPES,
    } = AquacultureNodes;

    // Status color mapping
    const getStatusColor = (status) => {
      if (status === 'operational' || status === 'active') return '#22c55e';
      if (status === 'maintenance') return '#eab308';
      if (status === 'out_of_service') return '#ef4444';
      return '#94a3b8';
    };

    // ============================================
    // Chart Widget Node (Editor-specific)
    // ============================================
    function ChartWidgetNode({ id, data, selected }) {
      const { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, BarChart, Bar } = Recharts;

      const width = data?.width || 320;
      const height = data?.height || 200;
      const widgetType = data?.widgetType || 'line-chart';
      const title = data?.title || 'Chart Widget';
      const color = data?.color || '#3b82f6';
      const mode = data?.mode || 'demo';

      // Demo data for preview
      const demoData = useMemo(() => [
        { time: '00:00', value: 22.5 },
        { time: '04:00', value: 23.1 },
        { time: '08:00', value: 24.2 },
        { time: '12:00', value: 25.8 },
        { time: '16:00', value: 24.5 },
        { time: '20:00', value: 23.2 },
      ], []);

      const chartData = data?.chartData?.length > 0 ? data.chartData : demoData;

      if (!LineChart) {
        return h('div', {
          style: { width, height, background: '#f8fafc', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', border: selected ? '2px solid #3b82f6' : '1px solid #e2e8f0' }
        }, h('span', { style: { color: '#94a3b8' } }, 'Recharts not loaded'));
      }

      // Select chart component based on type
      let ChartComponent, DataComponent;
      if (widgetType === 'area-chart') {
        ChartComponent = AreaChart;
        DataComponent = (props) => h(Area, { ...props, fillOpacity: 0.3 });
      } else if (widgetType === 'bar-chart') {
        ChartComponent = BarChart;
        DataComponent = Bar;
      } else {
        ChartComponent = LineChart;
        DataComponent = Line;
      }

      return h('div', {
        style: { width, height }
      }, [
        h(Handle, { key: 'target-left', type: 'target', position: Position.Left, style: { background: '#3b82f6', border: '2px solid white' } }),
        h(Handle, { key: 'target-top', type: 'target', position: Position.Top, style: { background: '#3b82f6', border: '2px solid white' } }),

        // Header
        h('div', { key: 'header', className: 'chart-widget-header' }, [
          h('span', { key: 'icon', style: { fontSize: 14 } }, '\uD83D\uDCC8'),
          h('span', { key: 'title', style: { fontSize: 12, fontWeight: 600, color: '#1e40af', flex: 1 } }, title),
          mode === 'demo' && h('span', { key: 'badge', style: { fontSize: 9, background: '#fef3c7', color: '#92400e', padding: '1px 4px', borderRadius: 3 } }, 'DEMO')
        ]),

        // Chart content
        h('div', { key: 'content', className: 'chart-widget-content' },
          h(ResponsiveContainer, { width: '100%', height: height - 70 },
            h(ChartComponent, { data: chartData },
              h(XAxis, { dataKey: 'time', tick: { fontSize: 9 }, stroke: '#9ca3af' }),
              h(YAxis, { tick: { fontSize: 9 }, stroke: '#9ca3af', width: 35 }),
              h(Tooltip, { contentStyle: { fontSize: 10 } }),
              h(DataComponent, {
                type: 'monotone',
                dataKey: 'value',
                stroke: color,
                fill: color,
                strokeWidth: 2,
                dot: false
              })
            )
          )
        ),

        // Footer
        h('div', { key: 'footer', className: 'chart-widget-footer' }, [
          h('span', { key: 'channels' }, `${data?.selectedChannels?.length || 0} channels`),
          h('span', { key: 'refresh' }, data?.timeRange || 'live')
        ]),

        h(Handle, { key: 'source-right', type: 'source', position: Position.Right, style: { background: '#22c55e', border: '2px solid white' } }),
        h(Handle, { key: 'source-bottom', type: 'source', position: Position.Bottom, style: { background: '#22c55e', border: '2px solid white' } })
      ]);
    }

    // Algae bag color wrappers
    function AlgaeBagRedNode(props) {
      return h(AlgaeBagNode, { ...props, data: { ...props.data, color: 'red' } });
    }
    function AlgaeBagGreenNode(props) {
      return h(AlgaeBagNode, { ...props, data: { ...props.data, color: 'green' } });
    }
    function AlgaeBagYellowNode(props) {
      return h(AlgaeBagNode, { ...props, data: { ...props.data, color: 'yellow' } });
    }

    // ============================================
    // SCADA Widget Node (Canvas vanilla JS renderer)
    // ============================================
    function ScadaWidgetNodeCanvas({ data, selected }) {
      var w = (data && data.width) || 240;
      var h_val = (data && data.height) || 200;
      return h('div', {
        style: {
          width: w, height: h_val,
          background: 'white',
          border: selected ? '2px solid #06b6d4' : '1px solid #d1d5db',
          borderRadius: 8,
          overflow: 'hidden',
          position: 'relative',
          boxShadow: selected ? '0 0 0 2px rgba(6,182,212,0.3)' : 'none',
        }
      }, [
        // Widget type badge (top-left)
        h('div', {
          key: 'badge',
          style: { position: 'absolute', top: 4, left: 4, fontSize: 10, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }
        }, data && data.widgetType || 'widget'),
        // Live value (center)
        h('div', {
          key: 'value',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 24, fontWeight: 600, color: '#1f2937' }
        }, data && data.liveValue != null ? String(data.liveValue) : '\u2014'),
        // Tag name (bottom)
        h('div', {
          key: 'tag',
          style: { position: 'absolute', bottom: 4, left: 4, right: 4, fontSize: 9, color: '#9ca3af', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        }, data && data.tagName || ''),
      ]);
    }

    // Edge types registration - use from UMD bundle
    const edgeTypes = baseEdgeTypes;

    // Node types registration - use from UMD bundle
    const nodeTypes = {
      scadaWidget: ScadaWidgetNodeCanvas,
      equipment: EquipmentNode,
      blower: BlowerNode,
      drumFilter: DrumFilterNode,
      uvUnit: UVUnitNode,
      radialSettler: RadialSettlerNode,
      fishTank: FishTankNode,
      connectionPoint: ConnectionPointNode,
      tankInlet: TankInletNode,
      sensor: SensorNode,
      algaeBagRed: AlgaeBagRedNode,
      algaeBagGreen: AlgaeBagGreenNode,
      algaeBagYellow: AlgaeBagYellowNode,
      chartWidget: ChartWidgetNode,
      demandFeeder: DemandFeederNode,
      automaticFeeder: AutomaticFeederNode,
      ultrafiltration: UltrafiltrationNode,
      dualDrainTank: DualDrainTankNode,
      cleanWaterTank: CleanWaterTankNode,
      dirtyWaterTank: DirtyWaterTankNode,
      waterSupply: WaterSupplyNode,
      waterDischarge: WaterDischargeNode,
      mbbr: MBBRNode,
      hepaFilter: HEPAFilterNode,
      dosingPump: DosingPumpNode,
      heater: HeaterNode,
      shellAndTubeHeatExchanger: ShellTubeHeatExchangerNode,
      plateHeatExchanger: PlateHeatExchangerNode,
      chiller: ChillerNode,
      gasGenerator: GasGeneratorNode,
      dieselGenerator: DieselGeneratorNode,
      pump: PumpNode,
      valve: ValveNode,
      ozoneGenerator: OzoneGeneratorNode,
      oxygenGenerator: OxygenGeneratorNode,
    };

    // Equipment type to node type mapping
    // Maps database equipment type codes to ReactFlow node types
    // Codes are normalized: lowercase and hyphens replaced with underscores
    const equipmentTypeToNodeType = {
      // Blower types (aeration equipment)
      'blower': 'blower',
      'root_blower': 'blower',
      'lobe_blower': 'blower',
      'aerator': 'blower',
      // Drum Filter types (mechanical filtration)
      'filter_drum': 'drumFilter',
      'drum_filter': 'drumFilter',
      'filter_mechanical': 'drumFilter',
      'mechanical_filter': 'drumFilter',
      // UV types (water treatment)
      'filter_uv': 'uvUnit',
      'uv_sterilizer': 'uvUnit',
      'uv_filter': 'uvUnit',
      'uv': 'uvUnit',
      // Settler/Biofilter types (biological filtration)
      'settler': 'radialSettler',
      'radial_settler': 'radialSettler',
      'settling_tank': 'radialSettler',
      'filter_bead': 'radialSettler',
      'filter_biological': 'radialSettler',
      'biofilter': 'radialSettler',
      'biological_filter': 'radialSettler',
      // Tank types (all tanks use fishTank node)
      'tank_circular': 'fishTank',
      'tank_raceway': 'fishTank',
      'tank_rectangular': 'fishTank',
      'fish_tank': 'fishTank',
      'raceway': 'fishTank',
      'tank': 'fishTank',
      'ras_tank': 'fishTank',
      'nursery_tank': 'fishTank',
      'grow_out_tank': 'fishTank',
      // Connection point types
      'connection_point': 'connectionPoint',
      'junction': 'connectionPoint',
      'tee': 'connectionPoint',
      // Tank inlet types
      'tank_inlet': 'tankInlet',
      'inlet': 'tankInlet',
      'water_inlet': 'tankInlet',
      // Sensor types
      'sensor': 'sensor',
      'sensor_node_template': 'sensor',
      // Algae cultivation bag types
      'algae_bag_red': 'algaeBagRed',
      'algae_bag_rhodomonas': 'algaeBagRed',
      'rhodomonas_bag': 'algaeBagRed',
      'algae_bag_green': 'algaeBagGreen',
      'algae_bag_chlorella': 'algaeBagGreen',
      'chlorella_bag': 'algaeBagGreen',
      'algae_bag_yellow': 'algaeBagYellow',
      'algae_bag_dunaliella': 'algaeBagYellow',
      'dunaliella_bag': 'algaeBagYellow',
      'algae_bag': 'algaeBagGreen',
      // Feeder types - database codes (normalized from feeder-*)
      'feeder_automatic': 'automaticFeeder',
      'feeder_demand': 'demandFeeder',
      // Legacy/alternative codes for backwards compatibility
      'demand_feeder': 'demandFeeder',
      'pendulum_feeder': 'demandFeeder',
      'fish_activated_feeder': 'demandFeeder',
      'automatic_feeder': 'automaticFeeder',
      'auto_feeder': 'automaticFeeder',
      'motorized_feeder': 'automaticFeeder',
      'auger_feeder': 'automaticFeeder',
      'feeder': 'automaticFeeder',
      // Ultrafiltration types (membrane filtration)
      'ultrafiltration': 'ultrafiltration',
      'uf_membrane': 'ultrafiltration',
      'membrane_filter': 'ultrafiltration',
      // Dual Drain Tank types
      'dual_drain_tank': 'dualDrainTank',
      'dual_drain': 'dualDrainTank',
      'cornell_tank': 'dualDrainTank',
      // Water tanks
      'clean_water_tank': 'cleanWaterTank',
      'dirty_water_tank': 'dirtyWaterTank',
      'sump_tank': 'dirtyWaterTank',
      'water_supply': 'waterSupply',
      'water_discharge': 'waterDischarge',
      // MBBR
      'mbbr': 'mbbr',
      'moving_bed': 'mbbr',
      // HEPA Filter
      'hepa_filter': 'hepaFilter',
      'hepa': 'hepaFilter',
      // Dosing Pump
      'dosing_pump': 'dosingPump',
      'chemical_pump': 'dosingPump',
      // Heat exchangers
      'heater': 'heater',
      'water_heater': 'heater',
      'shell_tube_heat_exchanger': 'shellAndTubeHeatExchanger',
      'shell_and_tube': 'shellAndTubeHeatExchanger',
      'plate_heat_exchanger': 'plateHeatExchanger',
      'plate_exchanger': 'plateHeatExchanger',
      'chiller': 'chiller',
      'water_chiller': 'chiller',
      // Generators
      'gas_generator': 'gasGenerator',
      'diesel_generator': 'dieselGenerator',
      'backup_generator': 'dieselGenerator',
      // Pump types
      'pump': 'pump',
      'centrifugal_pump': 'pump',
      'submersible_pump': 'pump',
      'water_pump': 'pump',
      // Valve types
      'valve': 'valve',
      'ball_valve': 'valve',
      'gate_valve': 'valve',
      'butterfly_valve': 'valve',
      // Ozone/Oxygen
      'ozone_generator': 'ozoneGenerator',
      'ozonator': 'ozoneGenerator',
      'oxygen_generator': 'oxygenGenerator',
      'oxygen_concentrator': 'oxygenGenerator',
      'lox': 'oxygenGenerator',
      'psa': 'oxygenGenerator',
      // Chart Widget types
      'line_chart': 'chartWidget',
      'area_chart': 'chartWidget',
      'bar_chart': 'chartWidget',
      'gauge_widget': 'chartWidget',
      'chart_widget': 'chartWidget',
      'widget': 'chartWidget',
    };

    // Default edge options with P&ID styling
    const defaultEdgeOptions = {
      type: 'orthogonal',
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: getEdgeStyle('process-pipe'),
      data: {
        connectionType: 'process-pipe',
        midX1: null,
        midY: null,
        midX2: null
      }
    };

    // Cached parent origin for secure postMessage
    let cachedParentOrigin = '*';

    // ============================================
    // Main Process Editor Canvas Component
    // ============================================
    function ProcessEditorCanvas() {
      const reactFlowWrapper = useRef(null);
      const [nodes, setNodes, onNodesChange] = useNodesState([]);
      const [edges, setEdges, onEdgesChange] = useEdgesState([]);
      const [reactFlowInstance, setReactFlowInstance] = useState(null);
      const [selectedNodeId, setSelectedNodeId] = useState(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState(null);
      const [highlightedNodeId, setHighlightedNodeId] = useState(null);

      // Refs for stable access inside message handler (avoids stale closure)
      const nodesRef = useRef(nodes);
      const edgesRef = useRef(edges);
      useEffect(() => { nodesRef.current = nodes; }, [nodes]);
      useEffect(() => { edgesRef.current = edges; }, [edges]);

      // Handle new connection
      const onConnect = useCallback((params) => {
        // Get edge style from data or use default
        const newEdge = {
          ...params,
          id: `e-${params.source}-${params.sourceHandle || 'default'}-${params.target}-${params.targetHandle || 'default'}-${Date.now()}`,
          type: 'orthogonal',
          data: {
            connectionType: 'process-pipe',
            midX1: null,
            midY: null,
            midX2: null
          },
          style: getEdgeStyle('process-pipe')
        };
        setEdges((eds) => addEdge(newEdge, eds));
        notifyParent('edgeAdded', newEdge);
      }, [setEdges]);

      // Handle node click
      const onNodeClick = useCallback((event, node) => {
        setSelectedNodeId(node.id);
        setSelectedEdgeId(null);
        notifyParent('nodeSelected', node);
        // SCADA overlay node selected — notify parent with dedicated message
        if (node.type === 'scadaWidget') {
          notifyParent('overlayNodeSelected', { nodeId: node.id, nodeData: node.data });
        }
      }, []);

      // Handle edge click
      const onEdgeClick = useCallback((event, edge) => {
        setSelectedEdgeId(edge.id);
        setSelectedNodeId(null);
        notifyParent('edgeSelected', edge);
      }, []);

      // Handle pane click (deselect)
      const onPaneClick = useCallback(() => {
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        notifyParent('selectionCleared', null);
      }, []);

      // Handle node drag stop — notify parent when overlay node is moved
      const onNodeDragStop = useCallback((event, node) => {
        if (node.type === 'scadaWidget') {
          notifyParent('overlayNodeMoved', { nodeId: node.id, position: node.position });
        }
      }, []);

      // Handle nodes delete — notify parent when overlay nodes are deleted via keyboard
      const onNodesDelete = useCallback((deletedNodes) => {
        deletedNodes.forEach((node) => {
          if (node.type === 'scadaWidget') {
            notifyParent('overlayNodeDeleted', { nodeId: node.id });
          }
        });
      }, []);

      // Handle drag over for drop
      const onDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }, []);

      // Handle drop from palette
      const onDrop = useCallback((event) => {
        event.preventDefault();

        if (!reactFlowInstance) return;

        // Check for SCADA widget drop from HMI palette
        const scadaWidgetData = event.dataTransfer.getData('application/scada-widget');
        if (scadaWidgetData) {
          try {
            const widgetInfo = JSON.parse(scadaWidgetData);
            const position = reactFlowInstance.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            notifyParent('overlayNodeDropped', {
              widgetType: widgetInfo.widgetType || widgetInfo.type || 'unknown',
              position,
              widgetData: widgetInfo,
            });
          } catch (e) {
          }
          return;
        }

        const equipmentData = event.dataTransfer.getData('application/equipment') || event.dataTransfer.getData('application/reactflow');
        if (!equipmentData) return;

        let equipment;
        try {
          equipment = JSON.parse(equipmentData);
        } catch (e) {
          return;
        }

        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

        // Normalize equipment type code for mapping
        const normalizedCode = (equipment.equipmentType?.code || equipment.type || 'equipment')
          .toLowerCase()
          .replace(/-/g, '_');

        // Map equipment type to node type - prefer explicit nodeType from template
        const nodeType = equipment.equipmentType?.nodeType || equipmentTypeToNodeType[normalizedCode] || 'equipment';

        // Build node data from equipment
        let nodeData = {
          label: equipment.name || equipment.label || normalizedCode,
          equipmentId: equipment.id,
          equipmentCode: equipment.code,
          equipmentName: equipment.name,
          equipmentType: equipment.equipmentType?.name || normalizedCode,
          equipmentCategory: equipment.equipmentType?.category || 'equipment',
          status: equipment.status || 'operational',
          width: equipment.equipmentType?.defaultWidth,
          height: equipment.equipmentType?.defaultHeight,
        };

        // ChartWidget nodes have additional widget-specific data
        if (nodeType === 'chartWidget') {
          nodeData = {
            ...nodeData,
            widgetType: equipment.equipmentType?.widgetType || 'line-chart',
            title: equipment.name || 'New Chart',
            width: equipment.equipmentType?.defaultWidth || 320,
            height: equipment.equipmentType?.defaultHeight || 200,
            // Data channel config - user will configure via modal
            dataChannelIds: [],
            selectedChannels: [],
            timeRange: 'live',
            refreshInterval: 5000,
            mode: 'demo', // Start in demo mode with mock data
          };
        }

        const newNode = {
          id: `${nodeType}-${Date.now()}`,
          type: nodeType,
          position,
          data: nodeData,
        };

        setNodes((nds) => nds.concat(newNode));
        notifyParent('nodeAdded', newNode);
      }, [reactFlowInstance, setNodes]);

      // Notify parent window (use cached origin for security)
      const notifyParent = useCallback((type, data) => {
        window.parent.postMessage({ type, data, source: CANVAS_SOURCE }, cachedParentOrigin);
      }, []);

      // Listen for messages from parent
      useEffect(() => {
        const handleMessage = (event) => {
          const { type, data, source } = event.data || {};
          if (source !== HOST_SOURCE) return;

          // Cache parent origin on first valid message
          if (!cachedParentOrigin || cachedParentOrigin === '*') {
            cachedParentOrigin = event.origin;
          }

          // Validate origin against cached parent origin
          if (cachedParentOrigin !== '*' && event.origin !== cachedParentOrigin) return;

          switch (type) {
            case 'setNodes':
              // Validate nodes to ensure all have valid positions
              const validatedNodes = (data || [])
                .filter(node => node && node.id) // Filter out invalid nodes
                .map(node => ({
                  ...node,
                  // Ensure position exists with valid coordinates
                  position: {
                    x: node.position?.x ?? 0,
                    y: node.position?.y ?? 0
                  }
                }));
              setNodes(validatedNodes);
              break;
            case 'setEdges':
              // Validate edge.data and apply styles on load
              const validatedEdges = (data || []).map(edge => ({
                ...edge,
                type: edge.type || 'orthogonal',
                style: getEdgeStyle(edge.data?.connectionType || 'process-pipe'),
                data: {
                  connectionType: 'process-pipe',
                  midX1: null,
                  midY: null,
                  midX2: null,
                  ...(edge.data || {})  // Preserve existing edge.data
                }
              }));
              setEdges(validatedEdges);
              break;
            case 'addNode':
              setNodes((nds) => nds.concat(data));
              break;
            case 'removeNode':
              setNodes((nds) => nds.filter((n) => n.id !== data));
              setEdges((eds) => eds.filter((e) => e.source !== data && e.target !== data));
              break;
            case 'fitView':
              if (reactFlowInstance) reactFlowInstance.fitView();
              break;
            case 'zoomIn':
              if (reactFlowInstance) reactFlowInstance.zoomIn();
              break;
            case 'zoomOut':
              if (reactFlowInstance) reactFlowInstance.zoomOut();
              break;
            case 'getState':
              notifyParent('state', { nodes: nodesRef.current, edges: edgesRef.current });
              break;
            case 'highlightNode':
              // Highlight a specific node with flash animation
              setHighlightedNodeId(data);
              // Also center the view on the node
              if (reactFlowInstance) {
                const node = nodesRef.current.find(n => n.id === data);
                if (node) {
                  reactFlowInstance.setCenter(node.position.x + 80, node.position.y + 50, { duration: 500, zoom: 1 });
                }
              }
              // Clear highlight after animation
              setTimeout(() => setHighlightedNodeId(null), 1500);
              break;
            case 'updateNodeData':
              // Update a specific node's data (used after linking/unlinking equipment)
              if (data && data.nodeId) {

                // Check if this is a handle type change (source <-> target)
                const handleTypeKeys = Object.keys(data.data || {}).filter(key =>
                  key.includes('Type') || key === 'inlet' || key === 'outlet' ||
                  key === 'top' || key === 'bottom' || key === 'left' || key === 'right' ||
                  key.startsWith('inlet') || key.startsWith('drain')
                );

                if (handleTypeKeys.length > 0) {
                  // A handle type changed - need to update connected edges
                  const nodeId = data.nodeId;

                  // Map handle keys to handle IDs based on node type patterns
                  const getHandleId = (key) => {
                    const keyToHandleId = {
                      'inlet': 'blower-inlet',
                      'outlet': 'blower-outlet',
                      'leftType': ['uv-left', 'radial-left', 'ddt-left', 'algae-left'],
                      'rightType': ['uv-right', 'radial-right', 'ddt-right', 'algae-right'],
                      'bottomType': ['radial-bottom', 'cp-bottom', 'feeder-bottom', 'algae-bottom'],
                      'inletType1': 'inlet-1',
                      'inletType2': 'inlet-2',
                      'inletType3': 'inlet-3',
                      'drainType': 'drain',
                      'topType': ['cp-top', 'feeder-top'],
                      'top': 'inlet-top',
                      'bottom': 'inlet-bottom',
                      'top1Type': 'algae-top1',
                      'top2Type': 'algae-top2',
                      'top3Type': 'algae-top3',
                      'top4Type': 'algae-top4',
                      'backflushType': 'uf-backflush',
                      'feedType': 'uf-feed',
                      'cleanWaterType': 'uf-cleanwater',
                      'plc1Type': 'uf-plc1',
                      'plc2Type': 'uf-plc2',
                      'plc3Type': 'uf-plc3',
                      'elec1Type': 'uf-elec1',
                      'elec2Type': 'uf-elec2',
                      'elec3Type': 'uf-elec3',
                      'sideDrainType': 'ddt-sideDrain',
                      'bottomLeftType': 'ddt-bottomLeft',
                      'bottomRightType': 'ddt-bottomRight'
                    };
                    return keyToHandleId[key] || key;
                  };

                  const matchesHandleId = (edgeHandleId, mappedHandleId) => {
                    if (Array.isArray(mappedHandleId)) {
                      return mappedHandleId.includes(edgeHandleId);
                    }
                    return edgeHandleId === mappedHandleId;
                  };

                  handleTypeKeys.forEach(key => {
                    const newType = data.data[key];
                    const handleIds = getHandleId(key);


                    setEdges((eds) => eds.map((edge) => {
                      if (edge.source === nodeId && matchesHandleId(edge.sourceHandle, handleIds)) {
                        if (newType === 'target') {
                          return {
                            ...edge,
                            source: edge.target,
                            target: edge.source,
                            sourceHandle: edge.targetHandle,
                            targetHandle: edge.sourceHandle
                          };
                        }
                      }
                      if (edge.target === nodeId && matchesHandleId(edge.targetHandle, handleIds)) {
                        if (newType === 'source') {
                          return {
                            ...edge,
                            source: edge.target,
                            target: edge.source,
                            sourceHandle: edge.targetHandle,
                            targetHandle: edge.sourceHandle
                          };
                        }
                      }
                      return edge;
                    }));
                  });
                }

                setNodes((nds) => {
                  const updatedNodes = nds.map((n) =>
                    n.id === data.nodeId
                      ? { ...n, data: { ...n.data, ...data.data } }
                      : n
                  );
                  return updatedNodes;
                });
              }
              break;
            case 'updateEdgeData':
              // Update a specific edge's data (used for changing connection type)
              if (data && data.edgeId) {
                setEdges((eds) => eds.map((e) =>
                  e.id === data.edgeId
                    ? {
                        ...e,
                        data: { ...e.data, ...data.data },
                        style: getEdgeStyle(data.data?.connectionType || e.data?.connectionType)
                      }
                    : e
                ));
              }
              break;

            // ============================================
            // SCADA Overlay Messages (Parent → iframe)
            // ============================================
            case 'setEditorMode': {
              // { mode: 'pid'|'hmi'|'plc'|'runtime'|'debug' }
              const editorMode = data && data.mode;
              setNodes((nds) => nds.map((n) => {
                if (n.type === 'scadaWidget') {
                  // HMI mode: scadaWidget draggable, P&ID nodes locked
                  return { ...n, draggable: editorMode === 'hmi', selectable: editorMode === 'hmi' || editorMode === 'pid' };
                }
                // P&ID nodes: draggable only in pid mode
                return { ...n, draggable: editorMode === 'pid', selectable: editorMode === 'pid' || editorMode === 'hmi' };
              }));
              break;
            }
            case 'addOverlayNode': {
              // { node: { id, type:'scadaWidget', position, data } }
              const overlayNode = data && data.node;
              if (overlayNode && overlayNode.id) {
                const newOverlay = {
                  ...overlayNode,
                  type: overlayNode.type || 'scadaWidget',
                  position: { x: overlayNode.position?.x || 0, y: overlayNode.position?.y || 0 },
                  zIndex: 500,
                };
                setNodes((nds) => nds.concat(newOverlay));
                notifyParent('nodeAdded', newOverlay);
              }
              break;
            }
            case 'removeOverlayNode': {
              // { nodeId }
              const removeId = data && data.nodeId;
              if (removeId) {
                setNodes((nds) => nds.filter((n) => n.id !== removeId));
                setEdges((eds) => eds.filter((e) => e.source !== removeId && e.target !== removeId));
              }
              break;
            }
            case 'updateOverlayNode': {
              // { nodeId, data: Partial }
              const updateId = data && data.nodeId;
              const updateData = data && data.data;
              if (updateId && updateData) {
                setNodes((nds) => nds.map((n) =>
                  n.id === updateId ? { ...n, data: { ...n.data, ...updateData } } : n
                ));
              }
              break;
            }
            case 'updateLiveValues': {
              // { values: Record<tagName, any> } — batch live value update for all scadaWidget nodes
              const values = data && data.values;
              if (values && typeof values === 'object') {
                setNodes((nds) => nds.map((n) => {
                  if (n.type !== 'scadaWidget') return n;
                  const tagName = n.data && n.data.tagName;
                  if (tagName && values[tagName] !== undefined) {
                    return { ...n, data: { ...n.data, liveValue: values[tagName] } };
                  }
                  return n;
                }));
              }
              break;
            }
            case 'setNodeVisibility': {
              // { nodeIds: string[], visible: boolean } — multi-screen toggle
              const nodeIds = data && data.nodeIds;
              const visible = data && data.visible;
              if (Array.isArray(nodeIds)) {
                const idSet = new Set(nodeIds);
                setNodes((nds) => nds.map((n) =>
                  idSet.has(n.id) ? { ...n, hidden: !visible } : n
                ));
              }
              break;
            }
            case 'lockPidNodes': {
              // { locked: boolean } — lock/unlock P&ID nodes' draggable/selectable
              const locked = data && data.locked;
              setNodes((nds) => nds.map((n) => {
                if (n.type === 'scadaWidget') return n; // Don't affect overlay nodes
                return { ...n, draggable: !locked, selectable: true };
              }));
              break;
            }
            case 'getViewport': {
              if (reactFlowInstance) {
                var vp = reactFlowInstance.getViewport();
                notifyParent('viewportState', vp);
              }
              break;
            }
            case 'setViewport': {
              if (reactFlowInstance && data) {
                reactFlowInstance.setViewport({ x: data.x || 0, y: data.y || 0, zoom: data.zoom || 1 });
              }
              break;
            }
            case 'setActiveScreen': {
              var screenId = data && data.screenId;
              if (screenId) {
                setNodes(function(nds) { return nds.map(function(n) {
                  if (n.type === 'scadaWidget') {
                    return { ...n, hidden: n.data && n.data.screenId !== screenId };
                  }
                  return n;
                }); });
              }
              break;
            }
            default:
              break;
          }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
      }, [reactFlowInstance, setNodes, setEdges, notifyParent]);


      // Notify parent when nodes change
      useEffect(() => {
        notifyParent('nodesChange', nodes);
      }, [nodes, notifyParent]);

      // Notify parent when edges change
      useEffect(() => {
        notifyParent('edgesChange', edges);
      }, [edges, notifyParent]);

      // Notify parent when ready
      useEffect(() => {
        if (reactFlowInstance) {
          notifyParent('ready', { ready: true });
        }
      }, [reactFlowInstance, notifyParent]);


      // Add highlight class to nodes when highlighted
      const displayNodes = useMemo(() =>
        nodes.map(node => ({
          ...node,
          className: node.id === highlightedNodeId ? 'node-highlighted' : ''
        })),
        [nodes, highlightedNodeId]
      );

      // Apply P&ID connection type styles to edges
      const displayEdges = useMemo(() =>
        edges.map(edge => ({
          ...edge,
          style: {
            ...edge.style,
            ...getEdgeStyle(edge.data?.connectionType)
          }
        })),
        [edges]
      );

      return h('div', {
        ref: reactFlowWrapper,
        style: { width: '100%', height: '100%' }
      },
        h(ReactFlow, {
          nodes: displayNodes,
          edges: displayEdges,
          onNodesChange: onNodesChange,
          onEdgesChange: onEdgesChange,
          onConnect: onConnect,
          onNodeClick: onNodeClick,
          onEdgeClick: onEdgeClick,
          onPaneClick: onPaneClick,
          onNodeDragStop: onNodeDragStop,
          onNodesDelete: onNodesDelete,
          onDrop: onDrop,
          onDragOver: onDragOver,
          onInit: setReactFlowInstance,
          nodeTypes: nodeTypes,
          edgeTypes: edgeTypes,
          defaultEdgeOptions: defaultEdgeOptions,
          fitView: true,
          snapToGrid: true,
          snapGrid: [15, 15],
          connectionLineStyle: { stroke: '#1f2937', strokeWidth: 3 },
          deleteKeyCode: ['Backspace', 'Delete'],
        }, [
          h(Controls, { key: 'controls', position: 'bottom-left' }),
          h(MiniMap, {
            key: 'minimap',
            position: 'bottom-right',
            nodeColor: (node) => getStatusColor(node.data?.status),
            maskColor: 'rgba(0, 0, 0, 0.1)'
          }),
          h(Background, {
            key: 'background',
            variant: 'dots',
            gap: 15,
            size: 1,
            color: '#d1d5db'
          })
        ])
      );
    }

    // Render the app
    const root = createRoot(document.getElementById('root'));
    root.render(
      h(ReactFlowProvider, null,
        h(ProcessEditorCanvas)
      )
    );
