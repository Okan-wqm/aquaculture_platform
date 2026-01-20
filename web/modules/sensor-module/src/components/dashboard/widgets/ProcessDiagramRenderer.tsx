/**
 * Process Diagram Renderer
 *
 * SVG-based lightweight renderer for process diagrams.
 * Used for dashboard backgrounds and process widgets.
 * Does not use ReactFlow - pure SVG for performance.
 */

import React, { useMemo } from 'react';

// ============================================================================
// Types (matching backend process.entity.ts)
// ============================================================================

export interface ProcessNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    equipmentId?: string;
    equipmentName?: string;
    equipmentCode?: string;
    equipmentType?: string;
    equipmentCategory?: string;
    status?: string;
    label?: string;
    sensorMappings?: SensorMapping[];
    connectionPoints?: Record<string, string>;
    metadata?: Record<string, unknown>;
  };
}

export interface ProcessEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export interface SensorMapping {
  sensorId: string;
  sensorName: string;
  channelId: string;
  channelName: string;
  dataPath: string;
  dataType: string;
  unit?: string;
}

// ============================================================================
// Node Dimensions Map
// ============================================================================

const NODE_DIMENSIONS: Record<string, { w: number; h: number }> = {
  automaticFeeder: { w: 87, h: 150 },
  demandFeeder: { w: 86, h: 150 },
  connectionPoint: { w: 30, h: 30 },
  cp: { w: 30, h: 30 },
  algaeBagRed: { w: 60, h: 150 },
  algaeBagGreen: { w: 60, h: 150 },
  algaeBagYellow: { w: 60, h: 150 },
  tankInlet: { w: 50, h: 80 },
  tank: { w: 120, h: 80 },
  pump: { w: 80, h: 60 },
  filter: { w: 100, h: 70 },
  blower: { w: 80, h: 80 },
  uv: { w: 60, h: 100 },
  sensor: { w: 60, h: 60 },
  default: { w: 120, h: 80 },
};

// Status colors
const STATUS_COLORS: Record<string, string> = {
  operational: '#10B981',
  active: '#10B981',
  running: '#10B981',
  maintenance: '#F59E0B',
  warning: '#F59E0B',
  repair: '#EF4444',
  critical: '#EF4444',
  offline: '#6B7280',
  inactive: '#6B7280',
  default: '#0EA5E9',
};

// ============================================================================
// Specialized SVG Renderers
// ============================================================================

/**
 * Render Automatic Feeder SVG
 */
const renderAutomaticFeeder = (x: number, y: number, displayName: string) => (
  <g key={`af-${x}-${y}`} transform={`translate(${x}, ${y})`}>
    <svg width="87" height="150" viewBox="0 0 220 380" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="hopperGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#4a5568"/>
          <stop offset="50%" stopColor="#718096"/>
          <stop offset="100%" stopColor="#4a5568"/>
        </linearGradient>
        <linearGradient id="motorGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2d3748"/>
          <stop offset="100%" stopColor="#1a202c"/>
        </linearGradient>
        <linearGradient id="pelletGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#d69e2e"/>
          <stop offset="100%" stopColor="#b7791f"/>
        </linearGradient>
      </defs>

      {/* Main Hopper */}
      <path d="M40 20 L180 20 L160 140 L60 140 Z" fill="url(#hopperGradient)" stroke="#2d3748" strokeWidth="3"/>
      <ellipse cx="110" cy="20" rx="70" ry="15" fill="#718096" stroke="#2d3748" strokeWidth="2"/>

      {/* Pellets in hopper */}
      <g>
        <circle cx="90" cy="50" r="8" fill="url(#pelletGradient)"/>
        <circle cx="110" cy="45" r="7" fill="url(#pelletGradient)"/>
        <circle cx="130" cy="52" r="8" fill="url(#pelletGradient)"/>
        <circle cx="100" cy="70" r="6" fill="url(#pelletGradient)"/>
        <circle cx="120" cy="68" r="7" fill="url(#pelletGradient)"/>
        <circle cx="105" cy="90" r="5" fill="url(#pelletGradient)"/>
        <circle cx="115" cy="88" r="6" fill="url(#pelletGradient)"/>
      </g>

      {/* Motor Housing */}
      <rect x="70" y="145" width="80" height="60" rx="5" fill="url(#motorGradient)" stroke="#1a202c" strokeWidth="2"/>
      <circle cx="110" cy="175" r="20" fill="#4a5568" stroke="#2d3748" strokeWidth="2"/>
      <circle cx="110" cy="175" r="8" fill="#1a202c"/>

      {/* Ventilation slots */}
      <g stroke="#1a202c" strokeWidth="2">
        <line x1="75" y1="155" x2="95" y2="155"/>
        <line x1="75" y1="162" x2="95" y2="162"/>
        <line x1="125" y1="155" x2="145" y2="155"/>
        <line x1="125" y1="162" x2="145" y2="162"/>
      </g>

      {/* Auger Tube */}
      <rect x="95" y="205" width="30" height="120" fill="#718096" stroke="#4a5568" strokeWidth="2"/>

      {/* Auger spiral */}
      <g stroke="#2d3748" strokeWidth="3" fill="none">
        <path d="M95 220 Q110 225 125 220"/>
        <path d="M95 245 Q110 250 125 245"/>
        <path d="M95 270 Q110 275 125 270"/>
        <path d="M95 295 Q110 300 125 295"/>
      </g>

      {/* Discharge outlet */}
      <path d="M95 325 L80 360 L140 360 L125 325 Z" fill="#4a5568" stroke="#2d3748" strokeWidth="2"/>

      {/* Falling pellets */}
      <g>
        <circle cx="105" cy="345" r="4" fill="url(#pelletGradient)"/>
        <circle cx="115" cy="352" r="3" fill="url(#pelletGradient)"/>
        <circle cx="108" cy="358" r="4" fill="url(#pelletGradient)"/>
      </g>

      {/* Power connector */}
      <rect x="155" y="155" width="25" height="20" rx="3" fill="#e53e3e" stroke="#c53030" strokeWidth="2"/>
      <text x="167" y="169" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">PWR</text>

      {/* Signal connector */}
      <rect x="155" y="180" width="25" height="20" rx="3" fill="#3182ce" stroke="#2b6cb0" strokeWidth="2"/>
      <text x="167" y="194" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">SIG</text>

      {/* Mounting brackets */}
      <rect x="30" y="130" width="15" height="30" fill="#2d3748"/>
      <rect x="175" y="130" width="15" height="30" fill="#2d3748"/>
      <circle cx="37" cy="137" r="4" fill="#718096"/>
      <circle cx="37" cy="153" r="4" fill="#718096"/>
      <circle cx="183" cy="137" r="4" fill="#718096"/>
      <circle cx="183" cy="153" r="4" fill="#718096"/>
    </svg>

    {/* Label */}
    <text
      x={43}
      y={160}
      textAnchor="middle"
      fontSize={10}
      fontFamily="system-ui, sans-serif"
      fill="#374151"
      fontWeight={500}
    >
      {displayName.length > 12 ? displayName.substring(0, 10) + '...' : displayName}
    </text>
  </g>
);

/**
 * Render Demand Feeder SVG
 */
const renderDemandFeeder = (x: number, y: number, displayName: string) => (
  <g key={`df-${x}-${y}`} transform={`translate(${x}, ${y})`}>
    <svg width="86" height="150" viewBox="0 0 200 350" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="dfHopperGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#4a5568"/>
          <stop offset="50%" stopColor="#718096"/>
          <stop offset="100%" stopColor="#4a5568"/>
        </linearGradient>
        <linearGradient id="dfPelletGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#d69e2e"/>
          <stop offset="100%" stopColor="#b7791f"/>
        </linearGradient>
      </defs>

      {/* Main Hopper */}
      <path d="M30 20 L170 20 L140 160 L60 160 Z" fill="url(#dfHopperGradient)" stroke="#2d3748" strokeWidth="3"/>
      <ellipse cx="100" cy="20" rx="70" ry="15" fill="#718096" stroke="#2d3748" strokeWidth="2"/>

      {/* Pellets in hopper */}
      <g>
        <circle cx="80" cy="50" r="8" fill="url(#dfPelletGradient)"/>
        <circle cx="100" cy="45" r="7" fill="url(#dfPelletGradient)"/>
        <circle cx="120" cy="52" r="8" fill="url(#dfPelletGradient)"/>
        <circle cx="90" cy="75" r="6" fill="url(#dfPelletGradient)"/>
        <circle cx="110" cy="72" r="7" fill="url(#dfPelletGradient)"/>
        <circle cx="95" cy="100" r="5" fill="url(#dfPelletGradient)"/>
        <circle cx="105" cy="98" r="6" fill="url(#dfPelletGradient)"/>
        <circle cx="100" cy="125" r="4" fill="url(#dfPelletGradient)"/>
      </g>

      {/* Discharge tube */}
      <rect x="85" y="160" width="30" height="40" fill="#4a5568" stroke="#2d3748" strokeWidth="2"/>

      {/* Discharge opening */}
      <ellipse cx="100" cy="200" rx="15" ry="8" fill="#2d3748" stroke="#1a202c" strokeWidth="2"/>

      {/* Pendulum assembly */}
      <g>
        {/* Pendulum rod */}
        <line x1="100" y1="200" x2="100" y2="280" stroke="#718096" strokeWidth="6"/>

        {/* Activation plate */}
        <ellipse cx="100" cy="290" rx="35" ry="12" fill="#e2e8f0" stroke="#a0aec0" strokeWidth="2"/>

        {/* Pendulum pivot */}
        <circle cx="100" cy="200" r="8" fill="#2d3748" stroke="#1a202c" strokeWidth="2"/>
      </g>

      {/* Falling pellets */}
      <g>
        <circle cx="95" cy="220" r="4" fill="url(#dfPelletGradient)"/>
        <circle cx="105" cy="235" r="3" fill="url(#dfPelletGradient)"/>
        <circle cx="100" cy="250" r="4" fill="url(#dfPelletGradient)"/>
      </g>

      {/* Mounting hardware */}
      <rect x="20" y="10" width="12" height="25" fill="#2d3748"/>
      <rect x="168" y="10" width="12" height="25" fill="#2d3748"/>
      <circle cx="26" cy="17" r="4" fill="#718096"/>
      <circle cx="26" cy="28" r="4" fill="#718096"/>
      <circle cx="174" cy="17" r="4" fill="#718096"/>
      <circle cx="174" cy="28" r="4" fill="#718096"/>

      {/* Support chains */}
      <g stroke="#718096" strokeWidth="3" fill="none">
        <path d="M26 35 L26 0"/>
        <path d="M174 35 L174 0"/>
      </g>
    </svg>

    {/* Label */}
    <text
      x={43}
      y={160}
      textAnchor="middle"
      fontSize={10}
      fontFamily="system-ui, sans-serif"
      fill="#374151"
      fontWeight={500}
    >
      {displayName.length > 12 ? displayName.substring(0, 10) + '...' : displayName}
    </text>
  </g>
);

/**
 * Render Connection Point (CP) SVG
 */
const renderConnectionPoint = (x: number, y: number, displayName: string) => (
  <g key={`cp-${x}-${y}`} transform={`translate(${x}, ${y})`}>
    <circle cx={15} cy={15} r={12} fill="#ffcc00" stroke="#333" strokeWidth={2} />
    <text
      x={15}
      y={19}
      textAnchor="middle"
      fontSize={8}
      fontFamily="system-ui, sans-serif"
      fill="#333"
      fontWeight="bold"
    >
      CP
    </text>
  </g>
);

/**
 * Render default node with icon
 */
const renderDefaultNode = (node: ProcessNode, displayName: string, statusColor: string) => {
  const { position, data } = node;
  const dims = NODE_DIMENSIONS[node.type] || NODE_DIMENSIONS.default;
  const { equipmentType, equipmentCategory } = data;

  // Equipment type to SVG icon mapping
  const EQUIPMENT_ICONS: Record<string, string> = {
    tank: 'M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zM4 18V6h16v12H4z',
    pump: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    filter: 'M3 4h18v2H3V4zm2 4h14v2H5V8zm2 4h10v2H7v-2zm2 4h6v2H9v-2z',
    sensor: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    blower: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z',
    uv: 'M12 18a6 6 0 100-12 6 6 0 000 12zm0-14v2m0 12v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
    default: 'M4 4h16v16H4V4z',
  };

  const iconPath = EQUIPMENT_ICONS[equipmentType?.toLowerCase() || '']
    || EQUIPMENT_ICONS[equipmentCategory?.toLowerCase() || '']
    || EQUIPMENT_ICONS.default;

  const ICON_SIZE = 32;

  return (
    <g transform={`translate(${position.x}, ${position.y})`}>
      {/* Node background */}
      <rect
        x={0}
        y={0}
        width={dims.w}
        height={dims.h}
        rx={8}
        ry={8}
        fill="white"
        stroke={statusColor}
        strokeWidth={2}
        filter="drop-shadow(0 2px 4px rgba(0,0,0,0.1))"
      />

      {/* Status indicator */}
      <circle
        cx={dims.w - 12}
        cy={12}
        r={5}
        fill={statusColor}
      />

      {/* Equipment icon */}
      <g transform={`translate(${(dims.w - ICON_SIZE) / 2}, 12)`}>
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox="0 0 24 24"
          fill="none"
          stroke={statusColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={iconPath} />
        </svg>
      </g>

      {/* Equipment name */}
      <text
        x={dims.w / 2}
        y={dims.h - 12}
        textAnchor="middle"
        fontSize={10}
        fontFamily="system-ui, sans-serif"
        fill="#374151"
        fontWeight={500}
      >
        {displayName.length > 14 ? displayName.substring(0, 12) + '...' : displayName}
      </text>
    </g>
  );
};

// ============================================================================
// Helper Components
// ============================================================================

interface ProcessNodeIconProps {
  node: ProcessNode;
}

const ProcessNodeIcon: React.FC<ProcessNodeIconProps> = ({ node }) => {
  const { position, data, type } = node;
  const { status } = data;
  const displayName = data.equipmentName || data.label || 'Unknown';
  const statusColor = STATUS_COLORS[status?.toLowerCase() || ''] || STATUS_COLORS.default;

  // Dispatch to specialized renderers based on node type
  const nodeType = type?.toLowerCase() || '';

  switch (nodeType) {
    case 'automaticfeeder':
    case 'automatic-feeder':
    case 'autofeeder':
      return renderAutomaticFeeder(position.x, position.y, displayName);

    case 'demandfeeder':
    case 'demand-feeder':
      return renderDemandFeeder(position.x, position.y, displayName);

    case 'connectionpoint':
    case 'connection-point':
    case 'cp':
      return renderConnectionPoint(position.x, position.y, displayName);

    default:
      return renderDefaultNode(node, displayName, statusColor);
  }
};

interface ProcessEdgePathProps {
  edge: ProcessEdge;
  nodes: ProcessNode[];
}

const ProcessEdgePath: React.FC<ProcessEdgePathProps> = ({ edge, nodes }) => {
  const sourceNode = nodes.find(n => n.id === edge.source);
  const targetNode = nodes.find(n => n.id === edge.target);

  if (!sourceNode || !targetNode) return null;

  // Calculate connection points with dynamic dimensions
  const getHandlePosition = (node: ProcessNode, handle?: string, isSource: boolean = true) => {
    const { x, y } = node.position;
    const nodeType = node.type?.toLowerCase() || '';
    const dims = NODE_DIMENSIONS[nodeType] || NODE_DIMENSIONS.default;

    // Connection Point specific handles
    if (nodeType === 'connectionpoint' || nodeType === 'connection-point' || nodeType === 'cp') {
      switch (handle) {
        case 'cp-top':
          return { x: x + 15, y: y + 3 };
        case 'cp-bottom':
          return { x: x + 15, y: y + 27 };
        case 'cp-left':
          return { x: x + 3, y: y + 15 };
        case 'cp-right':
          return { x: x + 27, y: y + 15 };
        case 'top':
          return { x: x + 15, y };
        case 'bottom':
          return { x: x + 15, y: y + 30 };
        case 'left':
          return { x, y: y + 15 };
        case 'right':
          return { x: x + 30, y: y + 15 };
      }
    }

    // Automatic Feeder specific handles
    if (nodeType === 'automaticfeeder' || nodeType === 'automatic-feeder' || nodeType === 'autofeeder') {
      switch (handle) {
        case 'power':
          return { x: x + 87, y: y + 60 };
        case 'signal':
          return { x: x + 87, y: y + 75 };
        case 'top':
          return { x: x + 43, y };
        case 'bottom':
          return { x: x + 43, y: y + 150 };
        case 'left':
          return { x, y: y + 75 };
        case 'right':
          return { x: x + 87, y: y + 75 };
      }
    }

    // Demand Feeder specific handles
    if (nodeType === 'demandfeeder' || nodeType === 'demand-feeder') {
      switch (handle) {
        case 'top':
          return { x: x + 43, y };
        case 'bottom':
          return { x: x + 43, y: y + 150 };
        case 'left':
          return { x, y: y + 75 };
        case 'right':
          return { x: x + 86, y: y + 75 };
      }
    }

    // Standard handle positions
    switch (handle) {
      case 'top':
        return { x: x + dims.w / 2, y };
      case 'right':
        return { x: x + dims.w, y: y + dims.h / 2 };
      case 'bottom':
        return { x: x + dims.w / 2, y: y + dims.h };
      case 'left':
        return { x, y: y + dims.h / 2 };
      default:
        // Default to right for source, left for target
        return isSource
          ? { x: x + dims.w, y: y + dims.h / 2 }
          : { x, y: y + dims.h / 2 };
    }
  };

  const start = getHandlePosition(sourceNode, edge.sourceHandle, true);
  const end = getHandlePosition(targetNode, edge.targetHandle, false);

  // Create smooth bezier curve
  const controlPointOffset = Math.abs(end.x - start.x) / 2;
  const d = `M ${start.x} ${start.y} C ${start.x + controlPointOffset} ${start.y}, ${end.x - controlPointOffset} ${end.y}, ${end.x} ${end.y}`;

  return (
    <g>
      {/* Edge path */}
      <path
        d={d}
        fill="none"
        stroke="#94A3B8"
        strokeWidth={2}
        strokeLinecap="round"
      />
      {/* Arrow marker at end */}
      <circle
        cx={end.x}
        cy={end.y}
        r={4}
        fill="#94A3B8"
      />
    </g>
  );
};

// ============================================================================
// Main Component
// ============================================================================

interface ProcessDiagramRendererProps {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  readonly?: boolean;
  fitView?: boolean;
  className?: string;
}

export const ProcessDiagramRenderer: React.FC<ProcessDiagramRendererProps> = ({
  nodes,
  edges,
  readonly = true,
  fitView = false,
  className = '',
}) => {
  // Calculate bounds with dynamic dimensions
  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach((node) => {
      const nodeType = node.type?.toLowerCase() || '';
      const dims = NODE_DIMENSIONS[nodeType] || NODE_DIMENSIONS.default;

      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + dims.w);
      maxY = Math.max(maxY, node.position.y + dims.h);
    });

    return { minX, minY, maxX, maxY };
  }, [nodes]);

  const width = bounds.maxX - bounds.minX + 100;
  const height = bounds.maxY - bounds.minY + 100;
  const padding = 50;

  if (nodes.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-gray-400 ${className}`}>
        No process diagram
      </div>
    );
  }

  return (
    <svg
      viewBox={
        fitView
          ? `${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`
          : undefined
      }
      className={`w-full h-full ${className}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ minWidth: fitView ? undefined : width, minHeight: fitView ? undefined : height }}
    >
      {/* Background grid pattern */}
      <defs>
        <pattern
          id="process-grid"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r="1" fill="#E5E7EB" />
        </pattern>

        {/* Gradients for feeders (defined once) */}
        <linearGradient id="hopperGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#4a5568"/>
          <stop offset="50%" stopColor="#718096"/>
          <stop offset="100%" stopColor="#4a5568"/>
        </linearGradient>
        <linearGradient id="motorGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2d3748"/>
          <stop offset="100%" stopColor="#1a202c"/>
        </linearGradient>
        <linearGradient id="pelletGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#d69e2e"/>
          <stop offset="100%" stopColor="#b7791f"/>
        </linearGradient>
        <linearGradient id="dfHopperGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#4a5568"/>
          <stop offset="50%" stopColor="#718096"/>
          <stop offset="100%" stopColor="#4a5568"/>
        </linearGradient>
        <linearGradient id="dfPelletGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#d69e2e"/>
          <stop offset="100%" stopColor="#b7791f"/>
        </linearGradient>
      </defs>

      {/* Background */}
      <rect
        x={fitView ? bounds.minX - padding : 0}
        y={fitView ? bounds.minY - padding : 0}
        width={fitView ? width : '100%'}
        height={fitView ? height : '100%'}
        fill="url(#process-grid)"
      />

      {/* Render edges first (behind nodes) */}
      <g className="edges">
        {edges.map((edge) => (
          <ProcessEdgePath key={edge.id} edge={edge} nodes={nodes} />
        ))}
      </g>

      {/* Render nodes */}
      <g className="nodes">
        {nodes.map((node) => (
          <ProcessNodeIcon key={node.id} node={node} />
        ))}
      </g>
    </svg>
  );
};

export default ProcessDiagramRenderer;
