import { create } from 'zustand';
import type { WidgetPosition, ScreenWidget } from '../types/scada-package.types';
export type { WidgetPosition, ScreenWidget } from '../types/scada-package.types';

// Screen type
export type ScreenType = 'dashboard' | 'process' | 'alarms' | 'trends' | 'calibration' | 'control';

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
  emergencyStop: { holdDuration: number; affectedTags: string[]; resetRequiresPin: boolean } | null;
}

export interface TrendConfigDef {
  retentionDays: number;
  sampleIntervalSec: number;
  tags: string[];
}

interface ScadaPackageState {
  // Package meta
  packageId: string | null;
  packageName: string;
  processId: string | null;
  targetDeviceId: string | null;

  // Screens
  screens: ScreenDef[];
  activeScreenId: string;

  // Alarm Rules
  alarmRules: AlarmRuleDef[];

  // Control Permissions
  controlPermissions: ControlPermissionsDef;

  // Trend Config
  trendConfig: TrendConfigDef;

  // Viewport state per screen
  screenViewports: Record<string, ScreenViewport>;
  screenHistory: string[];

  // UI State
  isDirty: boolean;
  selectedWidgetId: string | null;
  rightPanelTab: 'widget' | 'alarms' | 'controls' | 'trends';

  // Screen actions
  addScreen: (type: ScreenType, name: string) => void;
  removeScreen: (id: string) => void;
  updateScreen: (id: string, updates: Partial<ScreenDef>) => void;
  setActiveScreen: (id: string) => void;
  setDefaultScreen: (id: string) => void;
  saveScreenViewport: (screenId: string, viewport: ScreenViewport) => void;
  getScreenViewport: (screenId: string) => ScreenViewport;

  // Widget actions
  addWidget: (screenId: string, widget: ScreenWidget) => void;
  removeWidget: (screenId: string, widgetId: string) => void;
  updateWidget: (screenId: string, widgetId: string, updates: Partial<ScreenWidget>) => void;
  updateWidgetPosition: (screenId: string, widgetId: string, position: WidgetPosition) => void;

  // Alarm actions
  addAlarmRule: (rule: AlarmRuleDef) => void;
  removeAlarmRule: (id: string) => void;
  updateAlarmRule: (id: string, updates: Partial<AlarmRuleDef>) => void;

  // Other actions
  updateControlPermissions: (perms: ControlPermissionsDef) => void;
  updateTrendConfig: (config: TrendConfigDef) => void;
  setSelectedWidget: (id: string | null) => void;
  setRightPanelTab: (tab: ScadaPackageState['rightPanelTab']) => void;
  setPackageName: (name: string) => void;
  setPackageId: (id: string | null) => void;
  setProcessId: (id: string | null) => void;
  setTargetDeviceId: (id: string | null) => void;

  // Export/Import
  toScadaPackageJSON: () => any;
  loadFromJSON: (json: any) => void;
  importProcessAsWidget: (process: { id: string; name: string; nodes: any[]; edges: any[] }) => void;

  // Reset
  reset: () => void;
}

const SCREEN_ICONS: Record<ScreenType, string> = {
  dashboard: 'LayoutDashboard',
  process: 'Workflow',
  alarms: 'AlertTriangle',
  trends: 'TrendingUp',
  calibration: 'Settings2',
  control: 'Gauge',
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Normalize widget type to camelCase (handles legacy kebab-case values). */
function normalizeWidgetType(type: string): string {
  if (type.includes('-')) {
    return type.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  return type;
}

const defaultControlPermissions: ControlPermissionsDef = {
  securityLevels: { none: [], confirm: [], pin: [] },
  pinHash: null,
  emergencyStop: null,
};

const defaultTrendConfig: TrendConfigDef = {
  retentionDays: 30,
  sampleIntervalSec: 60,
  tags: [],
};

const initialState = {
  packageId: null as string | null,
  packageName: '',
  processId: null as string | null,
  targetDeviceId: null as string | null,
  screens: [] as ScreenDef[],
  activeScreenId: '',
  alarmRules: [] as AlarmRuleDef[],
  controlPermissions: { ...defaultControlPermissions },
  trendConfig: { ...defaultTrendConfig },
  screenViewports: {} as Record<string, ScreenViewport>,
  screenHistory: [] as string[],
  isDirty: false,
  selectedWidgetId: null as string | null,
  rightPanelTab: 'widget' as const,
};

export const useScadaPackageStore = create<ScadaPackageState>((set, get) => ({
  ...initialState,

  // Screen actions
  addScreen: (type, name) => {
    const id = generateId();
    const isFirst = get().screens.length === 0;
    const screen: ScreenDef = {
      id,
      name,
      screenType: type,
      isDefault: isFirst,
      icon: SCREEN_ICONS[type] || 'LayoutDashboard',
      layout: { type: 'grid', cols: 12, rows: 8 },
      widgets: [],
    };
    set((state) => ({
      screens: [...state.screens, screen],
      activeScreenId: isFirst ? id : state.activeScreenId,
      isDirty: true,
    }));
  },

  removeScreen: (id) =>
    set((state) => {
      const remaining = state.screens.filter((s) => s.id !== id);
      // If the removed screen was active, switch to first remaining
      const newActiveId = state.activeScreenId === id
        ? (remaining[0]?.id || '')
        : state.activeScreenId;
      // If the removed screen was default, make first remaining default
      const wasDefault = state.screens.find((s) => s.id === id)?.isDefault;
      const updated = wasDefault && remaining.length > 0
        ? remaining.map((s, i) => i === 0 ? { ...s, isDefault: true } : s)
        : remaining;
      return { screens: updated, activeScreenId: newActiveId, isDirty: true };
    }),

  updateScreen: (id, updates) =>
    set((state) => ({
      screens: state.screens.map((s) => s.id === id ? { ...s, ...updates } : s),
      isDirty: true,
    })),

  setActiveScreen: (id) =>
    set((state) => {
      const history = state.activeScreenId
        ? [...state.screenHistory.filter((h) => h !== state.activeScreenId), state.activeScreenId]
        : state.screenHistory;
      return {
        activeScreenId: id,
        screenHistory: history.slice(-20), // keep last 20
      };
    }),

  saveScreenViewport: (screenId, viewport) =>
    set((state) => ({
      screenViewports: { ...state.screenViewports, [screenId]: viewport },
    })),

  getScreenViewport: (screenId) => {
    const vp = get().screenViewports[screenId];
    return vp || { x: 0, y: 0, zoom: 1 };
  },

  setDefaultScreen: (id) =>
    set((state) => ({
      screens: state.screens.map((s) => ({ ...s, isDefault: s.id === id })),
      isDirty: true,
    })),

  // Widget actions
  addWidget: (screenId, widget) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId ? { ...s, widgets: [...s.widgets, widget] } : s,
      ),
      isDirty: true,
    })),

  removeWidget: (screenId, widgetId) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId
          ? { ...s, widgets: s.widgets.filter((w) => w.id !== widgetId) }
          : s,
      ),
      selectedWidgetId: state.selectedWidgetId === widgetId ? null : state.selectedWidgetId,
      isDirty: true,
    })),

  updateWidget: (screenId, widgetId, updates) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId
          ? {
              ...s,
              widgets: s.widgets.map((w) =>
                w.id === widgetId ? { ...w, ...updates } : w,
              ),
            }
          : s,
      ),
      isDirty: true,
    })),

  updateWidgetPosition: (screenId, widgetId, position) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId
          ? {
              ...s,
              widgets: s.widgets.map((w) =>
                w.id === widgetId ? { ...w, position } : w,
              ),
            }
          : s,
      ),
      isDirty: true,
    })),

  // Alarm actions
  addAlarmRule: (rule) =>
    set((state) => ({
      alarmRules: [...state.alarmRules, rule],
      isDirty: true,
    })),

  removeAlarmRule: (id) =>
    set((state) => ({
      alarmRules: state.alarmRules.filter((r) => r.id !== id),
      isDirty: true,
    })),

  updateAlarmRule: (id, updates) =>
    set((state) => ({
      alarmRules: state.alarmRules.map((r) => r.id === id ? { ...r, ...updates } : r),
      isDirty: true,
    })),

  // Other actions
  updateControlPermissions: (perms) =>
    set({ controlPermissions: perms, isDirty: true }),

  updateTrendConfig: (config) =>
    set({ trendConfig: config, isDirty: true }),

  setSelectedWidget: (id) => set({ selectedWidgetId: id }),

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  setPackageName: (name) => set({ packageName: name, isDirty: true }),

  setPackageId: (id) => set({ packageId: id }),

  setProcessId: (id) => set({ processId: id, isDirty: true }),

  setTargetDeviceId: (id) => set({ targetDeviceId: id }),

  // Export to edge-compatible JSON
  toScadaPackageJSON: () => {
    const state = get();
    return {
      meta: {
        version: 1,
        packageName: state.packageName,
        processId: state.processId,
        edgeDeviceId: state.targetDeviceId,
      },
      screens: state.screens.map((s) => ({
        id: s.id,
        name: s.name,
        screenType: s.screenType,
        isDefault: s.isDefault,
        icon: s.icon,
        layout: s.layout,
        widgets: s.widgets.map((w) => ({
          id: w.id,
          widgetType: w.widgetType,
          position: w.position,
          config: w.config,
        })),
      })),
      alarmRules: state.alarmRules.map((r) => ({
        id: r.id,
        tag: r.tag,
        condition: r.condition,
        value: r.value,
        severity: r.severity,
        message: r.message,
        ...(r.deadband != null ? { deadband: r.deadband } : {}),
        ...(r.delay != null ? { delay: r.delay } : {}),
      })),
      controlPermissions: state.controlPermissions,
      trendConfig: state.trendConfig,
    };
  },

  // Load from saved JSON
  loadFromJSON: (json) => {
    const screens: ScreenDef[] = (json.screens || []).map((s: any) => ({
      id: s.id || generateId(),
      name: s.name || 'Unnamed',
      screenType: s.screenType || 'dashboard',
      isDefault: !!s.isDefault,
      icon: s.icon || SCREEN_ICONS[s.screenType as ScreenType] || 'LayoutDashboard',
      layout: s.layout || { type: 'grid', cols: 12, rows: 8 },
      widgets: (s.widgets || []).map((w: any) => ({
        id: w.id || generateId(),
        widgetType: normalizeWidgetType(w.widgetType || 'unknown'),
        position: w.position || { col: 0, row: 0, w: 2, h: 2 },
        config: w.config || {},
      })),
    }));

    set({
      packageName: json.meta?.packageName || '',
      processId: json.meta?.processId || null,
      targetDeviceId: json.meta?.edgeDeviceId || null,
      screens,
      activeScreenId: screens.find((s) => s.isDefault)?.id || screens[0]?.id || '',
      alarmRules: (json.alarmRules || []).map((r: any) => ({
        id: r.id || generateId(),
        tag: r.tag || '',
        condition: r.condition || '>',
        value: r.value ?? 0,
        severity: r.severity || 'warning',
        message: r.message || '',
        deadband: r.deadband,
        delay: r.delay,
      })),
      controlPermissions: json.controlPermissions || { ...defaultControlPermissions },
      trendConfig: json.trendConfig || { ...defaultTrendConfig },
      isDirty: false,
      selectedWidgetId: null,
    });
  },

  // Import a process flow diagram as a processView widget
  importProcessAsWidget: (process) => {
    const screenId = generateId();
    const widgetId = generateId();

    const screen: ScreenDef = {
      id: screenId,
      name: process.name || 'Process',
      screenType: 'process',
      isDefault: get().screens.length === 0,
      icon: SCREEN_ICONS.process,
      layout: { type: 'grid', cols: 12, rows: 8 },
      widgets: [
        {
          id: widgetId,
          widgetType: 'processView',
          position: { col: 0, row: 0, w: 12, h: 8 },
          config: {
            processId: process.id,
            processName: process.name,
            nodes: process.nodes,
            edges: process.edges,
          },
        },
      ],
    };

    set((state) => ({
      processId: process.id,
      screens: [...state.screens, screen],
      activeScreenId: state.screens.length === 0 ? screenId : state.activeScreenId,
      isDirty: true,
    }));
  },

  // Reset store to initial state
  reset: () => set({ ...initialState }),
}));
