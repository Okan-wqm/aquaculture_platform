/**
 * ScreenCanvas - Center canvas area for SCADA Package Builder
 * Uses CSS grid with drag-and-drop (no react-grid-layout dependency)
 * 12-column grid with free placement via absolute positioning
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { X, Move } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useScadaPackageStore, ScreenWidget } from '../../store/scadaPackageStore';
import { WIDGET_DEFAULTS, ScadaWidgetType } from './WidgetPalette';

const GRID_COLS = 12;
const GRID_ROWS = 8;

// Widget type icons for mini preview
const WIDGET_ICONS: Record<string, string> = {
  gauge: '🎯',
  numericDisplay: '🔢',
  statusIndicator: '🟢',
  tankLevel: '🛢️',
  toggleSwitch: '🔘',
  slider: '🎚️',
  numericInput: '⌨️',
  pushButton: '⏺️',
  emergencyStop: '🛑',
  trendChart: '📈',
  alarmBanner: '🔔',
  alarmList: '📋',
  calibrationWizard: '🔧',
  calibrationHistory: '📜',
  calibrationStatus: '✅',
  processView: '🏭',
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export const ScreenCanvas: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [dragOverCell, setDragOverCell] = useState<{ col: number; row: number } | null>(null);

  // Local drag/resize state to avoid store updates on every mousemove
  const [dragState, setDragState] = useState<{
    widgetId: string;
    col: number;
    row: number;
    w: number;
    h: number;
  } | null>(null);

  // Resize tracking state for widget resize
  const resizingRef = useRef<{
    widgetId: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const {
    activeScreenId,
    screens,
    selectedWidgetId,
    setSelectedWidget,
    addWidget,
    removeWidget,
    updateWidgetPosition,
  } = useScadaPackageStore(useShallow((s) => ({
    activeScreenId: s.activeScreenId,
    screens: s.screens,
    selectedWidgetId: s.selectedWidgetId,
    setSelectedWidget: s.setSelectedWidget,
    addWidget: s.addWidget,
    removeWidget: s.removeWidget,
    updateWidgetPosition: s.updateWidgetPosition,
  })));

  const activeScreen = screens.find((s) => s.id === activeScreenId);
  const widgets = activeScreen?.widgets ?? [];

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cellW = containerSize.width / GRID_COLS;
  const cellH = containerSize.height / GRID_ROWS;

  // Drop handler for new widgets from palette
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverCell(null);

      const data = e.dataTransfer.getData('application/scada-widget');
      if (!data || !activeScreenId) return;

      const widgetData = JSON.parse(data) as {
        type: ScadaWidgetType;
        label: string;
        defaultW: number;
        defaultH: number;
      };

      // Calculate grid position from drop coordinates
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const col = Math.max(0, Math.min(GRID_COLS - widgetData.defaultW, Math.floor((e.clientX - rect.left) / cellW)));
      const row = Math.max(0, Math.min(GRID_ROWS - widgetData.defaultH, Math.floor((e.clientY - rect.top) / cellH)));

      const newWidget: ScreenWidget = {
        id: generateId(),
        widgetType: widgetData.type,
        position: {
          col,
          row,
          w: widgetData.defaultW,
          h: widgetData.defaultH,
        },
        config: {},
      };

      addWidget(activeScreenId, newWidget);
    },
    [activeScreenId, cellW, cellH, addWidget]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const col = Math.floor((e.clientX - rect.left) / cellW);
      const row = Math.floor((e.clientY - rect.top) / cellH);
      setDragOverCell({ col: Math.max(0, Math.min(GRID_COLS - 1, col)), row: Math.max(0, Math.min(GRID_ROWS - 1, row)) });
    },
    [cellW, cellH]
  );

  const handleDragLeave = useCallback(() => {
    setDragOverCell(null);
  }, []);

  // Widget resize via mouse - uses local state during drag, commits on mouseUp
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, widgetId: string, currentW: number, currentH: number) => {
      e.stopPropagation();
      e.preventDefault();
      resizingRef.current = {
        widgetId,
        startX: e.clientX,
        startY: e.clientY,
        startW: currentW,
        startH: currentH,
      };

      const widget = widgets.find((w) => w.id === widgetId);
      if (!widget) return;

      setDragState({
        widgetId,
        col: widget.position.col,
        row: widget.position.row,
        w: currentW,
        h: currentH,
      });

      const onMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const dx = ev.clientX - resizingRef.current.startX;
        const dy = ev.clientY - resizingRef.current.startY;
        const newW = Math.max(1, Math.min(GRID_COLS, resizingRef.current.startW + Math.round(dx / cellW)));
        const newH = Math.max(1, Math.min(GRID_ROWS, resizingRef.current.startH + Math.round(dy / cellH)));
        setDragState({
          widgetId: resizingRef.current.widgetId,
          col: widget.position.col,
          row: widget.position.row,
          w: newW,
          h: newH,
        });
      };

      const onMouseUp = () => {
        if (resizingRef.current && activeScreenId) {
          // Read final local state and commit to store
          setDragState((prev) => {
            if (prev && prev.widgetId === resizingRef.current?.widgetId) {
              updateWidgetPosition(activeScreenId, prev.widgetId, {
                col: prev.col,
                row: prev.row,
                w: prev.w,
                h: prev.h,
              });
            }
            return null;
          });
        }
        resizingRef.current = null;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [activeScreenId, cellW, cellH, updateWidgetPosition, widgets]
  );

  // Widget drag (move) via mouse - uses local state during drag, commits on mouseUp
  const handleMoveStart = useCallback(
    (e: React.MouseEvent, widgetId: string, currentCol: number, currentRow: number, currentW: number, currentH: number) => {
      e.stopPropagation();
      e.preventDefault();
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;

      setDragState({
        widgetId,
        col: currentCol,
        row: currentRow,
        w: currentW,
        h: currentH,
      });

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startMouseX;
        const dy = ev.clientY - startMouseY;
        const newCol = Math.max(0, Math.min(GRID_COLS - 1, currentCol + Math.round(dx / cellW)));
        const newRow = Math.max(0, Math.min(GRID_ROWS - 1, currentRow + Math.round(dy / cellH)));
        setDragState({
          widgetId,
          col: newCol,
          row: newRow,
          w: currentW,
          h: currentH,
        });
      };

      const onMouseUp = () => {
        if (activeScreenId) {
          setDragState((prev) => {
            if (prev && prev.widgetId === widgetId) {
              updateWidgetPosition(activeScreenId, widgetId, {
                col: prev.col,
                row: prev.row,
                w: prev.w,
                h: prev.h,
              });
            }
            return null;
          });
        }
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [activeScreenId, cellW, cellH, updateWidgetPosition]
  );

  return (
    <div className="flex-1 bg-gray-100 p-2 overflow-hidden flex flex-col">
      {/* Screen tabs */}
      {!activeScreen && (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          Ekran secin veya yeni ekran ekleyin
        </div>
      )}

      {activeScreen && (
        <div
          ref={containerRef}
          className="flex-1 relative bg-white rounded-lg border border-gray-300 overflow-hidden"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => setSelectedWidget(null)}
        >
          {/* Grid lines */}
          {cellW > 0 && cellH > 0 && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 0 }}>
              {Array.from({ length: GRID_COLS + 1 }, (_, i) => (
                <line
                  key={`v${i}`}
                  x1={i * cellW}
                  y1={0}
                  x2={i * cellW}
                  y2={containerSize.height}
                  stroke="#e5e7eb"
                  strokeWidth={1}
                  strokeDasharray={i === 0 || i === GRID_COLS ? undefined : '2,4'}
                />
              ))}
              {Array.from({ length: GRID_ROWS + 1 }, (_, i) => (
                <line
                  key={`h${i}`}
                  x1={0}
                  y1={i * cellH}
                  x2={containerSize.width}
                  y2={i * cellH}
                  stroke="#e5e7eb"
                  strokeWidth={1}
                  strokeDasharray={i === 0 || i === GRID_ROWS ? undefined : '2,4'}
                />
              ))}
            </svg>
          )}

          {/* Drop indicator */}
          {dragOverCell && cellW > 0 && (
            <div
              className="absolute bg-cyan-100 border-2 border-dashed border-cyan-400 rounded pointer-events-none"
              style={{
                left: dragOverCell.col * cellW,
                top: dragOverCell.row * cellH,
                width: cellW * 3,
                height: cellH * 3,
                zIndex: 5,
              }}
            />
          )}

          {/* Widgets */}
          {widgets.map((widget) => {
            const isSelected = selectedWidgetId === widget.id;
            const isDragging = dragState?.widgetId === widget.id;
            const pos = isDragging ? dragState : widget.position;
            return (
              <div
                key={widget.id}
                className={`absolute rounded border ${
                  isDragging ? '' : 'transition-shadow'
                } ${
                  isSelected
                    ? 'border-cyan-500 ring-2 ring-cyan-300 shadow-lg z-20'
                    : 'border-gray-300 shadow-sm hover:shadow-md z-10'
                } bg-white flex flex-col overflow-hidden`}
                style={{
                  left: pos.col * cellW,
                  top: pos.row * cellH,
                  width: pos.w * cellW - 2,
                  height: pos.h * cellH - 2,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedWidget(widget.id);
                }}
              >
                {/* Title bar */}
                <div className="flex items-center justify-between px-2 py-1 bg-gray-50 border-b border-gray-200 flex-shrink-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      className="cursor-move text-gray-400 hover:text-gray-600"
                      onMouseDown={(e) =>
                        handleMoveStart(e, widget.id, widget.position.col, widget.position.row, widget.position.w, widget.position.h)
                      }
                    >
                      <Move className="w-3 h-3" />
                    </button>
                    <span className="text-xs font-medium text-gray-600 truncate">
                      {widget.config?.label || widget.widgetType}
                    </span>
                  </div>
                  <button
                    className="text-gray-400 hover:text-red-500 flex-shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeScreenId) removeWidget(activeScreenId, widget.id);
                    }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>

                {/* Mini preview */}
                <div className="flex-1 flex flex-col items-center justify-center p-1 text-center">
                  <span className="text-2xl">{WIDGET_ICONS[widget.widgetType] || '📦'}</span>
                  {widget.config?.tagName && (
                    <span className="text-[10px] text-gray-500 mt-0.5 truncate max-w-full">
                      {widget.config.tagName}
                    </span>
                  )}
                </div>

                {/* Resize handle */}
                <div
                  className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize"
                  onMouseDown={(e) => handleResizeStart(e, widget.id, widget.position.w, widget.position.h)}
                >
                  <svg className="w-3 h-3 text-gray-400" viewBox="0 0 12 12">
                    <path d="M10 2L2 10M10 6L6 10M10 10L10 10" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </div>
              </div>
            );
          })}

          {/* Empty state */}
          {widgets.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center text-gray-400">
                <p className="text-sm">Widget palette'den surukleyerek buraya birakin</p>
                <p className="text-xs mt-1">12 sutunlu grid, serbest yerlestirme</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
