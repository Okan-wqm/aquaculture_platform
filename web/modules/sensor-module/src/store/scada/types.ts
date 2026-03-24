/**
 * SCADA Store — Canonical type definitions for the decomposed store.
 *
 * The monolithic scadaPackageStore is refactored into 9 slices:
 *   sceneSlice     — Screen CRUD, hierarchy, viewport, navigation
 *   widgetSlice    — Widget CRUD, position, resize
 *   edgeSlice      — Edge CRUD, type changes
 *   selectionSlice — Widget/edge selection, clipboard, copy/paste
 *   historySlice   — Undo/redo (command pattern)
 *   alarmSlice     — Alarm rules, control permissions, trend config
 *   groupSlice     — Widget grouping/ungrouping
 *   templateSlice  — Widget templates save/load/apply
 *   projectSlice   — Package meta, automation, serialization, reset
 *
 * All slice implementations use zustand + immer middleware.
 * Each slice's StateCreator receives the full ScadaStore type so it can
 * read/write any field—slices are an organisational boundary, not an
 * isolation boundary.
 */

import type { StateCreator } from 'zustand';
import type {
  WidgetPosition,
  ScreenWidget,
  AutomationBinding,
  VariableBinding,
} from '../../types/scada-package.types';
import type { ScadaEdge, ScadaEdgeData } from '../../types/scada-edge.types';
import type { OverlayEntry } from '../../engine/views/types';

/* ------------------------------------------------------------------ */
/*  Re-exports (backward compatibility with old store imports)         */
/* ------------------------------------------------------------------ */

export type {
  WidgetPosition,
  ScreenWidget,
  AutomationBinding,
  VariableBinding,
} from '../../types/scada-package.types';
export type { ScadaWidgetType } from '../../types/scada-widget.types';
export type { ScadaEdge, ScadaEdgeData } from '../../types/scada-edge.types';

/* ------------------------------------------------------------------ */
/*  Domain Types                                                       */
/* ------------------------------------------------------------------ */

export type ScreenType =
  | 'dashboard'
  | 'process'
  | 'alarms'
  | 'trends'
  | 'calibration'
  | 'control';

export interface ScreenViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ScreenDef {
  id: string;
  name: string;
  screenType: ScreenType;
  isDefault: boolean;
  icon: string;
  layout: { type: string; cols: number; rows: number };
  widgets: ScreenWidget[];
  edges: ScadaEdge[];
  /** Parent screen ID for hierarchy (null = root level). */
  parentId?: string | null;
  /** Display order among siblings. */
  sortOrder?: number;
  /** Optional background image URL for the screen canvas. */
  backgroundImage?: string | null;
  /** Background image opacity (0-1). */
  backgroundOpacity?: number;
}

export interface AlarmRuleDef {
  id: string;
  tag: string;
  condition: string;
  value: number;
  severity: 'critical' | 'high' | 'warning' | 'info';
  message: string;
  deadband?: number;
  delay?: number;
}

export interface ControlPermissionsDef {
  securityLevels: { none: string[]; confirm: string[]; pin: string[] };
  pinHash: string | null;
  emergencyStop: {
    holdDuration: number;
    affectedTags: string[];
    resetRequiresPin: boolean;
  } | null;
}

export interface TrendConfigDef {
  retentionDays: number;
  sampleIntervalSec: number;
  tags: string[];
}

/* ------------------------------------------------------------------ */
/*  JSON Import/Export Types                                            */
/* ------------------------------------------------------------------ */

export interface ScreenJSON {
  id?: string;
  name?: string;
  screenType?: string;
  isDefault?: boolean;
  icon?: string;
  layout?: { type: string; cols: number; rows: number };
  widgets?: Array<{
    id?: string;
    widgetType?: string;
    position?: Partial<WidgetPosition>;
    config?: Record<string, unknown>;
    groupId?: string | null;
    locked?: boolean;
    animations?: ScreenWidget['animations'];
    events?: ScreenWidget['events'];
  }>;
  edges?: ScadaEdge[];
  parentId?: string | null;
  sortOrder?: number;
  backgroundImage?: string | null;
  backgroundOpacity?: number;
}

export interface AlarmRuleJSON {
  id?: string;
  tag?: string;
  condition?: string;
  value?: number;
  severity?: string;
  message?: string;
  deadband?: number;
  delay?: number;
}

export interface ScadaPackageJSON {
  meta?: {
    version?: number;
    packageName?: string;
    processId?: string | null;
    edgeDeviceId?: string | null;
    automationBindings?: AutomationBinding[];
  };
  screens?: ScreenJSON[];
  alarmRules?: AlarmRuleJSON[];
  controlPermissions?: ControlPermissionsDef;
  trendConfig?: TrendConfigDef;
}

/* ------------------------------------------------------------------ */
/*  History (Undo / Redo) — Command Pattern                            */
/* ------------------------------------------------------------------ */

export type HistoryEntry =
  // Widget
  | { type: 'WIDGET_ADD'; screenId: string; widget: ScreenWidget }
  | { type: 'WIDGET_REMOVE'; screenId: string; widget: ScreenWidget; removedEdges: ScadaEdge[] }
  | { type: 'WIDGET_UPDATE'; screenId: string; widgetId: string; before: ScreenWidget; after: ScreenWidget }
  | { type: 'WIDGET_MOVE'; screenId: string; widgetId: string; from: WidgetPosition; to: WidgetPosition }
  // Edge
  | { type: 'EDGE_ADD'; screenId: string; edge: ScadaEdge }
  | { type: 'EDGE_REMOVE'; screenId: string; edge: ScadaEdge }
  | { type: 'EDGE_UPDATE'; screenId: string; edgeId: string; before: ScadaEdgeData; after: ScadaEdgeData }
  // Screen
  | { type: 'SCREEN_ADD'; screen: ScreenDef }
  | { type: 'SCREEN_REMOVE'; screen: ScreenDef; index: number; wasActive: boolean }
  | { type: 'SCREEN_UPDATE'; screenId: string; before: Partial<ScreenDef>; after: Partial<ScreenDef> }
  // Alarm
  | { type: 'ALARM_ADD'; rule: AlarmRuleDef }
  | { type: 'ALARM_REMOVE'; rule: AlarmRuleDef; index: number }
  | { type: 'ALARM_UPDATE'; ruleId: string; before: AlarmRuleDef; after: AlarmRuleDef }
  // Composite
  | { type: 'BATCH'; entries: HistoryEntry[]; label: string };

/* ------------------------------------------------------------------ */
/*  Clipboard                                                          */
/* ------------------------------------------------------------------ */

export interface ClipboardData {
  widgets: ScreenWidget[];
  edges: ScadaEdge[];
  sourceScreenId: string;
}

/* ------------------------------------------------------------------ */
/*  Widget Template Types                                              */
/* ------------------------------------------------------------------ */

export interface WidgetTemplate {
  id: string;
  name: string;
  category: string;
  widgetType: string;
  config: Record<string, unknown>;
  defaultSize: { w: number; h: number };
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/*  Slice Interfaces                                                   */
/* ------------------------------------------------------------------ */

// --- Scene Slice ---

export interface SceneSlice {
  screens: ScreenDef[];
  activeScreenId: string;
  screenViewports: Record<string, ScreenViewport>;
  screenHistory: string[];

  addScreen: (type: ScreenType, name: string) => void;
  removeScreen: (id: string) => void;
  duplicateScreen: (id: string) => void;
  updateScreen: (id: string, updates: Partial<ScreenDef>) => void;
  setActiveScreen: (id: string) => void;
  setDefaultScreen: (id: string) => void;
  saveScreenViewport: (screenId: string, viewport: ScreenViewport) => void;
  getScreenViewport: (screenId: string) => ScreenViewport;
}

// --- Widget Slice (operates on screens[].widgets) ---

export interface WidgetSlice {
  addWidget: (screenId: string, widget: ScreenWidget) => void;
  removeWidget: (screenId: string, widgetId: string) => void;
  updateWidget: (screenId: string, widgetId: string, updates: Partial<ScreenWidget>) => void;
  updateWidgetPosition: (screenId: string, widgetId: string, position: WidgetPosition) => void;
  bringToFront: (screenId: string, widgetId: string) => void;
  sendToBack: (screenId: string, widgetId: string) => void;
  toggleWidgetLock: (screenId: string, widgetId: string) => void;
}

// --- Edge Slice (operates on screens[].edges) ---

export interface EdgeSlice {
  addEdge: (screenId: string, edge: ScadaEdge) => void;
  removeEdge: (screenId: string, edgeId: string) => void;
  updateEdgeData: (screenId: string, edgeId: string, data: Partial<ScadaEdgeData>) => void;
  updateEdgeType: (screenId: string, edgeId: string, newType: ScadaEdge['type']) => void;
}

// --- Selection Slice ---

export interface SelectionSlice {
  selectedWidgetId: string | null;
  selectedWidgetIds: string[];
  selectedEdgeId: string | null;
  clipboard: ClipboardData | null;

  setSelectedWidget: (id: string | null) => void;
  setSelectedEdge: (id: string | null) => void;
  toggleWidgetSelection: (id: string) => void;
  selectGroup: (screenId: string, groupId: string) => void;
  selectAllWidgets: () => void;
  deselectAll: () => void;
  copySelectedWidgets: () => void;
  cutSelectedWidgets: () => void;
  pasteWidgets: (targetScreenId?: string) => void;
  clearClipboard: () => void;
}

// --- History Slice ---

export interface HistorySlice {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  undo: () => void;
  redo: () => void;
  pushHistory: (entry: HistoryEntry) => void;
  clearHistory: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

// --- Alarm Slice ---

export interface AlarmSlice {
  alarmRules: AlarmRuleDef[];
  controlPermissions: ControlPermissionsDef;
  trendConfig: TrendConfigDef;

  addAlarmRule: (rule: AlarmRuleDef) => void;
  removeAlarmRule: (id: string) => void;
  updateAlarmRule: (id: string, updates: Partial<AlarmRuleDef>) => void;
  updateControlPermissions: (perms: ControlPermissionsDef) => void;
  updateTrendConfig: (config: TrendConfigDef) => void;
}

// --- Group Slice ---

export interface GroupSlice {
  groupWidgets: (screenId: string, widgetIds: string[]) => string; // returns groupId
  ungroupWidgets: (screenId: string, groupId: string) => void;
  getGroupMembers: (screenId: string, groupId: string) => string[]; // returns widget IDs
}

// --- Template Slice ---

export interface TemplateSlice {
  widgetTemplates: WidgetTemplate[];
  saveAsTemplate: (name: string, category: string, widget: ScreenWidget) => string;
  deleteTemplate: (id: string) => void;
  applyTemplate: (screenId: string, templateId: string, position: { col: number; row: number }) => void;
  getTemplatesByCategory: () => Record<string, WidgetTemplate[]>;
}

// --- Simulation Slice ---

export interface SimulationSlice {
  simulationMode: boolean;
  simTagValues: Record<string, any>;
  simAlarms: Array<{ ruleId: string; severity: string; message: string; firedAt: string }>;

  setSimulationMode: (on: boolean) => void;
  setSimTagValue: (tagName: string, value: any) => void;
  setSimTagValuesBatch: (values: Record<string, any>) => void;
  clearSimTagValues: () => void;
  setSimAlarms: (alarms: SimulationSlice['simAlarms']) => void;
}

// --- View Manager Slice ---

export interface ViewManagerSlice {
  overlays: OverlayEntry[];
  openOverlay: (entry: Omit<OverlayEntry, 'id'>) => string;
  closeOverlay: (id: string) => void;
  closeAllOverlays: () => void;
}

// --- Project Slice ---

export interface ProjectSlice {
  packageId: string | null;
  packageName: string;
  processId: string | null;
  targetDeviceId: string | null;
  automationBindings: AutomationBinding[];
  isDirty: boolean;
  rightPanelTab: 'widget' | 'alarms' | 'controls' | 'trends' | 'automation';

  setPackageId: (id: string | null) => void;
  setPackageName: (name: string) => void;
  setProcessId: (id: string | null) => void;
  setTargetDeviceId: (id: string | null) => void;
  setRightPanelTab: (tab: ProjectSlice['rightPanelTab']) => void;

  addAutomationProgram: (
    programId: string,
    programName: string,
    programCode: string,
    variables: Array<{
      id: string;
      varName: string;
      scope: string;
      dataType: string;
      ioTagName?: string;
    }>,
  ) => void;
  removeAutomationProgram: (programId: string) => void;
  bindVariableToWidget: (programId: string, variableId: string, widgetId: string, tag: string) => void;
  bindVariableToWidgetAndSetTag: (programId: string, variableId: string, widgetId: string, tag: string) => void;
  unbindVariable: (programId: string, variableId: string) => void;
  autoBindByTag: () => { matched: number; unmatched: number };

  toScadaPackageJSON: () => ScadaPackageJSON;
  loadFromJSON: (json: ScadaPackageJSON) => void;
  importProcessAsWidget: (process: { id: string; name: string; nodes: unknown[]; edges: unknown[] }) => void;
  reset: () => void;
}

/* ------------------------------------------------------------------ */
/*  Combined Store                                                     */
/* ------------------------------------------------------------------ */

export type ScadaStore =
  SceneSlice &
  WidgetSlice &
  EdgeSlice &
  SelectionSlice &
  HistorySlice &
  AlarmSlice &
  GroupSlice &
  TemplateSlice &
  ProjectSlice &
  SimulationSlice &
  ViewManagerSlice;

/* ------------------------------------------------------------------ */
/*  Slice Creator Helper Type                                          */
/*                                                                     */
/*  Each slice file exports:                                           */
/*    export const createXxxSlice: ScadaSliceCreator<XxxSlice> = ...   */
/* ------------------------------------------------------------------ */

export type ScadaSliceCreator<T> = StateCreator<
  ScadaStore,
  [['zustand/immer', never]],
  [],
  T
>;

/* ------------------------------------------------------------------ */
/*  Shared Utilities                                                   */
/* ------------------------------------------------------------------ */

export function generateId(): string {
  return crypto.randomUUID();
}

export function normalizeWidgetType(type: string): string {
  if (type.includes('-')) {
    return type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  }
  return type;
}

export const SCREEN_ICONS: Record<ScreenType, string> = {
  dashboard: 'LayoutDashboard',
  process: 'Workflow',
  alarms: 'AlertTriangle',
  trends: 'TrendingUp',
  calibration: 'Settings2',
  control: 'Gauge',
};

export const DEFAULT_CONTROL_PERMISSIONS: ControlPermissionsDef = {
  securityLevels: { none: [], confirm: [], pin: [] },
  pinHash: null,
  emergencyStop: null,
};

export const DEFAULT_TREND_CONFIG: TrendConfigDef = {
  retentionDays: 30,
  sampleIntervalSec: 60,
  tags: [],
};

export const DEFAULT_LAYOUT = { type: 'grid' as const, cols: 12, rows: 8 };

export const MAX_UNDO_STACK = 50;

/* ------------------------------------------------------------------ */
/*  Deep Clone (works with both plain objects and Immer draft proxies)  */
/* ------------------------------------------------------------------ */

/**
 * Deep clone that safely handles Immer draft proxies.
 * Falls back to unwrapping via immer's `current()` before cloning.
 */
export function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // value is an Immer draft proxy — unwrap first
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { current } = require('immer');
    return structuredClone(current(value)) as T;
  }
}
