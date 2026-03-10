import type { ScadaEdge } from './scada-edge.types';

export type ScadaPackageStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export type ScreenType = 'dashboard' | 'process' | 'alarms' | 'trends' | 'calibration' | 'control';

export interface WidgetPosition {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface ScreenWidget {
  id: string;
  widgetType: string;
  position: WidgetPosition;
  config: Record<string, unknown>;
}

export interface Screen {
  id: string;
  name: string;
  screenType: string;
  isDefault: boolean;
  icon: string;
  layout: { type: string; cols: number; rows: number };
  widgets: ScreenWidget[];
  edges?: ScadaEdge[];
}

export interface AlarmRule {
  id: string;
  tag: string;
  condition: string;
  value: number;
  severity: 'critical' | 'high' | 'warning' | 'info';
  message: string;
  deadband?: number;
  delay?: number;
}

export interface ControlPermissions {
  securityLevels: { none: string[]; confirm: string[]; pin: string[] };
  pinHash: string | null;
  emergencyStop: {
    holdDuration: number;
    affectedTags: string[];
    resetRequiresPin: boolean;
  } | null;
}

export interface TrendConfig {
  retentionDays: number;
  sampleIntervalSec: number;
  tags: string[];
}

export interface PackageMeta {
  version?: number;
  packageName?: string;
  processId?: string | null;
  edgeDeviceId?: string | null;
  automationBindings?: AutomationBinding[];
  author?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ScadaPackageData {
  meta?: PackageMeta;
  screens: Screen[];
  alarmRules: AlarmRule[];
  controlPermissions: ControlPermissions;
  trendConfig: TrendConfig;
}

export interface ScadaPackage {
  id: string;
  name: string;
  description?: string;
  version: number;
  processId?: string;
  processName?: string;
  packageData: ScadaPackageData;
  status: ScadaPackageStatus;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Automation Binding (SCADA ↔ Otomasyon Program entegrasyonu)
// ---------------------------------------------------------------------------

export interface VariableBinding {
  variableId: string;
  varName: string;
  scope: 'INPUT' | 'OUTPUT' | 'IN_OUT';
  dataType: string;
  boundWidgetId: string | null;
  boundTag: string | null;
  ioTagName?: string;
}

export interface AutomationBinding {
  programId: string;
  programName: string;
  programCode: string;
  variableBindings: VariableBinding[];
}

export interface ScadaPackageFilter {
  status?: ScadaPackageStatus;
  processId?: string;
  searchTerm?: string;
}

export interface ScadaPackageListResult {
  items: ScadaPackage[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}
