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
import { WIDGET_SIZES, GRID_CELL_W, GRID_CELL_H, EQUIPMENT_SUBTYPE_SIZES } from '../../constants/scada-widget-sizes';

interface WidgetDefinition {
  type: ScadaWidgetType;
  label: string;
  icon: React.ReactNode;
  defaultConfig?: Record<string, unknown>;
}

interface WidgetCategory {
  name: string;
  widgets: WidgetDefinition[];
}

const PUMP_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <circle cx="7" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    <polygon points="11,5 15,8 11,11" fill="currentColor"/>
  </svg>
);

const VALVE_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <polygon points="2,4 8,8 2,12" fill="currentColor" opacity="0.6"/>
    <polygon points="14,4 8,8 14,12" fill="currentColor" opacity="0.6"/>
  </svg>
);

const TANK_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <rect x="3" y="3" width="10" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M3,3 Q8,0 13,3" fill="none" stroke="currentColor" strokeWidth="1.5"/>
  </svg>
);

const HX_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <rect x="2" y="4" width="12" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    <line x1="5" y1="6" x2="5" y2="10" stroke="currentColor" strokeWidth="1"/>
    <line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" strokeWidth="1"/>
    <line x1="11" y1="6" x2="11" y2="10" stroke="currentColor" strokeWidth="1"/>
  </svg>
);

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
  {
    name: 'Pompa',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Santrifuj Pompa', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'centrifugalPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Disli Pompa', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'gearPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Diyafram Pompa', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'diaphragmPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Piston Pompa', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'pistonPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Dalgic Pompa', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'submersiblePump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Vakum Pompa', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'vacuumPump' } },
    ],
  },
  {
    name: 'Vana',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Surgulu Vana', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'gateValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Kuresel Vana', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'ballValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Kelebek Vana', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'butterflyValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Glob Vana', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'globeValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Cekvalf', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'checkValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Emniyet Vanasi', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'reliefValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Kontrol Vanasi', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'controlValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Igne Vana', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'needleValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Solenoid Vana', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'solenoidValve' } },
    ],
  },
  {
    name: 'Tank / Vessel',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Dikey Tank', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'verticalTank' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Yatay Tank', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'horizontalTank' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Konik Dipli Tank', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'conicalBottomTank' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Basinçli Kap', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'pressureVessel' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Silo', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'silo' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Karistirma Tanki', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'mixingTank' } },
    ],
  },
  {
    name: 'Isi Degistirici',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Boru Demeti', icon: HX_ICON, defaultConfig: { equipmentSubType: 'shellAndTube' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Plakali Esanjor', icon: HX_ICON, defaultConfig: { equipmentSubType: 'plateHeatExchanger' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Hava Sogutucu', icon: HX_ICON, defaultConfig: { equipmentSubType: 'airCooler' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Kondenser', icon: HX_ICON, defaultConfig: { equipmentSubType: 'condenser' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Evaporator', icon: HX_ICON, defaultConfig: { equipmentSubType: 'evaporator' } },
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
    const subType = widget.defaultConfig?.equipmentSubType as string | undefined;
    const sizeDef = subType
      ? EQUIPMENT_SUBTYPE_SIZES[subType as import('../../types/scada-widget.types').EquipmentSubType] || WIDGET_SIZES[widget.type]
      : WIDGET_SIZES[widget.type];
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
          ...widget.defaultConfig,
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
                  const eqSubType = widget.defaultConfig?.equipmentSubType as string | undefined;
                  const sizeDef = eqSubType
                    ? EQUIPMENT_SUBTYPE_SIZES[eqSubType as import('../../types/scada-widget.types').EquipmentSubType]
                    : WIDGET_SIZES[widget.type];
                  const pw = sizeDef ? sizeDef.defaultW * GRID_CELL_W : 0;
                  const ph = sizeDef ? sizeDef.defaultH * GRID_CELL_H : 0;
                  return (
                    <div
                      key={widget.defaultConfig?.equipmentSubType as string || widget.type}
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
