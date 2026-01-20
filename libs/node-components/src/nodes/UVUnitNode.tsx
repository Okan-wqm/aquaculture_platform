/**
 * UVUnitNode Component
 * UV Disinfection unit using BaseNode architecture for rotation support
 */

import React from 'react';
import type { NodeProps } from 'reactflow';
import BaseNode from './BaseNode';
import { NodeRegistry } from '../registry/NodeRegistry';

interface UVUnitNodeData {
  rotation?: number;
  handles?: Array<{
    id: string;
    type: 'source' | 'target';
    position: { x: number; y: number };
  }>;
  label?: string;
  isScadaMode?: boolean;
}

const WIDTH = 160;
const HEIGHT = 100;

const UVUnitNode: React.FC<NodeProps<UVUnitNodeData>> = ({ id, selected, data }) => {
  const rotation = data?.rotation || 0;
  const isScadaMode = data?.isScadaMode || false;
  const handles = data?.handles || [
    { id: 'uv-left', type: 'target' as const, position: { x: 40, y: 50 } },
    { id: 'uv-right', type: 'source' as const, position: { x: 120, y: 50 } },
  ];

  return (
    <BaseNode
      id={id}
      selected={selected}
      rotation={rotation}
      handles={handles}
      width={WIDTH}
      height={HEIGHT}
      isScadaMode={isScadaMode}
      render={() => (
        <>
          <rect x="40" y="30" width="80" height="40" rx="10" fill="#cfd8dc" stroke="#333" strokeWidth="2" />
          <rect x="50" y="40" width="60" height="20" fill="#aeefff" stroke="#00bcd4" strokeWidth="1.5" rx="4" />
          <rect x="55" y="45" width="50" height="10" fill="#7df9ff" opacity="0.6" rx="2" />
          <text x="80" y="25" fontSize="12" textAnchor="middle" fill="#000">
            {data?.label || 'UV Unit'}
          </text>
          <text x="80" y="90" fontSize="10" textAnchor="middle" fill="#666">
            UV Dezenfeksiyon
          </text>
        </>
      )}
    />
  );
};

// Auto-register
NodeRegistry.register({
  id: 'uvUnit',
  label: 'UV Unit',
  labelTr: 'UV Ünitesi',
  category: 'disinfection',
  description: 'Ultraviolet disinfection chamber',
  component: UVUnitNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['uv_unit', 'uv', 'ultraviolet'],
});

export default UVUnitNode;
