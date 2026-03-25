export type EventTrigger = 'click' | 'dblclick' | 'mousedown' | 'mouseup' | 'mouseover' | 'mouseout';

// Guvenlik: runScript ve openUrl Phase 5'te sandboxed execution ile implement edilecek
// Su an handler'siz -- kullanici configure ediyor ama runtime'da sessizce basarisiz oluyor
// TODO(phase-5): Implement with Web Worker sandbox and URL validation
// Security: these actions are disabled until proper sandboxing prevents arbitrary code
// execution (runScript) and open-redirect / SSRF attacks (openUrl)
export type EventAction =
  | 'navigate'
  | 'openCard'
  | 'openDialog'
  | 'setValue'
  | 'toggleValue';
  // | 'runScript'   -- disabled: requires Web Worker sandbox (Phase 5)
  // | 'openUrl';    -- disabled: requires URL validation + allowlist (Phase 5)

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
