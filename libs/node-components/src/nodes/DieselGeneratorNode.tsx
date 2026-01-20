/**
 * DieselGeneratorNode Component
 * Diesel backup generator with engine and alternator
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface DieselGeneratorNodeData {
  label?: string;
  outputType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 180;
const HEIGHT = 120;

const DieselGeneratorNode: React.FC<NodeProps<DieselGeneratorNodeData>> = ({ id, data, selected }) => {
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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 180 120">
        <defs>
          <linearGradient id={`diesel-engine-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#37474F" />
            <stop offset="50%" stopColor="#546E7A" />
            <stop offset="100%" stopColor="#37474F" />
          </linearGradient>
          <linearGradient id={`diesel-alt-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#1565C0" />
            <stop offset="50%" stopColor="#1976D2" />
            <stop offset="100%" stopColor="#1565C0" />
          </linearGradient>
        </defs>

        {/* Base/Frame */}
        <rect x={10} y={85} width={160} height={15} rx={3} fill="#263238" stroke="#1B1B1B" strokeWidth={1} />

        {/* Engine block */}
        <rect x={15} y={35} width={80} height={50} rx={3} fill={`url(#diesel-engine-${id})`} stroke="#263238" strokeWidth={2} />

        {/* Engine fins (cooling) */}
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} x={20 + i * 15} y={40} width={10} height={40} fill="#455A64" stroke="#37474F" strokeWidth={0.5} />
        ))}

        {/* Exhaust */}
        <rect x={30} y={15} width={15} height={20} rx={2} fill="#424242" stroke="#212121" strokeWidth={1} />
        <circle cx={37} cy={10} r={5} fill="#757575" opacity={0.5} />
        <circle cx={40} cy={5} r={3} fill="#9E9E9E" opacity={0.4} />

        {/* Alternator */}
        <rect x={100} y={40} width={60} height={45} rx={5} fill={`url(#diesel-alt-${id})`} stroke="#0D47A1" strokeWidth={2} />

        {/* Alternator ventilation */}
        <circle cx={130} cy={62} r={15} fill="#1E88E5" stroke="#1565C0" strokeWidth={1} />
        <circle cx={130} cy={62} r={8} fill="#0D47A1" />
        <text x={130} y={66} fontSize={10} fill="#fff" textAnchor="middle">⚡</text>

        {/* Coupling between engine and alternator */}
        <rect x={95} y={50} width={10} height={25} fill="#78909C" />

        {/* Fuel tank */}
        <rect x={15} y={20} width={15} height={15} rx={2} fill="#FF9800" stroke="#F57C00" strokeWidth={1} />
        <text x={22} y={32} fontSize={8} fill="#fff" textAnchor="middle">F</text>

        {/* Output cable */}
        <path d="M 165 62 L 175 62" stroke="#FFC107" strokeWidth={4} fill="none" />

        {/* Label */}
        <text x={90} y={110} fontSize={10} fill="#333" textAnchor="middle">{data?.label || 'Diesel Generator'}</text>
      </svg>

      {/* Output Handle (power) */}
      <div
        style={{ position: 'absolute', left: 175, top: 62, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle}
      >
        <Handle
          id={`diesel-out-${outputType}`}
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
  id: 'dieselGenerator',
  label: 'Diesel Generator',
  labelTr: 'Dizel Jenerator',
  category: 'power',
  description: 'Diesel backup generator',
  component: DieselGeneratorNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['diesel_generator', 'generator', 'backup_power'],
});

export default DieselGeneratorNode;
