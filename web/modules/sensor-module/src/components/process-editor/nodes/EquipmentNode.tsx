/**
 * Equipment Node Component for ReactFlow
 * Displays equipment with SVG icon, dynamic sizing, and configurable connection points
 */

import React, { memo, useState, useCallback } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { getEquipmentIcon } from '../../equipment-icons/EquipmentIconLoader';
import { getEquipmentSize, ConnectionPointPosition, ConnectionPointType } from '../../equipment-icons/equipmentTypes';
import { EquipmentNodeData, useProcessStore } from '../../../store/processStore';
import { ConnectionPointContextMenu } from '../components/ConnectionPointContextMenu';

// Status colors for equipment
const statusColors: Record<string, { bg: string; border: string; text: string }> = {
  operational: { bg: 'bg-green-50', border: 'border-green-400', text: 'text-green-700' },
  active: { bg: 'bg-green-50', border: 'border-green-400', text: 'text-green-700' },
  maintenance: { bg: 'bg-yellow-50', border: 'border-yellow-400', text: 'text-yellow-700' },
  repair: { bg: 'bg-orange-50', border: 'border-orange-400', text: 'text-orange-700' },
  out_of_service: { bg: 'bg-red-50', border: 'border-red-400', text: 'text-red-700' },
  decommissioned: { bg: 'bg-gray-50', border: 'border-gray-400', text: 'text-gray-500' },
  standby: { bg: 'bg-blue-50', border: 'border-blue-400', text: 'text-blue-700' },
  preparing: { bg: 'bg-purple-50', border: 'border-purple-400', text: 'text-purple-700' },
  cleaning: { bg: 'bg-cyan-50', border: 'border-cyan-400', text: 'text-cyan-700' },
  harvesting: { bg: 'bg-amber-50', border: 'border-amber-400', text: 'text-amber-700' },
  fallow: { bg: 'bg-stone-50', border: 'border-stone-400', text: 'text-stone-600' },
  quarantine: { bg: 'bg-rose-50', border: 'border-rose-400', text: 'text-rose-700' },
};

const getStatusStyle = (status: string) => {
  return statusColors[status.toLowerCase()] || statusColors.standby;
};

// Connection point styles based on type
const getConnectionPointStyle = (type: ConnectionPointType) => {
  if (type === 'input') {
    return {
      background: '#3b82f6', // blue-500
      border: '2px solid white',
    };
  }
  return {
    background: '#22c55e', // green-500
    border: '2px solid white',
  };
};

// Context menu state
interface ContextMenuState {
  isOpen: boolean;
  position: { x: number; y: number };
  pointId: ConnectionPointPosition;
}

export const EquipmentNode = memo(({ id, data, selected }: NodeProps<EquipmentNodeData>) => {
  const Icon = getEquipmentIcon(data.equipmentType);
  const statusStyle = getStatusStyle(data.status);
  const size = getEquipmentSize(data.equipmentType);
  const updateConnectionPointType = useProcessStore((state) => state.updateConnectionPointType);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    position: { x: 0, y: 0 },
    pointId: 'top',
  });

  // Handle right-click on connection point
  const handleConnectionPointContextMenu = useCallback(
    (event: React.MouseEvent, pointId: ConnectionPointPosition) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        isOpen: true,
        position: { x: event.clientX, y: event.clientY },
        pointId,
      });
    },
    []
  );

  // Handle connection point type change
  const handleConnectionPointTypeChange = useCallback(
    (pointId: ConnectionPointPosition, newType: ConnectionPointType) => {
      updateConnectionPointType(id, pointId, newType);
    },
    [id, updateConnectionPointType]
  );

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // Get connection point type
  const getPointType = (pointId: ConnectionPointPosition): ConnectionPointType => {
    return data.connectionPoints?.[pointId] || (pointId === 'top' || pointId === 'left' ? 'input' : 'output');
  };

  // Calculate icon size based on node size (roughly 40% of smaller dimension)
  const iconSize = Math.min(size.width, size.height) * 0.35;

  return (
    <>
      <div
        className={`
          equipment-node relative
          rounded-lg border-2 shadow-md
          transition-all duration-200
          ${statusStyle.bg} ${statusStyle.border}
          ${selected ? 'ring-2 ring-blue-500 ring-offset-2 shadow-lg scale-105' : 'hover:shadow-lg'}
        `}
        style={{
          width: size.width,
          height: size.height,
        }}
      >
        {/* Connection Point - Top */}
        <div
          className="absolute left-1/2 -translate-x-1/2 cursor-pointer z-10"
          style={{ top: -8 }}
          onContextMenu={(e) => handleConnectionPointContextMenu(e, 'top')}
        >
          <Handle
            type={getPointType('top') === 'input' ? 'target' : 'source'}
            position={Position.Top}
            id="top"
            className="!w-4 !h-4 !rounded-full !cursor-pointer"
            style={getConnectionPointStyle(getPointType('top'))}
          />
        </div>

        {/* Connection Point - Right */}
        <div
          className="absolute top-1/2 -translate-y-1/2 cursor-pointer z-10"
          style={{ right: -8 }}
          onContextMenu={(e) => handleConnectionPointContextMenu(e, 'right')}
        >
          <Handle
            type={getPointType('right') === 'input' ? 'target' : 'source'}
            position={Position.Right}
            id="right"
            className="!w-4 !h-4 !rounded-full !cursor-pointer"
            style={getConnectionPointStyle(getPointType('right'))}
          />
        </div>

        {/* Connection Point - Bottom */}
        <div
          className="absolute left-1/2 -translate-x-1/2 cursor-pointer z-10"
          style={{ bottom: -8 }}
          onContextMenu={(e) => handleConnectionPointContextMenu(e, 'bottom')}
        >
          <Handle
            type={getPointType('bottom') === 'input' ? 'target' : 'source'}
            position={Position.Bottom}
            id="bottom"
            className="!w-4 !h-4 !rounded-full !cursor-pointer"
            style={getConnectionPointStyle(getPointType('bottom'))}
          />
        </div>

        {/* Connection Point - Left */}
        <div
          className="absolute top-1/2 -translate-y-1/2 cursor-pointer z-10"
          style={{ left: -8 }}
          onContextMenu={(e) => handleConnectionPointContextMenu(e, 'left')}
        >
          <Handle
            type={getPointType('left') === 'input' ? 'target' : 'source'}
            position={Position.Left}
            id="left"
            className="!w-4 !h-4 !rounded-full !cursor-pointer"
            style={getConnectionPointStyle(getPointType('left'))}
          />
        </div>

        {/* Node Content */}
        <div className="p-3 h-full flex flex-col">
          {/* Icon */}
          <div className="flex-1 flex items-center justify-center">
            <div className={`${statusStyle.text}`}>
              <Icon size={iconSize} />
            </div>
          </div>

          {/* Equipment Info */}
          <div className="mt-2">
            <div className="font-medium text-sm text-gray-900 truncate text-center" title={data.equipmentName}>
              {data.equipmentName}
            </div>
            <div className="text-xs text-gray-500 truncate text-center" title={data.equipmentCode}>
              {data.equipmentCode}
            </div>
          </div>

          {/* Status Badge */}
          <div className="flex items-center justify-center mt-2">
            <span
              className={`
                inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium
                ${statusStyle.bg} ${statusStyle.text}
              `}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                  data.status === 'operational' || data.status === 'active'
                    ? 'bg-green-500 animate-pulse'
                    : statusStyle.text.replace('text-', 'bg-')
                }`}
              />
              {data.status.charAt(0).toUpperCase() + data.status.slice(1).replace('_', ' ')}
            </span>
          </div>
        </div>
      </div>

      {/* Context Menu */}
      <ConnectionPointContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        connectionPointId={contextMenu.pointId}
        currentType={getPointType(contextMenu.pointId)}
        onChangeType={handleConnectionPointTypeChange}
        onClose={closeContextMenu}
      />
    </>
  );
});

EquipmentNode.displayName = 'EquipmentNode';

export default EquipmentNode;
