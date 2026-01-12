// src/components/nodes/TankInlet.tsx
import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals, Node } from 'reactflow';

interface TankInletProps {
  id: string;
  data: {
    top?: 'source' | 'target';
    bottom?: 'source' | 'target';
    rotation?: number;
  };
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
}

const TankInlet: React.FC<TankInletProps> & {
  defaultHandles: { top: 'source' | 'target'; bottom: 'source' | 'target' };
} = ({ id, data, setNodes }) => {
  const width = 100;
  const height = 160;
  const rotation = data?.rotation ?? 0;

  const updateNodeInternals = useUpdateNodeInternals();

  const [top, setTop] = useState(data?.top ?? TankInlet.defaultHandles.top);
  const [bottom, setBottom] = useState(
    data?.bottom ?? TankInlet.defaultHandles.bottom
  );

  const topColor = top === 'source' ? 'red' : 'blue';
  const bottomColor = bottom === 'source' ? 'red' : 'blue';

  const handleTypeChange = (
    e: React.MouseEvent,
    current: 'source' | 'target',
    setFunc: React.Dispatch<React.SetStateAction<'source' | 'target'>>,
    key: 'top' | 'bottom'
  ) => {
    e.preventDefault();
    const newVal = current === 'source' ? 'target' : 'source';
    setFunc(newVal);
    setNodes((prev) =>
      prev.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, [key]: newVal } }
          : node
      )
    );
  };

  // rotation da eklendi!
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, top, bottom, rotation, updateNodeInternals]);

  const holeY = [40, 55, 70, 85, 100, 115];

  return (
    <div
      style={{
        width,
        height,
        position: 'relative',
        pointerEvents: 'none',
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
      }}
    >
      <svg width={width} height={height} style={{ pointerEvents: 'auto' }}>
        {/* Gri dikey boru */}
        <rect
          x={25}
          y={20}
          width={10}
          height={120}
          fill="#888"
          stroke="#333"
          strokeWidth={1.5}
          rx={3}
        />
        {/* Delikler ve oklar */}
        {holeY.map((y, i) => (
          <g key={i}>
            <circle cx={30} cy={y} r={1.8} fill="#b3d9ff" />
            <polygon
              points={`${32},${y} ${42},${y - 4} ${42},${y + 4}`}
              fill="#1ca3ec"
              opacity={0.8}
            />
          </g>
        ))}
        <text x={50} y={150} textAnchor="middle" fontSize={10} fill="#000">
          Tank Inlet
        </text>
      </svg>

      {/* Üst Handle */}
      <Handle
        id={`tankinlet-top-${top}`}
        type={top}
        onContextMenu={(e) => handleTypeChange(e, top, setTop, 'top')}
        style={{
          position: 'absolute',
          left: 30,
          top: 20,
          width: 10,
          height: 10,
          background: topColor,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
          cursor: 'pointer',
        }}
      />

      {/* Alt Handle */}
      <Handle
        id={`tankinlet-bottom-${bottom}`}
        type={bottom}
        onContextMenu={(e) => handleTypeChange(e, bottom, setBottom, 'bottom')}
        style={{
          position: 'absolute',
          left: 30,
          top: 140,
          width: 10,
          height: 10,
          background: bottomColor,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
          cursor: 'pointer',
        }}
      />
    </div>
  );
};

TankInlet.defaultHandles = {
  top: 'target',
  bottom: 'source',
};

export default TankInlet;
