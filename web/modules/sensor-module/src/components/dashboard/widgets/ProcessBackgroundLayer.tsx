/**
 * Process Background Layer
 *
 * Draggable and zoomable process diagram layer for dashboard background.
 * Only interactive in edit mode.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ProcessDiagramRenderer, ProcessNode, ProcessEdge } from './ProcessDiagramRenderer';
import { useProcess } from '../../../hooks/useProcess';

// ============================================================================
// Types
// ============================================================================

interface Process {
  id: string;
  name: string;
  description?: string;
  status: string;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}

export interface ProcessBackgroundLayerProps {
  processId: string;
  position: { x: number; y: number };
  scale: number;
  opacity: number;
  onPositionChange: (pos: { x: number; y: number }) => void;
  onScaleChange: (scale: number) => void;
  isEditMode: boolean;
}

// ============================================================================
// Component
// ============================================================================

export const ProcessBackgroundLayer: React.FC<ProcessBackgroundLayerProps> = ({
  processId,
  position,
  scale,
  opacity,
  onPositionChange,
  onScaleChange,
  isEditMode,
}) => {
  const { getProcess } = useProcess();
  const [process, setProcess] = useState<Process | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Load process data
  useEffect(() => {
    if (!processId) {
      setProcess(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getProcess(processId)
      .then((data) => {
        setProcess(data as Process);
      })
      .catch((err) => {
        console.error('[ProcessBackgroundLayer] Failed to load process:', err);
        setError(err.message || 'Failed to load process');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [processId, getProcess]);

  // Mouse drag handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isEditMode) return;
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };
    },
    [isEditMode, position]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      onPositionChange({
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y,
      });
    },
    [isDragging, onPositionChange]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Global mouse up listener (for when mouse leaves the element)
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => setIsDragging(false);
      window.addEventListener('mouseup', handleGlobalMouseUp);
      return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }
  }, [isDragging]);

  // Wheel zoom handler
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!isEditMode) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newScale = Math.max(0.3, Math.min(3, scale + delta));
      onScaleChange(newScale);
    },
    [isEditMode, scale, onScaleChange]
  );

  // Loading state
  if (loading) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ opacity: opacity * 0.5 }}
      >
        <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  // Error state
  if (error || !process) {
    return null; // Silent fail for background - don't show error UI
  }

  return (
    <div
      ref={containerRef}
      className={`absolute ${isEditMode ? 'cursor-move' : ''}`}
      style={{
        transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
        transformOrigin: 'top left',
        opacity,
        pointerEvents: isEditMode ? 'auto' : 'none',
        transition: isDragging ? 'none' : 'opacity 0.3s ease',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      <ProcessDiagramRenderer
        nodes={process.nodes}
        edges={process.edges}
        readonly={true}
        fitView={false}
      />

      {/* Edit mode indicator */}
      {isEditMode && (
        <div className="absolute top-2 left-2 px-2 py-1 bg-cyan-500 text-white text-xs rounded shadow">
          Drag to move | Scroll to zoom
        </div>
      )}
    </div>
  );
};

export default ProcessBackgroundLayer;
