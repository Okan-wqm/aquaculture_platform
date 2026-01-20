/**
 * OzoneGeneratorNode Component
 * Ozone generator for water disinfection
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface OzoneGeneratorNodeData {
  label?: string;
  airInType?: HandleType;
  ozoneOutType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 120;
const HEIGHT = 140;

const OzoneGeneratorNode: React.FC<NodeProps<OzoneGeneratorNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [airInType, setAirInType] = useState<HandleType>(data?.airInType || 'target');
  const [ozoneOutType, setOzoneOutType] = useState<HandleType>(data?.ozoneOutType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof OzoneGeneratorNodeData
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
  }, [id, airInType, ozoneOutType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 120 140">
        <defs>
          <linearGradient id={`ozone-body-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#5E35B1" />
            <stop offset="50%" stopColor="#7E57C2" />
            <stop offset="100%" stopColor="#5E35B1" />
          </linearGradient>
          <linearGradient id={`ozone-glow-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#B388FF" stopOpacity={0.8} />
            <stop offset="100%" stopColor="#7C4DFF" stopOpacity={0.4} />
          </linearGradient>
        </defs>

        {/* Main housing */}
        <rect x={20} y={25} width={80} height={90} rx={5} fill={`url(#ozone-body-${id})`} stroke="#4527A0" strokeWidth={2} />

        {/* Corona discharge tube */}
        <rect x={35} y={40} width={50} height={60} rx={3} fill="#311B92" stroke="#4527A0" strokeWidth={1} />

        {/* Plasma effect */}
        <ellipse cx={60} cy={70} rx={15} ry={20} fill={`url(#ozone-glow-${id})`} />

        {/* Discharge lines */}
        <path d="M 45 55 L 55 65 L 45 75 L 55 85" stroke="#B388FF" strokeWidth={2} fill="none" />
        <path d="M 65 55 L 75 65 L 65 75 L 75 85" stroke="#B388FF" strokeWidth={2} fill="none" />

        {/* Air inlet (left side) */}
        <rect x={5} y={55} width={15} height={12} fill="#90CAF9" stroke="#42A5F5" strokeWidth={1} />
        <text x={12} y={64} fontSize={7} fill="#1565C0" textAnchor="middle">O₂</text>

        {/* Ozone outlet (right side) */}
        <rect x={100} y={55} width={15} height={12} fill="#CE93D8" stroke="#AB47BC" strokeWidth={1} />
        <text x={108} y={64} fontSize={7} fill="#7B1FA2" textAnchor="middle">O₃</text>

        {/* Control panel */}
        <rect x={30} y={30} width={60} height={8} rx={2} fill="#1A1A2E" />
        <circle cx={40} cy={34} r={2} fill="#4CAF50" />
        <circle cx={50} cy={34} r={2} fill="#FFC107" />
        <circle cx={60} cy={34} r={2} fill="#2196F3" />

        {/* Ozone symbol */}
        <text x={60} y={110} fontSize={14} fill="#E1BEE7" textAnchor="middle" fontWeight="bold">O₃</text>

        {/* Label */}
        <text x={60} y={130} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Ozone Generator'}</text>
      </svg>

      {/* Air In Handle (left) */}
      <div
        style={{ position: 'absolute', left: 5, top: 61, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(airInType, setAirInType, 'airInType')}
      >
        <Handle
          id={`ozone-in-${airInType}`}
          type={airInType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(airInType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Ozone Out Handle (right) */}
      <div
        style={{ position: 'absolute', left: 115, top: 61, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(ozoneOutType, setOzoneOutType, 'ozoneOutType')}
      >
        <Handle
          id={`ozone-out-${ozoneOutType}`}
          type={ozoneOutType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(ozoneOutType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'ozoneGenerator',
  label: 'Ozone Generator',
  labelTr: 'Ozon Jeneratoru',
  category: 'disinfection',
  description: 'Ozone generator for water disinfection',
  component: OzoneGeneratorNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['ozone_generator', 'ozonator', 'ozone_unit'],
});

export default OzoneGeneratorNode;
