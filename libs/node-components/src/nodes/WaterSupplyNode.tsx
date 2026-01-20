/**
 * WaterSupplyNode Component
 * Water supply/intake source
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface WaterSupplyNodeData {
  label?: string;
  outputType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 100;
const HEIGHT = 80;

const WaterSupplyNode: React.FC<NodeProps<WaterSupplyNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [outputType, setOutputType] = useState<HandleType>(data?.outputType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (e: React.MouseEvent) => {
    if (isScadaMode) return;
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = outputType === 'source' ? 'target' : 'source';
    setOutputType(newType);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, outputType: newType } } : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, outputType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 100 80">
        <defs>
          <linearGradient id={`supply-water-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#4FC3F7" stopOpacity={0.8} />
            <stop offset="100%" stopColor="#0288D1" stopOpacity={0.9} />
          </linearGradient>
          <radialGradient id={`supply-wave-${id}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#B3E5FC" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#4FC3F7" stopOpacity={0} />
          </radialGradient>
        </defs>

        {/* Water source circle */}
        <circle cx={40} cy={40} r={30} fill={`url(#supply-water-${id})`} stroke="#0277BD" strokeWidth={2} />

        {/* Wave effect */}
        <circle cx={40} cy={40} r={20} fill={`url(#supply-wave-${id})`} />
        <circle cx={40} cy={40} r={10} fill={`url(#supply-wave-${id})`} />

        {/* Water drops */}
        <path d="M 35 30 Q 35 25 38 28 Q 40 22 42 28 Q 45 25 45 30 Z" fill="#B3E5FC" />
        <path d="M 33 45 Q 33 40 36 43 Q 38 37 40 43 Q 43 40 43 45 Z" fill="#B3E5FC" opacity={0.7} />

        {/* Output arrow indicator */}
        <path d="M 70 40 L 85 40 L 80 35 M 85 40 L 80 45" stroke="#0288D1" strokeWidth={2} fill="none" />

        {/* Outlet pipe */}
        <rect x={70} y={35} width={25} height={10} fill="#42A5F5" stroke="#1E88E5" strokeWidth={1} />

        {/* Label */}
        <text x={40} y={75} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Water Supply'}</text>
      </svg>

      {/* Output Handle */}
      <div
        style={{ position: 'absolute', left: 95, top: 40, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle}
      >
        <Handle
          id={`supply-out-${outputType}`}
          type={outputType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(outputType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'waterSupply',
  label: 'Water Supply',
  labelTr: 'Su Temini',
  category: 'utility',
  description: 'Water supply/intake source',
  component: WaterSupplyNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['water_supply', 'intake', 'water_source'],
});

export default WaterSupplyNode;
