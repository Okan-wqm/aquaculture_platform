/**
 * WidgetTooltip - Shows widget info on hover during edit mode.
 * Displays: type, label, tag, position, size, group/lock status.
 */

import React from 'react';

interface WidgetTooltipProps {
  widgetType: string;
  label?: string;
  tagName?: string;
  position: { col: number; row: number; w: number; h: number };
  locked?: boolean;
  groupId?: string | null;
  visible: boolean;
  x: number;
  y: number;
}

export const WidgetTooltip: React.FC<WidgetTooltipProps> = ({
  widgetType,
  label,
  tagName,
  position,
  locked,
  groupId,
  visible,
  x,
  y,
}) => {
  if (!visible) return null;

  return (
    <div
      className="fixed z-[9999] pointer-events-none bg-gray-900/90 text-white text-[10px] leading-relaxed rounded-md px-2.5 py-1.5 shadow-lg max-w-[200px]"
      style={{ left: x + 12, top: y + 12 }}
    >
      <div className="font-medium text-cyan-300">{widgetType}</div>
      {label && <div className="text-gray-500">{label}</div>}
      {tagName && <div className="text-emerald-300 font-mono">{tagName}</div>}
      <div className="text-gray-500 mt-0.5">
        Position: ({position.col},{position.row}) Size: {position.w}x{position.h}
      </div>
      <div className="flex gap-2 mt-0.5">
        {locked && <span className="text-yellow-400">Locked</span>}
        {groupId && <span className="text-blue-300">Grouped</span>}
      </div>
    </div>
  );
};
