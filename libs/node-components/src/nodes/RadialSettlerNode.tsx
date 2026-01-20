/**
 * RadialSettlerNode Component
 * Conical settling tank with 3 toggleable handles
 */

import React, { useEffect, useState } from 'react';
import { Handle, useUpdateNodeInternals, useReactFlow, NodeProps, Position } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface RadialSettlerNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  bottomType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 120;
const HEIGHT = 160;

const RadialSettlerNode: React.FC<NodeProps<RadialSettlerNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'target');
  const [bottomType, setBottomType] = useState<HandleType>(data?.bottomType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';
  const toggleType = (type: HandleType): HandleType => (type === 'source' ? 'target' : 'source');

  const handleRightClick = (e: React.MouseEvent, side: 'left' | 'right' | 'bottom') => {
    if (isScadaMode) return;
    e.preventDefault();
    e.stopPropagation();

    const newVal = side === 'left' ? toggleType(leftType) : side === 'right' ? toggleType(rightType) : toggleType(bottomType);

    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, [`${side}Type`]: newVal } } : node
      )
    );

    if (side === 'left') setLeftType(newVal);
    if (side === 'right') setRightType(newVal);
    if (side === 'bottom') setBottomType(newVal);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [leftType, rightType, bottomType, id, updateNodeInternals]);

  return (
    <div style={{ width: WIDTH, height: HEIGHT, position: 'relative', pointerEvents: 'none', border: selected ? '2px solid #3b82f6' : '2px solid transparent', borderRadius: 8 }}>
      <svg width={WIDTH} height={HEIGHT} style={{ pointerEvents: 'auto' }}>
        <rect x="20" y="40" width="80" height="80" fill="#8e7c66" opacity="0.8" />
        <polygon points="20,120 60,160 100,120" fill="#8e7c66" opacity="0.8" />
        <ellipse cx="60" cy="20" rx="40" ry="10" fill="#bbb" stroke="#333" strokeWidth="2" />
        <line x1="20" y1="20" x2="20" y2="120" stroke="#333" strokeWidth="2" />
        <line x1="100" y1="20" x2="100" y2="120" stroke="#333" strokeWidth="2" />
        <polygon points="20,120 60,160 100,120" fill="#bbb" stroke="#333" strokeWidth="2" />
        <rect x="0" y="50" width="20" height="20" fill="#888" stroke="#333" strokeWidth="2" />
        <rect x="100" y="50" width="20" height="20" fill="#888" stroke="#333" strokeWidth="2" />
        <text x="60" y="90" fill="#000" textAnchor="middle" fontSize="12">{data?.label || 'Settler'}</text>
      </svg>

      <div style={{ position: 'absolute', left: 10, top: 60, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={(e) => handleRightClick(e, 'left')}>
        <Handle id={`radial-left-${leftType}`} type={leftType} position={Position.Left} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(leftType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
      <div style={{ position: 'absolute', left: 110, top: 60, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={(e) => handleRightClick(e, 'right')}>
        <Handle id={`radial-right-${rightType}`} type={rightType} position={Position.Right} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(rightType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
      <div style={{ position: 'absolute', left: 60, top: 160, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={(e) => handleRightClick(e, 'bottom')}>
        <Handle id={`radial-bottom-${bottomType}`} type={bottomType} position={Position.Bottom} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(bottomType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'radialSettler',
  label: 'Radial Settler',
  labelTr: 'Radyal Çöktürücü',
  category: 'filtration',
  description: 'Conical settling tank for solids separation',
  component: RadialSettlerNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['radial_settler', 'settler', 'settling_tank'],
});

export default RadialSettlerNode;
