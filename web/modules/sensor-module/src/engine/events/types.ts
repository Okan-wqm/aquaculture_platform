export type EventTrigger = 'click' | 'dblclick' | 'mousedown' | 'mouseup' | 'mouseover' | 'mouseout';

/**
 * Event actions that trigger script execution or URL navigation.
 * 'runScript' and 'openUrl' restored from Phase 0 removal -- now backed
 * by Web Worker sandbox (Phase 5A) with timeout, rate limiting, and URL validation.
 */
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
  /** Script ID from the package-level scripts array (for runScript action). */
  scriptId?: string;
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

/* ------------------------------------------------------------------ */
/*  SCADA Script Definitions (package-level scripting)                  */
/* ------------------------------------------------------------------ */

/**
 * Trigger types determining when a script should execute.
 * - event:     Triggered by widget events via the runScript action
 * - tagChange: Fires when a specified tag's value changes
 * - interval:  Fires at a configurable millisecond interval (min 1000ms)
 * - load:      Fires once when the SCADA view loads
 */
export type ScriptTrigger = 'event' | 'tagChange' | 'interval' | 'load';

/**
 * Package-level script definition for client-side SCADA automation.
 * Scripts execute inside a Web Worker sandbox with a restricted API
 * ($getTag, $setTag, $log, etc.) and configurable timeout.
 */
export interface ScadaScript {
  id: string;
  name: string;
  code: string;
  trigger: ScriptTrigger;
  enabled: boolean;
  /** Tag that triggers execution (only for tagChange trigger). */
  triggerTag?: string;
  /** Interval in milliseconds (only for interval trigger, min 1000). */
  triggerInterval?: number;
  /** Optional device ID for tag scope resolution. */
  deviceId?: string | null;
}
