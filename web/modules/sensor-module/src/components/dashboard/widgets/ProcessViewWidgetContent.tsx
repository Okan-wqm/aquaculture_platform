/**
 * Process View Widget Content
 *
 * Displays a process diagram inside a dashboard widget.
 * Shows fit-to-container view of the selected process.
 */

import React, { useState, useEffect } from 'react';
import { WidgetConfig } from '../types';
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

interface ProcessViewWidgetContentProps {
  config: WidgetConfig;
}

// ============================================================================
// Component
// ============================================================================

export const ProcessViewWidgetContent: React.FC<ProcessViewWidgetContentProps> = ({
  config,
}) => {
  const { getProcess } = useProcess();
  const [process, setProcess] = useState<Process | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load process data
  useEffect(() => {
    if (!config.processId) {
      setError('No process selected');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getProcess(config.processId)
      .then((data) => {
        setProcess(data as Process);
      })
      .catch((err) => {
        console.error('[ProcessViewWidgetContent] Failed to load process:', err);
        setError(err.message || 'Failed to load process');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [config.processId, getProcess]);

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        {error}
      </div>
    );
  }

  // No process
  if (!process) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No process data
      </div>
    );
  }

  // No nodes
  if (!process.nodes || process.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
        <p>Process: {process.name}</p>
        <p className="text-xs mt-1">No equipment nodes defined</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-hidden">
      {/* Process name header */}
      <div className="absolute top-1 left-2 z-10">
        <span className="text-xs text-gray-500 bg-white/80 px-1 rounded">
          {process.name}
        </span>
      </div>

      {/* Process diagram */}
      <ProcessDiagramRenderer
        nodes={process.nodes}
        edges={process.edges}
        readonly={true}
        fitView={true}
      />
    </div>
  );
};

export default ProcessViewWidgetContent;
