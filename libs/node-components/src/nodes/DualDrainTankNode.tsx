/**
 * DualDrainTankNode Component
 * Fish tank with dual drain system (center and side drains)
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface DualDrainTankNodeData {
  label?: string;
  inletType?: HandleType;
  centerDrainType?: HandleType;
  sideDrainType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 180;
const HEIGHT = 160;

const DualDrainTankNode: React.FC<NodeProps<DualDrainTankNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [inletType, setInletType] = useState<HandleType>(data?.inletType || 'target');
  const [centerDrainType, setCenterDrainType] = useState<HandleType>(data?.centerDrainType || 'source');
  const [sideDrainType, setSideDrainType] = useState<HandleType>(data?.sideDrainType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof DualDrainTankNodeData
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
  }, [id, inletType, centerDrainType, sideDrainType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 180 160">
        <defs>
          <linearGradient id={`dual-tank-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#546E7A" />
            <stop offset="50%" stopColor="#78909C" />
            <stop offset="100%" stopColor="#546E7A" />
          </linearGradient>
          <linearGradient id={`dual-water-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#4FC3F7" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#0288D1" stopOpacity={0.8} />
          </linearGradient>
        </defs>

        {/* Tank body (circular top view) */}
        <ellipse cx={90} cy={70} rx={75} ry={50} fill={`url(#dual-tank-${id})`} stroke="#455A64" strokeWidth={3} />

        {/* Water surface */}
        <ellipse cx={90} cy={70} rx={70} ry={45} fill={`url(#dual-water-${id})`} />

        {/* Center drain (darker circle) */}
        <circle cx={90} cy={70} r={15} fill="#263238" stroke="#1B1B1B" strokeWidth={2} />
        <circle cx={90} cy={70} r={8} fill="#37474F" />

        {/* Center drain pipe (going down) */}
        <rect x={83} y={130} width={14} height={25} fill="#455A64" stroke="#37474F" strokeWidth={1} />
        <text x={90} y={148} fontSize={7} fill="#fff" textAnchor="middle">C</text>

        {/* Side drain (on the right) */}
        <rect x={155} y={60} width={20} height={20} rx={3} fill="#455A64" stroke="#37474F" strokeWidth={1} />
        <circle cx={165} cy={70} r={6} fill="#263238" />
        <text x={165} y={73} fontSize={7} fill="#fff" textAnchor="middle">S</text>

        {/* Inlet pipe (top left) */}
        <rect x={5} y={40} width={25} height={12} fill="#42A5F5" stroke="#1E88E5" strokeWidth={1} />
        <path d="M 30 46 L 45 55" stroke="#42A5F5" strokeWidth={4} />

        {/* Water flow arrow */}
        <path d="M 50 55 Q 70 45 90 55" stroke="#B3E5FC" strokeWidth={2} strokeDasharray="4,2" fill="none" />

        {/* Fish silhouettes */}
        <ellipse cx={70} cy={75} rx={8} ry={4} fill="#90A4AE" opacity={0.5} />
        <ellipse cx={110} cy={65} rx={6} ry={3} fill="#90A4AE" opacity={0.4} />
        <ellipse cx={95} cy={85} rx={7} ry={3} fill="#90A4AE" opacity={0.5} />

        {/* Label */}
        <text x={90} y={15} fontSize={10} fill="#333" textAnchor="middle">{data?.label || 'Dual Drain Tank'}</text>
      </svg>

      {/* Inlet Handle (left) */}
      <div
        style={{ position: 'absolute', left: 5, top: 46, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(inletType, setInletType, 'inletType')}
      >
        <Handle
          id={`dual-inlet-${inletType}`}
          type={inletType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inletType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Center Drain Handle (bottom) */}
      <div
        style={{ position: 'absolute', left: 90, top: 155, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(centerDrainType, setCenterDrainType, 'centerDrainType')}
      >
        <Handle
          id={`dual-center-${centerDrainType}`}
          type={centerDrainType}
          position={Position.Bottom}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(centerDrainType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Side Drain Handle (right) */}
      <div
        style={{ position: 'absolute', left: 175, top: 70, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(sideDrainType, setSideDrainType, 'sideDrainType')}
      >
        <Handle
          id={`dual-side-${sideDrainType}`}
          type={sideDrainType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(sideDrainType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'dualDrainTank',
  label: 'Dual Drain Tank',
  labelTr: 'Cift Tahliyeli Tank',
  category: 'tank',
  description: 'Fish tank with center and side drains',
  component: DualDrainTankNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['dual_drain_tank', 'cornell_tank', 'swirl_separator_tank'],
});

export default DualDrainTankNode;
