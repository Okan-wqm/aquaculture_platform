import React, { useEffect } from 'react';
import { Handle, useReactFlow, useUpdateNodeInternals } from 'reactflow';
import { rotatePoint } from '../../utils/rotatePoint';

type HandleConfig = {
  id: string;
  type: 'source' | 'target';
  position: { x: number; y: number };
};

interface BaseNodeProps {
  id: string;
  selected: boolean;
  rotation?: number;
  handles: HandleConfig[];
  render: () => React.ReactNode;
}

const BaseNode: React.FC<BaseNodeProps> = ({ id, selected, rotation = 0, handles, render }) => {
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  const updateHandleType = (handleId: string) => {
    setNodes((prevNodes) =>
      prevNodes.map((node) => {
        if (node.id !== id) return node;
        const updatedHandles = node.data?.handles?.map((h: HandleConfig) =>
          h.id === handleId ? { ...h, type: h.type === 'source' ? 'target' : 'source' } : h
        );
        return {
          ...node,
          data: {
            ...node.data,
            handles: updatedHandles,
          },
        };
      })
    );
    updateNodeInternals(id);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [handles.map(h => `${h.id}:${h.type}`).join(','), id, updateNodeInternals]);

  return (
    <div
      style={{
        width: 160,
        height: 100,
        position: 'relative',
        pointerEvents: 'none',
        border: selected ? '2px solid red' : 'none',
      }}
    >
      <svg width="160" height="100" viewBox="0 0 160 100" style={{ pointerEvents: 'auto' }}>
        <g transform={`rotate(${rotation}, 80, 50)`}>
          {render()}
        </g>
      </svg>

      {handles.map((handle) => {
        const rotated = rotatePoint(80, 50, handle.position.x, handle.position.y, rotation);
        return (
          <div
            key={handle.id}
            style={{
              position: 'absolute',
              left: rotated.x,
              top: rotated.y,
              width: 10,
              height: 10,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'all',
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              updateHandleType(handle.id);
            }}
          >
            <Handle
              id={handle.id}
              type={handle.type}
              style={{
                width: '100%',
                height: '100%',
                background: handle.type === 'source' ? 'red' : 'blue',
                borderRadius: '50%',
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

export default BaseNode;
