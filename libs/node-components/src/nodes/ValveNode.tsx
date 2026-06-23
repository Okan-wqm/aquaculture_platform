/**
 * ValveNode Component
 * Professional valve (ball, gate, butterfly, check) for flow control
 */

import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow, type Node } from '@xyflow/react';
import React, { useState, useEffect } from 'react';

import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';
type ValveType = 'ball' | 'gate' | 'butterfly' | 'check';

interface ValveNodeData extends Record<string, unknown> {
  label?: string;
  valveType?: ValveType;
  isOpen?: boolean;
  leftType?: HandleType;
  rightType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 120;
const HEIGHT = 90;

const ValveNode: React.FC<NodeProps<Node<ValveNodeData>>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const valveType = data?.valveType || 'ball';
  const isOpen = data?.isOpen !== false;

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof ValveNodeData
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

  const openColor = '#388E3C';
  const closedColor = '#C62828';
  const bodyColor = isOpen ? openColor : closedColor;
  const lightColor = isOpen ? '#81C784' : '#E57373';

  const renderValveBody = () => {
    switch (valveType) {
      case 'butterfly':
        return (
          <>
            {/* Butterfly body ring */}
            <circle cx={60} cy={40} r={18} fill="none" stroke={bodyColor} strokeWidth={3} />
            {/* Disc */}
            <line
              x1={60} y1={22} x2={60} y2={58}
              stroke={lightColor} strokeWidth={4} strokeLinecap="round"
              transform={isOpen ? 'rotate(0 60 40)' : 'rotate(90 60 40)'}
            />
            {/* Shaft */}
            <circle cx={60} cy={40} r={3} fill={bodyColor} stroke="#333" strokeWidth={1} />
          </>
        );
      case 'gate':
        return (
          <>
            {/* Gate body */}
            <rect x={48} y={26} width={24} height={28} rx={2} fill={bodyColor} stroke="#333" strokeWidth={1.5} />
            {/* Gate plate */}
            <rect
              x={53} y={isOpen ? 14 : 30} width={14} height={16}
              rx={1} fill={lightColor} stroke="#333" strokeWidth={1}
            />
            {/* Stem */}
            <rect x={57} y={8} width={6} height={20} fill="#78909C" stroke="#546E7A" strokeWidth={1} />
            {/* Handwheel */}
            <circle cx={60} cy={8} r={6} fill="none" stroke="#455A64" strokeWidth={2} />
            <circle cx={60} cy={8} r={2} fill="#455A64" />
          </>
        );
      case 'check':
        return (
          <>
            {/* Check body */}
            <polygon points="42,26 78,40 42,54" fill={bodyColor} stroke="#333" strokeWidth={1.5} />
            {/* Disc/flap */}
            <line x1={55} y1={28} x2={55} y2={52} stroke={lightColor} strokeWidth={3} strokeLinecap="round" />
            {/* Hinge */}
            <circle cx={55} cy={40} r={4} fill={lightColor} stroke="#333" strokeWidth={1} />
            {/* Direction arrow */}
            <path d="M 68 40 L 76 40 L 73 36 M 76 40 L 73 44" fill="none" stroke="#666" strokeWidth={1.5} />
          </>
        );
      case 'ball':
      default:
        return (
          <>
            {/* Body - two triangles (bowtie) */}
            <polygon points="38,24 60,40 38,56" fill={bodyColor} stroke="#333" strokeWidth={1.5} />
            <polygon points="82,24 60,40 82,56" fill={bodyColor} stroke="#333" strokeWidth={1.5} />
            {/* Ball */}
            <circle cx={60} cy={40} r={10} fill={lightColor} stroke="#333" strokeWidth={1.5} />
            {/* Port through ball */}
            {isOpen && (
              <rect x={50} y={37} width={20} height={6} rx={2} fill={bodyColor} opacity={0.6} />
            )}
            {/* Stem */}
            <rect x={57} y={14} width={6} height={16} fill="#78909C" stroke="#546E7A" strokeWidth={1} />
            {/* Handle */}
            <rect
              x={isOpen ? 48 : 56} y={isOpen ? 10 : 2}
              width={isOpen ? 24 : 8} height={isOpen ? 6 : 14}
              rx={2} fill="#455A64" stroke="#37474F" strokeWidth={1}
            />
          </>
        );
    }
  };

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 120 90">
        <defs>
          <linearGradient id={`valve-pipe-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#90A4AE" />
            <stop offset="50%" stopColor="#B0BEC5" />
            <stop offset="100%" stopColor="#78909C" />
          </linearGradient>
        </defs>

        {/* Inlet pipe */}
        <rect x={5} y={34} width={35} height={12} fill={`url(#valve-pipe-${id})`} stroke="#546E7A" strokeWidth={1.5} />
        {/* Inlet flange */}
        <rect x={5} y={31} width={6} height={18} rx={1} fill="#607D8B" stroke="#455A64" strokeWidth={1} />

        {/* Outlet pipe */}
        <rect x={80} y={34} width={35} height={12} fill={`url(#valve-pipe-${id})`} stroke="#546E7A" strokeWidth={1.5} />
        {/* Outlet flange */}
        <rect x={109} y={31} width={6} height={18} rx={1} fill="#607D8B" stroke="#455A64" strokeWidth={1} />

        {/* Valve body */}
        {renderValveBody()}

        {/* Status indicator */}
        <circle cx={15} cy={24} r={3} fill={isOpen ? '#4CAF50' : '#F44336'} stroke="#333" strokeWidth={0.5} />

        {/* Label */}
        <text x={60} y={80} fontSize={9} fill="#333" textAnchor="middle">{data?.label || valveType.charAt(0).toUpperCase() + valveType.slice(1)}</text>
      </svg>

      {/* Left Handle */}
      <div
        style={{ position: 'absolute', left: 5, top: 40, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`valve-left-${leftType}`}
          type={leftType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(leftType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Right Handle */}
      <div
        style={{ position: 'absolute', left: 115, top: 40, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(rightType, setRightType, 'rightType')}
      >
        <Handle
          id={`valve-right-${rightType}`}
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
  id: 'valve',
  label: 'Valve',
  labelTr: 'Vana',
  category: 'distribution',
  description: 'Flow control valve',
  component: ValveNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['valve', 'ball_valve', 'gate_valve', 'butterfly_valve', 'check_valve'],
});

export default ValveNode;
