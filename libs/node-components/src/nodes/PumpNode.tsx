/**
 * PumpNode Component
 * Generic water pump (centrifugal, submersible)
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface PumpNodeData {
  label?: string;
  isRunning?: boolean;
  inletType?: HandleType;
  outletType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 100;
const HEIGHT = 80;

const PumpNode: React.FC<NodeProps<PumpNodeData>> = ({ id, data, selected }) => {
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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 100 80">
        <defs>
          <linearGradient id={`pump-body-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={isRunning ? '#1565C0' : '#546E7A'} />
            <stop offset="50%" stopColor={isRunning ? '#1976D2' : '#78909C'} />
            <stop offset="100%" stopColor={isRunning ? '#1565C0' : '#546E7A'} />
          </linearGradient>
        </defs>

        {/* Inlet pipe */}
        <rect x={5} y={30} width={20} height={12} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Pump body (volute) */}
        <circle cx={50} cy={36} r={22} fill={`url(#pump-body-${id})`} stroke={isRunning ? '#0D47A1' : '#455A64'} strokeWidth={2} />

        {/* Impeller */}
        <circle cx={50} cy={36} r={12} fill={isRunning ? '#0D47A1' : '#455A64'} />
        {isRunning && (
          <>
            <line x1={50} y1={24} x2={50} y2={48} stroke="#1E88E5" strokeWidth={2} />
            <line x1={38} y1={36} x2={62} y2={36} stroke="#1E88E5" strokeWidth={2} />
            <line x1={42} y1={28} x2={58} y2={44} stroke="#1E88E5" strokeWidth={2} />
            <line x1={42} y1={44} x2={58} y2={28} stroke="#1E88E5" strokeWidth={2} />
          </>
        )}

        {/* Outlet pipe (top discharge) */}
        <rect x={44} y={5} width={12} height={15} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Motor housing */}
        <rect x={72} y={26} width={23} height={20} rx={2} fill="#455A64" stroke="#37474F" strokeWidth={1} />

        {/* Motor fan */}
        <circle cx={83} cy={36} r={6} fill={isRunning ? '#4CAF50' : '#757575'} stroke="#333" strokeWidth={1} />

        {/* Status indicator */}
        <circle cx={83} cy={36} r={3} fill={isRunning ? '#81C784' : '#9E9E9E'} />

        {/* Label */}
        <text x={50} y={72} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Pump'}</text>
      </svg>

      {/* Inlet Handle (left) */}
      <div
        style={{ position: 'absolute', left: 5, top: 36, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
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
        style={{ position: 'absolute', left: 50, top: 5, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
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
