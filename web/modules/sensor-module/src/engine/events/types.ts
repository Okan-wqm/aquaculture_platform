export type EventTrigger = 'click' | 'dblclick' | 'mousedown' | 'mouseup' | 'mouseover' | 'mouseout';

export type EventAction =
  | 'navigate'
  | 'openCard'
  | 'openDialog'
  | 'setValue'
  | 'toggleValue'
  | 'runScript'
  | 'openUrl';

export interface WidgetEventDef {
  id: string;
  trigger: EventTrigger;
  action: EventAction;
  params: EventParams;
}

export interface EventParams {
  targetScreenId?: string;
  width?: number;
  height?: number;
  targetTag?: string;
  value?: unknown;
  toggleTag?: string;
  programId?: string;
  url?: string;
  variableMap?: Record<string, string>;
}

export interface WidgetEventPayload {
  widgetId: string;
  screenId: string;
  action: EventAction;
  params: EventParams;
  mousePosition?: { x: number; y: number };
}

export type EventHandler = (event: WidgetEventPayload) => void;
