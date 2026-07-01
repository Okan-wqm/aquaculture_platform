/**
 * usePropertiesPanelHandlers — Consolidates widget/edge/alarm handler callbacks
 * and selected element memos used by the PropertiesPanel.
 *
 * Extracted from ScadaPackageBuilderPage to keep the page under 500 lines.
 */

import { useCallback, useMemo } from 'react';
import { useScadaPackageStore } from '../../store/scada';
import type { ScadaEdgeType, ScadaEdge } from '../../types/scada-edge.types';
import type { ScreenWidget } from '../../types/scada-package.types';
import type { WidgetEventDef } from '../../engine/events/types';
import type { AnimationRule } from '../../engine/animation/types';
import type { AlarmRuleDef } from '../../store/scada/types';

interface SelectedWidgetData {
  id: string;
  type: string;
  config: Record<string, unknown>;
  name?: string;
  position: ScreenWidget['position'];
  locked?: boolean;
  visible?: boolean;
  permissions?: ScreenWidget['permissions'];
  events?: WidgetEventDef[];
  animations?: AnimationRule[];
}

interface PropertiesPanelHandlers {
  selectedWidget: SelectedWidgetData | null;
  selectedEdge: ScadaEdge | null;
  handleWidgetConfigChange: (widgetId: string, updates: Record<string, unknown>) => void;
  handleWidgetUpdate: (widgetId: string, updates: Partial<ScreenWidget>) => void;
  handleWidgetEventsChange: (widgetId: string, events: WidgetEventDef[]) => void;
  handleWidgetAnimationsChange: (widgetId: string, animations: AnimationRule[]) => void;
  handleEdgeDataChange: (edgeId: string, updates: Record<string, unknown>) => void;
  handleEdgeTypeChange: (edgeId: string, newType: string) => void;
  handleEdgeDelete: (edgeId: string) => void;
  handleAlarmRulesChange: (rules: AlarmRuleDef[]) => void;
}

export function usePropertiesPanelHandlers(
  selectedWidgetId: string | null,
  selectedEdgeId: string | null,
  activeScreenId: string | null,
  screens: Array<{
    id: string;
    widgets: ScreenWidget[];
    edges: ScadaEdge[];
  }>,
  alarmRules: AlarmRuleDef[],
): PropertiesPanelHandlers {
  const updateEdgeData = useScadaPackageStore((s) => s.updateEdgeData);
  const updateEdgeType = useScadaPackageStore((s) => s.updateEdgeType);
  const removeEdge = useScadaPackageStore((s) => s.removeEdge);
  const addAlarmRule = useScadaPackageStore((s) => s.addAlarmRule);
  const removeAlarmRule = useScadaPackageStore((s) => s.removeAlarmRule);
  const updateAlarmRule = useScadaPackageStore((s) => s.updateAlarmRule);

  // Find selected widget
  const selectedWidget = useMemo((): SelectedWidgetData | null => {
    if (!selectedWidgetId || !activeScreenId) return null;
    const screen = screens.find((s) => s.id === activeScreenId);
    if (!screen) return null;
    const widget = screen.widgets.find((w) => w.id === selectedWidgetId);
    if (!widget) return null;
    return {
      id: widget.id,
      type: widget.widgetType,
      config: widget.config,
      name: widget.name,
      position: widget.position,
      locked: widget.locked,
      visible: widget.visible,
      permissions: widget.permissions,
      events: widget.events,
      animations: widget.animations,
    };
  }, [selectedWidgetId, activeScreenId, screens]);

  // Find selected edge
  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId || !activeScreenId) return null;
    const screen = screens.find((s) => s.id === activeScreenId);
    return screen?.edges.find((e) => e.id === selectedEdgeId) ?? null;
  }, [selectedEdgeId, activeScreenId, screens]);

  // Widget config change handler
  const handleWidgetConfigChange = useCallback(
    (widgetId: string, updates: Record<string, unknown>) => {
      const state = useScadaPackageStore.getState();
      if (!state.activeScreenId) return;
      const screen = state.screens.find((s) => s.id === state.activeScreenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      state.updateWidget(state.activeScreenId, widgetId, {
        config: { ...widget.config, ...updates },
      });
    },
    [],
  );

  // Widget top-level field update handler
  const handleWidgetUpdate = useCallback(
    (widgetId: string, updates: Partial<ScreenWidget>) => {
      const state = useScadaPackageStore.getState();
      if (!state.activeScreenId) return;
      state.updateWidget(state.activeScreenId, widgetId, updates);
    },
    [],
  );

  // Widget events change handler
  const handleWidgetEventsChange = useCallback(
    (widgetId: string, events: WidgetEventDef[]) => {
      const state = useScadaPackageStore.getState();
      if (!state.activeScreenId) return;
      state.updateWidget(state.activeScreenId, widgetId, { events });
    },
    [],
  );

  // Widget animations change handler
  const handleWidgetAnimationsChange = useCallback(
    (widgetId: string, animations: AnimationRule[]) => {
      const state = useScadaPackageStore.getState();
      if (!state.activeScreenId) return;
      state.updateWidget(state.activeScreenId, widgetId, { animations });
    },
    [],
  );

  // Edge handlers
  const handleEdgeDataChange = useCallback(
    (edgeId: string, updates: Record<string, unknown>) => {
      if (!activeScreenId) return;
      updateEdgeData(activeScreenId, edgeId, updates);
    },
    [activeScreenId, updateEdgeData],
  );

  const handleEdgeTypeChange = useCallback(
    (edgeId: string, newType: string) => {
      if (!activeScreenId) return;
      updateEdgeType(activeScreenId, edgeId, newType as ScadaEdgeType);
    },
    [activeScreenId, updateEdgeType],
  );

  const handleEdgeDelete = useCallback(
    (edgeId: string) => {
      if (!activeScreenId) return;
      removeEdge(activeScreenId, edgeId);
    },
    [activeScreenId, removeEdge],
  );

  // Alarm rules change handler — diff-based
  const handleAlarmRulesChange = useCallback(
    (rules: AlarmRuleDef[]) => {
      const existingIds = new Set(alarmRules.map((r) => r.id));
      const newIds = new Set(rules.map((r) => r.id));
      for (const r of alarmRules) {
        if (!newIds.has(r.id)) removeAlarmRule(r.id);
      }
      for (const r of rules) {
        if (!existingIds.has(r.id)) {
          addAlarmRule(r);
        } else {
          updateAlarmRule(r.id, r);
        }
      }
    },
    [alarmRules, addAlarmRule, removeAlarmRule, updateAlarmRule],
  );

  return {
    selectedWidget,
    selectedEdge,
    handleWidgetConfigChange,
    handleWidgetUpdate,
    handleWidgetEventsChange,
    handleWidgetAnimationsChange,
    handleEdgeDataChange,
    handleEdgeTypeChange,
    handleEdgeDelete,
    handleAlarmRulesChange,
  };
}
