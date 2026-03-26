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
  Link2,
  Type,
  GitCommitHorizontal,
  Shapes,
  Square,
  Circle,
  Minus,
  FileImage,
  Calendar,
  Video,
  MapPinned,
  Ellipsis,
  Spline,
  Image,
  Hexagon,
  Triangle,
  Diamond,
  ArrowRight,
  Table2,
  Globe,
  BarChart3,
  PieChart,
  Disc3,
  ChevronDownSquare,
  Puzzle,
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

const FEEDER_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <polygon points="4,4 12,4 10,12 6,12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    <rect x="6" y="1" width="4" height="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
    <line x1="7" y1="12" x2="7" y2="15" stroke="currentColor" strokeWidth="1"/>
    <line x1="9" y1="12" x2="9" y2="15" stroke="currentColor" strokeWidth="1"/>
  </svg>
);

const FILTER_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <path d="M3,3 L13,3 L10,13 L6,13 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    <line x1="5" y1="6" x2="8" y2="11" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.5,1"/>
    <line x1="11" y1="6" x2="8" y2="11" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.5,1"/>
  </svg>
);

const WATER_TANK_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <rect x="3" y="4" width="10" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    <ellipse cx="8" cy="4" rx="5" ry="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    <rect x="4" y="8" width="8" height="4" rx="0" fill="currentColor" opacity="0.2"/>
  </svg>
);

const MBBR_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    <circle cx="5" cy="7" r="1.2" fill="currentColor" opacity="0.5"/>
    <circle cx="8" cy="6" r="1.2" fill="currentColor" opacity="0.5"/>
    <circle cx="11" cy="7" r="1.2" fill="currentColor" opacity="0.5"/>
    <circle cx="6.5" cy="9.5" r="1.2" fill="currentColor" opacity="0.5"/>
    <circle cx="9.5" cy="9.5" r="1.2" fill="currentColor" opacity="0.5"/>
  </svg>
);

const HEPA_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <rect x="4" y="2" width="8" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M6,4 L10,6 L6,8 L10,10 L6,12" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
  </svg>
);

const CORNELL_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="w-4 h-4">
    <path d="M2,4 L12,4 L12,12 L8,13 L2,12 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    <rect x="12" y="5" width="3" height="6" fill="none" stroke="currentColor" strokeWidth="1"/>
    <line x1="7" y1="13" x2="7" y2="15" stroke="currentColor" strokeWidth="1.5"/>
  </svg>
);

const WIDGET_CATEGORIES: WidgetCategory[] = [
  {
    name: 'Indicators',
    widgets: [
      { type: 'gauge', label: 'Gauge', icon: <Gauge className="w-4 h-4" /> },
      { type: 'numericDisplay', label: 'NumericDisplay', icon: <Hash className="w-4 h-4" /> },
      { type: 'statusIndicator', label: 'StatusIndicator', icon: <Activity className="w-4 h-4" /> },
      { type: 'tankLevel', label: 'TankLevel', icon: <Droplets className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Control',
    widgets: [
      { type: 'toggleSwitch', label: 'ToggleSwitch', icon: <ToggleLeft className="w-4 h-4" /> },
      { type: 'slider', label: 'Slider', icon: <SlidersHorizontal className="w-4 h-4" /> },
      { type: 'numericInput', label: 'NumericInput', icon: <Keyboard className="w-4 h-4" /> },
      { type: 'pushButton', label: 'PushButton', icon: <CircleDot className="w-4 h-4" /> },
      { type: 'emergencyStop', label: 'EmergencyStop', icon: <OctagonAlert className="w-4 h-4" /> },
      { type: 'knob', label: 'Knob', icon: <Disc3 className="w-4 h-4" /> },
      { type: 'dropdownSelect', label: 'Dropdown Select', icon: <ChevronDownSquare className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Charts',
    widgets: [
      { type: 'trendChart', label: 'TrendChart', icon: <TrendingUp className="w-4 h-4" /> },
      { type: 'barChart', label: 'Bar Chart', icon: <BarChart3 className="w-4 h-4" /> },
      { type: 'pieChart', label: 'Pie Chart', icon: <PieChart className="w-4 h-4" /> },
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
    name: 'Calibration',
    widgets: [
      { type: 'calibrationWizard', label: 'CalibrationWizard', icon: <Wrench className="w-4 h-4" /> },
      { type: 'calibrationHistory', label: 'CalibrationHistory', icon: <History className="w-4 h-4" /> },
      { type: 'calibrationStatus', label: 'CalibrationStatus', icon: <CheckCircle className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Process',
    widgets: [
      { type: 'processView', label: 'ProcessView', icon: <LayoutDashboard className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Navigation & Text',
    widgets: [
      { type: 'screenLink', label: 'Screen Link', icon: <Link2 className="w-4 h-4" /> },
      { type: 'staticText', label: 'Text Label', icon: <Type className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Piping',
    widgets: [
      { type: 'pipeFlow', label: 'Pipe Flow', icon: <GitCommitHorizontal className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Shapes',
    widgets: [
      { type: 'svgRect', label: 'Rectangle', icon: <Square className="w-4 h-4" /> },
      { type: 'svgCircle', label: 'Circle', icon: <Circle className="w-4 h-4" /> },
      { type: 'svgLine', label: 'Line', icon: <Minus className="w-4 h-4" /> },
      { type: 'svgText', label: 'Text', icon: <Type className="w-4 h-4" /> },
      { type: 'customSvg', label: 'Custom SVG', icon: <FileImage className="w-4 h-4" /> },
      { type: 'svgEllipse', label: 'Ellipse', icon: <Ellipsis className="w-4 h-4" /> },
      { type: 'svgPath', label: 'Path', icon: <Spline className="w-4 h-4" /> },
      { type: 'svgPolygon', label: 'Polygon', icon: <Hexagon className="w-4 h-4" /> },
      { type: 'svgTriangle', label: 'Triangle', icon: <Triangle className="w-4 h-4" /> },
      { type: 'svgDiamond', label: 'Diamond', icon: <Diamond className="w-4 h-4" /> },
      { type: 'svgArrow', label: 'Arrow', icon: <ArrowRight className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Automation',
    widgets: [
      { type: 'scheduler', label: 'Scheduler', icon: <Calendar className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Data & Embedding',
    widgets: [
      { type: 'dataTable', label: 'Data Table', icon: <Table2 className="w-4 h-4" /> },
      { type: 'iframe', label: 'IFrame', icon: <Globe className="w-4 h-4" /> },
      { type: 'progressBar', label: 'Progress Bar', icon: <BarChart3 className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Media',
    widgets: [
      { type: 'videoStream', label: 'Video Stream', icon: <Video className="w-4 h-4" /> },
      { type: 'mapView', label: 'Map View', icon: <MapPinned className="w-4 h-4" /> },
      { type: 'rasterImage', label: 'Image', icon: <Image className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Community',
    widgets: [
      { type: 'fuxaWidget', label: 'FUXA Widget', icon: <Puzzle className="w-4 h-4" /> },
    ],
  },
  {
    name: 'Process Equipment',
    widgets: [
      { type: 'feeder' as ScadaWidgetType, label: 'Feeder', icon: FEEDER_ICON },
      { type: 'mbbr' as ScadaWidgetType, label: 'MBBR', icon: MBBR_ICON },
      { type: 'hepaFilter' as ScadaWidgetType, label: 'HEPA Filter', icon: HEPA_ICON },
      { type: 'radialFilter' as ScadaWidgetType, label: 'Radial Filter', icon: FILTER_ICON },
      { type: 'cornellDualDrain' as ScadaWidgetType, label: 'Cornell Dual Drain', icon: CORNELL_ICON },
    ],
  },
  {
    name: 'Water Tanks',
    widgets: [
      { type: 'cleanWaterTank' as ScadaWidgetType, label: 'Clean Water Tank', icon: WATER_TANK_ICON },
      { type: 'dirtyWaterTank' as ScadaWidgetType, label: 'Dirty Water Tank', icon: WATER_TANK_ICON },
    ],
  },
  {
    name: 'Pumps',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Centrifugal Pump', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'centrifugalPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Gear Pump', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'gearPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Diaphragm Pump', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'diaphragmPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Piston Pump', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'pistonPump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Submersible Pump', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'submersiblePump' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Vacuum Pump', icon: PUMP_ICON, defaultConfig: { equipmentSubType: 'vacuumPump' } },
    ],
  },
  {
    name: 'Valves',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Gate Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'gateValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Ball Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'ballValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Butterfly Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'butterflyValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Globe Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'globeValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Check Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'checkValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Relief Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'reliefValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Control Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'controlValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Needle Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'needleValve' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Solenoid Valve', icon: VALVE_ICON, defaultConfig: { equipmentSubType: 'solenoidValve' } },
    ],
  },
  {
    name: 'Tank / Vessel',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Vertical Tank', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'verticalTank' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Horizontal Tank', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'horizontalTank' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Conical Bottom Tank', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'conicalBottomTank' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Pressure Vessel', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'pressureVessel' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Silo', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'silo' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Mixing Tank', icon: TANK_ICON, defaultConfig: { equipmentSubType: 'mixingTank' } },
    ],
  },
  {
    name: 'Heat Exchangers',
    widgets: [
      { type: 'equipment' as ScadaWidgetType, label: 'Shell & Tube', icon: HX_ICON, defaultConfig: { equipmentSubType: 'shellAndTube' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Plate Heat Exchanger', icon: HX_ICON, defaultConfig: { equipmentSubType: 'plateHeatExchanger' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Air Cooler', icon: HX_ICON, defaultConfig: { equipmentSubType: 'airCooler' } },
      { type: 'equipment' as ScadaWidgetType, label: 'Condenser', icon: HX_ICON, defaultConfig: { equipmentSubType: 'condenser' } },
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
                <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
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
                      <GripVertical className="w-3 h-3 text-gray-500 group-hover:text-cyan-400 flex-shrink-0" />
                      <span className="text-gray-600 flex-shrink-0">{widget.icon}</span>
                      <span className="text-xs text-gray-700 truncate flex-1">{widget.label}</span>
                      {pw > 0 && (
                        <span className="text-[10px] text-gray-500 flex-shrink-0">
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
