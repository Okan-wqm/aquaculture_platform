/**
 * WidgetPalette - Left sidebar with draggable SCADA widget cards
 * Organized by category with collapsible accordion sections
 */

import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Gauge,
  Hash,
  Activity,
  ToggleLeft,
  SlidersHorizontal,
  Keyboard,
  CircleDot,
  OctagonAlert,
  TrendingUp,
  Bell,
  List,
  Wrench,
  History,
  CheckCircle,
  LayoutDashboard,
  GripVertical,
  Droplets,
} from 'lucide-react';
import type { ScadaWidgetType } from '../../types/scada-widget.types';
import { WIDGET_SIZES, GRID_CELL_W, GRID_CELL_H } from '../../constants/scada-widget-sizes';

interface WidgetDefinition {
  type: ScadaWidgetType;
  label: string;
  icon: React.ReactNode;
}

interface WidgetCategory {
  name: string;
  widgets: WidgetDefinition[];
}

const WIDGET_CATEGORIES: WidgetCategory[] = [
  {
    name: 'Gosterge',
    widgets: [
      { type: 'gauge', label: 'Gauge', icon: <Gauge className="w-4 h-4" /> },
      { type: 'numericDisplay', label: 'NumericDisplay', icon: <Hash className="w-4 h-4" /> },
      { type: 'statusIndicator', label: 'StatusIndicator', icon: <Activity className="w-4 h-4" /> },
      { type: 'tankLevel', label: 'TankLevel', icon: <Droplets className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Kontrol',
    widgets: [
      { type: 'toggleSwitch', label: 'ToggleSwitch', icon: <ToggleLeft className="w-4 h-4" /> },
      { type: 'slider', label: 'Slider', icon: <SlidersHorizontal className="w-4 h-4" /> },
      { type: 'numericInput', label: 'NumericInput', icon: <Keyboard className="w-4 h-4" /> },
      { type: 'pushButton', label: 'PushButton', icon: <CircleDot className="w-4 h-4" /> },
      { type: 'emergencyStop', label: 'EmergencyStop', icon: <OctagonAlert className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Trend',
    widgets: [
      { type: 'trendChart', label: 'TrendChart', icon: <TrendingUp className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Alarm',
    widgets: [
      { type: 'alarmBanner', label: 'AlarmBanner', icon: <Bell className="w-4 h-4" /> },
      { type: 'alarmList', label: 'AlarmList', icon: <List className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Kalibrasyon',
    widgets: [
      { type: 'calibrationWizard', label: 'CalibrationWizard', icon: <Wrench className="w-4 h-4" /> },
      { type: 'calibrationHistory', label: 'CalibrationHistory', icon: <History className="w-4 h-4" /> },
      { type: 'calibrationStatus', label: 'CalibrationStatus', icon: <CheckCircle className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Proses',
    widgets: [
      { type: 'processView', label: 'ProcessView', icon: <LayoutDashboard className="w-4 h-4" /> },
    ],
  },
];

export const WidgetPalette: React.FC = () => {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(WIDGET_CATEGORIES.map((c) => c.name))
  );

  const toggleCategory = (name: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleDragStart = (e: React.DragEvent, widget: WidgetDefinition) => {
    const sizeDef = WIDGET_SIZES[widget.type];
    const defaultWidth = sizeDef ? sizeDef.defaultW * GRID_CELL_W : 240;
    const defaultHeight = sizeDef ? sizeDef.defaultH * GRID_CELL_H : 200;

    e.dataTransfer.setData(
      'application/reactflow-widget',
      JSON.stringify({
        widgetType: widget.type,
        label: widget.label,
        defaultWidth,
        defaultHeight,
        defaultConfig: {
          label: widget.label,
        },
      })
    );
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="w-56 border-r border-gray-200 bg-white flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Widget Palette
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto">
        {WIDGET_CATEGORIES.map((category) => (
          <div key={category.name}>
            <button
              onClick={() => toggleCategory(category.name)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border-b border-gray-100"
            >
              <span>{category.name}</span>
              {expandedCategories.has(category.name) ? (
                <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
              )}
            </button>
            {expandedCategories.has(category.name) && (
              <div className="py-1 px-2 space-y-1">
                {category.widgets.map((widget) => {
                  const sizeDef = WIDGET_SIZES[widget.type];
                  const pw = sizeDef ? sizeDef.defaultW * GRID_CELL_W : 0;
                  const ph = sizeDef ? sizeDef.defaultH * GRID_CELL_H : 0;
                  return (
                    <div
                      key={widget.type}
                      draggable
                      onDragStart={(e) => handleDragStart(e, widget)}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-gray-200 bg-white hover:border-cyan-400 hover:bg-cyan-50 cursor-grab active:cursor-grabbing transition-colors group"
                    >
                      <GripVertical className="w-3 h-3 text-gray-300 group-hover:text-cyan-400 flex-shrink-0" />
                      <span className="text-gray-600 flex-shrink-0">{widget.icon}</span>
                      <span className="text-xs text-gray-700 truncate flex-1">{widget.label}</span>
                      {pw > 0 && (
                        <span className="text-[9px] text-gray-400 flex-shrink-0">
                          {pw}x{ph}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
