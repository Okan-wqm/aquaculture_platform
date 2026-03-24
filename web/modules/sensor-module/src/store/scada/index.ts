// Store hooks
export { useScadaStore, useScadaPackageStore, createScadaStore } from './createScadaStore';

// All types
export type {
  ScreenType,
  ScreenViewport,
  ScreenDef,
  AlarmRuleDef,
  ControlPermissionsDef,
  TrendConfigDef,
  ScreenJSON,
  AlarmRuleJSON,
  ScadaPackageJSON,
  WidgetPosition,
  ScreenWidget,
  AutomationBinding,
  VariableBinding,
  ScadaWidgetType,
  ScadaEdge,
  ScadaEdgeData,
  // New types
  HistoryEntry,
  ClipboardData,
  GroupSlice,
  WidgetTemplate,
  TemplateSlice,
  SimulationSlice,
  ViewManagerSlice,
  ScadaStore,
} from './types';

// Utilities
export { generateId, normalizeWidgetType, deepClone, SCREEN_ICONS } from './types';

// Scene hierarchy utilities
export { buildScreenTree, getAncestors, getScreenPath, getChildren, getRootScreens, flattenTree, wouldCreateCycle } from './sceneUtils';
export type { ScreenTreeNode } from './sceneUtils';

// Alignment utilities
export { alignLeft, alignRight, alignTop, alignBottom, alignCenterH, alignCenterV, distributeH, distributeV, matchWidth, matchHeight } from './alignmentUtils';

// Template slice
export { createTemplateSlice } from './templateSlice';

// View manager slice
export { createViewManagerSlice } from './viewManagerSlice';

// Screen import/export utilities
export { exportScreen, importScreen, downloadScreenJSON } from './screenIO';
