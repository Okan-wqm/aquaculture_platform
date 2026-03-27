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
  | 'staticText'
  | 'pipeFlow'
  | 'svgRect'
  | 'svgCircle'
  | 'svgLine'
  | 'svgText'
  | 'scheduler'
  | 'customSvg'
  | 'svgEllipse'
  | 'svgPath'
  | 'svgPolygon'
  | 'svgTriangle'
  | 'svgDiamond'
  | 'svgArrow'
  | 'rasterImage'
  | 'videoStream'
  | 'mapView'
  | 'dataTable'
  | 'iframe'
  | 'progressBar'
  | 'barChart'
  | 'pieChart'
  | 'knob'
  | 'dropdownSelect'
  | 'fuxaWidget'
  | 'vfdDrive'
  | 'vfdMini'
  | 'vfdGroup';

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

/* ------------------------------------------------------------------ */
/*  Per-widget permissions (ISA-101 security model)                    */
/* ------------------------------------------------------------------ */

/**
 * Per-widget role-based access control following ISA-101 HMI security guidelines.
 * Separates visibility from interactivity -- an operator may see a valve
 * but not be allowed to operate it without supervisor authorization.
 *
 * Roles are string IDs matching the tenant's role definitions from auth-service.
 * Empty arrays mean "visible/enabled for all roles" (default open).
 */
export interface WidgetPermissions {
  /** Role IDs that can see this widget. Empty = visible to all. */
  showRoles: string[];
  /** Role IDs that can interact with this widget. Empty = enabled for all. */
  enableRoles: string[];
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
  /**
   * Z-index for layer ordering. Passed from ScreenWidget.zIndex
   * so the node renderer can apply it to the container style.
   */
  zIndex?: number;
}
