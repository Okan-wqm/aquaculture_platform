/**
 * SCADA Runtime Types — Shared contracts for HMI operator mode.
 *
 * This is the canonical type file for the runtime (operator) layer.
 * All agents/modules import from here to ensure coherent integration.
 *
 * Covers: DataProvider, WebSocket events, Alarm runtime, Tag system,
 * Widget actions, Operator permissions, Trend charts, Script engine.
 */

/* ================================================================== */
/*  1. TAG & DATA PROVIDER                                             */
/* ================================================================== */

/** A single tag value update from any data source. */
export interface TagValueChange {
  tagId: string;
  value: number | string | boolean;
  timestamp: number;
  quality: TagQuality;
  deviceId?: string;
}

export type TagQuality = 'good' | 'bad' | 'uncertain';

/** Device connection status. */
export type DeviceConnectionStatus =
  | 'online'
  | 'offline'
  | 'connecting'
  | 'error'
  | 'warning';

export interface DeviceStatusChange {
  deviceId: string;
  status: DeviceConnectionStatus;
  lastSeen?: number;
}

/**
 * IDataProvider — The core abstraction that decouples widgets from data sources.
 *
 * Implementations:
 *   - SimulationDataProvider (uses ST interpreter + manual injection)
 *   - LiveDeviceDataProvider (WebSocket → real devices)
 *   - HybridDataProvider     (mixes simulation and live)
 */
export interface IDataProvider {
  /** Subscribe to live tag value updates. */
  subscribeToTags(tagIds: string[]): void;
  /** Unsubscribe from tag value updates. */
  unsubscribeFromTags(tagIds: string[]): void;
  /** Write a value to a tag (operator action). */
  writeTagValue(tagId: string, value: unknown): Promise<void>;
  /** Get current cached value of a tag. */
  getTagValue(tagId: string): TagValueChange | null;
  /**
   * Snapshot of every currently-cached tag value, keyed by tagId.
   *
   * Returns a plain object copy (not a live reference) so callers that
   * serialize it across a Worker boundary — e.g. the client-script
   * sandbox — receive a stable, self-contained view. Implementations
   * already hold the full value map internally; this exposes it without
   * widening write access.
   */
  getTagSnapshot(): Record<string, TagValueChange>;
  /** Query historical data. */
  queryHistory(
    tagIds: string[],
    from: Date,
    to: Date,
  ): Promise<HistoricalDataResult>;
  /** Connection state of the provider. */
  connectionState: DataProviderConnectionState;
}

export type DataProviderConnectionState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error';

export type DataProviderType = 'simulation' | 'live' | 'hybrid';

/* ================================================================== */
/*  2. WEBSOCKET EVENTS (Socket.IO)                                    */
/* ================================================================== */

/**
 * Event names exchanged between frontend Socket.IO client and
 * NestJS WebSocket gateway. Mirrors FUXA IoEventTypes but typed.
 */
export enum ScadaSocketEvent {
  // Tag data
  TAG_SUBSCRIBE = 'scada:tag:subscribe',
  TAG_UNSUBSCRIBE = 'scada:tag:unsubscribe',
  TAG_VALUES = 'scada:tag:values',
  TAG_WRITE = 'scada:tag:write',
  TAG_WRITE_ACK = 'scada:tag:write-ack',

  // Device status
  DEVICE_STATUS = 'scada:device:status',
  DEVICE_STATUS_REQUEST = 'scada:device:status-request',

  // Alarms
  ALARM_STATUS = 'scada:alarm:status',
  ALARM_ACK = 'scada:alarm:ack',
  ALARM_ACK_ALL = 'scada:alarm:ack-all',
  ALARM_HISTORY_QUERY = 'scada:alarm:history-query',
  ALARM_HISTORY_RESULT = 'scada:alarm:history-result',

  // Historical data (DAQ)
  DAQ_QUERY = 'scada:daq:query',
  DAQ_RESULT = 'scada:daq:result',

  // Scripts
  SCRIPT_RUN = 'scada:script:run',
  SCRIPT_RESULT = 'scada:script:result',
  SCRIPT_CONSOLE = 'scada:script:console',

  // Commands (server → client)
  COMMAND_SET_VIEW = 'scada:cmd:set-view',
  COMMAND_OPEN_CARD = 'scada:cmd:open-card',
  COMMAND_TOAST = 'scada:cmd:toast',

  // Connection
  HEARTBEAT = 'scada:heartbeat',
  AUTH = 'scada:auth',
}

/** Payload: TAG_VALUES (server → client) */
export interface TagValuesPayload {
  deviceId: string;
  values: TagValueChange[];
}

/** Payload: TAG_WRITE (client → server) */
export interface TagWritePayload {
  tagId: string;
  value: unknown;
  /** Optional math function: 'set' (default), 'add', 'remove'. */
  function?: 'set' | 'add' | 'remove';
}

/** Payload: DAQ_QUERY */
export interface DaqQueryPayload {
  queryId: string;
  tagIds: string[];
  from: number; // unix ms
  to: number;   // unix ms
  /** If true, server sends chunked results. */
  chunked?: boolean;
  /** Aggregation function (optional). */
  aggregation?: DaqAggregation;
}

/** Payload: DAQ_RESULT */
export interface DaqResultPayload {
  queryId: string;
  data: Record<string, HistoricalDataPoint[]>;
  /** True if more chunks are coming. */
  hasMore?: boolean;
  chunkIndex?: number;
}

/* ================================================================== */
/*  3. ALARM RUNTIME                                                   */
/* ================================================================== */

/** Alarm severity levels (FUXA-compatible). */
export type AlarmSeverity = 'critical' | 'high' | 'warning' | 'info';

/**
 * Alarm state machine (FUXA 4-state model):
 *   INACTIVE → ACTIVE → CLEARED → ACKNOWLEDGED
 *                ↑         ↓
 *                └─────────┘  (re-activation)
 */
export type AlarmRuntimeStatus =
  | 'inactive'        // VOID — not triggered
  | 'active'          // ON — condition met, not acknowledged
  | 'cleared'         // OFF — condition cleared, awaiting ack
  | 'acknowledged';   // ACK — acknowledged while active

/**
 * ACK mode (FUXA-compatible):
 *   float    — auto-clear, no ack required
 *   ackActive  — must ack while active OR after clear
 *   ackPassive — must ack only after condition clears
 */
export type AlarmAckMode = 'float' | 'ackActive' | 'ackPassive';

/** Extended alarm rule with runtime fields. */
export interface AlarmRuleRuntime {
  id: string;
  name: string;
  tagId: string;
  condition: '>' | '<' | '>=' | '<=' | '==' | '!=';
  threshold: number;
  severity: AlarmSeverity;
  message: string;
  /** Suppress changes within this range. */
  deadband?: number;
  /** Seconds the condition must persist before alarm activates. */
  timeDelay?: number;
  /** Minimum seconds between evaluations. */
  checkInterval?: number;
  /** Bitwise mask applied to tag value before comparison. */
  bitmask?: number;
  ackMode: AlarmAckMode;
  group?: string;
  enabled: boolean;
  /** Actions executed on state change. */
  actions?: AlarmAction[];
  /** Per-severity display colors. */
  colors?: { background: string; text: string };
}

/** Active alarm instance. */
export interface AlarmInstance {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlarmSeverity;
  status: AlarmRuntimeStatus;
  message: string;
  group?: string;
  currentValue: number;
  threshold: number;
  onTime: number;   // unix ms
  offTime?: number;
  ackTime?: number;
  ackUserId?: string;
  colors?: { background: string; text: string };
}

/** Alarm status summary (pushed to clients). */
export interface AlarmStatusSummary {
  critical: number;
  high: number;
  warning: number;
  info: number;
  activeAlarms: AlarmInstance[];
  /** Pending toast/popup actions from alarm triggers. */
  pendingActions?: AlarmActionCommand[];
}

/** Alarm action definition. */
export interface AlarmAction {
  type: AlarmActionType;
  params: Record<string, unknown>;
}

export type AlarmActionType =
  | 'setValue'
  | 'runScript'
  | 'popup'
  | 'setView'
  | 'toastMessage';

/** Alarm action command (server → client). */
export interface AlarmActionCommand {
  type: AlarmActionType;
  message?: string;
  severity?: AlarmSeverity;
  viewId?: string;
  toastType?: 'error' | 'warning' | 'success' | 'info';
}

/** Alarm history query filter. */
export interface AlarmHistoryFilter {
  severity?: AlarmSeverity[];
  group?: string;
  textSearch?: string;
  tagIds?: string[];
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

/* ================================================================== */
/*  4. WIDGET ACTIONS (Tag-value-driven behaviors)                     */
/* ================================================================== */

/**
 * WidgetAction — A tag-value-driven behavior applied to a widget at runtime.
 * Inspired by FUXA GaugeAction.
 */
export interface WidgetAction {
  id: string;
  tagId: string;
  bitmask?: number;
  type: WidgetActionType;
  range: { min: number; max: number };
  params: WidgetActionParams;
}

export type WidgetActionType =
  | 'hide'
  | 'show'
  | 'blink'
  | 'color'
  | 'rotate'
  | 'move'
  | 'animate'
  | 'refreshImage';

export type WidgetActionParams =
  | BlinkParams
  | ColorParams
  | RotateParams
  | MoveParams
  | AnimateParams
  | Record<string, never>; // empty for hide/show/refreshImage

export interface BlinkParams {
  fillA: string;
  fillB: string;
  strokeA: string;
  strokeB: string;
  intervalMs: number;
}

export interface ColorParams {
  fill: string;
  stroke: string;
  textColor?: string;
}

export interface RotateParams {
  minAngle: number;
  maxAngle: number;
  delayMs?: number;
}

export interface MoveParams {
  toX: number;
  toY: number;
  durationMs: number;
}

export interface AnimateParams {
  direction: 'clockwise' | 'anticlockwise' | 'stop';
  speedMs?: number;
}

/* ================================================================== */
/*  5. WIDGET EVENT SYSTEM                                             */
/* ================================================================== */

/** Event trigger types for widgets (user interaction). */
export type WidgetEventTrigger =
  | 'click'
  | 'dblclick'
  | 'mousedown'
  | 'mouseup'
  | 'mouseover'
  | 'mouseout'
  | 'onLoad';

/** Event action types (what happens when the trigger fires). */
export type WidgetEventActionType =
  | 'navigate'
  | 'openDialog'
  | 'openCard'
  | 'openTab'
  | 'setValue'
  | 'toggleValue'
  | 'runScript'
  | 'close';

/** A single event binding on a widget. */
export interface WidgetEventBinding {
  id: string;
  trigger: WidgetEventTrigger;
  action: WidgetEventActionType;
  params: WidgetEventParams;
}

export type WidgetEventParams =
  | { type: 'navigate'; screenId: string; scaleMode?: string }
  | { type: 'openDialog'; screenId: string; position?: 'center' }
  | { type: 'openCard'; screenId: string; x?: number; y?: number }
  | { type: 'openTab'; url: string }
  | { type: 'setValue'; tagId: string; value: unknown; function?: 'set' | 'add' | 'remove' }
  | { type: 'toggleValue'; tagId: string; bitmask?: number }
  | { type: 'runScript'; scriptId: string; params?: Record<string, unknown> }
  | { type: 'close' };

/* ================================================================== */
/*  6. OPERATOR SHELL & LAYOUT                                         */
/* ================================================================== */

/** Sidenav display mode (FUXA NaviModeType). */
export type SidenavMode = 'void' | 'overlay' | 'push' | 'fixed';

/** Zoom mode (FUXA ZoomModeType). */
export type ZoomMode = 'disabled' | 'panzoom' | 'autoresize';

/** Input mode for touch devices. */
export type InputMode = 'disabled' | 'enabled' | 'keyboard' | 'keyboardFullScreen';

/** Header item for the operator shell. */
export interface OperatorHeaderItem {
  id: string;
  type: 'button' | 'label' | 'image';
  text?: string;
  icon?: string;
  imageUrl?: string;
  /** Tag binding for dynamic text/color. */
  tagId?: string;
  /** Click action. */
  event?: WidgetEventBinding;
  /** Styling. */
  style?: Record<string, string>;
}

/** Navigation item for the operator sidenav. */
export interface OperatorNavItem {
  id: string;
  screenId: string;
  label: string;
  icon?: string;
  children?: OperatorNavItem[];
  permission?: WidgetPermission;
}

/** Operator layout configuration. */
export interface OperatorLayoutConfig {
  sidenavMode: SidenavMode;
  zoomMode: ZoomMode;
  inputMode: InputMode;
  hideNavigation: boolean; // kiosk mode
  showDateTime: boolean;
  showAlarmBadge: boolean;
  headerItems: OperatorHeaderItem[];
  navItems: OperatorNavItem[];
  startScreenId?: string;
  /** Custom CSS injected at runtime. */
  customCss?: string;
  /** View render delay for flicker prevention (ms). */
  viewRenderDelay?: number;
  /** Background color for the shell. */
  backgroundColor?: string;
}

/* ================================================================== */
/*  7. OPERATOR PERMISSIONS                                            */
/* ================================================================== */

/** HMI-level role. */
export type HmiRole =
  | 'viewer'
  | 'operator'
  | 'engineer'
  | 'supervisor'
  | 'admin';

/** Per-widget permission. */
export interface WidgetPermission {
  /** Roles that can see this widget. Empty = all. */
  showRoles: HmiRole[];
  /** Roles that can interact (click/write). Empty = all. */
  enabledRoles: HmiRole[];
}

/** Permission check result for a widget. */
export interface WidgetPermissionResult {
  visible: boolean;
  enabled: boolean;
  requiresConfirm: boolean;
  requiresPin: boolean;
}

/* ================================================================== */
/*  8. TREND CHARTS                                                    */
/* ================================================================== */

/** Chart view mode (FUXA ChartViewType). */
export type ChartViewMode = 'realtime' | 'history' | 'custom';

/** Time range presets. */
export type ChartTimeRange =
  | 'last1h'
  | 'last8h'
  | 'last1d'
  | 'last3d'
  | 'last1w'
  | 'last1m'
  | 'custom';

/** Line interpolation type. */
export type LineInterpolation =
  | 'linear'
  | 'stepAfter'
  | 'stepBefore'
  | 'spline'
  | 'scatter';

/** A single data series in a chart. */
export interface ChartLine {
  id: string;
  tagId: string;
  label: string;
  color: string;
  fill?: string;
  yAxis: 1 | 2 | 3 | 4;
  interpolation: LineInterpolation;
  lineWidth?: number;
  spanGaps?: boolean;
  zones?: ChartLineZone[];
}

/** Value-range-based coloring zone. */
export interface ChartLineZone {
  min: number;
  max: number;
  stroke: string;
  fill: string;
}

/** Chart options (subset of FUXA ChartOptions). */
export interface ChartOptions {
  title?: string;
  fontFamily?: string;
  colorBackground?: string;
  legendMode?: 'always' | 'follow' | 'bottom' | 'never';
  legendFontSize?: number;
  axisLabelColor?: string;
  gridLineColor?: string;
  scaleY1?: { min?: number; max?: number; label?: string };
  scaleY2?: { min?: number; max?: number; label?: string };
  scaleY3?: { min?: number; max?: number; label?: string };
  scaleY4?: { min?: number; max?: number; label?: string };
  decimalsPrecision?: number;
  realtimeWindowMinutes?: number;
  refreshIntervalMinutes?: number;
  hideToolbar?: boolean;
  mouseWheelScroll?: boolean;
  mouseWheelZoom?: boolean;
  staticChart?: boolean;
  dateFormat?: 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY';
  timeFormat?: '24h' | '12h';
  panelHeight?: number;
  panelWidth?: number;
}

/* ================================================================== */
/*  9. HISTORICAL DATA (DAQ)                                           */
/* ================================================================== */

export interface HistoricalDataPoint {
  timestamp: number; // unix ms
  value: number | string | boolean;
}

export interface HistoricalDataResult {
  data: Record<string, HistoricalDataPoint[]>;
  queryId?: string;
}

export type DaqAggregationFunction = 'min' | 'max' | 'avg' | 'sum';

export type DaqAggregationInterval =
  | '1min' | '5min' | '10min' | '30min'
  | '1h' | '1d';

export interface DaqAggregation {
  function: DaqAggregationFunction;
  interval: DaqAggregationInterval;
}

/** Per-tag DAQ persistence settings. */
export interface TagDaqSettings {
  enabled: boolean;
  /** Only save on value change. */
  onChangeOnly: boolean;
  /** Minimum save interval (seconds). */
  intervalSec: number;
  /** Restore last value on startup. */
  restoreOnStartup: boolean;
}

/* ================================================================== */
/*  10. SCRIPT ENGINE                                                  */
/* ================================================================== */

export type ScriptMode = 'server' | 'client';

export type ScriptSchedulingMode = 'interval' | 'start' | 'cron';

export interface ScadaScript {
  id: string;
  name: string;
  code: string;
  mode?: ScriptMode;
  enabled: boolean;
  scheduling?: ScriptScheduling;
  params?: ScriptParam[];
  trigger?: 'event' | 'tagChange' | 'interval' | 'load';
  triggerTag?: string;
  triggerInterval?: number;
  deviceId?: string | null;
}

export interface ScriptScheduling {
  mode: ScriptSchedulingMode;
  /** Interval in seconds (for 'interval' mode). */
  intervalSec?: number;
  /** Delay in seconds after start (for 'start' mode). */
  startDelaySec?: number;
  /** Cron expression (for 'cron' mode). */
  cronExpression?: string;
}

export interface ScriptParam {
  name: string;
  type: 'tagId' | 'value' | 'chart';
  value: unknown;
}

/** Script execution result. */
export interface ScriptResult {
  scriptId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/* ================================================================== */
/*  11. NOTIFICATION                                                   */
/* ================================================================== */

export type NotificationChannel = 'email' | 'webhook';

export interface NotificationConfig {
  id: string;
  channel: NotificationChannel;
  receiver: string; // email address or webhook URL
  /** Which severity levels trigger notification. */
  severities: AlarmSeverity[];
  /** Delay before first notification (minutes). */
  delayMinutes: number;
  /** Repeat interval while alarms are active (minutes, 0 = no repeat). */
  repeatIntervalMinutes: number;
  /** Fire on every new alarm or only once per activation. */
  mode: 'all' | 'single';
  enabled: boolean;
}

/* ================================================================== */
/*  12. VIEW OVERLAY SYSTEM                                            */
/* ================================================================== */

export type OverlayType = 'dialog' | 'card' | 'iframe';

export interface ViewOverlay {
  id: string;
  type: OverlayType;
  screenId?: string;
  url?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  zIndex: number;
  title?: string;
}

/* ================================================================== */
/*  13. ANIMATED PIPE                                                  */
/* ================================================================== */

export type PipeFlowDirection = 'forward' | 'reverse' | 'stop';

export interface PipeConfig {
  borderColor: string;
  borderWidth: number;
  pipeColor: string;
  pipeWidth: number;
  contentColor: string;
  contentWidth: number;
  contentSpace: number;
  /** Image animation along the pipe path. */
  imageAnimation?: {
    imageUrl: string;
    count: number;
    delayMs: number;
  };
}

/* ================================================================== */
/*  14. RUNTIME WIDGET PROPS (shared by all runtime renderers)         */
/* ================================================================== */

/** Base props injected into every widget when rendered in operator mode. */
export interface RuntimeWidgetProps {
  /** Current tag value from data provider. */
  value: unknown;
  /** Timestamp of last update. */
  timestamp: number;
  /** Data quality indicator. */
  quality: TagQuality;
  /** Widget configuration from SCADA package. */
  config: Record<string, unknown>;
  /** True = operator mode (runtime), false = editor mode. */
  isOperatorMode: boolean;
  /** Widget can be seen (permission check passed). */
  isVisible: boolean;
  /** Widget can be interacted with (permission check passed). */
  isEnabled: boolean;
  /** Callback for widget commands (click, toggle, setValue). */
  onCommand?: (command: string, value?: unknown) => void;
  /** Tag-value-driven actions active on this widget. */
  actions?: WidgetAction[];
  /** Event bindings for user interactions. */
  events?: WidgetEventBinding[];
  /** All tag values keyed by tagId (for multi-tag widgets like charts). */
  tagValues?: Record<string, TagValueChange>;
  /** Width/height for responsive rendering. */
  width?: number;
  height?: number;
}

/* ================================================================== */
/*  15. SCHEDULER WIDGET                                               */
/* ================================================================== */

export type SchedulerRecurrence = 'weekly' | 'monthly' | 'once';

export interface SchedulerEvent {
  id: string;
  tagId: string;
  name: string;
  recurrence: SchedulerRecurrence;
  /** Day of week (0-6) for weekly, day of month (1-31) for monthly. */
  days: number[];
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  /** Value to set on start. */
  onValue: unknown;
  /** Value to set on end. */
  offValue: unknown;
  enabled: boolean;
}

/* ================================================================== */
/*  16. REPORT GENERATION                                              */
/* ================================================================== */

export type ReportSchedule = 'none' | 'daily' | 'weekly' | 'monthly';

export interface ReportConfig {
  id: string;
  name: string;
  schedule: ReportSchedule;
  /** Tag IDs with aggregation settings for table data. */
  dataSources: ReportDataSource[];
  /** Email recipients. */
  recipients: string[];
  enabled: boolean;
}

export interface ReportDataSource {
  tagId: string;
  label: string;
  aggregation: DaqAggregation;
}
