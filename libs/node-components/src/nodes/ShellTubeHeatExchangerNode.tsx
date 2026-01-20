/**
 * ShellTubeHeatExchangerNode Component
 * Shell and tube heat exchanger for water temperature control
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface ShellTubeHeatExchangerNodeData {
  label?: string;
  shellInType?: HandleType;
  shellOutType?: HandleType;
  tubeInType?: HandleType;
  tubeOutType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 200;
const HEIGHT = 100;

const ShellTubeHeatExchangerNode: React.FC<NodeProps<ShellTubeHeatExchangerNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [shellInType, setShellInType] = useState<HandleType>(data?.shellInType || 'target');
  const [shellOutType, setShellOutType] = useState<HandleType>(data?.shellOutType || 'source');
  const [tubeInType, setTubeInType] = useState<HandleType>(data?.tubeInType || 'target');
  const [tubeOutType, setTubeOutType] = useState<HandleType>(data?.tubeOutType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof ShellTubeHeatExchangerNodeData
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
  }, [id, shellInType, shellOutType, tubeInType, tubeOutType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 200 100">
        <defs>
          <linearGradient id={`shell-body-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#607D8B" />
            <stop offset="50%" stopColor="#78909C" />
            <stop offset="100%" stopColor="#607D8B" />
          </linearGradient>
        </defs>

        {/* Shell (main body) */}
        <ellipse cx={30} cy={45} rx={15} ry={25} fill="#546E7A" stroke="#455A64" strokeWidth={2} />
        <rect x={30} y={20} width={140} height={50} fill={`url(#shell-body-${id})`} stroke="#455A64" strokeWidth={2} />
        <ellipse cx={170} cy={45} rx={15} ry={25} fill="#546E7A" stroke="#455A64" strokeWidth={2} />

        {/* Tubes inside */}
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={35} y1={28 + i * 12} x2={165} y2={28 + i * 12} stroke="#90A4AE" strokeWidth={3} />
        ))}

        {/* Shell inlet (top) */}
        <rect x={55} y={5} width={20} height={15} fill="#EF5350" stroke="#E53935" strokeWidth={1} />
        <text x={65} y={17} fontSize={7} fill="#fff" textAnchor="middle">S</text>

        {/* Shell outlet (bottom) */}
        <rect x={125} y={70} width={20} height={15} fill="#EF5350" stroke="#E53935" strokeWidth={1} />
        <text x={135} y={82} fontSize={7} fill="#fff" textAnchor="middle">S</text>

        {/* Tube inlet (left) */}
        <rect x={5} y={38} width={15} height={14} fill="#42A5F5" stroke="#1E88E5" strokeWidth={1} />
        <text x={12} y={48} fontSize={7} fill="#fff" textAnchor="middle">T</text>

        {/* Tube outlet (right) */}
        <rect x={180} y={38} width={15} height={14} fill="#42A5F5" stroke="#1E88E5" strokeWidth={1} />
        <text x={188} y={48} fontSize={7} fill="#fff" textAnchor="middle">T</text>

        {/* Label */}
        <text x={100} y={95} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Shell & Tube HX'}</text>
      </svg>

      {/* Shell In Handle (top) */}
      <div
        style={{ position: 'absolute', left: 65, top: 5, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(shellInType, setShellInType, 'shellInType')}
      >
        <Handle
          id={`st-shell-in-${shellInType}`}
          type={shellInType}
          position={Position.Top}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(shellInType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Shell Out Handle (bottom) */}
      <div
        style={{ position: 'absolute', left: 135, top: 85, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(shellOutType, setShellOutType, 'shellOutType')}
      >
        <Handle
          id={`st-shell-out-${shellOutType}`}
          type={shellOutType}
          position={Position.Bottom}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(shellOutType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Tube In Handle (left) */}
      <div
        style={{ position: 'absolute', left: 5, top: 45, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(tubeInType, setTubeInType, 'tubeInType')}
      >
        <Handle
          id={`st-tube-in-${tubeInType}`}
          type={tubeInType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(tubeInType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Tube Out Handle (right) */}
      <div
        style={{ position: 'absolute', left: 195, top: 45, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(tubeOutType, setTubeOutType, 'tubeOutType')}
      >
        <Handle
          id={`st-tube-out-${tubeOutType}`}
          type={tubeOutType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(tubeOutType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'shellTubeHeatExchanger',
  label: 'Shell & Tube HX',
  labelTr: 'Govde-Boru Isi Degistirici',
  category: 'heating_cooling',
  description: 'Shell and tube heat exchanger',
  component: ShellTubeHeatExchangerNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['shell_tube_heat_exchanger', 'sthe', 'shell_tube_hx'],
});

export default ShellTubeHeatExchangerNode;
