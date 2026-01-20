/**
 * BlowerNode Component
 * Lobe Blower with rotation support and toggleable inlet/outlet handles
 */

import React, { useEffect, useState } from 'react';
import { Handle, useUpdateNodeInternals, NodeProps } from 'reactflow';
import { rotatePoint } from '../utils/rotatePoint';
import { useProcessStore } from '../../../store/processStore';

type HandleType = 'source' | 'target';

interface BlowerNodeData {
  inlet?: HandleType;
  outlet?: HandleType;
  rotation?: number;
  label?: string;
}

const WIDTH = 200;
const HEIGHT = 140;

const BlowerNode: React.FC<NodeProps<BlowerNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useProcessStore((state) => state.updateNodeData);

  const [inlet, setInlet] = useState<HandleType>(data?.inlet || 'target');
  const [outlet, setOutlet] = useState<HandleType>(data?.outlet || 'source');
  const rotation = data?.rotation || 0;

  const inletColor = inlet === 'source' ? '#22c55e' : '#3b82f6';
  const outletColor = outlet === 'source' ? '#22c55e' : '#3b82f6';

  const centerX = WIDTH / 2;
  const centerY = HEIGHT / 2;

  // Calculate rotated handle positions
  const inletPos = rotatePoint(centerX, centerY, 50, 70, rotation);
  const outletPos = rotatePoint(centerX, centerY, 185, 70, rotation);

  const toggleHandle = (
    e: React.MouseEvent,
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: 'inlet' | 'outlet'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const newVal: HandleType = current === 'source' ? 'target' : 'source';
    setFunc(newVal);
    updateNodeData(id, { [key]: newVal } as any);
  };

  const rotateNode = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newRotation = ((rotation || 0) + 90) % 360;
    updateNodeData(id, { rotation: newRotation } as any);
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
      {/* Rotation button */}
      <button
        onClick={rotateNode}
        style={{
          position: 'absolute',
          top: 2,
          right: 2,
          zIndex: 10,
          fontSize: 12,
          cursor: 'pointer',
          background: '#eee',
          border: '1px solid #ccc',
          borderRadius: 4,
          padding: '2px 6px',
          pointerEvents: 'all',
        }}
      >
        ↻
      </button>

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
          id="blower-inlet"
          type={inlet}
          position={undefined as any}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: inletColor,
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
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
          id="blower-outlet"
          type={outlet}
          position={undefined as any}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: outletColor,
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>
    </div>
  );
};

export default BlowerNode;
