/**
 * BlowerNode Component
 * Lobe Blower with rotation support and toggleable inlet/outlet handles
 */

import React, { useEffect, useState } from 'react';
import { Handle, useUpdateNodeInternals, useReactFlow, NodeProps, Position } from 'reactflow';
import { rotatePoint } from '../utils/rotatePoint';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface BlowerNodeData {
  inlet?: HandleType;
  outlet?: HandleType;
  rotation?: number;
  label?: string;
  isScadaMode?: boolean;
}

const WIDTH = 200;
const HEIGHT = 140;

const BlowerNode: React.FC<NodeProps<BlowerNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();

  const [inlet, setInlet] = useState<HandleType>(data?.inlet || 'target');
  const [outlet, setOutlet] = useState<HandleType>(data?.outlet || 'source');
  const rotation = data?.rotation || 0;
  const isScadaMode = data?.isScadaMode || false;

  const inletColor = inlet === 'source' ? '#22c55e' : '#3b82f6';
  const outletColor = outlet === 'source' ? '#22c55e' : '#3b82f6';

  const centerX = WIDTH / 2;
  const centerY = HEIGHT / 2;

  // Calculate rotated handle positions
  const inletPos = rotatePoint(centerX, centerY, 50, 70, rotation);
  const outletPos = rotatePoint(centerX, centerY, 185, 70, rotation);

  const updateNodeData = (updates: Partial<BlowerNodeData>) => {
    if (isScadaMode) return; // Read-only in SCADA mode
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, ...updates } }
          : node
      )
    );
  };

  const toggleHandle = (
    e: React.MouseEvent,
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: 'inlet' | 'outlet'
  ) => {
    if (isScadaMode) return; // Read-only in SCADA mode
    e.preventDefault();
    e.stopPropagation();
    const newVal: HandleType = current === 'source' ? 'target' : 'source';
    setFunc(newVal);
    updateNodeData({ [key]: newVal });
  };

  const rotateNode = (e: React.MouseEvent) => {
    if (isScadaMode) return; // Read-only in SCADA mode
    e.stopPropagation();
    const newRotation = ((rotation || 0) + 90) % 360;
    updateNodeData({ rotation: newRotation });
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inlet, outlet, rotation, updateNodeInternals]);

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        position: 'relative',
        pointerEvents: 'none',
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      {/* Rotation button (hidden in SCADA mode) */}
      {!isScadaMode && (
        <button
          onClick={rotateNode}
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            zIndex: 10,
            fontSize: 12,
            cursor: 'pointer',
            background: '#f3f4f6',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            padding: '2px 6px',
            pointerEvents: 'all',
          }}
        >
          ↻
        </button>
      )}

      {/* Rotated SVG */}
      <div
        style={{
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          width: WIDTH,
          height: HEIGHT,
          pointerEvents: 'auto',
        }}
      >
        <svg width={WIDTH} height={HEIGHT}>
          {/* Housing */}
          <rect x="50" y="40" width="100" height="60" rx="12" fill="#cfd8dc" stroke="#444" strokeWidth="2" />
          {/* Left lobe */}
          <circle cx="75" cy="70" r="18" fill="#90caf9" stroke="#333" strokeWidth="1.5" />
          <path d="M75 52 A18 18 0 0 1 75 88 A18 18 0 0 1 75 52" fill="none" stroke="#1976d2" strokeWidth="1" />
          {/* Right lobe */}
          <circle cx="125" cy="70" r="18" fill="#90caf9" stroke="#333" strokeWidth="1.5" />
          <path d="M125 52 A18 18 0 0 1 125 88 A18 18 0 0 1 125 52" fill="none" stroke="#1976d2" strokeWidth="1" />
          {/* Center shaft */}
          <circle cx="100" cy="70" r="6" fill="#455a64" stroke="#222" strokeWidth="1.5" />
          {/* Motor */}
          <rect x="150" y="50" width="35" height="40" rx="4" fill="#90a4ae" stroke="#333" strokeWidth="2" />
          <circle cx="168" cy="70" r="6" fill="#212121" />
          <text x="168" y="75" fontSize="9" fill="#fff" textAnchor="middle">M</text>
          {/* Label */}
          <text x="100" y="125" textAnchor="middle" fontSize="12" fill="#000">
            {data?.label || 'Lobe Blower'}
          </text>
        </svg>
      </div>

      {/* Inlet Handle */}
      <div
        style={{
          position: 'absolute',
          left: inletPos.x,
          top: inletPos.y,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => toggleHandle(e, inlet, setInlet, 'inlet')}
      >
        <Handle
          id={`blower-inlet-${inlet}`}
          type={inlet}
          position={Position.Left}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: inletColor,
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Outlet Handle */}
      <div
        style={{
          position: 'absolute',
          left: outletPos.x,
          top: outletPos.y,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => toggleHandle(e, outlet, setOutlet, 'outlet')}
      >
        <Handle
          id={`blower-outlet-${outlet}`}
          type={outlet}
          position={Position.Right}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: outletColor,
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>
    </div>
  );
};

// Auto-register this node
NodeRegistry.register({
  id: 'blower',
  label: 'Lobe Blower',
  labelTr: 'Root Blower',
  category: 'aeration',
  description: 'Lobe blower with rotation support and toggleable inlet/outlet handles',
  component: BlowerNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  minSize: { width: 150, height: 100 },
  equipmentTypeCodes: ['blower', 'root_blower', 'lobe_blower'],
});

export default BlowerNode;
