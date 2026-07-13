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
import { ScadaSocketEvent } from '../scada-types';

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
   * Tenant this script runtime is bound to. Script SCADA APIs read tenant-
   * scoped alarm/history storage and broadcast to the tenant's HMI room, so
   * the runtime starts UNBOUND and refuses those operations until an
   * activation binds a real tenant (DB-SENSOR-CRITICAL-001) — no more
   * hardcoded 'default' bucket every tenant would share.
   */
  private boundTenantId: string | null = null;

  /** Bind this script runtime to a tenant. */
  setTenantId(tenantId: string): void {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error('ScriptEngineService.setTenantId: a non-empty tenantId is required');
    }
    this.boundTenantId = tenantId;
  }

  /** Return the bound tenant or throw — every tenant-scoped script API uses this. */
  private requireTenant(): string {
    if (this.boundTenantId == null) {
      throw new Error(
        'ScriptEngineService: no tenant bound — call setTenantId() before running tenant-scoped scripts',
      );
    }
    return this.boundTenantId;
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
      const bridges = this.buildSandbox(script, resolvedParams, capturedLogs);
      const result = await runInSandbox(script.code, bridges);

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
      const bridges = this.buildSandbox(script, resolvedParams, capturedLogs);
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
        // shows output in real time.
        try {
          this.gateway.broadcastCommand(
            this.requireTenant(),
            {
              type: 'TOAST',
              message: `[${level.toUpperCase()}] ${message}`,
              toastType: level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info',
            },
          );

          // Also emit a raw SCRIPT_CONSOLE event for dedicated console UIs
          if (this.gateway.server) {
            this.gateway.server.emit(ScadaSocketEvent.SCRIPT_CONSOLE, {
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

    return {
      /* ---- synchronous system functions -------------------------- */
      sync: {
        // Tag access
        $getTag: (id: unknown): TagValueChange | null => {
          try {
            return this.tagManager.getTagValue(String(id));
          } catch (err) {
            this.logger.error(`$getTag error: ${(err as Error).message}`);
            return null;
          }
        },

        $setTag: (id: unknown, value: unknown): void => {
          try {
            // Script writes run in the process-global runtime; route them to
            // that runtime's tenant (RT-011 will make the engine per-tenant).
            this.tagManager.writeTagValue(String(id), value, 'script-engine', this.alarmEngine.getTenantId());
          } catch (err) {
            this.logger.error(`$setTag error: ${(err as Error).message}`);
          }
        },

        $getTagId: (name: unknown): string | null => {
          try {
            // TagManagerService cache is keyed by tagId, not name.
            // We search all cached values for a matching display name.
            const all = this.tagManager.getAllTagValues();
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
            this.gateway.broadcastCommand(this.requireTenant(), {
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
            return this.alarmEngine.getActiveAlarms();
          } catch (err) {
            this.logger.error(`$getAlarms error: ${(err as Error).message}`);
            return [];
          }
        },
      },

      /* ---- asynchronous system functions (asyncify) -------------- */
      async: {
        // Notifications
        $sendMessage: async (
          to: unknown,
          subject: unknown,
          body: unknown,
        ): Promise<void> => {
          try {
            await this.notificationService.sendDirectEmail(String(to), String(subject), String(body));
          } catch (err) {
            this.logger.error(`$sendMessage error: ${(err as Error).message}`);
          }
        },

        $getAlarmsHistory: async (from: unknown, to: unknown): Promise<AlarmInstance[]> => {
          try {
            const filter: AlarmHistoryFilter = { from: Number(from), to: Number(to) };
            return await this.alarmStorage.getAlarmHistory(this.requireTenant(), filter);
          } catch (err) {
            this.logger.error(`$getAlarmsHistory error: ${(err as Error).message}`);
            return [];
          }
        },

        $ackAlarm: async (alarmId: unknown, userId: unknown = 'script-engine'): Promise<void> => {
          try {
            await this.alarmEngine.acknowledgeAlarm(String(alarmId), String(userId));
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
            // runs under this engine's own fail-closed tenant binding (same
            // source as the write/broadcast paths above).
            const idList = Array.isArray(ids) ? ids.map((id) => String(id)) : [];
            return await this.daqStorage.queryValues(
              this.requireTenant(),
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
