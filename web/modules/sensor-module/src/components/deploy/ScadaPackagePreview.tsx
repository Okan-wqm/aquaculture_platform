/**
 * SCADA package deploy preview — screen/widget/alarm counts + payload size.
 * Rendered inside DeployToEdgeDialog via its `preview` slot.
 */

import React from 'react';
import type { ScadaPackageJSON } from '../../store/scada';

export interface ScadaPackagePreviewProps {
  packageData: ScadaPackageJSON;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ScadaPackagePreview: React.FC<ScadaPackagePreviewProps> = ({ packageData }) => {
  const screenCount = packageData.screens?.length || 0;
  const widgetCount =
    packageData.screens?.reduce((sum, s) => sum + (s.widgets?.length || 0), 0) || 0;
  const alarmCount = packageData.alarmRules?.length || 0;
  const jsonSizeStr = formatSize(new Blob([JSON.stringify(packageData)]).size);

  return (
    <div className="grid grid-cols-4 gap-2">
      <div className="p-2 bg-purple-50 rounded-lg text-center border border-purple-100">
        <p className="text-lg font-bold text-purple-700">{screenCount}</p>
        <p className="text-xs text-purple-600">Screens</p>
      </div>
      <div className="p-2 bg-blue-50 rounded-lg text-center border border-blue-100">
        <p className="text-lg font-bold text-blue-700">{widgetCount}</p>
        <p className="text-xs text-blue-600">Widget</p>
      </div>
      <div className="p-2 bg-orange-50 rounded-lg text-center border border-orange-100">
        <p className="text-lg font-bold text-orange-700">{alarmCount}</p>
        <p className="text-xs text-orange-600">Alarms</p>
      </div>
      <div className="p-2 bg-gray-50 rounded-lg text-center border border-gray-200">
        <p className="text-lg font-bold text-gray-700">{jsonSizeStr}</p>
        <p className="text-xs text-gray-500">Size</p>
      </div>
    </div>
  );
};

export default ScadaPackagePreview;
