/**
 * SensorNode Component
 * Generic sensor node for monitoring parameters (pH, DO, temperature, etc.)
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';
type SensorType = 'pH' | 'DO' | 'temperature' | 'conductivity' | 'turbidity' | 'flow' | 'level' | 'pressure';

interface SensorNodeData {
  label?: string;
  sensorType?: SensorType;
  value?: number;
  unit?: string;
  connectionType?: HandleType;
  isScadaMode?: boolean;
}

const WIDTH = 80;
const HEIGHT = 100;

const sensorColors: Record<SensorType, { bg: string; stroke: string; text: string }> = {
  pH: { bg: '#E8F5E9', stroke: '#4CAF50', text: '#2E7D32' },
  DO: { bg: '#E3F2FD', stroke: '#2196F3', text: '#1565C0' },
  temperature: { bg: '#FFF3E0', stroke: '#FF9800', text: '#E65100' },
  conductivity: { bg: '#F3E5F5', stroke: '#9C27B0', text: '#6A1B9A' },
  turbidity: { bg: '#EFEBE9', stroke: '#795548', text: '#4E342E' },
  flow: { bg: '#E0F7FA', stroke: '#00BCD4', text: '#00838F' },
  level: { bg: '#FCE4EC', stroke: '#E91E63', text: '#AD1457' },
  pressure: { bg: '#FFFDE7', stroke: '#FFEB3B', text: '#F57F17' },
};

const sensorIcons: Record<SensorType, string> = {
  pH: 'pH',
  DO: 'O₂',
  temperature: '°C',
  conductivity: 'μS',
  turbidity: 'NTU',
  flow: 'm³',
  level: '%',
  pressure: 'bar',
};

const SensorNode: React.FC<NodeProps<SensorNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const sensorType = data?.sensorType || 'pH';
  const colors = sensorColors[sensorType];
  const icon = sensorIcons[sensorType];

  const [connectionType, setConnectionType] = useState<HandleType>(data?.connectionType || 'target');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (e: React.MouseEvent) => {
    if (isScadaMode) return;
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = connectionType === 'source' ? 'target' : 'source';
    setConnectionType(newType);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, connectionType: newType } } : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, connectionType, updateNodeInternals]);

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
      <svg width={WIDTH} height={HEIGHT} viewBox="0 0 80 100">
        {/* Sensor body */}
        <circle cx={40} cy={40} r={30} fill={colors.bg} stroke={colors.stroke} strokeWidth={2} />

        {/* Inner circle */}
        <circle cx={40} cy={40} r={20} fill="white" stroke={colors.stroke} strokeWidth={1} />

        {/* Sensor type icon */}
        <text x={40} y={45} fontSize={14} fill={colors.text} textAnchor="middle" fontWeight="bold">{icon}</text>

        {/* Probe */}
        <rect x={37} y={70} width={6} height={20} rx={2} fill={colors.stroke} />

        {/* Value display (if available) */}
        {data?.value !== undefined && (
          <text x={40} y={55} fontSize={8} fill={colors.text} textAnchor="middle">
            {data.value}{data.unit || ''}
          </text>
        )}

        {/* Label */}
        <text x={40} y={95} fontSize={9} fill="#333" textAnchor="middle">{data?.label || sensorType}</text>
      </svg>

      {/* Connection Handle */}
      <div
        style={{ position: 'absolute', left: 40, top: 90, width: 12, height: 12, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
        onContextMenu={toggleHandle}
      >
        <Handle
          id={`sensor-conn-${connectionType}`}
          type={connectionType}
          position={Position.Bottom}
          style={{ position: 'relative', width: '100%', height: '100%', background: getColor(connectionType), borderRadius: '50%', border: '2px solid white', cursor: isScadaMode ? 'default' : 'pointer', transform: 'none', left: 0, top: 0 }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'sensor',
  label: 'Sensor',
  labelTr: 'Sensor',
  category: 'monitoring',
  description: 'Generic sensor for water quality monitoring',
  component: SensorNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['sensor', 'probe', 'transmitter'],
});

export default SensorNode;
