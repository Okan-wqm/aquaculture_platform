import React, { useEffect, useState } from 'react';
import { Handle, Node, useUpdateNodeInternals } from 'reactflow';

interface LobeBlowerProps {
  id: string;
  data: {
    inlet?: 'source' | 'target';
    outlet?: 'source' | 'target';
    rotation?: number;
  };
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
}

const width = 200;
const height = 140;

function rotatePoint(x: number, y: number, cx: number, cy: number, angleDeg: number) {
  const angleRad = (angleDeg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  const rx = dx * Math.cos(angleRad) - dy * Math.sin(angleRad) + cx;
  const ry = dx * Math.sin(angleRad) + dy * Math.cos(angleRad) + cy;
  return { left: rx, top: ry };
}

const LobeBlower: React.FC<LobeBlowerProps> & {
  defaultHandles: { inlet: 'source' | 'target'; outlet: 'source' | 'target' };
} = ({ id, data, setNodes }) => {
  const [inlet, setInlet] = useState(data?.inlet || LobeBlower.defaultHandles.inlet);
  const [outlet, setOutlet] = useState(data?.outlet || LobeBlower.defaultHandles.outlet);
  const rotation = data?.rotation || 0;
  const updateNodeInternals = useUpdateNodeInternals();

  const inletColor = inlet === 'source' ? 'red' : 'blue';
  const outletColor = outlet === 'source' ? 'red' : 'blue';

  const centerX = width / 2;
  const centerY = height / 2;

  const inletPos = rotatePoint(50, 70, centerX, centerY, rotation);
  const outletPos = rotatePoint(185, 70, centerX, centerY, rotation);

  const toggleHandle = (
    e: React.MouseEvent,
    current: 'source' | 'target',
    setFunc: React.Dispatch<React.SetStateAction<'source' | 'target'>>,
    key: keyof LobeBlowerProps['data']
  ) => {
    e.preventDefault();
    const newVal = current === 'source' ? 'target' : 'source';
    setFunc(newVal);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, [key]: newVal } } : node
      )
    );
  };

  const rotateNode = () => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? {
              ...node,
              data: {
                ...node.data,
                rotation: ((node.data?.rotation || 0) + 90) % 360,
              },
            }
          : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inlet, outlet, rotation, updateNodeInternals]);

  return (
    <div
      style={{
        width,
        height,
        position: 'relative',
        pointerEvents: 'none',
      }}
    >
      {/* Döndürme butonu */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          rotateNode();
        }}
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

      {/* Dönen SVG */}
      <div
        style={{
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          width,
          height,
          pointerEvents: 'auto',
        }}
      >
        <svg width={width} height={height}>
          <rect x="50" y="40" width="100" height="60" rx="12" fill="#cfd8dc" stroke="#444" strokeWidth="2" />
          <circle cx="75" cy="70" r="18" fill="#90caf9" stroke="#333" strokeWidth="1.5" />
          <path d="M75 52 A18 18 0 0 1 75 88 A18 18 0 0 1 75 52" fill="none" stroke="#1976d2" strokeWidth="1" />
          <circle cx="125" cy="70" r="18" fill="#90caf9" stroke="#333" strokeWidth="1.5" />
          <path d="M125 52 A18 18 0 0 1 125 88 A18 18 0 0 1 125 52" fill="none" stroke="#1976d2" strokeWidth="1" />
          <circle cx="100" cy="70" r="6" fill="#455a64" stroke="#222" strokeWidth="1.5" />
          <rect x="150" y="50" width="35" height="40" rx="4" fill="#90a4ae" stroke="#333" strokeWidth="2" />
          <circle cx="168" cy="70" r="6" fill="#212121" />
          <text x="168" y="75" fontSize="9" fill="#fff" textAnchor="middle">M</text>
          <text x="100" y="125" textAnchor="middle" fontSize="12" fill="#000">Lobe Blower</text>
        </svg>
      </div>

      {/* Dinamik Inlet Handle */}
      <Handle
        id={`blower-inlet-${inlet}`}
        type={inlet}
        onContextMenu={(e) => toggleHandle(e, inlet, setInlet, 'inlet')}
        style={{
          position: 'absolute',
          left: inletPos.left,
          top: inletPos.top,
          width: 10,
          height: 10,
          background: inletColor,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
          cursor: 'pointer',
        }}
      />

      {/* Dinamik Outlet Handle */}
      <Handle
        id={`blower-outlet-${outlet}`}
        type={outlet}
        onContextMenu={(e) => toggleHandle(e, outlet, setOutlet, 'outlet')}
        style={{
          position: 'absolute',
          left: outletPos.left,
          top: outletPos.top,
          width: 10,
          height: 10,
          background: outletColor,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
          cursor: 'pointer',
        }}
      />
    </div>
  );
};

LobeBlower.defaultHandles = {
  inlet: 'target',
  outlet: 'source',
};

export default LobeBlower;
