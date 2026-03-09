/**
 * EdgeToolbar - Floating toolbar for edge/connection type selection
 * Appears on the SCADA canvas for controlling edge creation and editing.
 */

import React, { useState, useCallback } from 'react';
import { CONNECTION_TYPES, type ConnectionType } from '../../config/connectionTypes';
import type { ScadaEdgeType } from '../../types/scada-edge.types';

interface EdgeToolbarProps {
  selectedEdgeType: ScadaEdgeType;
  selectedConnectionType: ConnectionType;
  onEdgeTypeChange: (type: ScadaEdgeType) => void;
  onConnectionTypeChange: (type: ConnectionType) => void;
  hasSelectedEdge: boolean;
}

const EDGE_TYPE_OPTIONS: { type: ScadaEdgeType; label: string; icon: JSX.Element }[] = [
  {
    type: 'orthogonal',
    label: 'Orthogonal',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 14 L2 6 L16 6 L16 2" />
      </svg>
    ),
  },
  {
    type: 'multiHandle',
    label: 'Polyline',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 16 L8 6 L12 12 L16 2" />
      </svg>
    ),
  },
  {
    type: 'draggable',
    label: 'Bezier',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 14 Q2 2 16 4" />
      </svg>
    ),
  },
];

export const EdgeToolbar: React.FC<EdgeToolbarProps> = ({
  selectedEdgeType,
  selectedConnectionType,
  onEdgeTypeChange,
  onConnectionTypeChange,
  hasSelectedEdge,
}) => {
  const [showConnectionTypes, setShowConnectionTypes] = useState(false);

  const activeConnection = CONNECTION_TYPES.find((c) => c.id === selectedConnectionType) || CONNECTION_TYPES[0];

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-lg shadow-lg px-2 py-1.5">
      {/* Edge Type Selector */}
      <div className="flex items-center gap-0.5 border-r border-gray-200 pr-2">
        {EDGE_TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.type}
            onClick={() => onEdgeTypeChange(opt.type)}
            className={`p-1.5 rounded transition-colors ${
              selectedEdgeType === opt.type
                ? 'bg-cyan-100 text-cyan-700'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
            }`}
            title={opt.label}
          >
            {opt.icon}
          </button>
        ))}
      </div>

      {/* Connection Type Selector */}
      <div className="relative">
        <button
          onClick={() => setShowConnectionTypes(!showConnectionTypes)}
          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 transition-colors text-xs font-medium text-gray-700"
          title="Baglanti Tipi"
        >
          <span
            className="inline-block w-5 h-0.5 rounded"
            style={{
              backgroundColor: activeConnection.color,
              height: activeConnection.strokeWidth,
              backgroundImage: activeConnection.strokeDasharray
                ? undefined
                : undefined,
            }}
          />
          <span className="max-w-[80px] truncate">{activeConnection.label}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 3.5 L5 6.5 L8 3.5" />
          </svg>
        </button>

        {showConnectionTypes && (
          <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-xl py-1 z-50">
            {CONNECTION_TYPES.map((ct) => (
              <button
                key={ct.id}
                onClick={() => {
                  onConnectionTypeChange(ct.id);
                  setShowConnectionTypes(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-xs transition-colors ${
                  selectedConnectionType === ct.id
                    ? 'bg-cyan-50 text-cyan-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {/* Line preview */}
                <svg width="32" height="12" viewBox="0 0 32 12">
                  <line
                    x1="0"
                    y1="6"
                    x2="32"
                    y2="6"
                    stroke={ct.color}
                    strokeWidth={ct.strokeWidth}
                    strokeDasharray={ct.strokeDasharray || undefined}
                  />
                </svg>
                <span className="flex-1 text-left">{ct.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Context hint */}
      {hasSelectedEdge && (
        <span className="text-[10px] text-cyan-600 font-medium pl-1 border-l border-gray-200 ml-0.5">
          Secili edge
        </span>
      )}
    </div>
  );
};
