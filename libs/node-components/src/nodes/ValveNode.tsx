/**
 * ValveNode Component
 * Generic valve (ball, gate, butterfly) for flow control
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';
type ValveType = 'ball' | 'gate' | 'butterfly' | 'check';

interface ValveNodeData {
  label?: string;
  valveType?: ValveType;
  isOpen?: boolean;
  leftType?: HandleType;
  rightType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 80;
const HEIGHT = 60;

const valveColors = {
  open: { body: '#4CAF50', indicator: '#81C784' },
  closed: { body: '#F44336', indicator: '#E57373' },
};

const ValveNode: React.FC<NodeProps<ValveNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const valveType = data?.valveType || 'ball';
  const isOpen = data?.isOpen !== false;
  const colors = isOpen ? valveColors.open : valveColors.closed;

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof ValveNodeData
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
  }, [id, leftType, rightType, updateNodeInternals]);

  const renderValveBody = () => {
    switch (valveType) {
      case 'butterfly':
        return (
          <>
            <circle cx={40} cy={25} r={15} fill="none" stroke={colors.body} strokeWidth={3} />
            <line
              x1={40}
              y1={10}
              x2={40}
              y2={40}
              stroke={colors.indicator}
              strokeWidth={3}
              transform={isOpen ? 'rotate(0 40 25)' : 'rotate(90 40 25)'}
            />
          </>
        );
      case 'gate':
        return (
          <>
            <rect x={30} y={15} width={20} height={20} fill={colors.body} stroke="#333" strokeWidth={1} />
            <rect
              x={35}
              y={isOpen ? 5 : 18}
              width={10}
              height={12}
              fill={colors.indicator}
              stroke="#333"
              strokeWidth={1}
            />
          </>
        );
      case 'check':
        return (
          <>
            <polygon points="25,15 55,25 25,35" fill={colors.body} stroke="#333" strokeWidth={1} />
            <circle cx={35} cy={25} r={3} fill={colors.indicator} />
          </>
        );
      case 'ball':
      default:
        return (
          <>
            <polygon points="25,15 40,25 25,35" fill={colors.body} stroke="#333" strokeWidth={1} />
            <polygon points="55,15 40,25 55,35" fill={colors.body} stroke="#333" strokeWidth={1} />
            <circle cx={40} cy={25} r={8} fill={colors.indicator} stroke="#333" strokeWidth={1} />
          </>
        );
    }
  };

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 80 60">
        {/* Inlet pipe */}
        <rect x={5} y={20} width={20} height={10} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Outlet pipe */}
        <rect x={55} y={20} width={20} height={10} fill="#78909C" stroke="#546E7A" strokeWidth={1} />

        {/* Valve body */}
        {renderValveBody()}

        {/* Actuator/handle */}
        <rect x={35} y={2} width={10} height={8} rx={1} fill="#455A64" stroke="#37474F" strokeWidth={1} />

        {/* Label */}
        <text x={40} y={55} fontSize={8} fill="#333" textAnchor="middle">{data?.label || valveType.toUpperCase()}</text>
      </svg>

      {/* Left Handle */}
      <div
        style={{ position: 'absolute', left: 5, top: 25, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(leftType, setLeftType, 'leftType')}
      >
        <Handle
          id={`valve-left-${leftType}`}
          type={leftType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(leftType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Right Handle */}
      <div
        style={{ position: 'absolute', left: 75, top: 25, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(rightType, setRightType, 'rightType')}
      >
        <Handle
          id={`valve-right-${rightType}`}
          type={rightType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(rightType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'valve',
  label: 'Valve',
  labelTr: 'Vana',
  category: 'distribution',
  description: 'Flow control valve',
  component: ValveNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['valve', 'ball_valve', 'gate_valve', 'butterfly_valve', 'check_valve'],
});

export default ValveNode;
