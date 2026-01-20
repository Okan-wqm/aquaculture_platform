/**
 * ChillerNode Component
 * Industrial water chiller with cooling coils visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface ChillerNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 160;
const HEIGHT = 120;

const ChillerNode: React.FC<NodeProps<ChillerNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof ChillerNodeData
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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 160 120">
        <defs>
          <linearGradient id={`chiller-body-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0D47A1" />
            <stop offset="50%" stopColor="#1976D2" />
            <stop offset="100%" stopColor="#0D47A1" />
          </linearGradient>
          <linearGradient id={`chiller-coil-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#4FC3F7" />
            <stop offset="50%" stopColor="#81D4FA" />
            <stop offset="100%" stopColor="#4FC3F7" />
          </linearGradient>
        </defs>

        {/* Main body */}
        <rect x={30} y={25} width={100} height={70} rx={5} fill={`url(#chiller-body-${id})`} stroke="#0D47A1" strokeWidth={2} />

        {/* Cooling coils (zigzag) */}
        <path
          d="M 45 40 L 55 55 L 65 40 L 75 55 L 85 40 L 95 55 L 105 40 L 115 55"
          fill="none"
          stroke={`url(#chiller-coil-${id})`}
          strokeWidth={4}
          strokeLinecap="round"
        />
        <path
          d="M 45 65 L 55 80 L 65 65 L 75 80 L 85 65 L 95 80 L 105 65 L 115 80"
          fill="none"
          stroke={`url(#chiller-coil-${id})`}
          strokeWidth={4}
          strokeLinecap="round"
        />

        {/* Inlet pipe */}
        <rect x={5} y={55} width={25} height={10} fill="#757575" stroke="#424242" strokeWidth={1} />

        {/* Outlet pipe */}
        <rect x={130} y={55} width={25} height={10} fill="#757575" stroke="#424242" strokeWidth={1} />

        {/* Temperature indicator */}
        <circle cx={80} cy={15} r={8} fill="#fff" stroke="#0D47A1" strokeWidth={2} />
        <text x={80} y={18} fontSize={8} fill="#0D47A1" textAnchor="middle" fontWeight="bold">C</text>

        {/* Snowflake icon */}
        <text x={80} y={60} fontSize={16} fill="#E3F2FD" textAnchor="middle">❄</text>

        {/* Label */}
        <text x={80} y={110} fontSize={11} fill="#333" textAnchor="middle">{data?.label || 'Chiller'}</text>
      </svg>

      {/* Left Handle */}
      <div
        style={{ position: 'absolute', left: 5, top: 60, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`chiller-left-${leftType}`}
          type={leftType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(leftType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Right Handle */}
      <div
        style={{ position: 'absolute', left: 155, top: 60, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(rightType, setRightType, 'rightType')}
      >
        <Handle
          id={`chiller-right-${rightType}`}
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
  id: 'chiller',
  label: 'Chiller',
  labelTr: 'Sogutucu',
  category: 'heating_cooling',
  description: 'Industrial water chiller unit',
  component: ChillerNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['chiller', 'water_chiller', 'cooler'],
});

export default ChillerNode;
