/**
 * Type definitions for the SCADA client-side scripting system.
 *
 * Scripts execute in Web Worker sandboxes with a narrow, audited API surface.
 * No DOM access, no network access, no eval -- only SCADA operations.
 *
 * Security architecture:
 * - User code runs exclusively inside Web Workers (separate V8 isolates)
 * - Workers are created from inline Blob URLs (no external script files)
 * - Dangerous globals (fetch, XMLHttpRequest, importScripts, eval) are
 *   deleted before any user code executes
 * - All $api calls are asynchronous messages to the main thread where they
 *   undergo validation before routing to TagValueBus or WidgetEventBus
 * - Execution timeout enforced by the main thread via Worker.terminate()
 * - Tag write rate limiting prevents flooding the data bus
 */

/** Script trigger determines when a script executes */
export type ScriptTrigger = 'event' | 'tagChange' | 'interval' | 'load';

/** Primitive value types that can flow through the tag bus */
export type TagPrimitive = number | string | boolean;

/** Alarm severity levels for $setAlarm scripting API */
export type AlarmLevel = 'info' | 'warning' | 'critical' | 'emergency';

/** Script definition stored in a SCADA package */
export interface ScadaScript {
  id: string;
  name: string;
  code: string;
  trigger: ScriptTrigger;
  /** Tag name that triggers re-execution (for tagChange trigger) */
  triggerTag?: string;
  /** Interval in ms (for interval trigger, min 1000ms) */
  triggerInterval?: number;
  /** Whether script is enabled */
  enabled: boolean;
  /** Optional device ID for tag scope resolution in multi-device packages */
  deviceId?: string | null;
}

/** Message from main thread to worker */
export interface WorkerRequest {
  type: 'execute';
  scriptId: string;
  code: string;
  tagValues: Record<string, TagPrimitive>;
  params?: Record<string, unknown>;
  /**
   * Snapshot of widget config properties for $getProperty access.
   * Structure: { widgetId: { propertyName: primitiveValue } }
   *
   * Only primitive-valued config fields are included -- objects, arrays,
   * and functions are filtered out. This is a read-only snapshot taken
   * at execution start, not a live reference to the store.
   */
  widgetProperties?: Record<string, Record<string, TagPrimitive>>;
}

/** Message from worker to main thread */
export interface WorkerResponse {
  type: 'result' | 'api-call' | 'error' | 'log';
  scriptId: string;
  /** For api-call type: which sandbox method was called */
  apiMethod?: string;
  /** For api-call type: arguments passed to the sandbox method */
  apiArgs?: unknown[];
  /** For result type: return value from the user script */
  returnValue?: unknown;
  /** For error type: error message from the script execution */
  error?: string;
  /** For log type: the log message */
  message?: string;
  /** For log type: severity level */
  level?: 'info' | 'warn' | 'error';
}

/** API methods available inside the worker sandbox */
export interface ScriptSandboxAPI {
  /** Read the current value of a tag from the snapshot */
  $getTag: (tagName: string) => TagPrimitive;
  /** Write a value to a tag (rate-limited, async via postMessage) */
  $setTag: (tagName: string, value: TagPrimitive) => void;
  /** Navigate to another SCADA screen */
  $navigate: (screenId: string) => void;
  /** Open a SCADA screen as a floating card overlay */
  $openCard: (screenId: string, options?: { width?: number; height?: number }) => void;
  /** Open an external URL (validated: https only) */
  $openUrl: (url: string) => void;
  /** Log a message to the script console (rate-limited) */
  $log: (message: string) => void;
  /**
   * Dynamically change a widget's config property at runtime.
   * The bridge between scripting and the visual layer -- enables patterns
   * like "when pH drops below 6, turn tank border red" without
   * pre-configured animation rules.
   *
   * Security: propertyPath is validated against prototype pollution.
   * Only config-level properties are writable (not id, type, position).
   * The property change is dispatched to the Zustand store, not applied
   * directly to the DOM -- maintaining the single source of truth.
   *
   * Rate-limited: shares the write budget with $setTag.
   */
  $setProperty: (widgetId: string, propertyPath: string, value: TagPrimitive) => void;
  /**
   * Read a widget's config property from the pre-populated snapshot.
   * Enables conditional logic based on widget state without
   * requiring a separate tag for each property.
   *
   * Returns the property value synchronously from the store snapshot
   * provided at script execution start. Returns undefined if the
   * widget or property does not exist in the snapshot.
   */
  $getProperty: (widgetId: string, propertyPath: string) => TagPrimitive | undefined;
  /**
   * Close the topmost overlay (PopupCard or ModalDialog) from a script.
   * Enables "Close" buttons inside script-driven dialogs.
   * No-op when no overlay is open.
   */
  $closeDialog: () => void;
  /**
   * Programmatically raise an alarm from a script. Enables complex
   * alarm conditions that cannot be expressed as simple threshold rules
   * (e.g., "if temperature rises more than 5 degrees C in 10 minutes").
   *
   * Level: 'info' | 'warning' | 'critical' | 'emergency'
   * The alarm is added to the package's runtime alarm list and
   * triggers any configured alarm visual indicators.
   *
   * Message length capped at 500 characters to prevent abuse.
   */
  $setAlarm: (tagName: string, level: AlarmLevel, message: string) => void;
}

/** Execution result returned by ScriptExecutor.execute() */
export interface ScriptExecutionResult {
  success: boolean;
  error?: string;
  logs: string[];
  tagWrites: number;
  durationMs: number;
}

/**
 * Execution constraints for security.
 *
 * These limits are intentionally conservative for a multi-tenant SaaS
 * environment. A misbehaving script in one tenant's SCADA package must
 * not degrade performance for other tenants sharing the browser tab
 * (e.g., when multiple packages are open in different tabs).
 */
export const SANDBOX_LIMITS = {
  /** Maximum execution time per script invocation (ms) */
  TIMEOUT_MS: 500,
  /** Maximum tag writes per invocation (prevents flooding) */
  MAX_TAG_WRITES: 50,
  /** Maximum worker instances in the pool */
  MAX_WORKERS: 4,
  /** Minimum interval for interval-triggered scripts (ms) */
  MIN_INTERVAL_MS: 1000,
  /** Maximum script code size in bytes */
  MAX_CODE_SIZE: 50_000,
  /** Maximum log messages per invocation */
  MAX_LOGS: 20,
} as const;
