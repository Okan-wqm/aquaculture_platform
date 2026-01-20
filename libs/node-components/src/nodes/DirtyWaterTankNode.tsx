/**
 * DirtyWaterTankNode Component
 * Dirty/waste water tank with murky water visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface DirtyWaterTankNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  bottomType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 220;
const HEIGHT = 180;

const DirtyWaterTankNode: React.FC<NodeProps<DirtyWaterTankNodeData>> = ({ id, data, selected }) => {
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
    key: keyof DirtyWaterTankNodeData
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

  const gid = `dwt-${id.replace(/[^a-zA-Z0-9]/g, '')}`;

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 220 180">
        <defs>
          <linearGradient id={`${gid}-tankGradient`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#8D8D8D" />
            <stop offset="50%" stopColor="#B0B0B0" />
            <stop offset="100%" stopColor="#8D8D8D" />
          </linearGradient>
          <linearGradient id={`${gid}-dirtyWaterGradient`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#8B7355" stopOpacity={0.6} />
            <stop offset="50%" stopColor="#6B5344" stopOpacity={0.7} />
            <stop offset="100%" stopColor="#5D4037" stopOpacity={0.8} />
          </linearGradient>
          <linearGradient id={`${gid}-pipeGradient`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#757575" />
            <stop offset="50%" stopColor="#9E9E9E" />
            <stop offset="100%" stopColor="#757575" />
          </linearGradient>
          <linearGradient id={`${gid}-flangeGradient`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#9E9E9E" />
            <stop offset="50%" stopColor="#BDBDBD" />
            <stop offset="100%" stopColor="#9E9E9E" />
          </linearGradient>
        </defs>

        {/* Tank body */}
        <rect x={40} y={25} width={140} height={110} fill={`url(#${gid}-tankGradient)`} stroke="#616161" strokeWidth={2} />
        <rect x={36} y={21} width={148} height={8} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#757575" strokeWidth={1} />
        <rect x={36} y={135} width={148} height={8} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#757575" strokeWidth={1} />

        {/* Dirty water */}
        <rect x={44} y={45} width={132} height={88} fill={`url(#${gid}-dirtyWaterGradient)`} />
        <ellipse cx={80} cy={80} rx={8} ry={4} fill="#5D4037" opacity={0.4} />
        <ellipse cx={140} cy={95} rx={6} ry={3} fill="#5D4037" opacity={0.3} />
        <ellipse cx={100} cy={110} rx={10} ry={5} fill="#4E342E" opacity={0.3} />

        {/* Inlet pipe */}
        <rect x={5} y={50} width={39} height={10} fill={`url(#${gid}-pipeGradient)`} stroke="#616161" strokeWidth={1} />
        <rect x={3} y={48} width={5} height={14} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#757575" strokeWidth={0.5} />
        <polygon points="20,55 12,51 12,59" fill="#795548" />

        {/* Outlet pipe */}
        <rect x={176} y={50} width={39} height={10} fill={`url(#${gid}-pipeGradient)`} stroke="#616161" strokeWidth={1} />
        <rect x={212} y={48} width={5} height={14} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#757575" strokeWidth={0.5} />
        <polygon points="198,55 206,51 206,59" fill="#8D6E63" />

        {/* Bottom drain */}
        <rect x={105} y={140} width={10} height={25} fill={`url(#${gid}-pipeGradient)`} stroke="#616161" strokeWidth={1} />
        <rect x={102} y={138} width={16} height={5} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#757575" strokeWidth={0.5} />
        <rect x={102} y={163} width={16} height={5} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#757575" strokeWidth={0.5} />

        {/* Label */}
        <text x={110} y={35} fontSize={11} fill="#5D4037" textAnchor="middle" fontWeight="bold">{data?.label || 'Dirty Water'}</text>
      </svg>

      {/* Left Handle */}
      <div
        style={{ position: 'absolute', left: 3, top: 55, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`dwt-left-${leftType}`}
          type={leftType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(leftType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Right Handle */}
      <div
        style={{ position: 'absolute', left: 217, top: 55, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(rightType, setRightType, 'rightType')}
      >
        <Handle
          id={`dwt-right-${rightType}`}
          type={rightType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(rightType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Bottom Handle */}
      <div
        style={{ position: 'absolute', left: 110, top: 168, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(bottomType, setBottomType, 'bottomType')}
      >
        <Handle
          id={`dwt-bottom-${bottomType}`}
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
  id: 'dirtyWaterTank',
  label: 'Dirty Water Tank',
  labelTr: 'Kirli Su Tanki',
  category: 'tank',
  description: 'Dirty/waste water collection tank',
  component: DirtyWaterTankNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['dirty_water_tank', 'dwt', 'waste_tank'],
});

export default DirtyWaterTankNode;
