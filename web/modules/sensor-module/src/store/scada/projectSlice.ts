import type {
  ScadaSliceCreator,
  ProjectSlice,
  ScadaPackageJSON,
  ScreenJSON,
  AlarmRuleJSON,
  AlarmRuleDef,
  AutomationBinding,
  VariableBinding,
  ScreenWidget,
  ScreenDef,
  ScreenType,
  ScadaEdge,
} from './types';
import {
  generateId,
  normalizeWidgetType,
  SCREEN_ICONS,
  DEFAULT_LAYOUT,
  DEFAULT_CONTROL_PERMISSIONS,
  DEFAULT_TREND_CONFIG,
} from './types';
import type { WidgetPosition } from './types';
import { upcastScadaPackageDoc } from '@platform/sensor-contracts';

export const createProjectSlice: ScadaSliceCreator<ProjectSlice> = (set, get) => ({
  // State
  packageId: null,
  packageName: '',
  processId: null,
  targetDeviceId: null,
  automationBindings: [],
  scripts: [],
  isDirty: false,
  rightPanelTab: 'widget' as const,

  // ----------------------------------------------------------------
  //  Simple Setters
  // ----------------------------------------------------------------

  setPackageId: (id) =>
    set((state) => {
      state.packageId = id;
    }),

  setPackageName: (name) =>
    set((state) => {
      state.packageName = name;
      state.isDirty = true;
    }),

  setProcessId: (id) =>
    set((state) => {
      state.processId = id;
      state.isDirty = true;
    }),

  setTargetDeviceId: (id) =>
    set((state) => {
      state.targetDeviceId = id;
    }),

  setRightPanelTab: (tab) =>
    set((state) => {
      state.rightPanelTab = tab;
    }),

  setScripts: (scripts) =>
    set((state) => {
      state.scripts = scripts;
      state.isDirty = true;
    }),

  // Mimari tutarlılık: isDirty flag'i named action ile temizlenir
  // Middleware (devtools, undo/redo) doğrudan setState'i yakalayamaz
  // Architectural consistency: isDirty cleared via named action so
  // devtools and undo/redo middleware can observe the transition
  markClean: () =>
    set((state) => {
      state.isDirty = false;
    }),

  // ----------------------------------------------------------------
  //  Automation Binding Actions
  // ----------------------------------------------------------------

  addAutomationProgram: (programId, programName, programCode, variables) =>
    set((state) => {
      if (state.automationBindings.some((b) => b.programId === programId)) return;
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
      state.automationBindings.push(binding);
      state.isDirty = true;
    }),

  removeAutomationProgram: (programId) =>
    set((state) => {
      state.automationBindings = state.automationBindings.filter(
        (b) => b.programId !== programId,
      );
      state.isDirty = true;
    }),

  bindVariableToWidget: (programId, variableId, widgetId, tag) =>
    set((state) => {
      const binding = state.automationBindings.find((b) => b.programId === programId);
      if (!binding) return;
      const variable = binding.variableBindings.find((v) => v.variableId === variableId);
      if (!variable) return;
      variable.boundWidgetId = widgetId;
      variable.boundTag = tag;
      state.isDirty = true;
    }),

  bindVariableToWidgetAndSetTag: (programId, variableId, widgetId, tag) =>
    set((state) => {
      // Set widget's config.tagName across ALL screens (and clean up legacy config.tag)
      for (const screen of state.screens) {
        for (const widget of screen.widgets) {
          if (widget.id === widgetId) {
            widget.config.tagName = tag;
            delete widget.config.tag;
          }
        }
      }
      // Create the binding
      const binding = state.automationBindings.find((b) => b.programId === programId);
      if (!binding) return;
      const variable = binding.variableBindings.find((v) => v.variableId === variableId);
      if (!variable) return;
      variable.boundWidgetId = widgetId;
      variable.boundTag = tag;
      state.isDirty = true;
    }),

  unbindVariable: (programId, variableId) =>
    set((state) => {
      const binding = state.automationBindings.find((b) => b.programId === programId);
      if (!binding) return;
      const variable = binding.variableBindings.find((v) => v.variableId === variableId);
      if (!variable) return;
      variable.boundWidgetId = null;
      variable.boundTag = null;
      state.isDirty = true;
    }),

  autoBindByTag: () => {
    const state = get();
    const allWidgets = state.screens.flatMap((s) => s.widgets);

    // Primary lookup: by config.tagName (with fallback to legacy config.tag)
    const tagToWidget = new Map<string, { id: string; tag: string }>();
    // Fallback lookup: by config.label
    const labelToWidget = new Map<string, { id: string; label: string }>();

    for (const w of allWidgets) {
      const tag = (w.config.tagName || w.config.tag) as string | undefined;
      if (tag) tagToWidget.set(tag.toLowerCase(), { id: w.id, tag });
      const label = w.config.label as string | undefined;
      if (label) labelToWidget.set(label.toLowerCase(), { id: w.id, label });
    }

    let matched = 0;
    let unmatched = 0;

    const updatedBindings = state.automationBindings.map((b) => ({
      ...b,
      variableBindings: b.variableBindings.map((v) => {
        if (v.boundWidgetId) {
          matched++;
          return v;
        }
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

    set((state) => {
      state.automationBindings = updatedBindings as typeof state.automationBindings;
      state.isDirty = true;
    });

    return { matched, unmatched };
  },

  // ----------------------------------------------------------------
  //  Serialization — Export
  // ----------------------------------------------------------------

  toScadaPackageJSON: () => {
    const state = get();
    return {
      meta: {
        // Versioned document contract (ScadaPackageDocV2 in
        // @platform/sensor-contracts); loadFromJSON upcasts older docs.
        schemaVersion: 2,
        version: 1,
        packageName: state.packageName,
        processId: state.processId,
        edgeDeviceId: state.targetDeviceId,
        ...(state.automationBindings.length > 0
          ? { automationBindings: state.automationBindings }
          : {}),
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
          ...(w.name != null ? { name: w.name } : {}),
          ...(w.groupId != null ? { groupId: w.groupId } : {}),
          ...(w.locked ? { locked: w.locked } : {}),
          ...(w.visible != null ? { visible: w.visible } : {}),
          ...(w.zIndex != null && w.zIndex !== 0 ? { zIndex: w.zIndex } : {}),
          ...(w.permissions != null ? { permissions: w.permissions } : {}),
          ...(w.animations && w.animations.length > 0 ? { animations: w.animations } : {}),
          ...(w.events && w.events.length > 0 ? { events: w.events } : {}),
        })),
        ...(s.edges.length > 0 ? { edges: s.edges } : {}),
        ...(s.parentId != null ? { parentId: s.parentId } : {}),
        ...(s.sortOrder != null && s.sortOrder !== 0 ? { sortOrder: s.sortOrder } : {}),
        ...(s.backgroundImage != null ? { backgroundImage: s.backgroundImage } : {}),
        ...(s.backgroundOpacity != null ? { backgroundOpacity: s.backgroundOpacity } : {}),
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
      // Only include scripts in JSON when there are scripts to save
      ...(state.scripts.length > 0 ? { scripts: state.scripts } : {}),
    };
  },

  // ----------------------------------------------------------------
  //  Serialization — Import
  // ----------------------------------------------------------------

  loadFromJSON: (rawJson) => {
    // Upcast every incoming document to the current V2 contract (legacy
    // tagName/tag/tagId widget bindings gain a canonical config.tagRef;
    // full refs adopt without device context, device-local names promote
    // once the backend supplies deviceCode in later phases).
    const json = upcastScadaPackageDoc(rawJson) as ScadaPackageJSON;
    const screens: ScreenDef[] = (json.screens || []).map((s: ScreenJSON) => ({
      id: s.id || generateId(),
      name: s.name || 'Unnamed',
      screenType: (s.screenType as ScreenType) || 'dashboard',
      isDefault: !!s.isDefault,
      icon: s.icon || SCREEN_ICONS[(s.screenType as ScreenType)] || 'LayoutDashboard',
      layout: s.layout || { ...DEFAULT_LAYOUT },
      widgets: (s.widgets || []).map((w) => ({
        id: w.id || generateId(),
        widgetType: normalizeWidgetType(w.widgetType || 'unknown'),
        position: (w.position as WidgetPosition) || { col: 0, row: 0, w: 2, h: 2 },
        config: (w.config || {}) as Record<string, unknown>,
        ...(w.name != null ? { name: w.name } : {}),
        groupId: w.groupId ?? null,
        locked: w.locked ?? false,
        ...(w.visible != null ? { visible: w.visible } : {}),
        ...(w.zIndex != null ? { zIndex: w.zIndex } : {}),
        ...(w.permissions != null ? { permissions: w.permissions } : {}),
        animations: w.animations,
        events: w.events,
      })),
      edges: (s.edges || [])
        .filter(
          (e): e is ScadaEdge =>
            !!e &&
            typeof e.id === 'string' &&
            typeof e.source === 'string' &&
            typeof e.target === 'string' &&
            typeof e.type === 'string' &&
            !!e.data &&
            typeof e.data.connectionType === 'string',
        )
        .map((e) => ({
          ...e,
          type: (['orthogonal', 'multiHandle', 'draggable'].includes(e.type)
            ? e.type
            : 'orthogonal') as ScadaEdge['type'],
          data: { ...e.data },
        })),
      parentId: s.parentId ?? null,
      sortOrder: s.sortOrder ?? 0,
      ...(s.backgroundImage != null ? { backgroundImage: s.backgroundImage } : {}),
      ...(s.backgroundOpacity != null ? { backgroundOpacity: s.backgroundOpacity } : {}),
    }));

    const alarmRules: AlarmRuleDef[] = (json.alarmRules || []).map((r: AlarmRuleJSON) => ({
      id: r.id || generateId(),
      tag: r.tag || '',
      condition: r.condition || '>',
      value: r.value ?? 0,
      severity: (r.severity as AlarmRuleDef['severity']) || 'warning',
      message: r.message || '',
      deadband: r.deadband,
      delay: r.delay,
    }));

    set((state) => {
      state.packageName = json.meta?.packageName || '';
      state.processId = json.meta?.processId || null;
      state.targetDeviceId = json.meta?.edgeDeviceId || null;
      state.screens = screens;
      state.activeScreenId =
        screens.find((s) => s.isDefault)?.id || screens[0]?.id || '';
      state.alarmRules = alarmRules;
      state.automationBindings = json.meta?.automationBindings || [];
      state.scripts = json.scripts || [];
      state.controlPermissions = json.controlPermissions || {
        ...DEFAULT_CONTROL_PERMISSIONS,
        securityLevels: { ...DEFAULT_CONTROL_PERMISSIONS.securityLevels },
      };
      state.trendConfig = {
        ...DEFAULT_TREND_CONFIG,
        ...json.trendConfig,
        tags: Array.isArray(json.trendConfig?.tags)
          ? [...json.trendConfig.tags]
          : [...DEFAULT_TREND_CONFIG.tags],
      };
      state.isDirty = false;
      state.selectedWidgetId = null;
      state.selectedWidgetIds = [];
      state.selectedEdgeId = null;
    });
  },

  // ----------------------------------------------------------------
  //  Import Process as Widget
  // ----------------------------------------------------------------

  importProcessAsWidget: (process) => {
    const screenId = generateId();
    const widgetId = generateId();

    const screen: ScreenDef = {
      id: screenId,
      name: process.name || 'Process',
      screenType: 'process',
      isDefault: get().screens.length === 0,
      icon: SCREEN_ICONS.process,
      layout: { ...DEFAULT_LAYOUT },
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

    set((state) => {
      const isFirst = state.screens.length === 0;
      state.processId = process.id;
      state.screens.push(screen);
      if (isFirst) {
        state.activeScreenId = screenId;
      }
      state.isDirty = true;
    });
  },

  // ----------------------------------------------------------------
  //  Reset
  // ----------------------------------------------------------------

  reset: () =>
    set((state) => {
      state.packageId = null;
      state.packageName = '';
      state.processId = null;
      state.targetDeviceId = null;
      state.screens = [];
      state.activeScreenId = '';
      state.alarmRules = [];
      state.automationBindings = [];
      state.scripts = [];
      state.controlPermissions = {
        ...DEFAULT_CONTROL_PERMISSIONS,
        securityLevels: { ...DEFAULT_CONTROL_PERMISSIONS.securityLevels },
      };
      state.trendConfig = {
        ...DEFAULT_TREND_CONFIG,
        tags: [...DEFAULT_TREND_CONFIG.tags],
      };
      state.screenViewports = {};
      state.screenHistory = [];
      state.isDirty = false;
      state.selectedWidgetId = null;
      state.selectedWidgetIds = [];
      state.selectedEdgeId = null;
      state.rightPanelTab = 'widget';
      state.undoStack = [];
      state.redoStack = [];
      state.checkpoints = [];
      state.lastHistoryTimestamp = 0;
      state.clipboard = null;
    }),
});
