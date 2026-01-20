/**
 * HEPAFilterNode Component
 * High-Efficiency Particulate Air filter for air handling
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface HEPAFilterNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 120;
const HEIGHT = 100;

const HEPAFilterNode: React.FC<NodeProps<HEPAFilterNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof HEPAFilterNodeData
  ) => (e: React.MouseEvent) => {
    if (isScadaMode) return;
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = current === 'source' ? 'target' : 'source';
    setFunc(newType);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, [key]: newType } } : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, leftType, rightType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 120 100">
        <defs>
          <linearGradient id={`hepa-frame-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#455A64" />
            <stop offset="50%" stopColor="#607D8B" />
            <stop offset="100%" stopColor="#455A64" />
          </linearGradient>
          <pattern id={`hepa-media-${id}`} width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="#ECEFF1" />
            <line x1="0" y1="0" x2="8" y2="8" stroke="#CFD8DC" strokeWidth="0.5" />
            <line x1="8" y1="0" x2="0" y2="8" stroke="#CFD8DC" strokeWidth="0.5" />
          </pattern>
        </defs>

        {/* Frame */}
        <rect x={25} y={15} width={70} height={60} rx={3} fill={`url(#hepa-frame-${id})`} stroke="#37474F" strokeWidth={2} />

        {/* Filter media */}
        <rect x={30} y={20} width={60} height={50} fill={`url(#hepa-media-${id})`} />

        {/* Pleats visualization */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <path
            key={i}
            d={`M ${35 + i * 10} 25 L ${40 + i * 10} 65 L ${35 + i * 10} 65 L ${30 + i * 10} 25 Z`}
            fill="#B0BEC5"
            stroke="#78909C"
            strokeWidth={0.5}
          />
        ))}

        {/* Input duct */}
        <rect x={5} y={35} width={20} height={20} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Output duct */}
        <rect x={95} y={35} width={20} height={20} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Airflow arrows */}
        <path d="M 10 45 L 20 45" stroke="#4FC3F7" strokeWidth={2} markerEnd="url(#arrow)" />
        <path d="M 100 45 L 110 45" stroke="#4FC3F7" strokeWidth={2} markerEnd="url(#arrow)" />

        {/* HEPA label */}
        <text x={60} y={48} fontSize={10} fill="#263238" textAnchor="middle" fontWeight="bold">HEPA</text>

        {/* Label */}
        <text x={60} y={90} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'HEPA Filter'}</text>
      </svg>

      {/* Left Handle (air input) */}
      <div
        style={{ position: 'absolute', left: 5, top: 45, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`hepa-in-${leftType}`}
          type={leftType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(leftType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Right Handle (air output) */}
      <div
        style={{ position: 'absolute', left: 115, top: 45, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(rightType, setRightType, 'rightType')}
      >
        <Handle
          id={`hepa-out-${rightType}`}
          type={rightType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(rightType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'hepaFilter',
  label: 'HEPA Filter',
  labelTr: 'HEPA Filtre',
  category: 'filtration',
  description: 'High-Efficiency Particulate Air filter',
  component: HEPAFilterNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['hepa_filter', 'air_filter', 'particulate_filter'],
});

export default HEPAFilterNode;
