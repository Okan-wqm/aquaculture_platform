/**
 * DrumFilterNode Component
 * Faivre 200 Drum Filter with 5 toggleable handles
 */

import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals, useReactFlow, NodeProps, Position } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface DrumFilterNodeData {
  inletType1?: HandleType;
  inletType2?: HandleType;
  inletType3?: HandleType;
  drainType?: HandleType;
  outlet?: HandleType;
  label?: string;
  isScadaMode?: boolean;
}

const WIDTH = 455;
const HEIGHT = 176;

const DrumFilterNode: React.FC<NodeProps<DrumFilterNodeData>> = ({ id, data, selected }) => {
  const [inletType1, setInletType1] = useState<HandleType>(data?.inletType1 || 'target');
  const [inletType2, setInletType2] = useState<HandleType>(data?.inletType2 || 'target');
  const [inletType3, setInletType3] = useState<HandleType>(data?.inletType3 || 'target');
  const [drainType, setDrainType] = useState<HandleType>(data?.drainType || 'source');
  const [outlet, setOutlet] = useState<HandleType>(data?.outlet || 'source');
  const isScadaMode = data?.isScadaMode || false;

  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();

  const toggleHandler = (
    currentType: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    fieldName: keyof DrumFilterNodeData
  ) => (e: React.MouseEvent) => {
    if (isScadaMode) return;
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = currentType === 'source' ? 'target' : 'source';
    setFunc(newType);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, [fieldName]: newType } } : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inletType1, inletType2, inletType3, drainType, outlet, updateNodeInternals]);

  const scaleFactor = 0.56;
  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        position: 'relative',
        pointerEvents: 'none',
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      <div style={{ transform: `scale(${scaleFactor})`, transformOrigin: 'top left' }}>
        <svg width="812" height="315" viewBox="60 105 812 315" xmlns="http://www.w3.org/2000/svg" style={{ pointerEvents: 'auto' }}>
          <rect width="100%" height="100%" fill="transparent" />
          <rect x="90" y="230" width="70" height="40" fill="#9e9e9e" stroke="#333" strokeWidth="2" />
          <text x="95" y="225" fontSize="13" fill="#333">Giris</text>
          <rect x="100" y="180" width="120" height="15" fill="#7b5e57" stroke="#000" strokeWidth="1.5" />
          <text x="105" y="175" fontSize="12" fill="#000">Drenaj</text>
          <rect x="160" y="150" width="612" height="200" rx="20" ry="20" fill="#e0e0e0" stroke="#333" strokeWidth="2" />
          <text x="350" y="260" fontSize="16" fill="#000">{data?.label || 'Drum Filter'}</text>
          <defs>
            <pattern id="mesh" patternUnits="userSpaceOnUse" width="20" height="20">
              <path d="M0,0 L20,20 M20,0 L0,20" stroke="#888" strokeWidth="2" />
            </pattern>
          </defs>
          <rect x="180" y="170" width="572" height="160" fill="url(#mesh)" opacity="0.6" />
          <rect x="200" y="120" width="540" height="30" rx="10" fill="#cfd8dc" stroke="#444" strokeWidth="2" />
          <g fill="#000">
            {[180, 220, 260, 300, 340, 380, 420, 460, 500, 540, 580, 620, 660, 700].map((cx) => (
              <circle key={cx} cx={cx} cy="160" r="3" />
            ))}
          </g>
          <rect x="772" y="230" width="70" height="40" fill="#9e9e9e" stroke="#333" strokeWidth="2" />
          <text x="777" y="225" fontSize="13" fill="#333">Cikis</text>
          <g>
            <rect x="752" y="160" width="40" height="60" fill="#757575" stroke="#222" strokeWidth="1.5" rx="5" />
            <circle cx="772" cy="190" r="10" fill="#212121" />
            <text x="768" y="194" fontSize="8" fill="#fff">M</text>
          </g>
        </svg>
      </div>

      {/* Handles */}
      <div style={{ position: 'absolute', left: 17, top: 70, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={toggleHandler(inletType1, setInletType1, 'inletType1')}>
        <Handle id={`inlet-1-${inletType1}`} type={inletType1} position={Position.Left} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inletType1), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
      <div style={{ position: 'absolute', left: 17, top: 84, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={toggleHandler(inletType2, setInletType2, 'inletType2')}>
        <Handle id={`inlet-2-${inletType2}`} type={inletType2} position={Position.Left} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inletType2), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
      <div style={{ position: 'absolute', left: 17, top: 98, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={toggleHandler(inletType3, setInletType3, 'inletType3')}>
        <Handle id={`inlet-3-${inletType3}`} type={inletType3} position={Position.Left} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(inletType3), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
      <div style={{ position: 'absolute', left: 22, top: 46, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={toggleHandler(drainType, setDrainType, 'drainType')}>
        <Handle id={`drain-${drainType}`} type={drainType} position={Position.Left} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(drainType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
      <div style={{ position: 'absolute', left: 438, top: 81, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }} onContextMenu={toggleHandler(outlet, setOutlet, 'outlet')}>
        <Handle id={`outlet-${outlet}`} type={outlet} position={Position.Right} style={{ position: 'relative', width: '100%', height: '100%', background: getColor(outlet), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }} />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'drumFilter',
  label: 'Drum Filter',
  labelTr: 'Tambur Filtre',
  category: 'filtration',
  description: 'Faivre 200 Drum Filter with multiple inlets',
  component: DrumFilterNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['drum_filter', 'filter_drum', 'drum-filter'],
});

export default DrumFilterNode;
