/**
 * ScadaBuilderStatusBar — Bottom status bar extracted from ScadaPackageBuilderPage.
 *
 * Shows: draft status, version, screen/widget/connection/alarm counts,
 * active device, current screen name, simulation indicator.
 */

import React from 'react';
import { Monitor, Zap } from 'lucide-react';
import type { BuilderMode } from './ScadaBuilderToolbar';

interface ScreenSummary {
  id: string;
  name: string;
  widgetCount: number;
  edgeCount: number;
  alarmWidgetCount: number;
}

export interface ScadaBuilderStatusBarProps {
  screens: ScreenSummary[];
  activeScreenId: string | null;
  mode: BuilderMode;
  selectedDeviceName: string | null;
}

export const ScadaBuilderStatusBar: React.FC<ScadaBuilderStatusBarProps> = ({
  screens,
  activeScreenId,
  mode,
  selectedDeviceName,
}) => {
  const totalWidgets = screens.reduce((sum, s) => sum + s.widgetCount, 0);
  const totalEdges = screens.reduce((sum, s) => sum + s.edgeCount, 0);
  const alarmWidgets = screens.reduce((sum, s) => sum + s.alarmWidgetCount, 0);

  return (
    <div className="px-4 py-1 bg-white border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
      <div className="flex items-center gap-4">
        <span>Status: Draft</span>
        <span>v1</span>
        <span>{screens.length} screens</span>
        <span>{totalWidgets} widget</span>
        <span>{totalEdges} connections</span>
        <span>{alarmWidgets} alarm</span>
        {selectedDeviceName && (
          <span className="flex items-center gap-1">
            <Monitor className="w-3 h-3" />
            {selectedDeviceName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {activeScreenId && (
          <span className="text-gray-500">
            {screens.find((s) => s.id === activeScreenId)?.name ?? ''}
          </span>
        )}
        {mode === 'simulation' && (
          <span className="flex items-center gap-1 text-cyan-500 font-medium">
            <Zap className="w-3 h-3" />
            Simulation
          </span>
        )}
        <span className={`w-2 h-2 rounded-full ${mode === 'simulation' ? 'bg-cyan-500 animate-pulse' : 'bg-green-500'}`} />
        <span>{mode === 'simulation' ? 'Simulation Active' : 'Ready'}</span>
      </div>
    </div>
  );
};
