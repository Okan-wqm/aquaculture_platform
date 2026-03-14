/**
 * RAS Flow Diagram Widget
 *
 * Displays the Recirculating Aquaculture System (RAS) flow diagram
 * with real-time component status indicators.
 * TODO: Wire to sensor-service for live component status.
 */

import React from 'react';
import { Card } from '@aquaculture/shared-ui';

export interface RASFlowDiagramProps {
  farmId?: string;
  systemId?: string;
  className?: string;
}

export const RASFlowDiagram: React.FC<RASFlowDiagramProps> = ({
  farmId,
  systemId,
  className = '',
}) => {
  return (
    <Card className={`p-4 ${className}`}>
      <div className="text-center py-6 text-gray-500">
        <svg className="w-8 h-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <p className="text-sm font-medium text-gray-500">RAS Akış Diyagramı</p>
        {farmId && <p className="text-xs text-gray-500 mt-1">Çiftlik: {farmId}</p>}
        {systemId && <p className="text-xs text-gray-500">Sistem: {systemId}</p>}
        <p className="text-xs text-gray-500 mt-2">Veri bağlantısı kurulacak</p>
      </div>
    </Card>
  );
};

export default RASFlowDiagram;
