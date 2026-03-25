/**
 * DEPRECATED — This file now re-exports from the decomposed store at ./scada/.
 *
 * The monolithic 783-line store has been split into 7 focused slices:
 *   sceneSlice, widgetSlice, edgeSlice, selectionSlice,
 *   historySlice, alarmSlice, projectSlice
 *
 * All imports should eventually migrate to:
 *   import { useScadaPackageStore, ... } from '../store/scada';
 */

export {
  useScadaStore,
  useScadaPackageStore,
  createScadaStore,
  generateId,
  normalizeWidgetType,
  SCREEN_ICONS,
} from './scada';

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
  HistoryEntry,
  ClipboardData,
  SimulationSlice,
  ScadaStore,
} from './scada';
