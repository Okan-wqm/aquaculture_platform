/**
 * PlateHeatExchangerNode Component
 * Plate-type heat exchanger for water temperature control
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface PlateHeatExchangerNodeData {
  label?: string;
  hotInType?: HandleType;
  hotOutType?: HandleType;
  coldInType?: HandleType;
  coldOutType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 140;
const HEIGHT = 160;

const PlateHeatExchangerNode: React.FC<NodeProps<PlateHeatExchangerNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [hotInType, setHotInType] = useState<HandleType>(data?.hotInType || 'target');
  const [hotOutType, setHotOutType] = useState<HandleType>(data?.hotOutType || 'source');
  const [coldInType, setColdInType] = useState<HandleType>(data?.coldInType || 'target');
  const [coldOutType, setColdOutType] = useState<HandleType>(data?.coldOutType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof PlateHeatExchangerNodeData
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
  }, [id, hotInType, hotOutType, coldInType, coldOutType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 140 160">
        <defs>
          <linearGradient id={`plate-frame-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#455A64" />
            <stop offset="50%" stopColor="#607D8B" />
            <stop offset="100%" stopColor="#455A64" />
          </linearGradient>
        </defs>

        {/* Frame */}
        <rect x={30} y={25} width={80} height={100} rx={3} fill={`url(#plate-frame-${id})`} stroke="#37474F" strokeWidth={2} />

        {/* Plates */}
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <rect key={i} x={35} y={32 + i * 13} width={70} height={10} rx={1} fill="#78909C" stroke="#546E7A" strokeWidth={0.5} />
        ))}

        {/* Hot flow (red) - top left to bottom right */}
        <rect x={5} y={35} width={25} height={10} fill="#EF5350" stroke="#E53935" strokeWidth={1} />
        <rect x={110} y={105} width={25} height={10} fill="#EF5350" stroke="#E53935" strokeWidth={1} />
        <text x={18} y={43} fontSize={7} fill="#fff" textAnchor="middle">HOT</text>

        {/* Cold flow (blue) - top right to bottom left */}
        <rect x={110} y={35} width={25} height={10} fill="#42A5F5" stroke="#1E88E5" strokeWidth={1} />
        <rect x={5} y={105} width={25} height={10} fill="#42A5F5" stroke="#1E88E5" strokeWidth={1} />
        <text x={122} y={43} fontSize={7} fill="#fff" textAnchor="middle">COLD</text>

        {/* Heat transfer arrows */}
        <path d="M 55 50 L 85 100" stroke="#FF5722" strokeWidth={2} strokeDasharray="4,2" opacity={0.6} />
        <path d="M 85 50 L 55 100" stroke="#2196F3" strokeWidth={2} strokeDasharray="4,2" opacity={0.6} />

        {/* Label */}
        <text x={70} y={145} fontSize={9} fill="#333" textAnchor="middle">{data?.label || 'Plate HX'}</text>
        <text x={70} y={155} fontSize={7} fill="#666" textAnchor="middle">Heat Exchanger</text>
      </svg>

      {/* Hot In Handle (top left) */}
      <div
        style={{ position: 'absolute', left: 5, top: 40, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(hotInType, setHotInType, 'hotInType')}
      >
        <Handle
          id={`plate-hot-in-${hotInType}`}
          type={hotInType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(hotInType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Hot Out Handle (bottom right) */}
      <div
        style={{ position: 'absolute', left: 135, top: 110, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(hotOutType, setHotOutType, 'hotOutType')}
      >
        <Handle
          id={`plate-hot-out-${hotOutType}`}
          type={hotOutType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(hotOutType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Cold In Handle (top right) */}
      <div
        style={{ position: 'absolute', left: 135, top: 40, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(coldInType, setColdInType, 'coldInType')}
      >
        <Handle
          id={`plate-cold-in-${coldInType}`}
          type={coldInType}
          position={Position.Right}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(coldInType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>

      {/* Cold Out Handle (bottom left) */}
      <div
        style={{ position: 'absolute', left: 5, top: 110, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle(coldOutType, setColdOutType, 'coldOutType')}
      >
        <Handle
          id={`plate-cold-out-${coldOutType}`}
          type={coldOutType}
          position={Position.Left}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(coldOutType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'plateHeatExchanger',
  label: 'Plate Heat Exchanger',
  labelTr: 'Plakali Isi Degistirici',
  category: 'heating_cooling',
  description: 'Plate-type heat exchanger',
  component: PlateHeatExchangerNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['plate_heat_exchanger', 'phe', 'plate_hx'],
});

export default PlateHeatExchangerNode;
