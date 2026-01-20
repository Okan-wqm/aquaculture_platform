/**
 * BaseNode Component
 * A base component for creating rotatable nodes with dynamic handle positions
 */

import React, { useEffect } from 'react';
import { Handle, Position, useReactFlow, useUpdateNodeInternals } from 'reactflow';
import { rotatePoint } from '../../utils/rotatePoint';

/**
 * Determine the closest cardinal Position based on handle's rotated position
 * relative to the node center. This helps React Flow calculate correct edge endpoints.
 */
function getCardinalPosition(
  centerX: number,
  centerY: number,
  handleX: number,
  handleY: number
): Position {
  const angle = Math.atan2(handleY - centerY, handleX - centerX) * (180 / Math.PI);

  if (angle >= -45 && angle < 45) {
    return Position.Right;
  } else if (angle >= 45 && angle < 135) {
    return Position.Bottom;
  } else if (angle >= -135 && angle < -45) {
    return Position.Top;
  } else {
    return Position.Left;
  }
}

export type HandleType = 'source' | 'target';

export interface HandleConfig {
  id: string;
  type: HandleType;
  position: { x: number; y: number };
}

export interface BaseNodeProps {
  id: string;
  selected: boolean;
  rotation?: number;
  handles: HandleConfig[];
  render: () => React.ReactNode;
  width?: number;
  height?: number;
}

const BaseNode: React.FC<BaseNodeProps> = ({
  id,
  selected,
  rotation = 0,
  handles,
  render,
  width = 160,
  height = 100,
}) => {
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  // Toggle handle type on right-click
  const updateHandleType = (handleId: string) => {
    const currentHandle = handles.find((h) => h.id === handleId);
    if (!currentHandle) return;

    const newType: HandleType = currentHandle.type === 'source' ? 'target' : 'source';
    const updatedHandles = handles.map((h) =>
      h.id === handleId ? { ...h, type: newType } : h
    );

    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, handles: updatedHandles } }
          : node
      )
    );
    updateNodeInternals(id);
  };

  // Update node internals when handles or rotation changes
  useEffect(() => {
    updateNodeInternals(id);
  }, [handles.map((h) => `${h.id}:${h.type}`).join(','), rotation, id, updateNodeInternals]);

  const centerX = width / 2;
  const centerY = height / 2;

  return (
    <div
      style={{
        width,
        height,
        position: 'relative',
        pointerEvents: 'none',
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
        transition: 'border-color 0.2s',
      }}
    >
      {/* Rotated SVG Content */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ pointerEvents: 'auto' }}
      >
        <g transform={`rotate(${rotation}, ${centerX}, ${centerY})`}>
          {render()}
        </g>
      </svg>

      {/* Dynamic Handles */}
      {handles.map((handle) => {
        const rotated = rotatePoint(centerX, centerY, handle.position.x, handle.position.y, rotation);
        const handleColor = handle.type === 'source' ? '#22c55e' : '#3b82f6';

        return (
          <div
            key={handle.id}
            style={{
              position: 'absolute',
              left: rotated.x,
              top: rotated.y,
              width: 12,
              height: 12,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'all',
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              updateHandleType(handle.id);
            }}
          >
            <Handle
              id={handle.id}
              type={handle.type}
              position={getCardinalPosition(centerX, centerY, rotated.x, rotated.y)}
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                background: handleColor,
                borderRadius: '50%',
                border: '2px solid white',
                cursor: 'pointer',
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

export default BaseNode;
