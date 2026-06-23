/**
 * PumpNode Component
 * Professional centrifugal pump with volute casing, impeller, and motor
 */

import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow, type Node } from '@xyflow/react';
import React, { useState, useEffect } from 'react';

import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface PumpNodeData extends Record<string, unknown> {
  label?: string;
  isRunning?: boolean;
  inletType?: HandleType;
  outletType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 160;
const HEIGHT = 120;

const PumpNode: React.FC<NodeProps<Node<PumpNodeData>>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const isRunning = data?.isRunning !== false;

  const [inletType, setInletType] = useState<HandleType>(data?.inletType || 'target');
  const [outletType, setOutletType] = useState<HandleType>(data?.outletType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof PumpNodeData
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
  }, [id, inletType, outletType, updateNodeInternals]);

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
          <linearGradient id={`pump-body-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={isRunning ? '#1565C0' : '#546E7A'} />
            <stop offset="50%" stopColor={isRunning ? '#1E88E5' : '#78909C'} />
            <stop offset="100%" stopColor={isRunning ? '#1565C0' : '#546E7A'} />
          </linearGradient>
          <linearGradient id={`pump-motor-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#546E7A" />
            <stop offset="50%" stopColor="#78909C" />
            <stop offset="100%" stopColor="#546E7A" />
          </linearGradient>
          <radialGradient id={`pump-impeller-${id}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={isRunning ? '#42A5F5' : '#90A4AE'} />
            <stop offset="100%" stopColor={isRunning ? '#0D47A1' : '#455A64'} />
          </radialGradient>
        </defs>

        {/* Base plate */}
        <rect x={15} y={88} width={130} height={6} rx={2} fill="#37474F" stroke="#263238" strokeWidth={1} />

        {/* Motor housing */}
        <rect x={95} y={35} width={50} height={50} rx={4} fill={`url(#pump-motor-${id})`} stroke="#37474F" strokeWidth={2} />
        {/* Motor cooling fins */}
        <line x1={100} y1={40} x2={100} y2={80} stroke="#455A64" strokeWidth={1} />
        <line x1={107} y1={40} x2={107} y2={80} stroke="#455A64" strokeWidth={1} />
        <line x1={114} y1={40} x2={114} y2={80} stroke="#455A64" strokeWidth={1} />
        <line x1={121} y1={40} x2={121} y2={80} stroke="#455A64" strokeWidth={1} />
        {/* Motor end bell */}
        <rect x={128} y={42} width={14} height={36} rx={3} fill="#607D8B" stroke="#37474F" strokeWidth={1.5} />
        {/* Motor fan cover */}
        <circle cx={135} cy={60} r={10} fill="none" stroke="#455A64" strokeWidth={1.5} />
        <circle cx={135} cy={60} r={4} fill={isRunning ? '#4CAF50' : '#757575'} stroke="#333" strokeWidth={1} />
        {/* Motor nameplate */}
        <rect x={101} y={52} width={18} height={10} rx={1} fill="#FFF9C4" stroke="#F9A825" strokeWidth={0.5} />
        <text x={110} y={59.5} fontSize={6} fill="#F57F17" textAnchor="middle" fontWeight="bold">M</text>

        {/* Coupling guard */}
        <rect x={85} y={48} width={14} height={24} rx={2} fill="#90A4AE" stroke="#546E7A" strokeWidth={1} />
        <line x1={89} y1={52} x2={89} y2={68} stroke="#78909C" strokeWidth={1} strokeDasharray="2,2" />
        <line x1={95} y1={52} x2={95} y2={68} stroke="#78909C" strokeWidth={1} strokeDasharray="2,2" />

        {/* Volute casing (main pump body) */}
        <path
          d="M 25 60
             C 25 38, 45 20, 60 20
             C 75 20, 88 38, 88 60
             C 88 75, 78 88, 60 88
             C 42 88, 25 78, 25 60 Z"
          fill={`url(#pump-body-${id})`}
          stroke={isRunning ? '#0D47A1' : '#37474F'}
          strokeWidth={2}
        />

        {/* Volute spiral detail */}
        <path
          d="M 56 30 C 75 30, 80 45, 80 60 C 80 72, 72 82, 56 82"
          fill="none"
          stroke={isRunning ? '#0D47A1' : '#455A64'}
          strokeWidth={1}
          opacity={0.4}
        />

        {/* Impeller */}
        <circle cx={56} cy={56} r={18} fill={`url(#pump-impeller-${id})`} stroke={isRunning ? '#0D47A1' : '#455A64'} strokeWidth={1.5} />
        {/* Impeller vanes */}
        {isRunning ? (
          <>
            <path d="M 56 38 C 62 44, 68 50, 56 56" fill="none" stroke="#BBDEFB" strokeWidth={1.5} />
            <path d="M 74 56 C 68 50, 62 44, 56 56" fill="none" stroke="#BBDEFB" strokeWidth={1.5} />
            <path d="M 56 74 C 50 68, 44 62, 56 56" fill="none" stroke="#BBDEFB" strokeWidth={1.5} />
            <path d="M 38 56 C 44 62, 50 68, 56 56" fill="none" stroke="#BBDEFB" strokeWidth={1.5} />
          </>
        ) : (
          <>
            <line x1={56} y1={38} x2={56} y2={74} stroke="#90A4AE" strokeWidth={1.5} />
            <line x1={38} y1={56} x2={74} y2={56} stroke="#90A4AE" strokeWidth={1.5} />
            <line x1={43} y1={43} x2={69} y2={69} stroke="#90A4AE" strokeWidth={1.5} />
            <line x1={43} y1={69} x2={69} y2={43} stroke="#90A4AE" strokeWidth={1.5} />
          </>
        )}
        {/* Impeller hub */}
        <circle cx={56} cy={56} r={5} fill={isRunning ? '#1565C0' : '#455A64'} stroke="#263238" strokeWidth={1} />

        {/* Suction flange (left inlet) */}
        <rect x={2} y={50} width={24} height={12} fill="#78909C" stroke="#455A64" strokeWidth={1.5} />
        <rect x={2} y={47} width={6} height={18} rx={1} fill="#607D8B" stroke="#455A64" strokeWidth={1} />

        {/* Discharge flange (top outlet) */}
        <rect x={50} y={5} width={12} height={18} fill="#78909C" stroke="#455A64" strokeWidth={1.5} />
        <rect x={47} y={5} width={18} height={6} rx={1} fill="#607D8B" stroke="#455A64" strokeWidth={1} />

        {/* Status indicator light */}
        <circle cx={22} cy={30} r={4} fill={isRunning ? '#4CAF50' : '#F44336'} stroke="#333" strokeWidth={1} />
        <circle cx={22} cy={30} r={2} fill={isRunning ? '#81C784' : '#E57373'} />

        {/* Label */}
        <text x={80} y={110} fontSize={11} fill="#333" textAnchor="middle">{data?.label || 'Pump'}</text>
      </svg>

      {/* Inlet Handle (left) */}
      <div
        style={{ position: 'absolute', left: 2, top: 56, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(inletType, setInletType, 'inletType')}
      >
        <Handle
          id={`pump-inlet-${inletType}`}
          type={inletType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inletType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Outlet Handle (top) */}
      <div
        style={{ position: 'absolute', left: 56, top: 5, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(outletType, setOutletType, 'outletType')}
      >
        <Handle
          id={`pump-outlet-${outletType}`}
          type={outletType}
          position={Position.Top}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(outletType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'pump',
  label: 'Pump',
  labelTr: 'Pompa',
  category: 'pump',
  description: 'Centrifugal water pump',
  component: PumpNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['pump', 'centrifugal_pump', 'water_pump', 'circulation_pump'],
});

export default PumpNode;
