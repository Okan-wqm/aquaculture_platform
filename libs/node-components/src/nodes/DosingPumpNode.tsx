/**
 * DosingPumpNode Component
 * Chemical dosing pump with tank visualization
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface DosingPumpNodeData {
  label?: string;
  inletType?: HandleType;
  outletType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 120;
const HEIGHT = 160;

const DosingPumpNode: React.FC<NodeProps<DosingPumpNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [inletType, setInletType] = useState<HandleType>(data?.inletType || 'target');
  const [outletType, setOutletType] = useState<HandleType>(data?.outletType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof DosingPumpNodeData
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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 120 160">
        <defs>
          <linearGradient id={`dosing-tank-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#E8EAF6" />
            <stop offset="50%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#E8EAF6" />
          </linearGradient>
          <linearGradient id={`dosing-liquid-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#7C4DFF" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#651FFF" stopOpacity={0.8} />
          </linearGradient>
          <linearGradient id={`dosing-pump-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#455A64" />
            <stop offset="50%" stopColor="#607D8B" />
            <stop offset="100%" stopColor="#455A64" />
          </linearGradient>
        </defs>

        {/* Chemical tank */}
        <rect x={30} y={10} width={60} height={80} rx={3} fill={`url(#dosing-tank-${id})`} stroke="#9E9E9E" strokeWidth={2} />

        {/* Chemical liquid */}
        <rect x={34} y={35} width={52} height={52} fill={`url(#dosing-liquid-${id})`} />

        {/* Tank level marks */}
        <line x1={32} y1={30} x2={38} y2={30} stroke="#9E9E9E" strokeWidth={1} />
        <line x1={32} y1={50} x2={38} y2={50} stroke="#9E9E9E" strokeWidth={1} />
        <line x1={32} y1={70} x2={38} y2={70} stroke="#9E9E9E" strokeWidth={1} />

        {/* Dosing pump body */}
        <rect x={35} y={100} width={50} height={35} rx={3} fill={`url(#dosing-pump-${id})`} stroke="#37474F" strokeWidth={2} />

        {/* Pump motor */}
        <circle cx={60} cy={117} r={12} fill="#78909C" stroke="#546E7A" strokeWidth={1} />
        <circle cx={60} cy={117} r={5} fill="#455A64" />

        {/* Tubing from tank to pump */}
        <path d="M 60 90 L 60 100" stroke="#7C4DFF" strokeWidth={4} fill="none" />

        {/* Outlet tubing */}
        <path d="M 85 117 L 115 117" stroke="#7C4DFF" strokeWidth={4} fill="none" />

        {/* Label */}
        <text x={60} y={150} fontSize={10} fill="#333" textAnchor="middle">{data?.label || 'Dosing Pump'}</text>
      </svg>

      {/* Inlet Handle (top of tank) */}
      <div
        style={{ position: 'absolute', left: 60, top: 10, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(inletType, setInletType, 'inletType')}
      >
        <Handle
          id={`dosing-inlet-${inletType}`}
          type={inletType}
          position={Position.Top}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inletType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Outlet Handle */}
      <div
        style={{ position: 'absolute', left: 115, top: 117, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(outletType, setOutletType, 'outletType')}
      >
        <Handle
          id={`dosing-outlet-${outletType}`}
          type={outletType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(outletType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'dosingPump',
  label: 'Dosing Pump',
  labelTr: 'Dozaj Pompasi',
  category: 'pump',
  description: 'Chemical dosing pump with tank',
  component: DosingPumpNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['dosing_pump', 'chemical_pump', 'metering_pump'],
});

export default DosingPumpNode;
