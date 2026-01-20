/**
 * UltrafiltrationNode Component
 * Membrane ultrafiltration unit with 3 cylinders, PLC and power connections
 * 9 toggleable handles: 3 water flow + 3 PLC + 3 electrical
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface UltrafiltrationNodeData {
  label?: string;
  backflushType?: HandleType;
  feedType?: HandleType;
  cleanWaterType?: HandleType;
  plc1Type?: HandleType;
  plc2Type?: HandleType;
  plc3Type?: HandleType;
  elec1Type?: HandleType;
  elec2Type?: HandleType;
  elec3Type?: HandleType;
  isScadaMode?: boolean;
}

const SCALE_FACTOR = 0.8;
const WIDTH = 260 * SCALE_FACTOR;
const HEIGHT = 280 * SCALE_FACTOR;

const UltrafiltrationNode: React.FC<NodeProps<UltrafiltrationNodeData>> = ({ id, data, selected }) => {
  const isScadaMode = data?.isScadaMode || false;
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();

  // Water flow handle states
  const [backflushType, setBackflushType] = useState<HandleType>(data?.backflushType || 'target');
  const [feedType, setFeedType] = useState<HandleType>(data?.feedType || 'target');
  const [cleanWaterType, setCleanWaterType] = useState<HandleType>(data?.cleanWaterType || 'source');

  // PLC handle states
  const [plc1Type, setPlc1Type] = useState<HandleType>(data?.plc1Type || 'source');
  const [plc2Type, setPlc2Type] = useState<HandleType>(data?.plc2Type || 'source');
  const [plc3Type, setPlc3Type] = useState<HandleType>(data?.plc3Type || 'source');

  // Electrical handle states
  const [elec1Type, setElec1Type] = useState<HandleType>(data?.elec1Type || 'target');
  const [elec2Type, setElec2Type] = useState<HandleType>(data?.elec2Type || 'target');
  const [elec3Type, setElec3Type] = useState<HandleType>(data?.elec3Type || 'target');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof UltrafiltrationNodeData
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
  }, [id, backflushType, feedType, cleanWaterType, plc1Type, plc2Type, plc3Type, elec1Type, elec2Type, elec3Type, updateNodeInternals]);

  return (
    <div
      style={{
        position: 'relative',
        width: WIDTH,
        height: HEIGHT,
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox="0 0 260 280"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="uf-cylinderGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#9E9E9E"/>
            <stop offset="20%" stopColor="#E0E0E0"/>
            <stop offset="50%" stopColor="#FAFAFA"/>
            <stop offset="80%" stopColor="#BDBDBD"/>
            <stop offset="100%" stopColor="#757575"/>
          </linearGradient>
          <radialGradient id="uf-topCapGradient" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#BDBDBD"/>
            <stop offset="70%" stopColor="#9E9E9E"/>
            <stop offset="100%" stopColor="#616161"/>
          </radialGradient>
          <radialGradient id="uf-bottomCapGradient" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#757575"/>
            <stop offset="100%" stopColor="#424242"/>
          </radialGradient>
          <linearGradient id="uf-pipeGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#78909C"/>
            <stop offset="50%" stopColor="#B0BEC5"/>
            <stop offset="100%" stopColor="#546E7A"/>
          </linearGradient>
          <linearGradient id="uf-feedWater" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#1976D2"/>
            <stop offset="100%" stopColor="#42A5F5"/>
          </linearGradient>
          <linearGradient id="uf-cleanWater" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#4FC3F7"/>
            <stop offset="100%" stopColor="#81D4FA"/>
          </linearGradient>
          <linearGradient id="uf-backflushWater" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FF9800"/>
            <stop offset="100%" stopColor="#FFB74D"/>
          </linearGradient>
          <linearGradient id="uf-autoBoxGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#455A64"/>
            <stop offset="50%" stopColor="#607D8B"/>
            <stop offset="100%" stopColor="#37474F"/>
          </linearGradient>
          <linearGradient id="uf-elecBoxGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#F57C00"/>
            <stop offset="50%" stopColor="#FF9800"/>
            <stop offset="100%" stopColor="#E65100"/>
          </linearGradient>
        </defs>

        {/* Label */}
        <text x="90" y="14" fontSize="11" fill="#333" fontFamily="Arial" textAnchor="middle" fontWeight="bold">ULTRAFILTRATION</text>

        {/* Top connection pipe */}
        <rect x="20" y="28" width="140" height="10" rx="2" fill="url(#uf-pipeGradient)" stroke="#455A64" strokeWidth="1.5"/>

        {/* Backflush inlet */}
        <rect x="5" y="30" width="15" height="6" fill="url(#uf-backflushWater)" stroke="#E65100" strokeWidth="1"/>
        <circle cx="5" cy="33" r="2.5" fill="#222" stroke="#111" strokeWidth="1"/>
        <text x="3" y="26" fontSize="5" fill="#E65100" fontFamily="Arial" fontWeight="bold">BACKFLUSH</text>

        {/* Feed outlet */}
        <rect x="160" y="30" width="15" height="6" fill="url(#uf-feedWater)" stroke="#1565C0" strokeWidth="1"/>
        <circle cx="175" cy="33" r="2.5" fill="#222" stroke="#111" strokeWidth="1"/>
        <text x="162" y="26" fontSize="6" fill="#1565C0" fontFamily="Arial" fontWeight="bold">FEED</text>

        {/* Cylinder 1 (Left) */}
        <rect x="42" y="38" width="8" height="35" fill="url(#uf-pipeGradient)" stroke="#455A64" strokeWidth="1"/>
        <ellipse cx="46" cy="73" rx="14" ry="5" fill="url(#uf-topCapGradient)" stroke="#616161" strokeWidth="1"/>
        <rect x="32" y="73" width="28" height="120" fill="url(#uf-cylinderGradient)" stroke="#616161" strokeWidth="1.5"/>
        <line x1="38" y1="81" x2="38" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <line x1="46" y1="81" x2="46" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <line x1="54" y1="81" x2="54" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <ellipse cx="46" cy="193" rx="14" ry="5" fill="url(#uf-bottomCapGradient)" stroke="#424242" strokeWidth="1"/>
        <rect x="42" y="193" width="8" height="35" fill="url(#uf-cleanWater)" stroke="#0288D1" strokeWidth="1"/>

        {/* Cylinder 2 (Middle) */}
        <rect x="86" y="38" width="8" height="35" fill="url(#uf-pipeGradient)" stroke="#455A64" strokeWidth="1"/>
        <ellipse cx="90" cy="73" rx="14" ry="5" fill="url(#uf-topCapGradient)" stroke="#616161" strokeWidth="1"/>
        <rect x="76" y="73" width="28" height="120" fill="url(#uf-cylinderGradient)" stroke="#616161" strokeWidth="1.5"/>
        <line x1="82" y1="81" x2="82" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <line x1="90" y1="81" x2="90" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <line x1="98" y1="81" x2="98" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <ellipse cx="90" cy="193" rx="14" ry="5" fill="url(#uf-bottomCapGradient)" stroke="#424242" strokeWidth="1"/>
        <rect x="86" y="193" width="8" height="35" fill="url(#uf-cleanWater)" stroke="#0288D1" strokeWidth="1"/>

        {/* Cylinder 3 (Right) */}
        <rect x="130" y="38" width="8" height="35" fill="url(#uf-pipeGradient)" stroke="#455A64" strokeWidth="1"/>
        <ellipse cx="134" cy="73" rx="14" ry="5" fill="url(#uf-topCapGradient)" stroke="#616161" strokeWidth="1"/>
        <rect x="120" y="73" width="28" height="120" fill="url(#uf-cylinderGradient)" stroke="#616161" strokeWidth="1.5"/>
        <line x1="126" y1="81" x2="126" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <line x1="134" y1="81" x2="134" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <line x1="142" y1="81" x2="142" y2="185" stroke="#BDBDBD" strokeWidth="1" strokeDasharray="4,3"/>
        <ellipse cx="134" cy="193" rx="14" ry="5" fill="url(#uf-bottomCapGradient)" stroke="#424242" strokeWidth="1"/>
        <rect x="130" y="193" width="8" height="35" fill="url(#uf-cleanWater)" stroke="#0288D1" strokeWidth="1"/>

        {/* Bottom clean water collection */}
        <rect x="20" y="228" width="140" height="7" fill="url(#uf-cleanWater)" stroke="#0288D1" strokeWidth="1.5"/>
        <rect x="160" y="229" width="15" height="5" fill="url(#uf-cleanWater)" stroke="#0288D1" strokeWidth="1"/>
        <circle cx="175" cy="231.5" r="2.5" fill="#222" stroke="#111" strokeWidth="1"/>
        <text x="148" y="245" fontSize="5" fill="#0288D1" fontFamily="Arial" fontWeight="bold">CLEAN WATER</text>

        {/* Automation box (PLC) */}
        <rect x="195" y="60" width="38" height="45" rx="2" fill="url(#uf-autoBoxGradient)" stroke="#263238" strokeWidth="1.5"/>
        <text x="214" y="71" fontSize="5" fill="#B0BEC5" fontFamily="Arial" textAnchor="middle" fontWeight="bold">PLC</text>
        <text x="214" y="79" fontSize="4" fill="#90A4AE" fontFamily="Arial" textAnchor="middle">AUTOMATION</text>
        <circle cx="203" cy="88" r="2" fill="#4CAF50" stroke="#2E7D32" strokeWidth="0.5"/>
        <circle cx="210" cy="88" r="2" fill="#F44336" stroke="#C62828" strokeWidth="0.5"/>
        <circle cx="217" cy="88" r="2" fill="#FFC107" stroke="#F9A825" strokeWidth="0.5"/>
        <circle cx="224" cy="88" r="2" fill="#2196F3" stroke="#1565C0" strokeWidth="0.5"/>
        <rect x="201" y="94" width="26" height="8" rx="1" fill="#1B5E20" stroke="#0D47A1" strokeWidth="0.5"/>
        <text x="214" y="100" fontSize="4" fill="#76FF03" fontFamily="monospace" textAnchor="middle">RUN</text>
        <path d="M 195 80 Q 180 80, 165 70 L 148 63" stroke="#2196F3" strokeWidth="1.5" fill="none" strokeDasharray="2,1"/>
        <circle cx="233" cy="70" r="1.5" fill="#222" stroke="#111" strokeWidth="0.8"/>
        <circle cx="233" cy="80" r="1.5" fill="#222" stroke="#111" strokeWidth="0.8"/>
        <circle cx="233" cy="90" r="1.5" fill="#222" stroke="#111" strokeWidth="0.8"/>

        {/* Electrical box */}
        <rect x="195" y="115" width="38" height="40" rx="2" fill="url(#uf-elecBoxGradient)" stroke="#BF360C" strokeWidth="1.5"/>
        <text x="214" y="126" fontSize="5" fill="#FFF3E0" fontFamily="Arial" textAnchor="middle" fontWeight="bold">POWER</text>
        <text x="214" y="133" fontSize="4" fill="#FFE0B2" fontFamily="Arial" textAnchor="middle">ELECTRIC</text>
        <rect x="201" y="137" width="6" height="10" rx="1" fill="#424242" stroke="#212121" strokeWidth="0.5"/>
        <rect x="211" y="137" width="6" height="10" rx="1" fill="#424242" stroke="#212121" strokeWidth="0.5"/>
        <rect x="221" y="137" width="6" height="10" rx="1" fill="#424242" stroke="#212121" strokeWidth="0.5"/>
        <rect x="202.5" y="138" width="3" height="4" fill="#4CAF50"/>
        <rect x="212.5" y="138" width="3" height="4" fill="#4CAF50"/>
        <rect x="222.5" y="143" width="3" height="4" fill="#F44336"/>
        <path d="M 195 130 Q 180 130, 165 115 L 148 105" stroke="#F44336" strokeWidth="1.5" fill="none"/>
        <circle cx="233" cy="125" r="1.5" fill="#222" stroke="#111" strokeWidth="0.8"/>
        <circle cx="233" cy="135" r="1.5" fill="#222" stroke="#111" strokeWidth="0.8"/>
        <circle cx="233" cy="145" r="1.5" fill="#222" stroke="#111" strokeWidth="0.8"/>
      </svg>

      {/* BACKFLUSH Handle */}
      <div
        style={{
          position: 'absolute',
          left: 5 * SCALE_FACTOR,
          top: 33 * SCALE_FACTOR,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={toggleHandle(backflushType, setBackflushType, 'backflushType')}
      >
        <Handle
          id={`uf-backflush-${backflushType}`}
          type={backflushType}
          position={Position.Left}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(backflushType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* FEED Handle */}
      <div
        style={{
          position: 'absolute',
          left: 175 * SCALE_FACTOR,
          top: 33 * SCALE_FACTOR,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={toggleHandle(feedType, setFeedType, 'feedType')}
      >
        <Handle
          id={`uf-feed-${feedType}`}
          type={feedType}
          position={Position.Right}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(feedType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* CLEAN WATER Handle */}
      <div
        style={{
          position: 'absolute',
          left: 175 * SCALE_FACTOR,
          top: 231.5 * SCALE_FACTOR,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={toggleHandle(cleanWaterType, setCleanWaterType, 'cleanWaterType')}
      >
        <Handle
          id={`uf-cleanwater-${cleanWaterType}`}
          type={cleanWaterType}
          position={Position.Right}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(cleanWaterType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* PLC Handles */}
      {[70, 80, 90].map((y, i) => {
        const types = [plc1Type, plc2Type, plc3Type];
        const setters = [setPlc1Type, setPlc2Type, setPlc3Type];
        const keys: (keyof UltrafiltrationNodeData)[] = ['plc1Type', 'plc2Type', 'plc3Type'];
        return (
          <div
            key={`plc-${i}`}
            style={{
              position: 'absolute',
              left: 233 * SCALE_FACTOR,
              top: y * SCALE_FACTOR,
              width: 12,
              height: 12,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'all',
            }}
            onContextMenu={toggleHandle(types[i], setters[i], keys[i])}
          >
            <Handle
              id={`uf-plc${i + 1}-${types[i]}`}
              type={types[i]}
              position={Position.Right}
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                background: getColor(types[i]),
                borderRadius: '50%',
                border: '2px solid white',
                cursor: isScadaMode ? 'default' : 'pointer',
                transform: 'none',
                left: 0,
                top: 0,
              }}
            />
          </div>
        );
      })}

      {/* Electrical Handles */}
      {[125, 135, 145].map((y, i) => {
        const types = [elec1Type, elec2Type, elec3Type];
        const setters = [setElec1Type, setElec2Type, setElec3Type];
        const keys: (keyof UltrafiltrationNodeData)[] = ['elec1Type', 'elec2Type', 'elec3Type'];
        return (
          <div
            key={`elec-${i}`}
            style={{
              position: 'absolute',
              left: 233 * SCALE_FACTOR,
              top: y * SCALE_FACTOR,
              width: 12,
              height: 12,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'all',
            }}
            onContextMenu={toggleHandle(types[i], setters[i], keys[i])}
          >
            <Handle
              id={`uf-elec${i + 1}-${types[i]}`}
              type={types[i]}
              position={Position.Right}
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                background: getColor(types[i]),
                borderRadius: '50%',
                border: '2px solid white',
                cursor: isScadaMode ? 'default' : 'pointer',
                transform: 'none',
                left: 0,
                top: 0,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'ultrafiltration',
  label: 'Ultrafiltration',
  labelTr: 'Ultrafiltrasyon',
  category: 'filtration',
  description: 'Membrane ultrafiltration unit with PLC and power connections',
  component: UltrafiltrationNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['ultrafiltration', 'uf', 'membrane_filter'],
});

export default UltrafiltrationNode;
