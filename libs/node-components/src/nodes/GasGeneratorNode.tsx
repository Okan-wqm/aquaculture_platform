/**
 * GasGeneratorNode Component
 * Natural gas/LPG generator with turbine visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface GasGeneratorNodeData {
  label?: string;
  inputType?: HandleType;
  outputType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 180;
const HEIGHT = 120;

const GasGeneratorNode: React.FC<NodeProps<GasGeneratorNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [inputType, setInputType] = useState<HandleType>(data?.inputType || 'target');
  const [outputType, setOutputType] = useState<HandleType>(data?.outputType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof GasGeneratorNodeData
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
  }, [id, inputType, outputType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 180 120">
        <defs>
          <linearGradient id={`gas-body-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00695C" />
            <stop offset="50%" stopColor="#00897B" />
            <stop offset="100%" stopColor="#00695C" />
          </linearGradient>
          <linearGradient id={`gas-turbine-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#78909C" />
            <stop offset="50%" stopColor="#90A4AE" />
            <stop offset="100%" stopColor="#78909C" />
          </linearGradient>
        </defs>

        {/* Base/Frame */}
        <rect x={10} y={85} width={160} height={15} rx={3} fill="#263238" stroke="#1B1B1B" strokeWidth={1} />

        {/* Main housing */}
        <rect x={20} y={30} width={140} height={55} rx={5} fill={`url(#gas-body-${id})`} stroke="#004D40" strokeWidth={2} />

        {/* Turbine section */}
        <rect x={30} y={40} width={50} height={35} rx={3} fill={`url(#gas-turbine-${id})`} stroke="#546E7A" strokeWidth={1} />

        {/* Turbine blades */}
        <circle cx={55} cy={57} r={12} fill="#607D8B" stroke="#455A64" strokeWidth={1} />
        <line x1={55} y1={45} x2={55} y2={69} stroke="#455A64" strokeWidth={2} />
        <line x1={43} y1={57} x2={67} y2={57} stroke="#455A64" strokeWidth={2} />
        <line x1={47} y1={49} x2={63} y2={65} stroke="#455A64" strokeWidth={2} />
        <line x1={47} y1={65} x2={63} y2={49} stroke="#455A64" strokeWidth={2} />

        {/* Generator section */}
        <rect x={90} y={40} width={60} height={35} rx={3} fill="#1976D2" stroke="#0D47A1" strokeWidth={1} />
        <circle cx={120} cy={57} r={10} fill="#1E88E5" stroke="#1565C0" strokeWidth={1} />
        <text x={120} y={61} fontSize={12} fill="#fff" textAnchor="middle">⚡</text>

        {/* Gas inlet pipe */}
        <rect x={5} y={52} width={15} height={10} fill="#FFC107" stroke="#FFA000" strokeWidth={1} />
        <text x={12} y={60} fontSize={7} fill="#333" textAnchor="middle">G</text>

        {/* Exhaust */}
        <rect x={145} y={20} width={20} height={10} rx={2} fill="#424242" stroke="#212121" strokeWidth={1} />
        <circle cx={165} cy={15} r={4} fill="#757575" opacity={0.4} />

        {/* Power output cable */}
        <path d="M 155 57 L 175 57" stroke="#FFC107" strokeWidth={4} fill="none" />

        {/* Label */}
        <text x={90} y={110} fontSize={10} fill="#333" textAnchor="middle">{data?.label || 'Gas Generator'}</text>
      </svg>

      {/* Gas Input Handle */}
      <div
        style={{ position: 'absolute', left: 5, top: 57, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(inputType, setInputType, 'inputType')}
      >
        <Handle
          id={`gas-in-${inputType}`}
          type={inputType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inputType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Power Output Handle */}
      <div
        style={{ position: 'absolute', left: 175, top: 57, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(outputType, setOutputType, 'outputType')}
      >
        <Handle
          id={`gas-out-${outputType}`}
          type={outputType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(outputType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'gasGenerator',
  label: 'Gas Generator',
  labelTr: 'Gaz Jenerator',
  category: 'power',
  description: 'Natural gas/LPG turbine generator',
  component: GasGeneratorNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['gas_generator', 'turbine_generator', 'lpg_generator'],
});

export default GasGeneratorNode;
