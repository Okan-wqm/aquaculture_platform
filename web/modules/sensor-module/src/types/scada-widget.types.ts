/**
 * Shared SCADA widget type definitions.
 *
 * Canonical source for ScadaWidgetType and ScadaWidgetNodeData —
 * other modules should import from here instead of defining locally.
 */

export type ScadaWidgetType =
  | 'gauge'
  | 'numericDisplay'
  | 'statusIndicator'
  | 'tankLevel'
  | 'toggleSwitch'
  | 'slider'
  | 'numericInput'
  | 'pushButton'
  | 'emergencyStop'
  | 'trendChart'
  | 'alarmBanner'
  | 'alarmList'
  | 'calibrationWizard'
  | 'calibrationHistory'
  | 'calibrationStatus'
  | 'processView'
  | 'equipment'
  | 'feeder'
  | 'radialFilter'
  | 'cleanWaterTank'
  | 'dirtyWaterTank'
  | 'mbbr'
  | 'hepaFilter'
  | 'cornellDualDrain'
  | 'screenLink'
  | 'staticText';

/* ------------------------------------------------------------------ */
/*  Equipment sub-types                                                */
/* ------------------------------------------------------------------ */

export type EquipmentSubType =
  // Pumps
  | 'centrifugalPump'
  | 'gearPump'
  | 'diaphragmPump'
  | 'pistonPump'
  | 'submersiblePump'
  | 'vacuumPump'
  // Valves
  | 'gateValve'
  | 'ballValve'
  | 'butterflyValve'
  | 'globeValve'
  | 'checkValve'
  | 'reliefValve'
  | 'controlValve'
  | 'needleValve'
  | 'solenoidValve'
  // Tanks
  | 'verticalTank'
  | 'horizontalTank'
  | 'conicalBottomTank'
  | 'pressureVessel'
  | 'silo'
  | 'mixingTank'
  // Heat Exchangers
  | 'shellAndTube'
  | 'plateHeatExchanger'
  | 'airCooler'
  | 'condenser'
  | 'evaporator';

export type EquipmentState = 'running' | 'stopped' | 'open' | 'closed' | 'fault';

export interface EquipmentConnectionPoint {
  id: string;
  label: string;
  side: 'top' | 'right' | 'bottom' | 'left';
  /** Offset ratio along the side (0 = start, 1 = end) */
  offset: number;
  /** Whether this point acts as an inlet, outlet or both */
  direction: 'in' | 'out' | 'inout';
}

export interface ScadaWidgetNodeData {
  widgetType: ScadaWidgetType;
  config: Record<string, unknown>;
  screenId: string;
  liveValue?: number | string | boolean;
  label?: string;
  tagName?: string;
  tagFqn?: string;
  width?: number;
  height?: number;
  onResize?: (widgetType: string, width: number, height: number) => void;
  /** True when rendered in preview/runtime mode (disables edit-only overlays like tooltips). */
  isPreview?: boolean;
  /** Group ID from ScreenWidget, passed through for tooltip display. */
  groupId?: string | null;
}
