/**
 * AlgaeBagNode Component
 * Photobioreactor bag for algae cultivation with color variants
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';
type AlgaeColor = 'green' | 'red' | 'yellow' | 'brown';

interface AlgaeBagNodeData {
  label?: string;
  algaeColor?: AlgaeColor;
  topType?: HandleType;
  bottomType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 100;
const HEIGHT = 180;

const algaeColors: Record<AlgaeColor, { primary: string; secondary: string; bubble: string }> = {
  green: { primary: '#4CAF50', secondary: '#81C784', bubble: '#C8E6C9' },
  red: { primary: '#E53935', secondary: '#EF5350', bubble: '#FFCDD2' },
  yellow: { primary: '#FDD835', secondary: '#FFEE58', bubble: '#FFF9C4' },
  brown: { primary: '#795548', secondary: '#A1887F', bubble: '#D7CCC8' },
};

const AlgaeBagNode: React.FC<NodeProps<AlgaeBagNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const algaeColor = data?.algaeColor || 'green';
  const colors = algaeColors[algaeColor];

  const [topType, setTopType] = useState<HandleType>(data?.topType || 'target');
  const [bottomType, setBottomType] = useState<HandleType>(data?.bottomType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof AlgaeBagNodeData
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
  }, [id, topType, bottomType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 100 180">
        <defs>
          <linearGradient id={`algae-bag-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={colors.primary} stopOpacity={0.8} />
            <stop offset="50%" stopColor={colors.secondary} stopOpacity={0.9} />
            <stop offset="100%" stopColor={colors.primary} stopOpacity={0.8} />
          </linearGradient>
        </defs>

        {/* Bag frame/holder */}
        <rect x={20} y={5} width={60} height={10} rx={2} fill="#78909C" stroke="#546E7A" strokeWidth={1} />
        <rect x={20} y={155} width={60} height={10} rx={2} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Side frames */}
        <rect x={18} y={15} width={4} height={140} fill="#78909C" />
        <rect x={78} y={15} width={4} height={140} fill="#78909C" />

        {/* Bag body */}
        <rect x={25} y={15} width={50} height={140} rx={3} fill={`url(#algae-bag-${id})`} stroke={colors.primary} strokeWidth={1} />

        {/* Bubbles */}
        <circle cx={35} cy={40} r={4} fill={colors.bubble} opacity={0.7} />
        <circle cx={55} cy={60} r={5} fill={colors.bubble} opacity={0.6} />
        <circle cx={45} cy={90} r={4} fill={colors.bubble} opacity={0.7} />
        <circle cx={60} cy={120} r={3} fill={colors.bubble} opacity={0.5} />
        <circle cx={38} cy={130} r={4} fill={colors.bubble} opacity={0.6} />
        <circle cx={50} cy={50} r={3} fill={colors.bubble} opacity={0.5} />
        <circle cx={65} cy={80} r={4} fill={colors.bubble} opacity={0.6} />

        {/* Light source indicator */}
        <text x={50} y={175} fontSize={8} fill="#666" textAnchor="middle">💡</text>

        {/* Label */}
        <text x={50} y={-5} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Algae Bag'}</text>
      </svg>

      {/* Top Handle */}
      <div
        style={{ position: 'absolute', left: 50, top: 10, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(topType, setTopType, 'topType')}
      >
        <Handle
          id={`algae-top-${topType}`}
          type={topType}
          position={Position.Top}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(topType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Bottom Handle */}
      <div
        style={{ position: 'absolute', left: 50, top: 160, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(bottomType, setBottomType, 'bottomType')}
      >
        <Handle
          id={`algae-bottom-${bottomType}`}
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
  id: 'algaeBag',
  label: 'Algae Bag',
  labelTr: 'Alg Torbasi',
  category: 'algae',
  description: 'Photobioreactor bag for algae cultivation',
  component: AlgaeBagNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['algae_bag', 'photobioreactor', 'algae_reactor'],
});

export default AlgaeBagNode;
