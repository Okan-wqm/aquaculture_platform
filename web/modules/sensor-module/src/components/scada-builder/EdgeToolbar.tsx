/**
 * EdgeToolbar - Floating toolbar for edge/connection type selection
 * Appears on the SCADA canvas for controlling edge creation and editing.
 */

import React, { useState } from 'react';
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
    label: '90°',
    icon: (
      <svg width="28" height="16" viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 14 L2 4 L26 4 L26 2" />
      </svg>
    ),
  },
  {
    type: 'multiHandle',
    label: 'Poly',
    icon: (
      <svg width="28" height="16" viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 14 L10 4 L18 12 L26 2" />
      </svg>
    ),
  },
  {
    type: 'draggable',
    label: 'Curve',
    icon: (
      <svg width="28" height="16" viewBox="0 0 28 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 14 Q2 0 26 4" />
      </svg>
    ),
  },
];

// Connection type categories for the dropdown
const PROCESS_LINE_IDS: ConnectionType[] = ['process-pipe', 'steam', 'hydraulic', 'drain-vent', 'capillary'];
const SIGNAL_LINE_IDS: ConnectionType[] = ['electrical', 'pneumatic', 'instrument', 'data-link'];

export const EdgeToolbar: React.FC<EdgeToolbarProps> = ({
  selectedEdgeType,
  selectedConnectionType,
  onEdgeTypeChange,
  onConnectionTypeChange,
  hasSelectedEdge,
}) => {
  const [showConnectionTypes, setShowConnectionTypes] = useState(false);

  const activeConnection = CONNECTION_TYPES.find((c) => c.id === selectedConnectionType) || CONNECTION_TYPES[0];

  const processLines = CONNECTION_TYPES.filter(ct => PROCESS_LINE_IDS.includes(ct.id));
  const signalLines = CONNECTION_TYPES.filter(ct => SIGNAL_LINE_IDS.includes(ct.id));

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-lg shadow-lg px-2 py-1.5">
      {/* Edge Type Selector */}
      <div className="flex flex-col gap-0.5 border-r border-gray-200 pr-2">
        <span className="text-[9px] text-gray-400 font-medium leading-none px-0.5">Cizgi Sekli</span>
        <div className="flex items-center gap-0.5">
          {EDGE_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              onClick={() => onEdgeTypeChange(opt.type)}
              className={`flex items-center gap-1 px-2 py-1 rounded transition-colors text-[10px] font-medium ${
                selectedEdgeType === opt.type
                  ? 'bg-cyan-100 text-cyan-700'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
              }`}
              title={opt.label}
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Connection Type Selector */}
      <div className="relative">
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] text-gray-400 font-medium leading-none px-0.5">Baglanti Tipi</span>
          <button
            onClick={() => setShowConnectionTypes(!showConnectionTypes)}
            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 transition-colors text-xs font-medium text-gray-700"
            title="Baglanti Tipi"
          >
            <svg width="24" height="8" viewBox="0 0 24 8">
              <line
                x1="0" y1="4" x2="24" y2="4"
                stroke={activeConnection.color}
                strokeWidth={Math.min(activeConnection.strokeWidth, 2)}
                strokeDasharray={activeConnection.strokeDasharray || undefined}
              />
            </svg>
            <span className="max-w-[80px] truncate">{activeConnection.label}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 3.5 L5 6.5 L8 3.5" />
            </svg>
          </button>
        </div>

        {showConnectionTypes && (
          <>
            <div
              className="fixed inset-0 z-30"
              onClick={() => setShowConnectionTypes(false)}
            />
          <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-xl py-1 z-40">
            {/* Process Lines */}
            <div className="px-3 pt-1.5 pb-0.5">
              <span className="text-[9px] text-gray-400 font-semibold uppercase tracking-wider">Proses Hatlari</span>
            </div>
            {processLines.map((ct) => (
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
                <svg width="32" height="12" viewBox="0 0 32 12">
                  <line
                    x1="0" y1="6" x2="32" y2="6"
                    stroke={ct.color}
                    strokeWidth={ct.strokeWidth}
                    strokeDasharray={ct.strokeDasharray || undefined}
                  />
                </svg>
                <span className="flex-1 text-left">{ct.label}</span>
              </button>
            ))}

            {/* Signal Lines */}
            <div className="px-3 pt-2.5 pb-0.5 border-t border-gray-100 mt-1">
              <span className="text-[9px] text-gray-400 font-semibold uppercase tracking-wider">Sinyal Hatlari</span>
            </div>
            {signalLines.map((ct) => (
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
                <svg width="32" height="12" viewBox="0 0 32 12">
                  <line
                    x1="0" y1="6" x2="32" y2="6"
                    stroke={ct.color}
                    strokeWidth={ct.strokeWidth}
                    strokeDasharray={ct.strokeDasharray || undefined}
                  />
                </svg>
                <span className="flex-1 text-left">{ct.label}</span>
              </button>
            ))}
          </div>
          </>
        )}
      </div>

      {/* Context hint */}
      <div className="pl-1 border-l border-gray-200 ml-0.5">
        {hasSelectedEdge ? (
          <span className="text-[10px] text-cyan-700 font-medium bg-cyan-50 px-1.5 py-0.5 rounded">
            &#9998; Secili edge
          </span>
        ) : (
          <span className="text-[10px] text-gray-400 font-medium">
            (yeni baglanti)
          </span>
        )}
      </div>
    </div>
  );
};
