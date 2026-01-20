/**
 * AutomaticFeederNode Component
 * Automatic fish feeder with hopper and dispenser visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface AutomaticFeederNodeData {
  label?: string;
  bottomType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 100;
const HEIGHT = 140;

const AutomaticFeederNode: React.FC<NodeProps<AutomaticFeederNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [bottomType, setBottomType] = useState<HandleType>(data?.bottomType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (e: React.MouseEvent) => {
    if (isScadaMode) return;
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = bottomType === 'source' ? 'target' : 'source';
    setBottomType(newType);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, bottomType: newType } } : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, bottomType, updateNodeInternals]);

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        position: 'relative',
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 100 140">
        <defs>
          <linearGradient id={`feeder-hopper-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#455A64" />
            <stop offset="50%" stopColor="#607D8B" />
            <stop offset="100%" stopColor="#455A64" />
          </linearGradient>
          <linearGradient id={`feeder-feed-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#8D6E63" />
            <stop offset="100%" stopColor="#5D4037" />
          </linearGradient>
        </defs>

        {/* Hopper (funnel shape) */}
        <path
          d="M 20 10 L 80 10 L 65 60 L 35 60 Z"
          fill={`url(#feeder-hopper-${id})`}
          stroke="#37474F"
          strokeWidth={2}
        />

        {/* Feed level */}
        <path
          d="M 28 25 L 72 25 L 62 55 L 38 55 Z"
          fill={`url(#feeder-feed-${id})`}
        />

        {/* Motor housing */}
        <rect x={30} y={60} width={40} height={25} rx={3} fill="#546E7A" stroke="#37474F" strokeWidth={1} />

        {/* Motor indicator */}
        <circle cx={50} cy={72} r={8} fill="#78909C" stroke="#455A64" strokeWidth={1} />
        <circle cx={50} cy={72} r={3} fill="#263238" />

        {/* Dispenser tube */}
        <rect x={42} y={85} width={16} height={35} rx={2} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Feed particles falling */}
        <circle cx={46} cy={95} r={2} fill="#8D6E63" />
        <circle cx={54} cy={100} r={2} fill="#8D6E63" />
        <circle cx={50} cy={108} r={2} fill="#8D6E63" />
        <circle cx={48} cy={115} r={2} fill="#8D6E63" />

        {/* Label */}
        <text x={50} y={135} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Auto Feeder'}</text>
      </svg>

      {/* Bottom Handle (feed output) */}
      <div
        style={{ position: 'absolute', left: 50, top: 120, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle}
      >
        <Handle
          id={`feeder-out-${bottomType}`}
          type={bottomType}
          position={Position.Bottom}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(bottomType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'automaticFeeder',
  label: 'Automatic Feeder',
  labelTr: 'Otomatik Yemlik',
  category: 'feeding',
  description: 'Automatic fish feeder with timer',
  component: AutomaticFeederNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['automatic_feeder', 'feeder', 'auto_feeder'],
});

export default AutomaticFeederNode;
