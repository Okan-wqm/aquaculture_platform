/**
 * SCADA Viewer Component
 * iframe-based read-only process viewer with sensor data overlay
 * Uses postMessage for communication with standalone ReactFlow canvas
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Loader2 } from 'lucide-react';
import { useScadaViewerStore, ScadaProcess } from '../../store/scadaViewerStore';

// Strip HTML tags from a string to prevent stored XSS via canvas node rendering
function stripHtml(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/<[^>]*>/g, '');
}

// Sanitize node/edge string fields before forwarding to the canvas iframe (SEC-009)
function sanitizeNodes(nodes: ScadaProcess['nodes']): ScadaProcess['nodes'] {
  return nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      equipmentName: (stripHtml(node.data?.equipmentName) as string) ?? node.data.equipmentName,
      ...((node.data as unknown as Record<string, unknown>).description != null
        ? { description: stripHtml((node.data as unknown as Record<string, unknown>).description) as string }
        : {}),
    },
  }));
}

// Get canvas URL
const getCanvasUrl = () => {
  // In development, use relative path
  // In production (Docker), use mf path
  const basePath = window.location.hostname === 'localhost' && window.location.port === '3006'
    ? '/scada-viewer-canvas.html'
    : '/remotes/sensor-module/scada-viewer-canvas.html';
  return basePath;
};

interface ScadaViewerProps {
  className?: string;
}

export const ScadaViewer: React.FC<ScadaViewerProps> = ({ className = '' }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const {
    selectedProcess,
    sensorReadings,
    selectedEquipmentId,
    setSelectedEquipmentId,
    setIsPanelOpen,
  } = useScadaViewerStore();

  // Send message to canvas iframe
  const sendToCanvas = useCallback((type: string, data: unknown) => {
    if (!iframeRef.current?.contentWindow) return;

    iframeRef.current.contentWindow.postMessage(
      { type, data, source: 'scada-viewer-host' },
      window.location.origin
    );
  }, []);

  // Handle messages from canvas
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // SEC-002: validate origin before processing any payload content
      if (event.origin !== window.location.origin) return;
      const { type, data, source } = event.data || {};
      if (source !== 'scada-viewer-canvas') return;

      switch (type) {
        case 'ready':
          setIsCanvasReady(true);
          setIsLoading(false);
          // Send initial process if available
          if (selectedProcess) {
            sendToCanvas('setProcess', {
              nodes: sanitizeNodes(selectedProcess.nodes),
              edges: selectedProcess.edges,
            });
          }
          break;

        case 'nodeSelected':
          if (data?.data?.equipmentId) {
            setSelectedEquipmentId(data.data.equipmentId);
            setIsPanelOpen(true);
          }
          break;

        case 'selectionCleared':
          setSelectedEquipmentId(null);
          setIsPanelOpen(false);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [selectedProcess, sendToCanvas, setSelectedEquipmentId, setIsPanelOpen]);

  // Send process to canvas when it changes
  useEffect(() => {
    if (!isCanvasReady || !selectedProcess) return;

    sendToCanvas('setProcess', {
      nodes: sanitizeNodes(selectedProcess.nodes),
      edges: selectedProcess.edges,
    });
  }, [isCanvasReady, selectedProcess, sendToCanvas]);

  // Send sensor readings to canvas when they change
  useEffect(() => {
    if (!isCanvasReady) return;

    // PERF-008: sensorReadings is now a plain Record — send directly without conversion
    sendToCanvas('updateAllSensorData', sensorReadings);
  }, [isCanvasReady, sensorReadings, sendToCanvas]);

  // Control functions
  const handleZoomIn = () => sendToCanvas('zoomIn', null);
  const handleZoomOut = () => sendToCanvas('zoomOut', null);
  const handleFitView = () => sendToCanvas('fitView', null);

  // Show empty state if no process selected
  if (!selectedProcess) {
    return (
      <div className={`flex-1 flex items-center justify-center bg-gray-50 ${className}`}>
        <div className="text-center">
          <Loader2 size={48} className="mx-auto mb-4 text-gray-500" />
          <h3 className="text-lg font-medium text-gray-700 mb-2">
            Proses Seçin
          </h3>
          <p className="text-sm text-gray-500">
            Görüntülemek için sol üstten bir proses seçin
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex-1 relative ${className}`}>
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 bg-gray-50 flex items-center justify-center z-10">
          <div className="text-center">
            <Loader2 size={32} className="mx-auto mb-2 text-blue-500 animate-spin" />
            <p className="text-sm text-gray-600">SCADA görünümü yükleniyor...</p>
          </div>
        </div>
      )}

      {/* ReactFlow Canvas iframe */}
      <iframe
        ref={iframeRef}
        src={getCanvasUrl()}
        className="w-full h-full border-0"
        title="SCADA Viewer Canvas"
        sandbox="allow-scripts allow-same-origin"
      />

      {/* Process info panel */}
      <div className="absolute top-3 left-3 bg-white rounded-lg shadow-sm border border-gray-200 p-3 z-20">
        <h3 className="font-medium text-gray-900 text-sm">{selectedProcess.name}</h3>
        {selectedProcess.description && (
          <p className="text-xs text-gray-500 mt-1">{selectedProcess.description}</p>
        )}
        <div className="flex items-center gap-2 mt-2">
          <span
            className={`
              px-2 py-0.5 rounded-full text-xs font-medium
              ${
                selectedProcess.status === 'active'
                  ? 'bg-green-100 text-green-700'
                  : selectedProcess.status === 'draft'
                  ? 'bg-gray-100 text-gray-700'
                  : selectedProcess.status === 'inactive'
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-red-100 text-red-700'
              }
            `}
          >
            {selectedProcess.status === 'active'
              ? 'Aktif'
              : selectedProcess.status === 'draft'
              ? 'Taslak'
              : selectedProcess.status === 'inactive'
              ? 'Pasif'
              : 'Arşivlenmiş'}
          </span>
          <span className="text-xs text-gray-500">
            {selectedProcess.nodes.length} ekipman
          </span>
        </div>
      </div>

      {/* Controls panel */}
      <div className="absolute bottom-3 left-3 bg-white rounded-lg shadow-sm border border-gray-200 p-1 z-20">
        <div className="flex items-center gap-1">
          <button
            onClick={handleZoomIn}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="Yakınlaştır"
          >
            <ZoomIn size={18} className="text-gray-600" />
          </button>
          <button
            onClick={handleZoomOut}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="Uzaklaştır"
          >
            <ZoomOut size={18} className="text-gray-600" />
          </button>
          <div className="w-px h-6 bg-gray-200 mx-1" />
          <button
            onClick={handleFitView}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="Sığdır"
          >
            <Maximize2 size={18} className="text-gray-600" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScadaViewer;
