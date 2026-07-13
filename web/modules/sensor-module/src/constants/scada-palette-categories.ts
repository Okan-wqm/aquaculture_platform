/**
 * Palette widget category definitions — the single source of truth for the
 * SCADA widget palette, consumed by UnifiedLeftPanel (search, favorites,
 * recently-used). Uses string icon keys instead of JSX to stay
 * framework-agnostic in a constants file; UnifiedLeftPanel resolves each
 * `iconKey` against its ICONS registry.
 *
 * This list must stay a superset of every renderable widget type. The
 * palette-parity invariant test asserts every `type` here resolves in the
 * WidgetRenderer lazy-map and every equipment `symbolMap` key is present.
 */

import type { ScadaWidgetType } from '../types/scada-widget.types';

export interface PaletteWidgetDef {
  type: ScadaWidgetType;
  label: string;
  iconKey: string;
  defaultConfig?: Record<string, unknown>;
}

export interface PaletteCategory {
  name: string;
  widgets: PaletteWidgetDef[];
}

export const PALETTE_CATEGORIES: PaletteCategory[] = [
  { name: 'Indicators', widgets: [
    { type: 'gauge', label: 'Gauge', iconKey: 'Gauge' },
    { type: 'numericDisplay', label: 'NumericDisplay', iconKey: 'Hash' },
    { type: 'statusIndicator', label: 'StatusIndicator', iconKey: 'Activity' },
    { type: 'tankLevel', label: 'TankLevel', iconKey: 'Droplets' },
  ]},
  { name: 'Control', widgets: [
    { type: 'toggleSwitch', label: 'ToggleSwitch', iconKey: 'ToggleLeft' },
    { type: 'slider', label: 'Slider', iconKey: 'SlidersHorizontal' },
    { type: 'numericInput', label: 'NumericInput', iconKey: 'Keyboard' },
    { type: 'pushButton', label: 'PushButton', iconKey: 'CircleDot' },
    { type: 'emergencyStop', label: 'EmergencyStop', iconKey: 'OctagonAlert' },
    { type: 'knob', label: 'Knob', iconKey: 'Disc3' },
    { type: 'dropdownSelect', label: 'Dropdown Select', iconKey: 'ChevronDownSquare' },
  ]},
  { name: 'Charts', widgets: [
    { type: 'trendChart', label: 'TrendChart', iconKey: 'TrendingUp' },
    { type: 'barChart', label: 'Bar Chart', iconKey: 'BarChart3' },
    { type: 'pieChart', label: 'Pie Chart', iconKey: 'PieChart' },
  ]},
  { name: 'Alarm', widgets: [
    { type: 'alarmBanner', label: 'AlarmBanner', iconKey: 'Bell' },
    { type: 'alarmList', label: 'AlarmList', iconKey: 'List' },
  ]},
  { name: 'Calibration', widgets: [
    { type: 'calibrationWizard', label: 'CalibrationWizard', iconKey: 'Wrench' },
    { type: 'calibrationHistory', label: 'CalibrationHistory', iconKey: 'History' },
    { type: 'calibrationStatus', label: 'CalibrationStatus', iconKey: 'CheckCircle' },
  ]},
  { name: 'Process', widgets: [
    { type: 'processView', label: 'ProcessView', iconKey: 'LayoutDashboard' },
  ]},
  { name: 'Navigation & Text', widgets: [
    { type: 'screenLink', label: 'Screen Link', iconKey: 'Link2' },
    { type: 'staticText', label: 'Text Label', iconKey: 'Type' },
  ]},
  { name: 'Piping', widgets: [
    { type: 'pipeFlow', label: 'Pipe Flow', iconKey: 'GitCommitHorizontal' },
  ]},
  { name: 'Shapes', widgets: [
    { type: 'svgRect', label: 'Rectangle', iconKey: 'Square' },
    { type: 'svgCircle', label: 'Circle', iconKey: 'Circle' },
    { type: 'svgLine', label: 'Line', iconKey: 'Minus' },
    { type: 'svgText', label: 'Text', iconKey: 'Type' },
    { type: 'customSvg', label: 'Custom SVG', iconKey: 'FileImage' },
    { type: 'svgEllipse', label: 'Ellipse', iconKey: 'Ellipsis' },
    { type: 'svgPath', label: 'Path', iconKey: 'Spline' },
    { type: 'svgPolygon', label: 'Polygon', iconKey: 'Hexagon' },
    { type: 'svgTriangle', label: 'Triangle', iconKey: 'Triangle' },
    { type: 'svgDiamond', label: 'Diamond', iconKey: 'Diamond' },
    { type: 'svgArrow', label: 'Arrow', iconKey: 'ArrowRight' },
  ]},
  { name: 'Automation', widgets: [
    { type: 'scheduler', label: 'Scheduler', iconKey: 'Calendar' },
  ]},
  { name: 'Data & Embedding', widgets: [
    { type: 'dataTable', label: 'Data Table', iconKey: 'Table2' },
    { type: 'iframe', label: 'IFrame', iconKey: 'Globe' },
    { type: 'progressBar', label: 'Progress Bar', iconKey: 'BarChart3' },
  ]},
  { name: 'Media', widgets: [
    { type: 'videoStream', label: 'Video Stream', iconKey: 'Video' },
    { type: 'mapView', label: 'Map View', iconKey: 'MapPinned' },
    { type: 'rasterImage', label: 'Image', iconKey: 'Image' },
  ]},
  { name: 'Process Equipment', widgets: [
    { type: 'feeder' as ScadaWidgetType, label: 'Feeder', iconKey: 'Square' },
    { type: 'mbbr' as ScadaWidgetType, label: 'MBBR', iconKey: 'Square' },
    { type: 'hepaFilter' as ScadaWidgetType, label: 'HEPA Filter', iconKey: 'Square' },
    { type: 'radialFilter' as ScadaWidgetType, label: 'Radial Filter', iconKey: 'Square' },
    { type: 'cornellDualDrain' as ScadaWidgetType, label: 'Cornell Dual Drain', iconKey: 'Square' },
  ]},
  { name: 'Water Tanks', widgets: [
    { type: 'cleanWaterTank' as ScadaWidgetType, label: 'Clean Water Tank', iconKey: 'Square' },
    { type: 'dirtyWaterTank' as ScadaWidgetType, label: 'Dirty Water Tank', iconKey: 'Square' },
  ]},
  { name: 'Pumps', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Centrifugal Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'centrifugalPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Gear Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'gearPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Diaphragm Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'diaphragmPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Piston Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'pistonPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Submersible Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'submersiblePump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Vacuum Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'vacuumPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Turbine Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'turbinePump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Screw Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'screwPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Peristaltic Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'peristalticPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Blower Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'blowerPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Jet Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'jetPump' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Vane Pump', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'vanePump' } },
  ]},
  { name: 'Valves', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Gate Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'gateValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Ball Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'ballValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Butterfly Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'butterflyValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Globe Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'globeValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Check Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'checkValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Relief Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'reliefValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Control Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'controlValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Needle Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'needleValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Solenoid Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'solenoidValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Three-Way Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'threeWayValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Pinch Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'pinchValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Diaphragm Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'diaphragmValve' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Plug Valve', iconKey: 'Diamond', defaultConfig: { equipmentSubType: 'plugValve' } },
  ]},
  { name: 'Tank / Vessel', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Vertical Tank', iconKey: 'Square', defaultConfig: { equipmentSubType: 'verticalTank' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Horizontal Tank', iconKey: 'Square', defaultConfig: { equipmentSubType: 'horizontalTank' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Conical Bottom Tank', iconKey: 'Square', defaultConfig: { equipmentSubType: 'conicalBottomTank' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Pressure Vessel', iconKey: 'Square', defaultConfig: { equipmentSubType: 'pressureVessel' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Silo', iconKey: 'Square', defaultConfig: { equipmentSubType: 'silo' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Mixing Tank', iconKey: 'Square', defaultConfig: { equipmentSubType: 'mixingTank' } },
  ]},
  { name: 'Heat Exchangers', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Shell & Tube', iconKey: 'Square', defaultConfig: { equipmentSubType: 'shellAndTube' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Plate Heat Exchanger', iconKey: 'Square', defaultConfig: { equipmentSubType: 'plateHeatExchanger' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Air Cooler', iconKey: 'Square', defaultConfig: { equipmentSubType: 'airCooler' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Condenser', iconKey: 'Square', defaultConfig: { equipmentSubType: 'condenser' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Evaporator', iconKey: 'Square', defaultConfig: { equipmentSubType: 'evaporator' } },
  ]},
  { name: 'Compressors', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Piston Compressor', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'pistonCompressor' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Screw Compressor', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'screwCompressor' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Centrifugal Compressor', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'centrifugalCompressor' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Diaphragm Compressor', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'diaphragmCompressor' } },
  ]},
  { name: 'Motors', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'AC Motor', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'acMotor' } },
    { type: 'equipment' as ScadaWidgetType, label: 'VFD Motor', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'vfdMotor' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Servo Motor', iconKey: 'Circle', defaultConfig: { equipmentSubType: 'servoMotor' } },
  ]},
  { name: 'Filters', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Bag Filter', iconKey: 'Square', defaultConfig: { equipmentSubType: 'bagFilter' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Drum Filter', iconKey: 'Square', defaultConfig: { equipmentSubType: 'drumFilter' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Membrane Filter', iconKey: 'Square', defaultConfig: { equipmentSubType: 'membraneFilter' } },
  ]},
  { name: 'Instruments', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Pressure Transmitter', iconKey: 'Gauge', defaultConfig: { equipmentSubType: 'pressureTransmitter' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Flow Transmitter', iconKey: 'Gauge', defaultConfig: { equipmentSubType: 'flowTransmitter' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Level Transmitter', iconKey: 'Gauge', defaultConfig: { equipmentSubType: 'levelTransmitter' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Temperature Transmitter', iconKey: 'Gauge', defaultConfig: { equipmentSubType: 'temperatureTransmitter' } },
  ]},
  { name: 'Animated', widgets: [
    { type: 'equipment' as ScadaWidgetType, label: 'Animated Gear', iconKey: 'Activity', defaultConfig: { equipmentSubType: 'animatedGear' } },
    { type: 'equipment' as ScadaWidgetType, label: 'Animated Conveyor', iconKey: 'Activity', defaultConfig: { equipmentSubType: 'animatedConveyor' } },
  ]},
  { name: 'VFD / Motor Drives', widgets: [
    { type: 'vfdDrive' as ScadaWidgetType, label: 'VFD Drive', iconKey: 'Zap', defaultConfig: { brand: 'ABB', demoState: 'RUNNING' } },
    { type: 'vfdMini' as ScadaWidgetType, label: 'VFD Mini', iconKey: 'Zap', defaultConfig: { brand: 'ABB', demoState: 'RUNNING' } },
    { type: 'vfdGroup' as ScadaWidgetType, label: 'VFD Group', iconKey: 'Zap', defaultConfig: { title: 'VFD Group' } },
  ]},
];

/** Default categories to expand on first load */
export const DEFAULT_EXPANDED_CATEGORIES = new Set(['Indicators', 'Control']);

/** Unique key for a palette widget (type + optional subtype) */
export function paletteWidgetKey(w: PaletteWidgetDef): string {
  const sub = w.defaultConfig?.equipmentSubType as string | undefined;
  return sub ? `${w.type}::${sub}` : w.type;
}
