import React from 'react';
import BaseNode from './BaseNode';
import type { NodeProps } from 'reactflow';

const UVUnit: React.FC<NodeProps> = ({ id, selected, data }) => {
  const rotation = data?.rotation || 0;
  const handles = data?.handles || [
    { id: 'uv-left', type: 'target', position: { x: 40, y: 50 } },
    { id: 'uv-right', type: 'source', position: { x: 120, y: 50 } },
  ];

  return (
    <BaseNode
      id={id}
      selected={selected}
      rotation={rotation}
      handles={handles}
      render={() => (
        <>
          <rect x="40" y="30" width="80" height="40" rx="10" fill="#cfd8dc" stroke="#333" strokeWidth="2" />
          <rect x="50" y="40" width="60" height="20" fill="#aeefff" stroke="#00bcd4" strokeWidth="1.5" rx="4" />
          <text x="80" y="25" fontSize="12" textAnchor="middle" fill="#000">UV Unit</text>
          <text x="80" y="90" fontSize="10" textAnchor="middle" fill="#666">Ultraviyole Dezenfeksiyon</text>
        </>
      )}
    />
  );
};

export default UVUnit;
