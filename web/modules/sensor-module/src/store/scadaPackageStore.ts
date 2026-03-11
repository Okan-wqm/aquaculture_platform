import { create } from 'zustand';
import type { WidgetPosition, ScreenWidget, AutomationBinding, VariableBinding } from '../types/scada-package.types';
import type { ScadaEdge, ScadaEdgeData } from '../types/scada-edge.types';
export type { WidgetPosition, ScreenWidget } from '../types/scada-package.types';
export type { ScadaWidgetType } from '../types/scada-widget.types';
export type { AutomationBinding, VariableBinding } from '../types/scada-package.types';
export type { ScadaEdge, ScadaEdgeData } from '../types/scada-edge.types';

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
  edges: ScadaEdge[];
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

/* ------------------------------------------------------------------ */
/*  JSON schema for import/export                                      */
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
  }>;
  edges?: ScadaEdge[];
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

  // Automation Bindings
  automationBindings: AutomationBinding[];

  // Viewport state per screen
  screenViewports: Record<string, ScreenViewport>;
  screenHistory: string[];

  // UI State
  isDirty: boolean;
  selectedWidgetId: string | null;
  selectedEdgeId: string | null;
  rightPanelTab: 'widget' | 'alarms' | 'controls' | 'trends' | 'automation';

  // Screen actions
  addScreen: (type: ScreenType, name: string) => void;
  removeScreen: (id: string) => void;
  duplicateScreen: (id: string) => void;
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

  // Edge actions
  addEdge: (screenId: string, edge: ScadaEdge) => void;
  removeEdge: (screenId: string, edgeId: string) => void;
  updateEdgeData: (screenId: string, edgeId: string, data: Partial<ScadaEdgeData>) => void;
  updateEdgeType: (screenId: string, edgeId: string, newType: ScadaEdge['type']) => void;
  setSelectedEdge: (id: string | null) => void;

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

  // Automation Binding actions
  addAutomationProgram: (programId: string, programName: string, programCode: string, variables: { id: string; varName: string; scope: string; dataType: string; ioTagName?: string }[]) => void;
  removeAutomationProgram: (programId: string) => void;
  bindVariableToWidget: (programId: string, variableId: string, widgetId: string, tag: string) => void;
  bindVariableToWidgetAndSetTag: (programId: string, variableId: string, widgetId: string, tag: string) => void;
  unbindVariable: (programId: string, variableId: string) => void;
  autoBindByTag: () => { matched: number; unmatched: number };

  // Export/Import
  toScadaPackageJSON: () => ScadaPackageJSON;
  loadFromJSON: (json: ScadaPackageJSON) => void;
  importProcessAsWidget: (process: { id: string; name: string; nodes: unknown[]; edges: unknown[] }) => void;

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
  automationBindings: [] as AutomationBinding[],
  controlPermissions: { ...defaultControlPermissions },
  trendConfig: { ...defaultTrendConfig },
  screenViewports: {} as Record<string, ScreenViewport>,
  screenHistory: [] as string[],
  isDirty: false,
  selectedWidgetId: null as string | null,
  selectedEdgeId: null as string | null,
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
      edges: [],
    };
    set((state) => ({
      screens: [...state.screens, screen],
      activeScreenId: id,
      selectedWidgetId: null,
      isDirty: true,
    }));
  },

  removeScreen: (id) =>
    set((state) => {
      // Protect last screen
      if (state.screens.length <= 1) return state;
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
      return { screens: updated, activeScreenId: newActiveId, selectedWidgetId: null, selectedEdgeId: null, isDirty: true };
    }),

  duplicateScreen: (id) =>
    set((state) => {
      const source = state.screens.find((s) => s.id === id);
      if (!source) return state;
      const newId = generateId();
      // Build widget ID mapping for edge remapping
      const widgetIdMap = new Map<string, string>();
      const newWidgets = source.widgets.map((w) => {
        const nid = generateId();
        widgetIdMap.set(w.id, nid);
        return { ...w, id: nid, position: { ...w.position }, config: { ...w.config } };
      });
      const newEdges = source.edges.map((e) => {
        const dataCopy: ScadaEdgeData = { ...e.data };
        // Deep clone nested geometry arrays/objects
        if (dataCopy.bendPoints) dataCopy.bendPoints = dataCopy.bendPoints.map((p) => ({ ...p }));
        if (dataCopy.points) dataCopy.points = dataCopy.points.map((p) => ({ ...p }));
        if (dataCopy.controlPoint) dataCopy.controlPoint = { ...dataCopy.controlPoint };
        if (dataCopy.controlPoint2) dataCopy.controlPoint2 = { ...dataCopy.controlPoint2 };
        return {
          ...e,
          id: generateId(),
          source: widgetIdMap.get(e.source) || e.source,
          target: widgetIdMap.get(e.target) || e.target,
          data: dataCopy,
        };
      });
      const newScreen: ScreenDef = {
        ...source,
        id: newId,
        name: `${source.name} (Copy)`,
        isDefault: false,
        widgets: newWidgets,
        edges: newEdges,
      };
      return {
        screens: [...state.screens, newScreen],
        activeScreenId: newId,
        selectedWidgetId: null,
        selectedEdgeId: null,
        isDirty: true,
      };
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
        selectedWidgetId: null,
        selectedEdgeId: null,
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
          ? {
              ...s,
              widgets: s.widgets.filter((w) => w.id !== widgetId),
              edges: s.edges.filter((e) => e.source !== widgetId && e.target !== widgetId),
            }
          : s,
      ),
      // Clean up automation bindings that reference the removed widget
      automationBindings: state.automationBindings.map((b) => ({
        ...b,
        variableBindings: b.variableBindings.map((v) =>
          v.boundWidgetId === widgetId ? { ...v, boundWidgetId: null, boundTag: null } : v,
        ),
      })),
      selectedWidgetId: state.selectedWidgetId === widgetId ? null : state.selectedWidgetId,
      selectedEdgeId: state.screens.find((s) => s.id === screenId)
        ?.edges.some((e) => (e.source === widgetId || e.target === widgetId) && e.id === state.selectedEdgeId)
        ? null : state.selectedEdgeId,
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

  // Edge actions
  addEdge: (screenId, edge) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId ? { ...s, edges: [...s.edges, edge] } : s,
      ),
      isDirty: true,
    })),

  removeEdge: (screenId, edgeId) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId ? { ...s, edges: s.edges.filter((e) => e.id !== edgeId) } : s,
      ),
      selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
      isDirty: true,
    })),

  updateEdgeData: (screenId, edgeId, data) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId
          ? {
              ...s,
              edges: s.edges.map((e) =>
                e.id === edgeId ? { ...e, data: { ...e.data, ...data } } : e,
              ),
            }
          : s,
      ),
      isDirty: true,
    })),

  updateEdgeType: (screenId, edgeId, newType) =>
    set((state) => ({
      screens: state.screens.map((s) =>
        s.id === screenId
          ? {
              ...s,
              edges: s.edges.map((e) =>
                e.id === edgeId
                  ? {
                      ...e,
                      type: newType,
                      // Clear type-specific geometry data to avoid stale control/bend points
                      data: {
                        connectionType: e.data.connectionType,
                        label: e.data.label,
                        animated: e.data.animated,
                      },
                    }
                  : e,
              ),
            }
          : s,
      ),
      isDirty: true,
    })),

  setSelectedEdge: (id) => set((state) => ({
    selectedEdgeId: id,
    ...(id ? { selectedWidgetId: null } : {}),
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

  setSelectedWidget: (id) => set((state) => ({
    selectedWidgetId: id,
    ...(id ? { selectedEdgeId: null } : {}),
  })),

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  setPackageName: (name) => set({ packageName: name, isDirty: true }),

  setPackageId: (id) => set({ packageId: id }),

  setProcessId: (id) => set({ processId: id, isDirty: true }),

  setTargetDeviceId: (id) => set({ targetDeviceId: id }),

  // Automation Binding actions
  addAutomationProgram: (programId, programName, programCode, variables) =>
    set((state) => {
      if (state.automationBindings.some((b) => b.programId === programId)) return state;
      const binding: AutomationBinding = {
        programId,
        programName,
        programCode,
        variableBindings: variables
          .filter((v) => v.scope === 'INPUT' || v.scope === 'OUTPUT' || v.scope === 'INOUT')
          .map((v) => ({
            variableId: v.id,
            varName: v.varName,
            scope: v.scope as VariableBinding['scope'],
            dataType: v.dataType,
            boundWidgetId: null,
            boundTag: null,
            ioTagName: v.ioTagName,
          })),
      };
      return { automationBindings: [...state.automationBindings, binding], isDirty: true };
    }),

  removeAutomationProgram: (programId) =>
    set((state) => ({
      automationBindings: state.automationBindings.filter((b) => b.programId !== programId),
      isDirty: true,
    })),

  bindVariableToWidget: (programId, variableId, widgetId, tag) =>
    set((state) => ({
      automationBindings: state.automationBindings.map((b) =>
        b.programId === programId
          ? {
              ...b,
              variableBindings: b.variableBindings.map((v) =>
                v.variableId === variableId ? { ...v, boundWidgetId: widgetId, boundTag: tag } : v,
              ),
            }
          : b,
      ),
      isDirty: true,
    })),

  bindVariableToWidgetAndSetTag: (programId, variableId, widgetId, tag) =>
    set((state) => ({
      // Set widget's config.tag to the provided tag
      screens: state.screens.map((s) => ({
        ...s,
        widgets: s.widgets.map((w) =>
          w.id === widgetId ? { ...w, config: { ...w.config, tag } } : w,
        ),
      })),
      // Create the binding
      automationBindings: state.automationBindings.map((b) =>
        b.programId === programId
          ? {
              ...b,
              variableBindings: b.variableBindings.map((v) =>
                v.variableId === variableId ? { ...v, boundWidgetId: widgetId, boundTag: tag } : v,
              ),
            }
          : b,
      ),
      isDirty: true,
    })),

  unbindVariable: (programId, variableId) =>
    set((state) => ({
      automationBindings: state.automationBindings.map((b) =>
        b.programId === programId
          ? {
              ...b,
              variableBindings: b.variableBindings.map((v) =>
                v.variableId === variableId ? { ...v, boundWidgetId: null, boundTag: null } : v,
              ),
            }
          : b,
      ),
      isDirty: true,
    })),

  autoBindByTag: () => {
    const state = get();
    const allWidgets = state.screens.flatMap((s) => s.widgets);
    // Primary lookup: by config.tag
    const tagToWidget = new Map<string, { id: string; tag: string }>();
    // Fallback lookup: by config.label
    const labelToWidget = new Map<string, { id: string; label: string }>();
    for (const w of allWidgets) {
      const tag = w.config.tag as string | undefined;
      if (tag) tagToWidget.set(tag.toLowerCase(), { id: w.id, tag });
      const label = w.config.label as string | undefined;
      if (label) labelToWidget.set(label.toLowerCase(), { id: w.id, label });
    }

    let matched = 0;
    let unmatched = 0;
    const updatedBindings = state.automationBindings.map((b) => ({
      ...b,
      variableBindings: b.variableBindings.map((v) => {
        if (v.boundWidgetId) { matched++; return v; }
        const tagName = v.ioTagName || v.varName;
        const tagKey = tagName.toLowerCase();
        // Try matching by tag first
        const widgetByTag = tagToWidget.get(tagKey);
        if (widgetByTag) {
          matched++;
          return { ...v, boundWidgetId: widgetByTag.id, boundTag: widgetByTag.tag };
        }
        // Fallback: match by label
        const widgetByLabel = labelToWidget.get(tagKey);
        if (widgetByLabel) {
          matched++;
          return { ...v, boundWidgetId: widgetByLabel.id, boundTag: tagName };
        }
        unmatched++;
        return v;
      }),
    }));

    set({ automationBindings: updatedBindings, isDirty: true });
    return { matched, unmatched };
  },

  // Export to edge-compatible JSON
  toScadaPackageJSON: () => {
    const state = get();
    return {
      meta: {
        version: 1,
        packageName: state.packageName,
        processId: state.processId,
        edgeDeviceId: state.targetDeviceId,
        ...(state.automationBindings.length > 0 ? { automationBindings: state.automationBindings } : {}),
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
        ...(s.edges.length > 0 ? { edges: s.edges } : {}),
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
    const screens: ScreenDef[] = (json.screens || []).map((s: ScreenJSON) => ({
      id: s.id || generateId(),
      name: s.name || 'Unnamed',
      screenType: (s.screenType as ScreenType) || 'dashboard',
      isDefault: !!s.isDefault,
      icon: s.icon || SCREEN_ICONS[s.screenType as ScreenType] || 'LayoutDashboard',
      layout: s.layout || { type: 'grid', cols: 12, rows: 8 },
      widgets: (s.widgets || []).map((w) => ({
        id: w.id || generateId(),
        widgetType: normalizeWidgetType(w.widgetType || 'unknown'),
        position: (w.position as WidgetPosition) || { col: 0, row: 0, w: 2, h: 2 },
        config: (w.config || {}) as Record<string, unknown>,
      })),
      edges: (s.edges || [])
        .filter((e): e is ScadaEdge =>
          !!e && typeof e.id === 'string' && typeof e.source === 'string' && typeof e.target === 'string'
          && typeof e.type === 'string' && !!e.data && typeof e.data.connectionType === 'string'
        )
        .map((e) => ({
          ...e,
          type: (['orthogonal', 'multiHandle', 'draggable'].includes(e.type) ? e.type : 'orthogonal') as ScadaEdge['type'],
          data: { ...e.data },
        })),
    }));

    set({
      packageName: json.meta?.packageName || '',
      processId: json.meta?.processId || null,
      targetDeviceId: json.meta?.edgeDeviceId || null,
      screens,
      activeScreenId: screens.find((s) => s.isDefault)?.id || screens[0]?.id || '',
      alarmRules: (json.alarmRules || []).map((r: AlarmRuleJSON) => ({
        id: r.id || generateId(),
        tag: r.tag || '',
        condition: r.condition || '>',
        value: r.value ?? 0,
        severity: (r.severity as AlarmRuleDef['severity']) || 'warning',
        message: r.message || '',
        deadband: r.deadband,
        delay: r.delay,
      })),
      automationBindings: json.meta?.automationBindings || [],
      controlPermissions: json.controlPermissions || { ...defaultControlPermissions },
      trendConfig: json.trendConfig || { ...defaultTrendConfig },
      isDirty: false,
      selectedWidgetId: null,
      selectedEdgeId: null,
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
      edges: [],
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
