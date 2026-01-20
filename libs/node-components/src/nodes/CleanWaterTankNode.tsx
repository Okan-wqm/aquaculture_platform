/**
 * CleanWaterTankNode Component
 * Clean water storage tank with transparent water visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface CleanWaterTankNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  bottomType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 220;
const HEIGHT = 180;

const CleanWaterTankNode: React.FC<NodeProps<CleanWaterTankNodeData>> = ({ id, data, selected }) => {
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
    key: keyof CleanWaterTankNodeData
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

  const gid = `cwt-${id.replace(/[^a-zA-Z0-9]/g, '')}`;

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
            <stop offset="0%" stopColor="#D4C896" />
            <stop offset="50%" stopColor="#FFFEF5" />
            <stop offset="100%" stopColor="#D4C896" />
          </linearGradient>
          <linearGradient id={`${gid}-cleanWaterGradient`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#80DEEA" stopOpacity={0.5} />
            <stop offset="50%" stopColor="#4DD0E1" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#26C6DA" stopOpacity={0.7} />
          </linearGradient>
          <linearGradient id={`${gid}-waterSurface`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={`${gid}-pipeGradient`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#C9BC85" />
            <stop offset="50%" stopColor="#EDE5C5" />
            <stop offset="100%" stopColor="#C9BC85" />
          </linearGradient>
          <linearGradient id={`${gid}-flangeGradient`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#C9BC85" />
            <stop offset="50%" stopColor="#F0E8CC" />
            <stop offset="100%" stopColor="#C9BC85" />
          </linearGradient>
          <linearGradient id={`${gid}-baseGradient`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#D4C896" />
            <stop offset="100%" stopColor="#B8A870" />
          </linearGradient>
        </defs>

        {/* Tank body */}
        <rect x={40} y={25} width={140} height={110} fill={`url(#${gid}-tankGradient)`} stroke="#B8A870" strokeWidth={2} />
        <rect x={36} y={21} width={148} height={8} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#A89860" strokeWidth={1} />
        <rect x={36} y={135} width={148} height={8} rx={1} fill={`url(#${gid}-baseGradient)`} stroke="#A89860" strokeWidth={1} />

        {/* Clean water */}
        <rect x={44} y={40} width={132} height={93} fill={`url(#${gid}-cleanWaterGradient)`} />
        <rect x={44} y={40} width={132} height={12} fill={`url(#${gid}-waterSurface)`} />
        <line x1={44} y1={40} x2={176} y2={40} stroke="#80DEEA" strokeWidth={1.5} />
        <path d="M 50 42 Q 70 39, 90 42 Q 110 45, 130 42 Q 150 39, 170 42" stroke="#B2EBF2" strokeWidth={1} fill="none" opacity={0.6} />

        {/* Inlet pipe */}
        <rect x={5} y={50} width={39} height={10} fill={`url(#${gid}-pipeGradient)`} stroke="#A89860" strokeWidth={1} />
        <rect x={3} y={48} width={5} height={14} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#A89860" strokeWidth={0.5} />
        <polygon points="20,55 12,51 12,59" fill="#0277BD" />

        {/* Outlet pipe */}
        <rect x={176} y={50} width={39} height={10} fill={`url(#${gid}-pipeGradient)`} stroke="#A89860" strokeWidth={1} />
        <rect x={212} y={48} width={5} height={14} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#A89860" strokeWidth={0.5} />
        <polygon points="198,55 206,51 206,59" fill="#4DD0E1" />

        {/* Bottom drain */}
        <rect x={105} y={140} width={10} height={25} fill={`url(#${gid}-pipeGradient)`} stroke="#A89860" strokeWidth={1} />
        <rect x={102} y={138} width={16} height={5} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#A89860" strokeWidth={0.5} />
        <rect x={102} y={163} width={16} height={5} rx={1} fill={`url(#${gid}-flangeGradient)`} stroke="#A89860" strokeWidth={0.5} />

        {/* Label */}
        <text x={110} y={100} fontSize={12} fill="#006064" textAnchor="middle">{data?.label || 'Clean Water'}</text>
      </svg>

      {/* Left Handle */}
      <div
        style={{ position: 'absolute', left: 3, top: 55, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`cwt-left-${leftType}`}
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
          id={`cwt-right-${rightType}`}
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
          id={`cwt-bottom-${bottomType}`}
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
  id: 'cleanWaterTank',
  label: 'Clean Water Tank',
  labelTr: 'Temiz Su Tanki',
  category: 'tank',
  description: 'Clean water storage tank',
  component: CleanWaterTankNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['clean_water_tank', 'cwt', 'clean_tank'],
});

export default CleanWaterTankNode;
