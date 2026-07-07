/**
 * Layer management panel showing all widgets in the active screen
 * sorted by z-index (highest on top, like Photoshop/Figma layers panel).
 *
 * Architecture: This is a read-through view of the store's widget array
 * for the active screen. It doesn't maintain its own state -- all
 * operations dispatch to the Zustand store and the panel re-renders
 * from the updated store state.
 *
 * Features:
 * - Sorted list of widgets by z-index (descending -- top layer first)
 * - Widget type icon + name/label + type badge
 * - Visibility toggle (eye icon) per widget
 * - Lock toggle (lock icon) per widget
 * - Hover highlight: hovering a layer item highlights the widget on canvas
 * - Click to select: clicking a layer item selects the widget
 * - Selected widget highlighted in the list
 * - Z-order buttons: up, down, to-top, to-bottom
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  Unlock,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  ChevronsDown,
  Layers,
  Gauge,
  Type,
  ToggleLeft,
  Sliders,
  AlertTriangle,
  TrendingUp,
  Activity,
  Square,
  Circle,
  Minus,
  Image,
  Video,
  Map as MapIcon,
  Calendar,
  FileCode,
  Link2,
  Droplets,
  Hexagon,
  Triangle as TriangleIcon,
  Diamond,
  ArrowRight,
} from 'lucide-react';
import type { ScreenWidget } from '../../types/scada-package.types';
import { useScadaPackageStore } from '../../store/scada';

/* ------------------------------------------------------------------ */
/*  Widget type icon mapping                                           */
/*                                                                     */
/*  Maps ScadaWidgetType strings to compact lucide-react icons.        */
/*  Unknown types fall back to a generic Square icon.                  */
/* ------------------------------------------------------------------ */

const WIDGET_ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  gauge: Gauge,
  numericDisplay: Type,
  statusIndicator: Activity,
  tankLevel: Droplets,
  toggleSwitch: ToggleLeft,
  slider: Sliders,
  numericInput: Type,
  pushButton: Square,
  emergencyStop: AlertTriangle,
  trendChart: TrendingUp,
  alarmBanner: AlertTriangle,
  alarmList: AlertTriangle,
  processView: Activity,
  equipment: Activity,
  screenLink: Link2,
  staticText: Type,
  pipeFlow: Activity,
  svgRect: Square,
  svgCircle: Circle,
  svgLine: Minus,
  svgText: Type,
  svgEllipse: Circle,
  svgPath: FileCode,
  scheduler: Calendar,
  customSvg: FileCode,
  rasterImage: Image,
  videoStream: Video,
  mapView: MapIcon,
  svgPolygon: Hexagon,
  svgTriangle: TriangleIcon,
  svgDiamond: Diamond,
  svgArrow: ArrowRight,
};

function getWidgetIcon(widgetType: string): React.FC<{ className?: string }> {
  return WIDGET_ICON_MAP[widgetType] ?? Square;
}

/* ------------------------------------------------------------------ */
/*  LayerRow                                                           */
/* ------------------------------------------------------------------ */

interface LayerRowProps {
  widget: ScreenWidget;
  screenId: string;
  isSelected: boolean;
  onSelect: (widgetId: string) => void;
  onHighlight: (widgetId: string | null) => void;
}

const LayerRow: React.FC<LayerRowProps> = React.memo(({
  widget,
  screenId,
  isSelected,
  onSelect,
  onHighlight,
}) => {
  const IconComponent = getWidgetIcon(widget.widgetType);
  const isVisible = widget.visible !== false;
  const isLocked = widget.locked === true;

  // Derive display name: prefer explicit name, then config label, then widget type
  const displayName = widget.name
    || (widget.config?.label as string)
    || widget.widgetType;

  const handleVisibilityToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useScadaPackageStore.getState().toggleWidgetVisibility(screenId, widget.id);
  }, [screenId, widget.id]);

  const handleLockToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useScadaPackageStore.getState().toggleWidgetLock(screenId, widget.id);
  }, [screenId, widget.id]);

  const handleMoveUp = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useScadaPackageStore.getState().bringForward(screenId, widget.id);
  }, [screenId, widget.id]);

  const handleMoveDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useScadaPackageStore.getState().sendBackward(screenId, widget.id);
  }, [screenId, widget.id]);

  return (
    <div
      data-testid={`layer-row-${widget.id}`}
      className={`
        flex items-center gap-1 px-2 py-1.5 text-xs cursor-pointer select-none
        transition-colors group border-b border-gray-50
        ${isSelected ? 'bg-cyan-50 text-cyan-700' : 'text-gray-700 hover:bg-gray-50'}
        ${!isVisible ? 'opacity-50' : ''}
      `}
      onClick={() => onSelect(widget.id)}
      onMouseEnter={() => onHighlight(widget.id)}
      onMouseLeave={() => onHighlight(null)}
    >
      {/* Visibility toggle */}
      <button
        className="flex-shrink-0 p-0.5 rounded hover:bg-gray-200 transition-colors"
        onClick={handleVisibilityToggle}
        aria-label={isVisible ? 'Hide widget' : 'Show widget'}
        title={isVisible ? 'Hide widget' : 'Show widget'}
        data-testid={`layer-visibility-${widget.id}`}
      >
        {isVisible ? (
          <Eye className="w-3.5 h-3.5 text-gray-500" />
        ) : (
          <EyeOff className="w-3.5 h-3.5 text-gray-400" />
        )}
      </button>

      {/* Lock toggle */}
      <button
        className="flex-shrink-0 p-0.5 rounded hover:bg-gray-200 transition-colors"
        onClick={handleLockToggle}
        aria-label={isLocked ? 'Unlock widget' : 'Lock widget'}
        title={isLocked ? 'Unlock widget' : 'Lock widget'}
        data-testid={`layer-lock-${widget.id}`}
      >
        {isLocked ? (
          <Lock className="w-3.5 h-3.5 text-amber-500" />
        ) : (
          <Unlock className="w-3.5 h-3.5 text-gray-400 opacity-0 group-hover:opacity-100" />
        )}
      </button>

      {/* Widget type icon */}
      <IconComponent className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" />

      {/* Widget name (truncated) */}
      <span className="flex-1 min-w-0 truncate" style={{ maxWidth: 120 }}>
        {displayName}
      </span>

      {/* Move up / Move down buttons (visible on hover) */}
      <button
        className="flex-shrink-0 p-0.5 rounded hover:bg-gray-200 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleMoveUp}
        aria-label="Move up (bring forward)"
        title="Move up (bring forward)"
        data-testid={`layer-up-${widget.id}`}
      >
        <ChevronUp className="w-3 h-3 text-gray-500" />
      </button>
      <button
        className="flex-shrink-0 p-0.5 rounded hover:bg-gray-200 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleMoveDown}
        aria-label="Move down (send backward)"
        title="Move down (send backward)"
        data-testid={`layer-down-${widget.id}`}
      >
        <ChevronDown className="w-3 h-3 text-gray-500" />
      </button>
    </div>
  );
});

LayerRow.displayName = 'LayerRow';

/* ------------------------------------------------------------------ */
/*  LayersPanel                                                        */
/* ------------------------------------------------------------------ */

export const LayersPanel: React.FC = () => {
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const widgets = useScadaPackageStore((s) => {
    const screen = s.screens.find((scr) => scr.id === s.activeScreenId);
    return screen?.widgets ?? [];
  });
  const selectedWidgetId = useScadaPackageStore((s) => s.selectedWidgetId);
  const selectedWidgetIds = useScadaPackageStore((s) => s.selectedWidgetIds);
  const setSelectedWidget = useScadaPackageStore((s) => s.setSelectedWidget);
  const setHighlightedWidget = useScadaPackageStore((s) => s.setHighlightedWidget);

  /**
   * Group-aware layer list: widgets sharing a groupId are visually
   * indented and grouped together with a collapsible group header.
   * Group header shows: group color dot, member count, expand/collapse.
   */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  /**
   * Compute a deterministic color for each groupId (same algorithm as ScadaWidgetNode).
   */
  const getGroupColor = useCallback((groupId: string): string => {
    let hash = 0;
    for (let i = 0; i < groupId.length; i++) {
      hash = (hash + groupId.charCodeAt(i) * 37) % 360;
    }
    return `hsl(${hash}, 70%, 55%)`;
  }, []);

  /**
   * Sorted widget list: z-index descending (highest on top, like Figma).
   * Widgets without an explicit z-index default to 0.
   */
  const sortedWidgets = useMemo(() => {
    return [...widgets].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));
  }, [widgets]);

  /**
   * Build group-aware render list: grouped widgets appear together under
   * a group header row. Ungrouped widgets render as before.
   */
  interface GroupInfo {
    groupId: string;
    members: ScreenWidget[];
    color: string;
  }

  const { groups, ungrouped } = useMemo(() => {
    const groupMap = new Map<string, ScreenWidget[]>();
    const ungroupedList: ScreenWidget[] = [];

    for (const w of sortedWidgets) {
      if (w.groupId) {
        if (!groupMap.has(w.groupId)) {
          groupMap.set(w.groupId, []);
        }
        groupMap.get(w.groupId)!.push(w);
      } else {
        ungroupedList.push(w);
      }
    }

    const groupList: GroupInfo[] = [];
    for (const [gid, members] of groupMap.entries()) {
      groupList.push({ groupId: gid, members, color: getGroupColor(gid) });
    }

    return { groups: groupList, ungrouped: ungroupedList };
  }, [sortedWidgets, getGroupColor]);

  const handleSelectWidget = useCallback(
    (widgetId: string) => {
      setSelectedWidget(widgetId);
    },
    [setSelectedWidget],
  );

  const handleHighlightWidget = useCallback(
    (widgetId: string | null) => {
      setHighlightedWidget(widgetId);
    },
    [setHighlightedWidget],
  );

  // Header action: move selected widget to front
  const handleToFront = useCallback(() => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetId) {
      store.bringToFront(store.activeScreenId, store.selectedWidgetId);
    }
  }, []);

  // Header action: move selected widget to back
  const handleToBack = useCallback(() => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetId) {
      store.sendToBack(store.activeScreenId, store.selectedWidgetId);
    }
  }, []);

  const selectedSet = useMemo(
    () => new Set(selectedWidgetIds),
    [selectedWidgetIds],
  );

  const hasSelection = selectedWidgetId !== null;

  return (
    <div className="flex flex-col border-t border-gray-200 bg-white" data-testid="layers-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-gray-200">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <Layers className="w-3.5 h-3.5 text-gray-500" />
          <span>Layers</span>
          <span className="text-[11px] font-normal text-gray-500">
            ({widgets.length})
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleToFront}
            disabled={!hasSelection}
            className={`p-1 rounded transition-colors ${
              hasSelection
                ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                : 'text-gray-300 cursor-not-allowed'
            }`}
            aria-label="Bring to front"
            title="Bring to front"
          >
            <ChevronsUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleToBack}
            disabled={!hasSelection}
            className={`p-1 rounded transition-colors ${
              hasSelection
                ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                : 'text-gray-300 cursor-not-allowed'
            }`}
            aria-label="Send to back"
            title="Send to back"
          >
            <ChevronsDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Layer list -- group-aware rendering */}
      <div className="flex-1 overflow-y-auto max-h-48">
        {sortedWidgets.length === 0 ? (
          <div className="py-4 text-center text-xs text-gray-500">
            No widgets on this screen
          </div>
        ) : (
          <>
            {/* Grouped widgets with collapsible headers */}
            {groups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.groupId);
              return (
                <div key={`group-${group.groupId}`} data-testid={`layer-group-${group.groupId}`}>
                  {/* Group header row */}
                  <button
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold text-gray-600 bg-gray-50 border-b border-gray-100 hover:bg-gray-100 transition-colors"
                    onClick={() => toggleGroupCollapse(group.groupId)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
                    ) : (
                      <ChevronDown className="w-3 h-3 text-gray-400 flex-shrink-0" />
                    )}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: group.color }}
                    />
                    <span className="truncate">Group</span>
                    <span className="text-gray-500 font-normal">({group.members.length})</span>
                  </button>
                  {/* Group members (indented) */}
                  {!isCollapsed && group.members.map((w) => (
                    <div key={w.id} className="pl-4" style={{ borderLeft: `3px solid ${group.color}` }}>
                      <LayerRow
                        widget={w}
                        screenId={activeScreenId}
                        isSelected={selectedSet.has(w.id) || selectedWidgetId === w.id}
                        onSelect={handleSelectWidget}
                        onHighlight={handleHighlightWidget}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
            {/* Ungrouped widgets */}
            {ungrouped.map((w) => (
              <LayerRow
                key={w.id}
                widget={w}
                screenId={activeScreenId}
                isSelected={selectedSet.has(w.id) || selectedWidgetId === w.id}
                onSelect={handleSelectWidget}
                onHighlight={handleHighlightWidget}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export default LayersPanel;
