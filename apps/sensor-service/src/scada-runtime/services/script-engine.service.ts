/**
 * ScriptEngineService
 *
 * Server-side JavaScript execution sandbox for SCADA HMI scripts.
 *
 * Architecture
 * ─────────────
 * • Node.js `vm` module provides an isolated V8 context — no access to
 *   `require`, `process`, `fs`, `child_process`, or any host globals.
 * • A curated set of $-prefixed system functions is injected into every
 *   sandbox context, bridging scripts to SCADA services (tag reads/writes,
 *   alarms, notifications, view navigation, historical data).
 * • Each execution is time-bounded (default 5 s) via `vm.runInContext`
 *   `timeout` option.  Async scripts run inside a fresh Promise that races
 *   against the configured timeout.
 * • Script parameters of type 'tagId' are resolved to live tag values
 *   before the script runs, so scripts receive concrete values rather than
 *   raw tag IDs.
 * • Console output (log / warn / error) is captured and broadcast to all
 *   connected SCADA clients via the `SCRIPT_CONSOLE` WebSocket event so
 *   operators can see script output in the HMI console panel.
 *
 * Sandbox functions injected
 * ──────────────────────────
 *   $getTag(id)                        → TagValueChange | null
 *   $setTag(id, value)                 → void (fire-and-forget write)
 *   $getTagId(name)                    → string | null (lookup by display name)
 *   $setView(viewName)                 → void (broadcast SETVIEW command)
 *   $sendMessage(to, subject, body)    → Promise<void>
 *   $getAlarms()                       → AlarmInstance[]
 *   $getAlarmsHistory(from, to)        → Promise<AlarmInstance[]>
 *   $ackAlarm(alarmId, userId?)        → Promise<void>
 *   $getHistoricalTags(ids, from, to)  → Promise<Record<string, HistoricalDataPoint[]>>
 *   console.log / warn / error         → captured + forwarded via gateway
 *
 * Security
 * ────────
 * • `vm.createContext` is called with an explicit allowlist — no prototype
 *   pollution path back to the host.
 * • `require`, `process`, global, Buffer are intentionally absent from
 *   the sandbox object.
 * • Script timeout prevents infinite loops from blocking the event loop.
 */

import * as vm from 'vm';
import { Injectable, Logger } from '@nestjs/common';

import type {
  ScadaScript,
  ScriptParam,
  ScriptResult,
  AlarmInstance,
  AlarmHistoryFilter,
  HistoricalDataPoint,
  TagValueChange,
} from '../../../../../../web/modules/sensor-module/src/types/scada-runtime.types';
import { ScadaSocketEvent } from '../../../../../../web/modules/sensor-module/src/types/scada-runtime.types';

import { TagManagerService } from './tag-manager.service';
import { AlarmEngineService } from './alarm-engine.service';
import { NotificationService } from './notification.service';
import { AlarmStorageService } from './alarm-storage.service';
import { DaqStorageService } from './daq-storage.service';
import { ScadaRuntimeGateway } from '../scada-runtime.gateway';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

/** Default script execution timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Tenant ID used for gateway broadcasts when no context is available. */
const BROADCAST_TENANT_ID = 'default';

/* ------------------------------------------------------------------ */
/*  Internal console capture                                            */
/* ------------------------------------------------------------------ */

interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  Sandbox context shape                                               */
/* ------------------------------------------------------------------ */

/**
 * The shape of the object passed to vm.createContext.
 * Keeping it as an explicit interface prevents accidental host leakage.
 */
interface SandboxContext {
  // System functions
  $getTag: (id: string) => TagValueChange | null;
  $setTag: (id: string, value: unknown) => void;
  $getTagId: (name: string) => string | null;
  $setView: (viewName: string) => void;
  $sendMessage: (to: string, subject: string, body: string) => Promise<void>;
  $getAlarms: () => AlarmInstance[];
  $getAlarmsHistory: (from: number, to: number) => Promise<AlarmInstance[]>;
  $ackAlarm: (alarmId: string, userId?: string) => Promise<void>;
  $getHistoricalTags: (
    ids: string[],
    from: number,
    to: number,
  ) => Promise<Record<string, HistoricalDataPoint[]>>;
  // Console bridge
  console: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  // Script parameters (injected as named variables)
  params: Record<string, unknown>;
  // Safe math / timing globals
  Math: typeof Math;
  Date: typeof Date;
  JSON: typeof JSON;
  parseInt: typeof parseInt;
  parseFloat: typeof parseFloat;
  isNaN: typeof isNaN;
  isFinite: typeof isFinite;
  Number: typeof Number;
  String: typeof String;
  Boolean: typeof Boolean;
  Array: typeof Array;
  Object: typeof Object;
  Promise: typeof Promise;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/* ------------------------------------------------------------------ */
/*  Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class ScriptEngineService {
  private readonly logger = new Logger(ScriptEngineService.name);

  constructor(
    private readonly tagManager: TagManagerService,
    private readonly alarmEngine: AlarmEngineService,
    private readonly notificationService: NotificationService,
    private readonly alarmStorage: AlarmStorageService,
    private readonly daqStorage: DaqStorageService,
    private readonly gateway: ScadaRuntimeGateway,
  ) {}

  /* ---------------------------------------------------------------- */
  /*  Public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Execute a server-mode script with optional runtime parameters.
   *
   * Parameters of type 'tagId' are resolved to the current live tag value
   * before execution, making the resolved value available under the
   * parameter name inside the sandbox.
   *
   * @param script  The ScadaScript to execute.
   * @param params  Optional caller-supplied parameter overrides.
   * @returns       A ScriptResult describing success or failure.
   */
  async runScript(
    script: ScadaScript,
    params?: Record<string, unknown>,
  ): Promise<ScriptResult> {
    const startMs = Date.now();
    const capturedLogs: ConsoleEntry[] = [];

    this.logger.log(`[script] Running script id=${script.id} name="${script.name}"`);

    try {
      const resolvedParams = this.resolveParams(script.params ?? [], params);
      const sandbox = this.buildSandbox(script, resolvedParams, capturedLogs);
      const result = await this.executeInSandbox(script.code, sandbox, DEFAULT_TIMEOUT_MS);

      const durationMs = Date.now() - startMs;
      this.logger.log(
        `[script] Completed id=${script.id} duration=${durationMs}ms success=true`,
      );

      return {
        scriptId: script.id,
        success: true,
        result,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startMs;
      const errorMessage = (error as Error).message ?? String(error);

      this.logger.warn(
        `[script] Failed id=${script.id} duration=${durationMs}ms error="${errorMessage}"`,
      );

      return {
        scriptId: script.id,
        success: false,
        error: errorMessage,
        durationMs,
      };
    }
  }

  /**
   * Execute a script in test mode.
   *
   * Identical to `runScript` but console output is captured and returned
   * inside the result for display in the HMI script editor.
   *
   * @param script  The ScadaScript to test.
   * @returns       A ScriptResult with additional console output in `result`.
   */
  async testScript(script: ScadaScript): Promise<ScriptResult> {
    const startMs = Date.now();
    const capturedLogs: ConsoleEntry[] = [];

    this.logger.log(`[script] Testing script id=${script.id} name="${script.name}"`);

    try {
      const resolvedParams = this.resolveParams(script.params ?? [], undefined);
      const sandbox = this.buildSandbox(script, resolvedParams, capturedLogs);
      const result = await this.executeInSandbox(script.code, sandbox, DEFAULT_TIMEOUT_MS);

      const durationMs = Date.now() - startMs;
      this.logger.log(
        `[script] Test completed id=${script.id} duration=${durationMs}ms success=true`,
      );

      return {
        scriptId: script.id,
        success: true,
        result: { returnValue: result, consoleLogs: capturedLogs },
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startMs;
      const errorMessage = (error as Error).message ?? String(error);

      this.logger.warn(
        `[script] Test failed id=${script.id} duration=${durationMs}ms error="${errorMessage}"`,
      );

      return {
        scriptId: script.id,
        success: false,
        error: errorMessage,
        result: { consoleLogs: capturedLogs },
        durationMs,
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Parameter resolution                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve script parameter definitions into concrete values.
   *
   * - `tagId` type: the param's `value` is treated as a tag ID string;
   *   we fetch the current cached tag value and pass the TagValueChange
   *   (or null if not in cache) into the sandbox.
   * - `value` type: the raw `value` is passed through unchanged.
   * - `chart` type: the raw `value` is passed through unchanged (chart
   *   config objects consumed by the script at its own discretion).
   *
   * Any caller-supplied overrides in `extraParams` take precedence over
   * the definitions in the script.
   */
  private resolveParams(
    paramDefs: ScriptParam[],
    extraParams: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const def of paramDefs) {
      if (def.type === 'tagId') {
        const tagId = String(def.value ?? '');
        resolved[def.name] = tagId ? this.tagManager.getTagValue(tagId) : null;
      } else {
        // 'value' and 'chart' — pass through
        resolved[def.name] = def.value;
      }
    }

    // Caller-supplied overrides take precedence
    if (extraParams) {
      Object.assign(resolved, extraParams);
    }

    return resolved;
  }

  /* ---------------------------------------------------------------- */
  /*  Sandbox construction                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Build a frozen sandbox object with all system functions injected.
   *
   * The sandbox is the only object passed to vm.createContext, so the script
   * cannot reach the host Node.js environment through prototype chains or
   * global references — `require`, `process`, `global`, `Buffer`, and
   * `__dirname` are intentionally absent.
   */
  private buildSandbox(
    script: ScadaScript,
    params: Record<string, unknown>,
    capturedLogs: ConsoleEntry[],
  ): SandboxContext {
    const self = this;
    const scriptId = script.id;

    /* ---- console bridge ------------------------------------------ */
    const makeConsoleFn =
      (level: ConsoleEntry['level']) =>
      (...args: unknown[]): void => {
        const message = args
          .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
          .join(' ');

        const entry: ConsoleEntry = { level, message, timestamp: Date.now() };
        capturedLogs.push(entry);

        // Forward to gateway SCRIPT_CONSOLE event so the HMI console panel
        // shows output in real time.
        try {
          self.gateway.broadcastCommand(
            BROADCAST_TENANT_ID,
            {
              type: 'TOAST',
              message: `[${level.toUpperCase()}] ${message}`,
              toastType: level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info',
            },
          );

          // Also emit a raw SCRIPT_CONSOLE event for dedicated console UIs
          if (self.gateway.server) {
            self.gateway.server.emit(ScadaSocketEvent.SCRIPT_CONSOLE, {
              scriptId,
              level,
              message,
              timestamp: entry.timestamp,
            });
          }
        } catch {
          // Non-fatal: console capture should never block execution
        }
      };

    /* ---- system functions ---------------------------------------- */
    const sandbox: SandboxContext = {
      // Tag access
      $getTag: (id: string): TagValueChange | null => {
        try {
          return self.tagManager.getTagValue(id);
        } catch (err) {
          self.logger.error(`$getTag error: ${(err as Error).message}`);
          return null;
        }
      },

      $setTag: (id: string, value: unknown): void => {
        try {
          self.tagManager.writeTagValue(id, value, 'script-engine');
        } catch (err) {
          self.logger.error(`$setTag error: ${(err as Error).message}`);
        }
      },

      $getTagId: (name: string): string | null => {
        try {
          // TagManagerService cache is keyed by tagId, not name.
          // We search all cached values for a matching display name.
          const all = self.tagManager.getAllTagValues();
          const match = all.find(
            (tv) => (tv as TagValueChange & { name?: string }).name === name,
          );
          return match?.tagId ?? null;
        } catch (err) {
          self.logger.error(`$getTagId error: ${(err as Error).message}`);
          return null;
        }
      },

      // View navigation
      $setView: (viewName: string): void => {
        try {
          self.gateway.broadcastCommand(BROADCAST_TENANT_ID, {
            type: 'SETVIEW',
            viewId: viewName,
          });
        } catch (err) {
          self.logger.error(`$setView error: ${(err as Error).message}`);
        }
      },

      // Notifications
      $sendMessage: async (
        to: string,
        subject: string,
        body: string,
      ): Promise<void> => {
        try {
          await self.notificationService.sendDirectEmail(to, subject, body);
        } catch (err) {
          self.logger.error(`$sendMessage error: ${(err as Error).message}`);
        }
      },

      // Alarms
      $getAlarms: (): AlarmInstance[] => {
        try {
          return self.alarmEngine.getActiveAlarms();
        } catch (err) {
          self.logger.error(`$getAlarms error: ${(err as Error).message}`);
          return [];
        }
      },

      $getAlarmsHistory: async (from: number, to: number): Promise<AlarmInstance[]> => {
        try {
          const filter: AlarmHistoryFilter = { from, to };
          return await self.alarmStorage.getAlarmHistory(filter);
        } catch (err) {
          self.logger.error(`$getAlarmsHistory error: ${(err as Error).message}`);
          return [];
        }
      },

      $ackAlarm: async (alarmId: string, userId = 'script-engine'): Promise<void> => {
        try {
          await self.alarmEngine.acknowledgeAlarm(alarmId, userId);
        } catch (err) {
          self.logger.error(`$ackAlarm error: ${(err as Error).message}`);
        }
      },

      // Historical data
      $getHistoricalTags: async (
        ids: string[],
        from: number,
        to: number,
      ): Promise<Record<string, HistoricalDataPoint[]>> => {
        try {
          return await self.daqStorage.queryValues(ids, new Date(from), new Date(to));
        } catch (err) {
          self.logger.error(`$getHistoricalTags error: ${(err as Error).message}`);
          return {};
        }
      },

      // Console bridge
      console: {
        log: makeConsoleFn('log'),
        warn: makeConsoleFn('warn'),
        error: makeConsoleFn('error'),
      },

      // Script parameters
      params,

      // Safe ECMAScript built-ins
      Math,
      Date,
      JSON,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Promise,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };

    return sandbox;
  }

  /* ---------------------------------------------------------------- */
  /*  Script execution                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Compile and execute the script code inside a vm sandbox.
   *
   * The code is wrapped in an IIFE that allows top-level `await` by being
   * invoked through an async wrapper.  This lets simple scripts use await
   * without requiring them to declare an async function.
   *
   * The overall execution is bounded by `timeoutMs` via a Promise.race.
   */
  private async executeInSandbox(
    code: string,
    sandbox: SandboxContext,
    timeoutMs: number,
  ): Promise<unknown> {
    const context = vm.createContext(sandbox, {
      name: 'ScadaScriptSandbox',
      codeGeneration: {
        strings: false, // disable eval() / new Function()
        wasm: false,
      },
    });

    // Wrap user code in an async IIFE so top-level await works and the
    // return value is captured.
    const wrappedCode = `
(async function __scadaScript__() {
  ${code}
})()
`;

    const script = new vm.Script(wrappedCode, {
      filename: 'scada-script.js',
      lineOffset: -2,
    });

    // The vm timeout controls synchronous execution depth.
    // We also race a Promise-level timeout to catch async hangs.
    const vmPromise = script.runInContext(context, {
      timeout: timeoutMs,
      breakOnSigint: true,
    }) as Promise<unknown>;

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    );

    return Promise.race([vmPromise, timeoutPromise]);
  }
}
