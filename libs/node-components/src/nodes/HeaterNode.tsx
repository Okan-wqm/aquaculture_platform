/**
 * HeaterNode Component
 * Industrial water heater with heating elements visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface HeaterNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 160;
const HEIGHT = 120;

const HeaterNode: React.FC<NodeProps<HeaterNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof HeaterNodeData
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
          <linearGradient id={`heater-body-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#B71C1C" />
            <stop offset="50%" stopColor="#E53935" />
            <stop offset="100%" stopColor="#B71C1C" />
          </linearGradient>
          <linearGradient id={`heater-element-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FF5722" />
            <stop offset="50%" stopColor="#FF9800" />
            <stop offset="100%" stopColor="#FF5722" />
          </linearGradient>
        </defs>

        {/* Main body */}
        <rect x={30} y={25} width={100} height={70} rx={5} fill={`url(#heater-body-${id})`} stroke="#7f0000" strokeWidth={2} />

        {/* Heating elements */}
        <rect x={45} y={40} width={70} height={8} rx={2} fill={`url(#heater-element-${id})`} />
        <rect x={45} y={56} width={70} height={8} rx={2} fill={`url(#heater-element-${id})`} />
        <rect x={45} y={72} width={70} height={8} rx={2} fill={`url(#heater-element-${id})`} />

        {/* Inlet pipe */}
        <rect x={5} y={55} width={25} height={10} fill="#757575" stroke="#424242" strokeWidth={1} />

        {/* Outlet pipe */}
        <rect x={130} y={55} width={25} height={10} fill="#757575" stroke="#424242" strokeWidth={1} />

        {/* Temperature indicator */}
        <circle cx={80} y={15} r={8} fill="#fff" stroke="#B71C1C" strokeWidth={2} />
        <text x={80} y={18} fontSize={8} fill="#B71C1C" textAnchor="middle" fontWeight="bold">T</text>

        {/* Label */}
        <text x={80} y={110} fontSize={11} fill="#333" textAnchor="middle">{data?.label || 'Heater'}</text>
      </svg>

      {/* Left Handle */}
      <div
        style={{ position: 'absolute', left: 5, top: 60, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`heater-left-${leftType}`}
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
          id={`heater-right-${rightType}`}
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
  id: 'heater',
  label: 'Heater',
  labelTr: 'Isitici',
  category: 'heating_cooling',
  description: 'Industrial water heater unit',
  component: HeaterNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['heater', 'water_heater', 'heat_exchanger'],
});

export default HeaterNode;
