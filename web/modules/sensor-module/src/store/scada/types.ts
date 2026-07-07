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
 * Runtime slices (operator mode):
 *   operatorSlice        — HMI shell UI state (layout, overlays, role)
 *   alarmRuntimeSlice    — Live alarm instances & history
 *   notificationSlice    — Notification configs (email/webhook)
 *   scriptSlice          — Scripts & console output buffer
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
import type { OperatorSlice } from './operatorSlice';
import type { AlarmRuntimeSlice } from './alarmRuntimeSlice';
import type { NotificationSlice } from './notificationSlice';
import type { ScriptSlice } from './scriptSlice';
import type { ScadaScript } from '../../types/scada-runtime.types';
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
export type { ScadaWidgetType, WidgetPermissions } from '../../types/scada-widget.types';
export type { ScadaEdge, ScadaEdgeData } from '../../types/scada-edge.types';
export type { ScadaScript } from '../../types/scada-runtime.types';

// Runtime slice re-exports
export type { OperatorSlice } from './operatorSlice';
export type { AlarmRuntimeSlice } from './alarmRuntimeSlice';
export type { NotificationSlice } from './notificationSlice';
export type { ScriptSlice, ScriptConsoleEntry } from './scriptSlice';

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
    /** Human-readable widget name for layers panel. */
    name?: string;
    groupId?: string | null;
    locked?: boolean;
    /** When false, widget is hidden on canvas and at runtime. */
    visible?: boolean;
    /** Z-index for layer ordering (sparse integer). */
    zIndex?: number;
    /** Per-widget role-based access control. */
    permissions?: ScreenWidget['permissions'];
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
    /** Document contract version (ScadaPackageDocV2 = 2); absent on legacy V1 docs. */
    schemaVersion?: number;
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
  /** Package-level scripts for client-side automation (Phase 5B). */
  scripts?: ScadaScript[];
}

/* ------------------------------------------------------------------ */
/*  History (Undo / Redo) — Command Pattern                            */
/* ------------------------------------------------------------------ */

export const CHECKPOINT_INTERVAL = 25;

export const MERGE_WINDOW_MS = {
  WIDGET_MOVE: 500,
  WIDGET_UPDATE: 300,
  EDGE_UPDATE: 300,
  SCRIPT_CHANGE: 1000,
} as const;

export interface HistoryCheckpoint {
  id: string;
  label: string;
  timestamp: number;
  stackIndex: number;
  snapshot?: string;
}

export type HistoryEntry =
  // Widget
  | { type: 'WIDGET_ADD'; screenId: string; widget: ScreenWidget; timestamp?: number }
  | { type: 'WIDGET_REMOVE'; screenId: string; widget: ScreenWidget; removedEdges: ScadaEdge[]; timestamp?: number }
  | { type: 'WIDGET_UPDATE'; screenId: string; widgetId: string; before: ScreenWidget; after: ScreenWidget; timestamp?: number }
  | { type: 'WIDGET_MOVE'; screenId: string; widgetId: string; from: WidgetPosition; to: WidgetPosition; timestamp?: number }
  // Edge
  | { type: 'EDGE_ADD'; screenId: string; edge: ScadaEdge; timestamp?: number }
  | { type: 'EDGE_REMOVE'; screenId: string; edge: ScadaEdge; timestamp?: number }
  | { type: 'EDGE_UPDATE'; screenId: string; edgeId: string; before: ScadaEdgeData; after: ScadaEdgeData; timestamp?: number }
  // Screen
  | { type: 'SCREEN_ADD'; screen: ScreenDef; timestamp?: number }
  | { type: 'SCREEN_REMOVE'; screen: ScreenDef; index: number; wasActive: boolean; timestamp?: number }
  | { type: 'SCREEN_UPDATE'; screenId: string; before: Partial<ScreenDef>; after: Partial<ScreenDef>; timestamp?: number }
  // Alarm
  | { type: 'ALARM_ADD'; rule: AlarmRuleDef; timestamp?: number }
  | { type: 'ALARM_REMOVE'; rule: AlarmRuleDef; index: number; timestamp?: number }
  | { type: 'ALARM_UPDATE'; ruleId: string; before: AlarmRuleDef; after: AlarmRuleDef; timestamp?: number }
  // Composite
  | { type: 'BATCH'; entries: HistoryEntry[]; label: string; timestamp?: number };

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
  /**
   * Layer management actions implementing 4-level z-order control.
   * Uses sparse z-index values to avoid O(n) renumbering on every operation.
   *
   * bringToFront: Sets z-index to max(all widgets) + 10
   * sendToBack:   Sets z-index to min(all widgets) - 10
   * bringForward:  Swaps z-index with the next widget above
   * sendBackward:  Swaps z-index with the next widget below
   */
  bringToFront: (screenId: string, widgetId: string) => void;
  sendToBack: (screenId: string, widgetId: string) => void;
  bringForward: (screenId: string, widgetId: string) => void;
  sendBackward: (screenId: string, widgetId: string) => void;
  /** Direct z-index assignment for drag-and-drop reordering in the layers panel. */
  setWidgetZIndex: (screenId: string, widgetId: string, zIndex: number) => void;
  toggleWidgetLock: (screenId: string, widgetId: string) => void;
  /** Toggle layer visibility without deleting the widget. */
  toggleWidgetVisibility: (screenId: string, widgetId: string) => void;
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
  /**
   * Widget ID currently hovered in the Layers panel.
   * Used to show a non-interactive highlight outline on the canvas
   * so users can identify which canvas widget corresponds to a layer row.
   */
  highlightedWidgetId: string | null;

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
  /** Set highlighted widget ID (from Layers panel hover). null clears highlight. */
  setHighlightedWidget: (id: string | null) => void;
}

// --- History Slice ---

export interface HistorySlice {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  checkpoints: HistoryCheckpoint[];
  lastHistoryTimestamp: number;

  undo: () => void;
  redo: () => void;
  pushHistory: (entry: HistoryEntry) => void;
  clearHistory: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  undoDescription: () => string;
  redoDescription: () => string;
  createCheckpoint: (label: string) => void;
  jumpToCheckpoint: (checkpointId: string) => void;
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

/** Simulation tag values can be numeric, boolean, or string sensor readings. */
export type SimTagValue = string | number | boolean | null;

export interface SimulationSlice {
  simulationMode: boolean;
  simTagValues: Record<string, SimTagValue>;
  simAlarms: Array<{ ruleId: string; severity: string; message: string; firedAt: string }>;

  setSimulationMode: (on: boolean) => void;
  setSimTagValue: (tagName: string, value: SimTagValue) => void;
  setSimTagValuesBatch: (values: Record<string, SimTagValue>) => void;
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
  /** Package-level scripts for client-side SCADA automation. */
  scripts: ScadaScript[];
  isDirty: boolean;
  rightPanelTab: 'widget' | 'alarms' | 'controls' | 'trends' | 'automation' | 'events' | 'animations' | 'scripts';

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

  /** Replace the entire scripts array (used by ScriptsPanel onChange). */
  setScripts: (scripts: ScadaScript[]) => void;

  /**
   * Mimari tutarlılık: isDirty'yi named action üzerinden temizler.
   * Middleware (devtools, undo/redo) doğrudan setState'i yakalayamaz.
   *
   * Architectural consistency: clears isDirty via a named action.
   * Middleware (devtools, undo/redo) cannot intercept direct setState calls.
   */
  markClean: () => void;

  toScadaPackageJSON: () => ScadaPackageJSON;
  loadFromJSON: (json: ScadaPackageJSON) => void;
  importProcessAsWidget: (process: { id: string; name: string; nodes: unknown[]; edges: unknown[] }) => void;
  reset: () => void;
}

/* ------------------------------------------------------------------ */
/*  Combined Store                                                     */
/* ------------------------------------------------------------------ */

type ScadaOperatorSlice = Omit<
  OperatorSlice,
  'openOverlay' | 'closeOverlay' | 'closeAllOverlays'
>;

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
  ViewManagerSlice &
  // Runtime slices (operator mode)
  ScadaOperatorSlice &
  AlarmRuntimeSlice &
  NotificationSlice &
  ScriptSlice;

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

export const MAX_UNDO_STACK = 200;

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
