/**
 * DrumFilterNode Component
 * Faivre Drum Filter with 5 toggleable handles
 */

import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals, NodeProps, Position } from 'reactflow';
import { useProcessStore } from '../../../store/processStore';

type HandleType = 'source' | 'target';

/**
 * Valid handle field names for DrumFilterNodeData
 */
type HandleFieldName = 'inletType1' | 'inletType2' | 'inletType3' | 'drainType' | 'outlet';

interface DrumFilterNodeData {
  inletType1?: HandleType;
  inletType2?: HandleType;
  inletType3?: HandleType;
  drainType?: HandleType;
  outlet?: HandleType;
  label?: string;
}

const SCALE_FACTOR = 0.56;
const BASE_LEFT_OFFSET = 60;
const BASE_TOP_OFFSET = 105;
const WIDTH = Math.round(812 * SCALE_FACTOR);
const HEIGHT = Math.round(315 * SCALE_FACTOR);

const DrumFilterNode: React.FC<NodeProps<DrumFilterNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useProcessStore((state) => state.updateNodeData);

  const [inletType1, setInletType1] = useState<HandleType>(data?.inletType1 || 'target');
  const [inletType2, setInletType2] = useState<HandleType>(data?.inletType2 || 'target');
  const [inletType3, setInletType3] = useState<HandleType>(data?.inletType3 || 'target');
  const [drainType, setDrainType] = useState<HandleType>(data?.drainType || 'source');
  const [outlet, setOutlet] = useState<HandleType>(data?.outlet || 'source');

  const toggleHandler = (
    currentType: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    fieldName: HandleFieldName
  ) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = currentType === 'source' ? 'target' : 'source';
    setFunc(newType);
    updateNodeData(id, { [fieldName]: newType } as Partial<DrumFilterNodeData>);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inletType1, inletType2, inletType3, drainType, outlet, updateNodeInternals]);

  const handleStyle = (
    left: number,
    top: number,
    color: string
  ): React.CSSProperties => ({
    position: 'absolute',
    left: (left - BASE_LEFT_OFFSET) * SCALE_FACTOR,
    top: (top - BASE_TOP_OFFSET) * SCALE_FACTOR,
    width: 10,
    height: 10,
    background: color,
    borderRadius: '50%',
    border: '2px solid white',
    transform: 'translate(-50%, -50%)',
    cursor: 'pointer',
    pointerEvents: 'all',
  });

  const getHandleColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

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
      <div style={{ transform: `scale(${SCALE_FACTOR})`, transformOrigin: 'top left' }}>
        <svg width="812" height="315" viewBox="60 105 812 315" xmlns="http://www.w3.org/2000/svg" style={{ pointerEvents: 'auto' }}>
          <rect width="100%" height="100%" fill="transparent" />
          {/* Inlet pipe */}
          <rect x="90" y="230" width="70" height="40" fill="#9e9e9e" stroke="#333" strokeWidth="2" />
          <text x="95" y="225" fontSize="13" fill="#333">Giris Borusu</text>
          {/* Drain pipe */}
          <rect x="100" y="180" width="120" height="15" fill="#7b5e57" stroke="#000" strokeWidth="1.5" />
          <text x="105" y="175" fontSize="12" fill="#000">Drenaj Borusu</text>
          {/* Main body */}
          <rect x="160" y="150" width="612" height="200" rx="20" ry="20" fill="#e0e0e0" stroke="#333" strokeWidth="2" />
          <text x="350" y="260" fontSize="16" fill="#000">{data?.label || 'Faivre 200 Drum Filtre'}</text>
          {/* Mesh pattern */}
          <defs>
            <pattern id="mesh" patternUnits="userSpaceOnUse" width="20" height="20">
              <path d="M0,0 L20,20 M20,0 L0,20" stroke="#888" strokeWidth="2" />
            </pattern>
          </defs>
          <rect x="180" y="170" width="572" height="160" fill="url(#mesh)" opacity="0.6" />
          {/* Service cover */}
          <rect x="200" y="120" width="540" height="30" rx="10" fill="#cfd8dc" stroke="#444" strokeWidth="2" />
          <text x="400" y="115" fontSize="13" fill="#000">Servis Kapagi</text>
          {/* Cover hinges */}
          <g stroke="#fff" strokeWidth="2">
            <path d="M220 120 L220 105 L235 105 L235 120" />
            <path d="M300 120 L300 105 L315 105 L315 120" />
            <path d="M380 120 L380 105 L395 105 L395 120" />
            <path d="M460 120 L460 105 L475 105 L475 120" />
            <path d="M540 120 L540 105 L555 105 L555 120" />
            <path d="M620 120 L620 105 L635 105 L635 120" />
          </g>
          {/* Bolts */}
          <g fill="#000">
            {[180, 220, 260, 300, 340, 380, 420, 460, 500, 540, 580, 620, 660, 700].map((cx) => (
              <circle key={cx} cx={cx} cy="160" r="3" />
            ))}
          </g>
          {/* Water drops */}
          <g fill="none" stroke="#00f" strokeWidth="1">
            {[180, 220, 260, 300, 340, 380, 420, 460, 500, 540, 580, 620, 660, 700].map((cx) => (
              <path key={cx} d={`M${cx} 160 L${cx - 5} 170 L${cx + 5} 170 Z`} />
            ))}
          </g>
          {/* Outlet pipe */}
          <rect x="772" y="230" width="70" height="40" fill="#9e9e9e" stroke="#333" strokeWidth="2" />
          <text x="777" y="225" fontSize="13" fill="#333">Cikis Borusu</text>
          {/* Motor */}
          <g>
            <rect x="752" y="160" width="40" height="60" fill="#757575" stroke="#222" strokeWidth="1.5" rx="5" />
            <circle cx="772" cy="190" r="10" fill="#212121" />
            <rect x="762" y="155" width="20" height="10" fill="#444" />
            <text x="742" y="150" fontSize="11" fill="#000">Motor</text>
            <g stroke="#000" strokeWidth="1">
              <circle cx="792" cy="190" r="10" fill="#00ff00" />
              <line x1="788" y1="186" x2="796" y2="194" />
              <line x1="788" y1="194" x2="796" y2="186" />
            </g>
          </g>
          {/* Support legs */}
          <g fill="#616161" stroke="#333" strokeWidth="1.5">
            <rect x="180" y="350" width="20" height="40" />
            <rect x="175" y="390" width="30" height="10" />
            <rect x="712" y="350" width="20" height="40" />
            <rect x="707" y="390" width="30" height="10" />
          </g>
          <text x="185" y="420" fontSize="11" fill="#000">Destek</text>
          <text x="717" y="420" fontSize="11" fill="#000">Destek</text>
        </svg>
      </div>

      {/* Handles */}
      <div
        style={handleStyle(90, 245, getHandleColor(inletType1))}
        onContextMenu={toggleHandler(inletType1, setInletType1, 'inletType1')}
      >
        <Handle
          id="inlet-1"
          type={inletType1}
          position={Position.Top}
          isConnectable={true}
          style={{ position: 'relative', width: '100%', height: '100%', background: 'inherit', borderRadius: '50%', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      <div
        style={handleStyle(90, 255, getHandleColor(inletType2))}
        onContextMenu={toggleHandler(inletType2, setInletType2, 'inletType2')}
      >
        <Handle
          id="inlet-2"
          type={inletType2}
          position={Position.Top}
          isConnectable={true}
          style={{ position: 'relative', width: '100%', height: '100%', background: 'inherit', borderRadius: '50%', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      <div
        style={handleStyle(90, 265, getHandleColor(inletType3))}
        onContextMenu={toggleHandler(inletType3, setInletType3, 'inletType3')}
      >
        <Handle
          id="inlet-3"
          type={inletType3}
          position={Position.Top}
          isConnectable={true}
          style={{ position: 'relative', width: '100%', height: '100%', background: 'inherit', borderRadius: '50%', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      <div
        style={handleStyle(100, 187, getHandleColor(drainType))}
        onContextMenu={toggleHandler(drainType, setDrainType, 'drainType')}
      >
        <Handle
          id="drain"
          type={drainType}
          position={Position.Top}
          isConnectable={true}
          style={{ position: 'relative', width: '100%', height: '100%', background: 'inherit', borderRadius: '50%', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      <div
        style={handleStyle(842, 250, getHandleColor(outlet))}
        onContextMenu={toggleHandler(outlet, setOutlet, 'outlet')}
      >
        <Handle
          id="outlet"
          type={outlet}
          position={Position.Top}
          isConnectable={true}
          style={{ position: 'relative', width: '100%', height: '100%', background: 'inherit', borderRadius: '50%', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

export default DrumFilterNode;
