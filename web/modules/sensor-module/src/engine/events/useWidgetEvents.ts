import { useCallback, useMemo } from 'react';
import type { WidgetEventDef, EventTrigger } from './types';
import type { WidgetEventBus } from './WidgetEventBus';

export function useWidgetEvents(
  widgetId: string,
  screenId: string,
  events: WidgetEventDef[] | undefined,
  eventBus: WidgetEventBus,
): Record<string, (e: React.MouseEvent) => void> {
  const dispatch = useCallback(
    (trigger: EventTrigger, e: React.MouseEvent) => {
      if (!events) return;
      const matching = events.filter((ev) => ev.trigger === trigger);
      for (const ev of matching) {
        eventBus.dispatch({
          widgetId,
          screenId,
          action: ev.action,
          params: ev.params,
          mousePosition: { x: e.clientX, y: e.clientY },
        });
      }
    },
    [eventBus, widgetId, screenId, events],
  );

  return useMemo(
    () => ({
      onClick: (e: React.MouseEvent) => dispatch('click', e),
      onDoubleClick: (e: React.MouseEvent) => dispatch('dblclick', e),
      onMouseDown: (e: React.MouseEvent) => dispatch('mousedown', e),
      onMouseUp: (e: React.MouseEvent) => dispatch('mouseup', e),
      onMouseEnter: (e: React.MouseEvent) => dispatch('mouseover', e),
      onMouseLeave: (e: React.MouseEvent) => dispatch('mouseout', e),
    }),
    [dispatch],
  );
}
