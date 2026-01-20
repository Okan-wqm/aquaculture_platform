/**
 * OxygenGeneratorNode Component
 * LOX (Liquid Oxygen) or PSA oxygen generator
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface OxygenGeneratorNodeData {
  label?: string;
  outputType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 100;
const HEIGHT = 150;

const OxygenGeneratorNode: React.FC<NodeProps<OxygenGeneratorNodeData>> = ({ id, data, selected }) => {
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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 100 150">
        <defs>
          <linearGradient id={`o2-tank-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0277BD" />
            <stop offset="50%" stopColor="#0288D1" />
            <stop offset="100%" stopColor="#0277BD" />
          </linearGradient>
          <linearGradient id={`o2-liquid-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#4FC3F7" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#0288D1" stopOpacity={0.9} />
          </linearGradient>
        </defs>

        {/* LOX tank (cylindrical) */}
        <ellipse cx={50} cy={30} rx={30} ry={15} fill="#01579B" stroke="#014B7C" strokeWidth={2} />
        <rect x={20} y={30} width={60} height={80} fill={`url(#o2-tank-${id})`} stroke="#01579B" strokeWidth={2} />
        <ellipse cx={50} cy={110} rx={30} ry={15} fill="#0277BD" stroke="#01579B" strokeWidth={2} />

        {/* Liquid oxygen level */}
        <ellipse cx={50} cy={70} rx={25} ry={10} fill={`url(#o2-liquid-${id})`} />
        <rect x={25} y={70} width={50} height={35} fill={`url(#o2-liquid-${id})`} />
        <ellipse cx={50} cy={105} rx={25} ry={10} fill="#0288D1" />

        {/* Frost effect */}
        <circle cx={30} cy={50} r={3} fill="#E1F5FE" opacity={0.6} />
        <circle cx={70} cy={60} r={4} fill="#E1F5FE" opacity={0.5} />
        <circle cx={35} cy={80} r={3} fill="#E1F5FE" opacity={0.4} />

        {/* Pressure gauge */}
        <circle cx={50} cy={20} r={8} fill="#ECEFF1" stroke="#90A4AE" strokeWidth={1} />
        <line x1={50} y1={15} x2={53} y2={22} stroke="#E53935" strokeWidth={1} />

        {/* Output valve */}
        <rect x={70} y={85} width={25} height={10} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* O2 symbol */}
        <text x={50} y={95} fontSize={14} fill="#E1F5FE" textAnchor="middle" fontWeight="bold">O₂</text>

        {/* Label */}
        <text x={50} y={140} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'O₂ Generator'}</text>
      </svg>

      {/* Output Handle */}
      <div
        style={{ position: 'absolute', left: 95, top: 90, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle}
      >
        <Handle
          id={`o2-out-${outputType}`}
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
  id: 'oxygenGenerator',
  label: 'Oxygen Generator',
  labelTr: 'Oksijen Jeneratoru',
  category: 'aeration',
  description: 'LOX/PSA oxygen generator',
  component: OxygenGeneratorNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['oxygen_generator', 'lox_tank', 'psa_oxygen'],
});

export default OxygenGeneratorNode;
