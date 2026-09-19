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
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      <div className="p-2 bg-accent-50 dark:bg-accent-900/20 rounded-lg text-center border border-accent-100 dark:border-accent-800">
        <p className="text-lg font-bold text-accent-700 dark:text-accent-300">{screenCount}</p>
        <p className="text-xs text-accent-600 dark:text-accent-400">Screens</p>
      </div>
      <div className="p-2 bg-info-50 dark:bg-info-900/20 rounded-lg text-center border border-info-100 dark:border-info-800">
        <p className="text-lg font-bold text-info-700 dark:text-info-300">{widgetCount}</p>
        <p className="text-xs text-info-600 dark:text-info-400">Widget</p>
      </div>
      <div className="p-2 bg-accent-50 dark:bg-accent-900/20 rounded-lg text-center border border-accent-100 dark:border-accent-800">
        <p className="text-lg font-bold text-accent-700 dark:text-accent-300">{alarmCount}</p>
        <p className="text-xs text-accent-600 dark:text-accent-400">Alarms</p>
      </div>
      <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded-lg text-center border border-gray-200 dark:border-gray-700">
        <p className="text-lg font-bold text-gray-700 dark:text-gray-300">{jsonSizeStr}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">Size</p>
      </div>
    </div>
  );
};

export default ScadaPackagePreview;
