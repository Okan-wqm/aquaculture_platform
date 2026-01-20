/**
 * DemandFeederNode Component
 * Demand-activated fish feeder with pendulum trigger
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface DemandFeederNodeData {
  label?: string;
  bottomType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 100;
const HEIGHT = 160;

const DemandFeederNode: React.FC<NodeProps<DemandFeederNodeData>> = ({ id, data, selected }) => {
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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 100 160">
        <defs>
          <linearGradient id={`demand-hopper-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FF8F00" />
            <stop offset="50%" stopColor="#FFA726" />
            <stop offset="100%" stopColor="#FF8F00" />
          </linearGradient>
          <linearGradient id={`demand-feed-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#8D6E63" />
            <stop offset="100%" stopColor="#5D4037" />
          </linearGradient>
        </defs>

        {/* Hopper (funnel shape) */}
        <path
          d="M 20 10 L 80 10 L 60 70 L 40 70 Z"
          fill={`url(#demand-hopper-${id})`}
          stroke="#E65100"
          strokeWidth={2}
        />

        {/* Feed level */}
        <path
          d="M 28 25 L 72 25 L 57 65 L 43 65 Z"
          fill={`url(#demand-feed-${id})`}
        />

        {/* Dispenser plate */}
        <rect x={35} y={70} width={30} height={8} rx={2} fill="#546E7A" stroke="#37474F" strokeWidth={1} />

        {/* Pendulum rod */}
        <line x1={50} y1={78} x2={50} y2={130} stroke="#455A64" strokeWidth={3} />

        {/* Pendulum trigger */}
        <circle cx={50} cy={135} r={10} fill="#E65100" stroke="#BF360C" strokeWidth={2} />
        <circle cx={50} cy={135} r={4} fill="#FF8F00" />

        {/* Spring mechanism */}
        <path
          d="M 35 75 Q 30 80 35 85 Q 40 90 35 95"
          fill="none"
          stroke="#78909C"
          strokeWidth={2}
        />
        <path
          d="M 65 75 Q 70 80 65 85 Q 60 90 65 95"
          fill="none"
          stroke="#78909C"
          strokeWidth={2}
        />

        {/* Label */}
        <text x={50} y={155} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Demand Feeder'}</text>
      </svg>

      {/* Bottom Handle (pendulum/trigger) */}
      <div
        style={{ position: 'absolute', left: 50, top: 135, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle}
      >
        <Handle
          id={`demand-out-${bottomType}`}
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
  id: 'demandFeeder',
  label: 'Demand Feeder',
  labelTr: 'Talep Yemlik',
  category: 'feeding',
  description: 'Demand-activated feeder with pendulum trigger',
  component: DemandFeederNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['demand_feeder', 'pendulum_feeder'],
});

export default DemandFeederNode;
