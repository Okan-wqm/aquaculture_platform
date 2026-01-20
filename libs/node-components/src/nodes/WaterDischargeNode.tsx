/**
 * WaterDischargeNode Component
 * Water discharge/effluent outlet
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface WaterDischargeNodeData {
  label?: string;
  inputType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 100;
const HEIGHT = 80;

const WaterDischargeNode: React.FC<NodeProps<WaterDischargeNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [inputType, setInputType] = useState<HandleType>(data?.inputType || 'target');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (e: React.MouseEvent) => {
    if (isScadaMode) return;
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = inputType === 'source' ? 'target' : 'source';
    setInputType(newType);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, inputType: newType } } : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inputType, updateNodeInternals]);

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
          <linearGradient id={`discharge-water-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#8D6E63" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#5D4037" stopOpacity={0.8} />
          </linearGradient>
        </defs>

        {/* Inlet pipe */}
        <rect x={5} y={35} width={25} height={10} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Input arrow indicator */}
        <path d="M 10 40 L 25 40 M 20 35 L 25 40 L 20 45" stroke="#546E7A" strokeWidth={2} fill="none" />

        {/* Discharge pool/drain */}
        <ellipse cx={60} cy={40} rx={30} ry={20} fill={`url(#discharge-water-${id})`} stroke="#4E342E" strokeWidth={2} />

        {/* Swirl effect */}
        <path
          d="M 50 40 Q 55 35 60 40 Q 65 45 60 50 Q 55 45 60 40"
          fill="none"
          stroke="#A1887F"
          strokeWidth={2}
          opacity={0.6}
        />

        {/* Drain indicator */}
        <circle cx={60} cy={45} r={5} fill="#3E2723" stroke="#5D4037" strokeWidth={1} />

        {/* Outflow arrows */}
        <path d="M 60 55 L 55 65 M 60 55 L 65 65" stroke="#5D4037" strokeWidth={2} strokeDasharray="3,2" />

        {/* Label */}
        <text x={60} y={75} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Discharge'}</text>
      </svg>

      {/* Input Handle */}
      <div
        style={{ position: 'absolute', left: 5, top: 40, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle}
      >
        <Handle
          id={`discharge-in-${inputType}`}
          type={inputType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inputType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'waterDischarge',
  label: 'Water Discharge',
  labelTr: 'Su Desarji',
  category: 'utility',
  description: 'Water discharge/effluent outlet',
  component: WaterDischargeNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['water_discharge', 'effluent', 'drain', 'outlet'],
});

export default WaterDischargeNode;
