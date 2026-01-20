/**
 * EquipmentNode Component
 * Generic equipment node with 12 equipment types, dynamic sizing,
 * and 4 toggleable connection points (right-click to toggle input/output)
 */

import React, { memo, useState, useCallback, useEffect } from 'react';
import { Handle, Position, NodeProps, useReactFlow, useUpdateNodeInternals } from 'reactflow';
import { getEquipmentSize, ConnectionPointPosition, ConnectionPointType } from '../../config/equipmentTypes';

// Equipment type alias
type EquipmentType =
  | 'tank' | 'pump' | 'chiller' | 'heater' | 'root-blower'
  | 'fan' | 'feeder' | 'drum-filter' | 'sand-filter'
  | 'belt-filter' | 'electric-generator' | 'oxygen-generator';

// Node data interface
export interface EquipmentNodeData {
  equipmentType: EquipmentType;
  equipmentName?: string;
  equipmentCode?: string;
  status?: string;
  connectionPoints?: {
    top?: ConnectionPointType;
    right?: ConnectionPointType;
    bottom?: ConnectionPointType;
    left?: ConnectionPointType;
  };
}

// Status colors for equipment
const statusColors: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  operational: { bg: '#f0fdf4', border: '#4ade80', text: '#15803d', dot: '#22c55e' },
  active: { bg: '#f0fdf4', border: '#4ade80', text: '#15803d', dot: '#22c55e' },
  maintenance: { bg: '#fefce8', border: '#facc15', text: '#a16207', dot: '#eab308' },
  repair: { bg: '#fff7ed', border: '#fb923c', text: '#c2410c', dot: '#f97316' },
  out_of_service: { bg: '#fef2f2', border: '#f87171', text: '#b91c1c', dot: '#ef4444' },
  decommissioned: { bg: '#f9fafb', border: '#9ca3af', text: '#6b7280', dot: '#9ca3af' },
  standby: { bg: '#eff6ff', border: '#60a5fa', text: '#1d4ed8', dot: '#3b82f6' },
  preparing: { bg: '#faf5ff', border: '#c084fc', text: '#7c3aed', dot: '#a855f7' },
  cleaning: { bg: '#ecfeff', border: '#22d3ee', text: '#0e7490', dot: '#06b6d4' },
  harvesting: { bg: '#fffbeb', border: '#fbbf24', text: '#b45309', dot: '#f59e0b' },
  fallow: { bg: '#f5f5f4', border: '#a8a29e', text: '#57534e', dot: '#78716c' },
  quarantine: { bg: '#fff1f2', border: '#fb7185', text: '#be123c', dot: '#f43f5e' },
};

const getStatusStyle = (status: string) => {
  return statusColors[status?.toLowerCase()] || statusColors.standby;
};

// Connection point colors
const getConnectionPointStyle = (type: ConnectionPointType) => ({
  background: type === 'input' ? '#3b82f6' : '#22c55e',
  border: '2px solid white',
});

// Equipment Icons (inline SVG)
const EquipmentIcons: Record<string, React.FC<{ size: number; color: string }>> = {
  tank: ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="6" width="16" height="14" rx="2" stroke={color} strokeWidth="2" />
      <ellipse cx="12" cy="6" rx="8" ry="2" stroke={color} strokeWidth="2" />
      <path d="M8 14h8" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  pump: ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="6" stroke={color} strokeWidth="2" />
      <path d="M12 6v12M6 12h12" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M3 12h3M18 12h3" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  chiller: ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke={color} strokeWidth="2" />
      <path d="M8 12l2-3 2 3 2-3 2 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="6" cy="16" r="1" fill={color} />
      <circle cx="18" cy="16" r="1" fill={color} />
    </svg>
  ),
  heater: ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="6" width="16" height="12" rx="2" stroke={color} strokeWidth="2" />
      <path d="M8 10v4M12 9v6M16 10v4" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  'root-blower': ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <ellipse cx="12" cy="12" rx="8" ry="6" stroke={color} strokeWidth="2" />
      <ellipse cx="8" cy="12" rx="2" ry="3" stroke={color} strokeWidth="1.5" />
      <ellipse cx="16" cy="12" rx="2" ry="3" stroke={color} strokeWidth="1.5" />
      <path d="M4 12h2M18 12h2" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  fan: ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" fill={color} />
      <path d="M12 3c0 5-3 6-3 9s3 4 3 9c0-5 3-6 3-9s-3-4-3-9z" stroke={color} strokeWidth="1.5" />
      <path d="M3 12c5 0 6-3 9-3s4 3 9 3c-5 0-6 3-9 3s-4-3-9-3z" stroke={color} strokeWidth="1.5" />
    </svg>
  ),
  feeder: ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 8h12l-2 10H8L6 8z" stroke={color} strokeWidth="2" />
      <path d="M4 8h16" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M10 12l2 3 2-3" stroke={color} strokeWidth="1.5" />
    </svg>
  ),
  'drum-filter': ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="7" width="16" height="10" rx="5" stroke={color} strokeWidth="2" />
      <ellipse cx="4" cy="12" rx="1" ry="5" stroke={color} strokeWidth="1.5" />
      <ellipse cx="20" cy="12" rx="1" ry="5" stroke={color} strokeWidth="1.5" />
      <path d="M8 9v6M12 8v8M16 9v6" stroke={color} strokeWidth="1" opacity="0.5" />
    </svg>
  ),
  'sand-filter': ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 4h12l-2 16H8L6 4z" stroke={color} strokeWidth="2" />
      <path d="M7 10h10" stroke={color} strokeWidth="1.5" strokeDasharray="2 1" />
      <circle cx="9" cy="14" r="1" fill={color} opacity="0.5" />
      <circle cx="12" cy="15" r="1" fill={color} opacity="0.5" />
      <circle cx="15" cy="14" r="1" fill={color} opacity="0.5" />
    </svg>
  ),
  'belt-filter': ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="18" height="8" stroke={color} strokeWidth="2" />
      <circle cx="6" cy="12" r="2" stroke={color} strokeWidth="1.5" />
      <circle cx="18" cy="12" r="2" stroke={color} strokeWidth="1.5" />
      <path d="M8 12h8" stroke={color} strokeWidth="2" strokeDasharray="3 2" />
    </svg>
  ),
  'electric-generator': ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="6" width="16" height="12" rx="2" stroke={color} strokeWidth="2" />
      <path d="M13 9l-3 3h4l-3 3" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  'oxygen-generator': ({ size, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="7" stroke={color} strokeWidth="2" />
      <text x="12" y="16" textAnchor="middle" fontSize="10" fill={color} fontWeight="bold">O₂</text>
    </svg>
  ),
};

const getEquipmentIcon = (type: string) => {
  return EquipmentIcons[type] || EquipmentIcons['tank'];
};

export const EquipmentNode = memo(({ id, data, selected }: NodeProps<EquipmentNodeData>) => {
  const Icon = getEquipmentIcon(data.equipmentType);
  const statusStyle = getStatusStyle(data.status || 'standby');
  const size = getEquipmentSize(data.equipmentType);

  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  // Local state for connection points
  const [connectionPoints, setConnectionPoints] = useState({
    top: data.connectionPoints?.top || 'input' as ConnectionPointType,
    right: data.connectionPoints?.right || 'output' as ConnectionPointType,
    bottom: data.connectionPoints?.bottom || 'output' as ConnectionPointType,
    left: data.connectionPoints?.left || 'input' as ConnectionPointType,
  });

  // Sync with data changes
  useEffect(() => {
    if (data.connectionPoints) {
      setConnectionPoints({
        top: data.connectionPoints.top || 'input',
        right: data.connectionPoints.right || 'output',
        bottom: data.connectionPoints.bottom || 'output',
        left: data.connectionPoints.left || 'input',
      });
    }
  }, [data.connectionPoints]);

  // Update node internals when connection points change
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, connectionPoints, updateNodeInternals]);

  // Toggle connection point type on right-click
  const handleToggleConnectionPoint = useCallback(
    (e: React.MouseEvent, point: ConnectionPointPosition) => {
      e.preventDefault();
      e.stopPropagation();

      const currentType = connectionPoints[point];
      const newType: ConnectionPointType = currentType === 'input' ? 'output' : 'input';

      const newConnectionPoints = { ...connectionPoints, [point]: newType };
      setConnectionPoints(newConnectionPoints);

      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, connectionPoints: newConnectionPoints } }
            : node
        )
      );
    },
    [id, connectionPoints, setNodes]
  );

  // Calculate icon size
  const iconSize = Math.min(size.width, size.height) * 0.35;

  return (
    <div
      style={{
        width: size.width,
        height: size.height,
        position: 'relative',
        backgroundColor: statusStyle.bg,
        border: `2px solid ${selected ? '#3b82f6' : statusStyle.border}`,
        borderRadius: 8,
        boxShadow: selected ? '0 0 0 2px rgba(59, 130, 246, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
        transition: 'all 0.2s ease',
        transform: selected ? 'scale(1.02)' : 'scale(1)',
      }}
    >
      {/* Connection Point - Top */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: -8,
          transform: 'translateX(-50%)',
          width: 16,
          height: 16,
          zIndex: 10,
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleToggleConnectionPoint(e, 'top')}
      >
        <Handle
          type={connectionPoints.top === 'input' ? 'target' : 'source'}
          position={Position.Top}
          id="top"
          style={{
            ...getConnectionPointStyle(connectionPoints.top),
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            cursor: 'pointer',
            position: 'relative',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Connection Point - Right */}
      <div
        style={{
          position: 'absolute',
          right: -8,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 16,
          height: 16,
          zIndex: 10,
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleToggleConnectionPoint(e, 'right')}
      >
        <Handle
          type={connectionPoints.right === 'input' ? 'target' : 'source'}
          position={Position.Right}
          id="right"
          style={{
            ...getConnectionPointStyle(connectionPoints.right),
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            cursor: 'pointer',
            position: 'relative',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Connection Point - Bottom */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: -8,
          transform: 'translateX(-50%)',
          width: 16,
          height: 16,
          zIndex: 10,
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleToggleConnectionPoint(e, 'bottom')}
      >
        <Handle
          type={connectionPoints.bottom === 'input' ? 'target' : 'source'}
          position={Position.Bottom}
          id="bottom"
          style={{
            ...getConnectionPointStyle(connectionPoints.bottom),
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            cursor: 'pointer',
            position: 'relative',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Connection Point - Left */}
      <div
        style={{
          position: 'absolute',
          left: -8,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 16,
          height: 16,
          zIndex: 10,
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleToggleConnectionPoint(e, 'left')}
      >
        <Handle
          type={connectionPoints.left === 'input' ? 'target' : 'source'}
          position={Position.Left}
          id="left"
          style={{
            ...getConnectionPointStyle(connectionPoints.left),
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            cursor: 'pointer',
            position: 'relative',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Node Content */}
      <div
        style={{
          padding: 12,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Icon */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon size={iconSize} color={statusStyle.text} />
        </div>

        {/* Equipment Info */}
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <div
            style={{
              fontWeight: 500,
              fontSize: 13,
              color: '#111827',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={data.equipmentName}
          >
            {data.equipmentName || data.equipmentType}
          </div>
          {data.equipmentCode && (
            <div
              style={{
                fontSize: 11,
                color: '#6b7280',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={data.equipmentCode}
            >
              {data.equipmentCode}
            </div>
          )}
        </div>

        {/* Status Badge */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 8,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: 12,
              fontSize: 11,
              fontWeight: 500,
              backgroundColor: statusStyle.bg,
              color: statusStyle.text,
              border: `1px solid ${statusStyle.border}`,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                marginRight: 6,
                backgroundColor: statusStyle.dot,
                animation: data.status === 'operational' || data.status === 'active'
                  ? 'pulse 2s infinite'
                  : 'none',
              }}
            />
            {(data.status || 'standby').charAt(0).toUpperCase() +
             (data.status || 'standby').slice(1).replace('_', ' ')}
          </span>
        </div>
      </div>

      {/* Pulse animation style */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
});

EquipmentNode.displayName = 'EquipmentNode';

export default EquipmentNode;
