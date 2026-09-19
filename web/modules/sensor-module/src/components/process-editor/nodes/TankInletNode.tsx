/**
 * TankInletNode Component
 * Water inlet pipe with rotation support and toggleable handles
 */

import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals, NodeProps, type Node } from '@xyflow/react';
import { useProcessStore } from '../../../store/processStore';
import { colors, colors as themeColors } from '@aquaculture/shared-ui';

type HandleType = 'source' | 'target';

interface TankInletNodeData extends Record<string, unknown> {
  top?: HandleType;
  bottom?: HandleType;
  rotation?: number;
  label?: string;
}

const WIDTH = 100;
const HEIGHT = 160;

const TankInletNode: React.FC<NodeProps<Node<TankInletNodeData>>> = ({ id, data, selected }) => {
  const rotation = data?.rotation ?? 0;
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useProcessStore((state) => state.updateNodeData);

  const [top, setTop] = useState<HandleType>(data?.top ?? 'target');
  const [bottom, setBottom] = useState<HandleType>(data?.bottom ?? 'source');

  const topColor = top === 'source' ? colors.success[500] : colors.info[500];
  const bottomColor = bottom === 'source' ? colors.success[500] : colors.info[500];

  const handleTypeChange = (
    e: React.MouseEvent,
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: 'top' | 'bottom'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const newVal: HandleType = current === 'source' ? 'target' : 'source';
    setFunc(newVal);
    updateNodeData(id, { [key]: newVal } as any);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, top, bottom, rotation, updateNodeInternals]);

  const holeY = [40, 55, 70, 85, 100, 115];

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        position: 'relative',
        pointerEvents: 'none',
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
        border: selected ? `2px solid ${themeColors.info[500]}` : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      <svg width={WIDTH} height={HEIGHT} className="pointer-events-auto">
        {/* Vertical pipe */}
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
        {/* Water holes and flow arrows */}
        {holeY.map((y, i) => (
          <g key={i}>
            <circle cx={30} cy={y} r={1.8} fill={colors.primary[100]} />
            <polygon
              points={`${32},${y} ${42},${y - 4} ${42},${y + 4}`}
              fill={colors.primary[400]}
              opacity={0.8}
            />
          </g>
        ))}
        {/* Label */}
        <text x={50} y={150} textAnchor="middle" fontSize={10} fill="#000">
          {data?.label || 'Tank Inlet'}
        </text>
      </svg>

      {/* Top Handle */}
      <div
        className="absolute left-[30px] top-5 w-3 h-3 -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => handleTypeChange(e, top, setTop, 'top')}
      >
        <Handle
          id="tankinlet-top"
          type={top}
          position={undefined as any}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: topColor,
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Bottom Handle */}
      <div
        className="absolute left-[30px] top-[140px] w-3 h-3 -translate-x-1/2 -translate-y-1/2 [pointer-events:all]"
        onContextMenu={(e) => handleTypeChange(e, bottom, setBottom, 'bottom')}
      >
        <Handle
          id="tankinlet-bottom"
          type={bottom}
          position={undefined as any}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: bottomColor,
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

export default TankInletNode;
