/**
 * UVUnitNode Component
 * UV Disinfection unit using BaseNode for rotation support
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import BaseNode, { HandleConfig } from './BaseNode';

interface UVUnitNodeData {
  rotation?: number;
  handles?: HandleConfig[];
  label?: string;
}

const DEFAULT_HANDLES: HandleConfig[] = [
  { id: 'uv-left', type: 'target', position: { x: 40, y: 50 } },
  { id: 'uv-right', type: 'source', position: { x: 120, y: 50 } },
];

const UVUnitNode: React.FC<NodeProps<UVUnitNodeData>> = ({ id, selected, data }) => {
  const rotation = data?.rotation || 0;
  const handles = data?.handles || DEFAULT_HANDLES;

  return (
    <BaseNode
      id={id}
      selected={selected}
      rotation={rotation}
      handles={handles}
      render={() => (
        <>
          {/* UV Housing */}
          <rect x="40" y="30" width="80" height="40" rx="10" fill="#cfd8dc" stroke="#333" strokeWidth="2" />
          {/* UV Lamp */}
          <rect x="50" y="40" width="60" height="20" fill="#aeefff" stroke="#00bcd4" strokeWidth="1.5" rx="4" />
          {/* Glow effect */}
          <rect x="52" y="42" width="56" height="16" fill="#e0ffff" opacity="0.5" rx="3" />
          {/* Label */}
          <text x="80" y="25" fontSize="12" textAnchor="middle" fill="#000">
            {data?.label || 'UV Unit'}
          </text>
          <text x="80" y="90" fontSize="10" textAnchor="middle" fill="#666">
            Ultraviyole Dezenfeksiyon
          </text>
        </>
      )}
    />
  );
};

export default UVUnitNode;
