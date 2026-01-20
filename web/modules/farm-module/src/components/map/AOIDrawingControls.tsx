/**
 * AOIDrawingControls Component
 *
 * Toolbar for drawing and managing Areas of Interest (AOI) on the map.
 * This is the UI-only component that renders OUTSIDE MapContainer.
 * GeomanController handles the actual map integration INSIDE MapContainer.
 *
 * Features:
 * - Drawing mode buttons (polygon, circle, rectangle)
 * - AOI list with selection and deletion
 * - Rename AOIs inline
 * - Visual feedback during drawing
 */

import React, { useState } from 'react';
import type { AOI, DrawingMode } from '../../hooks/useAOIDrawing';

interface AOIDrawingControlsProps {
  aois: AOI[];
  activeAOI: AOI | null;
  drawingMode: DrawingMode;
  isDrawing: boolean;
  onDrawingModeChange: (mode: DrawingMode) => void;
  onSelectAOI: (id: string | null) => void;
  onDeleteAOI: (id: string) => void;
  onRenameAOI: (id: string, name: string) => void;
  onClearAll: () => void;
  isConfigured: boolean;
}

export const AOIDrawingControls: React.FC<AOIDrawingControlsProps> = ({
  aois,
  activeAOI,
  drawingMode,
  isDrawing,
  onDrawingModeChange,
  onSelectAOI,
  onDeleteAOI,
  onRenameAOI,
  onClearAll,
  isConfigured,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // Handle rename submit
  const handleRenameSubmit = (id: string) => {
    if (editName.trim()) {
      onRenameAOI(id, editName.trim());
    }
    setEditingId(null);
    setEditName('');
  };

  // Start editing name
  const startEditing = (aoi: AOI) => {
    setEditingId(aoi.id);
    setEditName(aoi.name);
  };

  if (!isConfigured) {
    return null;
  }

  return (
    <div className="absolute top-4 left-4 z-[1000]">
      {/* Main Toggle Button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg transition-colors ${
          isExpanded || isDrawing
            ? 'bg-primary-600 text-white'
            : 'bg-white text-gray-700 hover:bg-gray-50'
        }`}
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"
          />
        </svg>
        <span className="text-sm font-medium">
          AOI {aois.length > 0 && `(${aois.length})`}
        </span>
        {isDrawing && (
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
        )}
      </button>

      {/* Expanded Panel */}
      {isExpanded && (
        <div className="mt-2 bg-white rounded-lg shadow-lg overflow-hidden w-72">
          {/* Drawing Tools */}
          <div className="p-3 border-b">
            <div className="text-xs font-medium text-gray-500 mb-2">Cizim Araclari</div>
            <div className="flex gap-2">
              {/* Polygon */}
              <button
                onClick={() =>
                  onDrawingModeChange(drawingMode === 'polygon' ? 'none' : 'polygon')
                }
                className={`flex-1 flex flex-col items-center gap-1 p-2 rounded-lg transition-colors ${
                  drawingMode === 'polygon'
                    ? 'bg-primary-100 text-primary-700 ring-2 ring-primary-500'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                title="Poligon ciz"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
                  />
                </svg>
                <span className="text-xs">Poligon</span>
              </button>

              {/* Circle */}
              <button
                onClick={() =>
                  onDrawingModeChange(drawingMode === 'circle' ? 'none' : 'circle')
                }
                className={`flex-1 flex flex-col items-center gap-1 p-2 rounded-lg transition-colors ${
                  drawingMode === 'circle'
                    ? 'bg-primary-100 text-primary-700 ring-2 ring-primary-500'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                title="Daire ciz"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <circle cx="12" cy="12" r="9" strokeWidth={2} />
                </svg>
                <span className="text-xs">Daire</span>
              </button>

              {/* Rectangle */}
              <button
                onClick={() =>
                  onDrawingModeChange(drawingMode === 'rectangle' ? 'none' : 'rectangle')
                }
                className={`flex-1 flex flex-col items-center gap-1 p-2 rounded-lg transition-colors ${
                  drawingMode === 'rectangle'
                    ? 'bg-primary-100 text-primary-700 ring-2 ring-primary-500'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                title="Dikdortgen ciz"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <rect x="3" y="5" width="18" height="14" rx="2" strokeWidth={2} />
                </svg>
                <span className="text-xs">Dikdortgen</span>
              </button>
            </div>

            {/* Drawing hint */}
            {isDrawing && (
              <div className="mt-2 p-2 bg-blue-50 rounded-md">
                <p className="text-xs text-blue-700">
                  {drawingMode === 'polygon' && 'Haritaya tiklayarak poligon cizin. Cift tikla tamamlayin.'}
                  {drawingMode === 'circle' && 'Merkez noktasina tiklayin ve surukleyerek daire cizin.'}
                  {drawingMode === 'rectangle' && 'Bir koseden baslayarak dikdortgen cizin.'}
                </p>
              </div>
            )}
          </div>

          {/* AOI List */}
          <div className="max-h-64 overflow-y-auto">
            {aois.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-500">
                Henuz AOI eklenmemis.
                <br />
                <span className="text-xs">Yukaridaki araclarla cizim yapabilirsiniz.</span>
              </div>
            ) : (
              <div className="divide-y">
                {aois.map((aoi) => (
                  <div
                    key={aoi.id}
                    className={`p-3 cursor-pointer transition-colors ${
                      activeAOI?.id === aoi.id
                        ? 'bg-primary-50'
                        : 'hover:bg-gray-50'
                    }`}
                    onClick={() => onSelectAOI(aoi.id)}
                  >
                    <div className="flex items-start gap-2">
                      {/* Color indicator */}
                      <div
                        className="w-3 h-3 rounded-full mt-1 flex-shrink-0"
                        style={{ backgroundColor: aoi.color }}
                      />

                      <div className="flex-1 min-w-0">
                        {/* Name (editable) */}
                        {editingId === aoi.id ? (
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={() => handleRenameSubmit(aoi.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRenameSubmit(aoi.id);
                              if (e.key === 'Escape') {
                                setEditingId(null);
                                setEditName('');
                              }
                            }}
                            className="w-full text-sm font-medium bg-white border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary-500"
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <div
                            className="text-sm font-medium text-gray-900 truncate"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              startEditing(aoi);
                            }}
                            title="Cift tikla yeniden adlandir"
                          >
                            {aoi.name}
                          </div>
                        )}

                        {/* Area info */}
                        <div className="text-xs text-gray-500">
                          {aoi.area < 1
                            ? `${(aoi.area * 1000).toFixed(0)} m²`
                            : `${aoi.area.toFixed(2)} km²`}
                          {aoi.type === 'circle' && aoi.radius && (
                            <span className="ml-2">
                              (r: {aoi.radius >= 1000
                                ? `${(aoi.radius / 1000).toFixed(1)} km`
                                : `${aoi.radius.toFixed(0)} m`})
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Delete button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteAOI(aoi.id);
                        }}
                        className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                        title="Sil"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer Actions */}
          {aois.length > 0 && (
            <div className="p-2 border-t bg-gray-50">
              <button
                onClick={onClearAll}
                className="w-full text-xs text-red-600 hover:text-red-700 py-1"
              >
                Tum AOI'leri Temizle
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AOIDrawingControls;
