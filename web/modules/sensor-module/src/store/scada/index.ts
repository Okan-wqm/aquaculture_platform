// Store hooks
export { useScadaPackageStore, createScadaStore } from './createScadaStore';

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
  ScadaScript,
  // New types
  HistoryEntry,
  HistoryCheckpoint,
  ClipboardData,
  GroupSlice,
  WidgetTemplate,
  TemplateSlice,
  SimulationSlice,
  SimTagValue,
  ViewManagerSlice,
  ScadaStore,
} from './types';

// Utilities & Constants
export {
  generateId,
  normalizeWidgetType,
  deepClone,
  SCREEN_ICONS,
  MAX_UNDO_STACK,
  CHECKPOINT_INTERVAL,
  MERGE_WINDOW_MS,
} from './types';

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
