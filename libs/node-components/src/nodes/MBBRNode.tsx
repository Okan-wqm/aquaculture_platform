/**
 * MBBRNode Component
 * Moving Bed Biofilm Reactor with media carriers visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface MBBRNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  bottomType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 180;
const HEIGHT = 200;

const MBBRNode: React.FC<NodeProps<MBBRNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');
  const [bottomType, setBottomType] = useState<HandleType>(data?.bottomType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof MBBRNodeData
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
  }, [id, leftType, rightType, bottomType, updateNodeInternals]);

  // Generate random media carriers
  const carriers = Array.from({ length: 25 }, (_, i) => ({
    cx: 35 + Math.random() * 110,
    cy: 60 + Math.random() * 100,
    r: 6 + Math.random() * 4,
  }));

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 180 200">
        <defs>
          <linearGradient id={`mbbr-tank-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#455A64" />
            <stop offset="50%" stopColor="#607D8B" />
            <stop offset="100%" stopColor="#455A64" />
          </linearGradient>
          <linearGradient id={`mbbr-water-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#4DB6AC" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#26A69A" stopOpacity={0.6} />
          </linearGradient>
          <radialGradient id={`mbbr-carrier-${id}`} cx="30%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#FFF8E1" />
            <stop offset="100%" stopColor="#FFD54F" />
          </radialGradient>
        </defs>

        {/* Tank body */}
        <rect x={25} y={30} width={130} height={140} rx={5} fill={`url(#mbbr-tank-${id})`} stroke="#37474F" strokeWidth={2} />

        {/* Water */}
        <rect x={30} y={50} width={120} height={115} fill={`url(#mbbr-water-${id})`} />

        {/* Media carriers */}
        {carriers.map((carrier, i) => (
          <g key={i}>
            <circle cx={carrier.cx} cy={carrier.cy} r={carrier.r} fill={`url(#mbbr-carrier-${id})`} stroke="#FFA000" strokeWidth={0.5} />
            <circle cx={carrier.cx} cy={carrier.cy} r={carrier.r * 0.3} fill="none" stroke="#FFA000" strokeWidth={0.5} />
          </g>
        ))}

        {/* Air bubbles */}
        <circle cx={50} cy={140} r={3} fill="#E0F7FA" opacity={0.7} />
        <circle cx={90} cy={150} r={4} fill="#E0F7FA" opacity={0.6} />
        <circle cx={130} cy={145} r={3} fill="#E0F7FA" opacity={0.7} />
        <circle cx={70} cy={130} r={2} fill="#E0F7FA" opacity={0.5} />
        <circle cx={110} cy={135} r={3} fill="#E0F7FA" opacity={0.6} />

        {/* Aeration diffuser */}
        <rect x={40} y={165} width={100} height={5} rx={2} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Inlet pipe */}
        <rect x={5} y={65} width={20} height={10} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Outlet pipe */}
        <rect x={155} y={65} width={20} height={10} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Bottom drain */}
        <rect x={85} y={175} width={10} height={20} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Label */}
        <text x={90} y={20} fontSize={12} fill="#333" textAnchor="middle" fontWeight="bold">{data?.label || 'MBBR'}</text>
        <text x={90} y={45} fontSize={8} fill="#666" textAnchor="middle">Moving Bed Biofilm Reactor</text>
      </svg>

      {/* Left Handle */}
      <div
        style={{ position: 'absolute', left: 5, top: 70, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`mbbr-left-${leftType}`}
          type={leftType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(leftType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Right Handle */}
      <div
        style={{ position: 'absolute', left: 175, top: 70, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(rightType, setRightType, 'rightType')}
      >
        <Handle
          id={`mbbr-right-${rightType}`}
          type={rightType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(rightType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Bottom Handle */}
      <div
        style={{ position: 'absolute', left: 90, top: 195, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(bottomType, setBottomType, 'bottomType')}
      >
        <Handle
          id={`mbbr-bottom-${bottomType}`}
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
  id: 'mbbr',
  label: 'MBBR',
  labelTr: 'MBBR Biyoreaktör',
  category: 'filtration',
  description: 'Moving Bed Biofilm Reactor',
  component: MBBRNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['mbbr', 'biofilter', 'moving_bed'],
});

export default MBBRNode;
