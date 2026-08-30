/**
 * ScriptEngineService
 *
 * Server-side JavaScript execution sandbox for SCADA HMI scripts.
 *
 * Architecture
 * ─────────────
 * • Tenant-authored scripts run inside a QuickJS interpreter compiled to
 *   WebAssembly (see `quickjs-sandbox.ts`). The guest executes in an isolated
 *   linear-memory heap with its own built-ins and no ambient reference to any
 *   host object — `process`, `require`, `Buffer`, `global` are structurally
 *   unreachable, so this is a real security boundary (Node's `vm` is not).
 * • A curated set of $-prefixed system functions is bridged into every sandbox,
 *   connecting scripts to SCADA services (tag reads/writes, alarms,
 *   notifications, view navigation, historical data). Sync bridges are plain
 *   host functions; async bridges are exposed via QuickJS asyncify so the guest
 *   can `await` them.
 * • Each execution is bounded (default 5 s): an interrupt handler aborts
 *   synchronous hot loops and the returned guest promise is raced against the
 *   same deadline so a never-settling `await` cannot hang the host. Memory and
 *   stack are capped too.
 * • Script parameters of type 'tagId' are resolved to live tag values before
 *   the script runs, so scripts receive concrete values rather than raw tag IDs.
 * • Console output (log / warn / error) is captured and broadcast to all
 *   connected SCADA clients via the `SCRIPT_CONSOLE` WebSocket event so
 *   operators can see script output in the HMI console panel.
 *
 * Sandbox functions bridged
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
 */

import { Injectable, Logger } from '@nestjs/common';

import type {
  ScadaScript,
  ScriptParam,
  ScriptResult,
  AlarmInstance,
  AlarmHistoryFilter,
  HistoricalDataPoint,
  TagValueChange,
} from '../scada-types';

import { TagManagerService } from './tag-manager.service';
import { AlarmEngineService } from './alarm-engine.service';
import { NotificationService } from './notification.service';
import { AlarmStorageService } from './alarm-storage.service';
import { DaqStorageService } from './daq-storage.service';
import { ScadaRuntimeGateway } from '../scada-runtime.gateway';
import { runInSandbox } from './quickjs-sandbox';
import type { SandboxBridges } from './quickjs-sandbox';

/* ------------------------------------------------------------------ */
/*  Internal console capture                                            */
/* ------------------------------------------------------------------ */

interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class ScriptEngineService {
  private readonly logger = new Logger(ScriptEngineService.name);

  /**
   * The tenant is supplied PER RUN (RT-011): this singleton executes scripts
   * for whichever tenant's scheduled/triggered script fires, so every
   * tenant-scoped SCADA API (tag read/write, alarm read/ack, history, HMI
   * broadcast) is fenced to the run's own tenant rather than a shared binding.
   * A non-empty tenant is validated at the entry points below.
   */
  private static assertTenant(tenantId: string): string {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error('ScriptEngineService: a non-empty tenantId is required to run a script');
    }
    return tenantId;
  }

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
   * @param tenantId  The tenant this run executes for — fences every $-bridge.
   * @param script  The ScadaScript to execute.
   * @param params  Optional caller-supplied parameter overrides.
   * @returns       A ScriptResult describing success or failure.
   */
  async runScript(
    tenantId: string,
    script: ScadaScript,
    params?: Record<string, unknown>,
  ): Promise<ScriptResult> {
    const startMs = Date.now();
    const capturedLogs: ConsoleEntry[] = [];

    this.logger.log(`[script] Running script id=${script.id} name="${script.name}"`);

    try {
      // Fail-closed: an invalid tenant throws here, before any sandbox/bridge
      // exists — a tenant-less run never reads, writes, or broadcasts.
      ScriptEngineService.assertTenant(tenantId);
      const resolvedParams = this.resolveParams(tenantId, script.params ?? [], params);
      const bridges = this.buildSandbox(tenantId, script, resolvedParams, capturedLogs);
      const result = await runInSandbox(script.code, bridges);

      const durationMs = Date.now() - startMs;
      this.logger.log(`[script] Completed id=${script.id} duration=${durationMs}ms success=true`);

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
   * @param tenantId  The tenant this test run executes for — fences every $-bridge.
   * @param script  The ScadaScript to test.
   * @returns       A ScriptResult with additional console output in `result`.
   */
  async testScript(tenantId: string, script: ScadaScript): Promise<ScriptResult> {
    const startMs = Date.now();
    const capturedLogs: ConsoleEntry[] = [];

    this.logger.log(`[script] Testing script id=${script.id} name="${script.name}"`);

    try {
      ScriptEngineService.assertTenant(tenantId);
      const resolvedParams = this.resolveParams(tenantId, script.params ?? [], undefined);
      const bridges = this.buildSandbox(tenantId, script, resolvedParams, capturedLogs);
      const result = await runInSandbox(script.code, bridges);

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
    tenantId: string,
    paramDefs: ScriptParam[],
    extraParams: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const def of paramDefs) {
      if (def.type === 'tagId') {
        const tagId = String(def.value ?? '');
        resolved[def.name] = tagId ? this.tagManager.getTagValue(tenantId, tagId) : null;
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
   * Build the host bridge surface exposed to a sandboxed script.
   *
   * The returned object is the ONLY host-derived state the guest can reach:
   * the `$`-prefixed system functions (split into sync and asyncify-bridged
   * async), the `console` capture, and the resolved `params`. Everything else
   * the script sees (`Math`, `JSON`, `Date`, `Promise`, `Array`, …) is
   * QuickJS's own isolated built-in, so no prototype chain leads back to the
   * host — `require`, `process`, `global`, `Buffer` are structurally absent.
   */
  private buildSandbox(
    tenantId: string,
    script: ScadaScript,
    params: Record<string, unknown>,
    capturedLogs: ConsoleEntry[],
  ): SandboxBridges {
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
        // shows output in real time — scoped to the run's tenant room so one
        // tenant's script output never reaches another tenant's console.
        try {
          this.gateway.broadcastCommand(tenantId, {
            type: 'TOAST',
            message: `[${level.toUpperCase()}] ${message}`,
            toastType: level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info',
          });

          // Raw SCRIPT_CONSOLE event for dedicated console UIs, tenant-fenced.
          this.gateway.pushScriptConsole(tenantId, {
            scriptId,
            level,
            message,
            timestamp: entry.timestamp,
          });
        } catch {
          // Non-fatal: console capture should never block execution
        }
      };

    return {
      /* ---- synchronous system functions -------------------------- */
      sync: {
        // Tag access
        $getTag: (id: unknown): TagValueChange | null => {
          try {
            return this.tagManager.getTagValue(tenantId, String(id));
          } catch (err) {
            this.logger.error(`$getTag error: ${(err as Error).message}`);
            return null;
          }
        },

        $setTag: (id: unknown, value: unknown): void => {
          try {
            // The write is fenced to the run's own tenant (RT-011) — a script
            // can only actuate its own tenant's device.
            this.tagManager.writeTagValue(String(id), value, 'script-engine', tenantId);
          } catch (err) {
            this.logger.error(`$setTag error: ${(err as Error).message}`);
          }
        },

        $getTagId: (name: unknown): string | null => {
          try {
            // TagManagerService cache is keyed by tagId, not name.
            // We search this tenant's cached values for a matching display name.
            const all = this.tagManager.getAllTagValues(tenantId);
            const match = all.find(
              (tv) => (tv as TagValueChange & { name?: string }).name === name,
            );
            return match?.tagId ?? null;
          } catch (err) {
            this.logger.error(`$getTagId error: ${(err as Error).message}`);
            return null;
          }
        },

        // View navigation
        $setView: (viewName: unknown): void => {
          try {
            this.gateway.broadcastCommand(tenantId, {
              type: 'SETVIEW',
              viewId: String(viewName),
            });
          } catch (err) {
            this.logger.error(`$setView error: ${(err as Error).message}`);
          }
        },

        // Alarms (read)
        $getAlarms: (): AlarmInstance[] => {
          try {
            return this.alarmEngine.getActiveAlarms(tenantId);
          } catch (err) {
            this.logger.error(`$getAlarms error: ${(err as Error).message}`);
            return [];
          }
        },
      },

      /* ---- asynchronous system functions (asyncify) -------------- */
      async: {
        // Notifications
        $sendMessage: async (to: unknown, subject: unknown, body: unknown): Promise<void> => {
          try {
            await this.notificationService.sendDirectEmail(
              String(to),
              String(subject),
              String(body),
            );
          } catch (err) {
            this.logger.error(`$sendMessage error: ${(err as Error).message}`);
          }
        },

        $getAlarmsHistory: async (from: unknown, to: unknown): Promise<AlarmInstance[]> => {
          try {
            const filter: AlarmHistoryFilter = { from: Number(from), to: Number(to) };
            return await this.alarmStorage.getAlarmHistory(tenantId, filter);
          } catch (err) {
            this.logger.error(`$getAlarmsHistory error: ${(err as Error).message}`);
            return [];
          }
        },

        $ackAlarm: async (alarmId: unknown, userId: unknown = 'script-engine'): Promise<void> => {
          try {
            await this.alarmEngine.acknowledgeAlarm(tenantId, String(alarmId), String(userId));
          } catch (err) {
            this.logger.error(`$ackAlarm error: ${(err as Error).message}`);
          }
        },

        // Historical data
        $getHistoricalTags: async (
          ids: unknown,
          from: unknown,
          to: unknown,
        ): Promise<Record<string, HistoricalDataPoint[]>> => {
          try {
            // Tenant-fenced history read (SENSOR-HIGH-053): the script sandbox
            // reads only the run's own tenant history (same tenant as the
            // write/broadcast paths above).
            const idList = Array.isArray(ids) ? ids.map((id) => String(id)) : [];
            return await this.daqStorage.queryValues(
              tenantId,
              idList,
              new Date(Number(from)),
              new Date(Number(to)),
            );
          } catch (err) {
            this.logger.error(`$getHistoricalTags error: ${(err as Error).message}`);
            return {};
          }
        },
      },

      /* ---- console bridge ---------------------------------------- */
      console: {
        log: makeConsoleFn('log'),
        warn: makeConsoleFn('warn'),
        error: makeConsoleFn('error'),
      },

      /* ---- script parameters ------------------------------------- */
      params,
    };
  }
}
