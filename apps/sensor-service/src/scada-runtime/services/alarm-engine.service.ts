/**
 * AlarmEngineService
 *
 * Server-side alarm evaluation loop (FUXA pattern), multi-tenant (RT-011).
 *
 * Architecture
 * ─────────────
 * • ONE 1-second evaluation tick (setInterval) drives EVERY active tenant.
 * • Per-tenant state lives in `tenants: Map<tenantId, TenantAlarmState>`; a
 *   tenant is ACTIVE iff it has an entry. The loop iterates each active tenant
 *   and, for each of its enabled AlarmRuleRuntime, reads the tenant-qualified
 *   tag value from TagManagerService, applies bitmask, compares to threshold.
 * • 4-state machine per rule (per tenant):
 *     INACTIVE → ACTIVE (condition true for ≥ timeDelay seconds)
 *              → CLEARED (condition false + outside deadband)
 *              → ACKNOWLEDGED (operator acked)
 *              → back to INACTIVE once fully resolved.
 * • ACK modes:
 *     float      — alarm auto-resolves when condition clears (no ack required)
 *     ackActive  — can ack while ACTIVE or CLEARED
 *     ackPassive — can only ack when CLEARED
 * • Alarm actions executed on ACTIVE transition:
 *     toastMessage, popup, setView → pushed as pendingActions via gateway
 *     setValue → written to TagManagerService (under the owning tenant)
 *     runScript → TODO stub (emits internal event for script engine)
 * • AlarmStatusSummary pushed to each tenant's clients via the gateway every
 *   tick, scoped to that tenant's room.
 * • Rules/configs are injected per tenant via setAlarmRules(tenantId, …) /
 *   setNotificationConfigs(tenantId, …); the activation bridge that calls them
 *   is owned elsewhere (project-load / package-publish). This service does not
 *   own the rule definitions.
 *
 * Tenant isolation (DB-SENSOR-CRITICAL-001, RT-011)
 * ─────────────────────────────────────────────────
 * There is no shared/default bucket: every read, persist, and broadcast is
 * keyed by the tenant that owns the rule being evaluated. A tenant with no
 * entry is simply not evaluated — cross-tenant alarm state is structurally
 * impossible rather than defended against at each call site.
 *
 * Separation of concerns
 * ──────────────────────
 * Engine  → evaluates conditions, manages state machine
 * Storage → persists to DB (AlarmStorageService)
 * Notify  → delivers email/webhook (NotificationService)
 * Gateway → pushes WebSocket events (ScadaRuntimeGateway)
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';

import {
  SCADA_ALARM_ACK_EVENT,
  SCADA_ALARM_ACK_ALL_EVENT,
  type AlarmAckRequest,
  type AlarmAckAllRequest,
} from './alarm-ack.events';

import type {
  AlarmRuleRuntime,
  AlarmInstance,
  AlarmStatusSummary,
  AlarmRuntimeStatus,
  AlarmActionCommand,
  NotificationConfig,
} from '../scada-types';

import {
  evaluateCondition as coreEvaluateCondition,
  isOutsideDeadband as coreIsOutsideDeadband,
  delayElapsed as coreDelayElapsed,
} from '@platform/alarm-core';

import { ScadaRuntimeGateway } from '../scada-runtime.gateway';
import { TagManagerService } from './tag-manager.service';
import { AlarmStorageService } from './alarm-storage.service';
import { NotificationService } from './notification.service';
import type { ScadaAlarm, ScadaAlarmChronicle } from '../entities/alarm.entity';

/* ------------------------------------------------------------------ */
/*  Internal per-rule evaluation state                                 */
/* ------------------------------------------------------------------ */

interface RuleEvalState {
  /** Unix ms when the condition first became true (for timeDelay). */
  conditionTrueAt: number | null;
  /** The active AlarmInstance, if one exists. */
  alarm: AlarmInstance | null;
  /** True if we already executed "on-activate" actions this cycle. */
  actionsExecuted: boolean;
}

/* ------------------------------------------------------------------ */
/*  Per-tenant evaluation state                                        */
/* ------------------------------------------------------------------ */

/** All in-memory alarm evaluation state owned by one active tenant. */
interface TenantAlarmState {
  /** Alarm rules loaded for this tenant. */
  rules: AlarmRuleRuntime[];
  /** Notification configs loaded for this tenant. */
  notificationConfigs: NotificationConfig[];
  /** ruleId → per-rule evaluation state. */
  evalState: Map<string, RuleEvalState>;
  /** Action commands queued for this tenant's next status push. */
  pendingActions: AlarmActionCommand[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const EVAL_INTERVAL_MS = 1_000;

/* ------------------------------------------------------------------ */
/*  Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class AlarmEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlarmEngineService.name);

  /**
   * Per-tenant evaluation state. A tenant is ACTIVE iff it has an entry here.
   * The single 1 Hz loop iterates every active tenant; an empty map means the
   * engine evaluates for no one — there is no default/shared bucket any tenant
   * could collide in, so cross-tenant alarm state is structurally impossible
   * (DB-SENSOR-CRITICAL-001 preserved by construction).
   */
  private readonly tenants = new Map<string, TenantAlarmState>();

  private evalInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tagManager: TagManagerService,
    private readonly gateway: ScadaRuntimeGateway,
    private readonly storage: AlarmStorageService,
    private readonly notification: NotificationService,
  ) {}

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  onModuleInit(): void {
    this.startEvalLoop();
    this.logger.log('AlarmEngineService started — evaluation loop running at 1 Hz');
  }

  onModuleDestroy(): void {
    this.stopEvalLoop();
    this.logger.log('AlarmEngineService stopped');
  }

  private startEvalLoop(): void {
    if (this.evalInterval) return;
    this.evalInterval = setInterval(() => {
      try {
        this.evaluateTick();
      } catch (error) {
        this.logger.error(`evaluateTick error: ${(error as Error).message}`);
      }
    }, EVAL_INTERVAL_MS);
  }

  private stopEvalLoop(): void {
    if (this.evalInterval) {
      clearInterval(this.evalInterval);
      this.evalInterval = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Configuration injection (per tenant)                              */
  /* ---------------------------------------------------------------- */

  /** Get-or-create the evaluation-state bucket for a tenant. */
  private getOrCreateTenant(tenantId: string): TenantAlarmState {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error('AlarmEngineService: a non-empty tenantId is required');
    }
    let state = this.tenants.get(tenantId);
    if (!state) {
      state = { rules: [], notificationConfigs: [], evalState: new Map(), pendingActions: [] };
      this.tenants.set(tenantId, state);
    }
    return state;
  }

  /** Inject a tenant's alarm rules (activates the tenant if not already active). */
  setAlarmRules(tenantId: string, rules: AlarmRuleRuntime[]): void {
    const state = this.getOrCreateTenant(tenantId);
    state.rules = rules;
    // Remove stale eval state for rules that no longer exist
    const ruleIds = new Set(rules.map((r) => r.id));
    for (const [id] of state.evalState) {
      if (!ruleIds.has(id)) {
        state.evalState.delete(id);
      }
    }
    this.logger.log(`AlarmEngineService: tenant=${tenantId} loaded ${rules.length} alarm rule(s)`);
  }

  /** Inject a tenant's notification configs. */
  setNotificationConfigs(tenantId: string, configs: NotificationConfig[]): void {
    this.getOrCreateTenant(tenantId).notificationConfigs = configs;
  }

  /** Deactivate a tenant: stop evaluating it and drop all its in-memory state. */
  deactivateTenant(tenantId: string): void {
    if (this.tenants.delete(tenantId)) {
      this.logger.log(`AlarmEngineService: tenant=${tenantId} deactivated`);
    }
  }

  /** True if the tenant currently has active evaluation state. */
  isTenantActive(tenantId: string): boolean {
    return this.tenants.has(tenantId);
  }

  /* ---------------------------------------------------------------- */
  /*  Main evaluation tick                                              */
  /* ---------------------------------------------------------------- */

  private evaluateTick(): void {
    const now = Date.now();

    // One loop drives every active tenant. No tenants ⇒ no work — the engine
    // evaluates for no one rather than defaulting to a shared bucket.
    for (const [tenantId, state] of this.tenants) {
      for (const rule of state.rules) {
        if (!rule.enabled) continue;
        this.evaluateRule(tenantId, state, rule, now);
      }
      // Push status summary to this tenant's clients only.
      this.pushStatusSummary(tenantId, state);
    }
  }

  private evaluateRule(
    tenantId: string,
    state: TenantAlarmState,
    rule: AlarmRuleRuntime,
    now: number,
  ): void {
    // Get tag value from the tenant-qualified cache
    const tagChange = this.tagManager.getTagValue(tenantId, rule.tagId);
    if (!tagChange) return; // no data yet

    let rawValue =
      typeof tagChange.value === 'number' ? tagChange.value : parseFloat(String(tagChange.value));

    if (isNaN(rawValue)) return;

    // Apply bitmask if configured
    if (rule.bitmask != null) {
      rawValue = rawValue & rule.bitmask;
    }

    // Evaluate condition
    const conditionMet = this.evaluateCondition(rawValue, rule.condition, rule.threshold);

    // Ensure eval state exists
    let ruleState = state.evalState.get(rule.id);
    if (!ruleState) {
      ruleState = { conditionTrueAt: null, alarm: null, actionsExecuted: false };
      state.evalState.set(rule.id, ruleState);
    }

    const currentAlarm = ruleState.alarm;

    if (conditionMet) {
      if (currentAlarm == null || currentAlarm.status === 'inactive') {
        // Condition just became true — start delay timer
        if (ruleState.conditionTrueAt == null) {
          ruleState.conditionTrueAt = now;
        }

        const delayMs = (rule.timeDelay ?? 0) * 1000;
        const elapsedMs = now - ruleState.conditionTrueAt;

        // Shared alarm-core kernel: `elapsedMs >= delayMs` (ms precision).
        if (coreDelayElapsed(elapsedMs, delayMs)) {
          // Delay satisfied — activate alarm
          this.activateAlarm(tenantId, state, rule, rawValue, now, ruleState);
        }
      } else if (currentAlarm.status === 'cleared' || currentAlarm.status === 'acknowledged') {
        // Re-activation: condition became true again
        this.reactivateAlarm(tenantId, currentAlarm, rawValue, ruleState);
      }
      // else: already ACTIVE — update current value
      else if (currentAlarm.status === 'active') {
        currentAlarm.currentValue = rawValue;
        void this.storage
          .saveAlarm(tenantId, this.instanceToEntity(currentAlarm))
          .catch(() => undefined);
      }
    } else {
      // Condition not met — reset delay timer
      ruleState.conditionTrueAt = null;

      if (currentAlarm == null) return;

      if (currentAlarm.status === 'active' || currentAlarm.status === 'acknowledged') {
        // Check deadband: must leave [threshold ± deadband] before clearing
        if (this.isOutsideDeadband(rawValue, rule)) {
          this.clearAlarm(tenantId, currentAlarm, rawValue, now, rule, ruleState);
        }
      } else if (currentAlarm.status === 'cleared') {
        // Auto-resolve float alarms with no ack required
        if (rule.ackMode === 'float') {
          this.resolveAlarm(tenantId, currentAlarm, ruleState);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  State transitions                                                 */
  /* ---------------------------------------------------------------- */

  private activateAlarm(
    tenantId: string,
    state: TenantAlarmState,
    rule: AlarmRuleRuntime,
    value: number,
    now: number,
    ruleState: RuleEvalState,
  ): void {
    const alarm: AlarmInstance = {
      id: randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      status: 'active',
      message: rule.message,
      group: rule.group,
      currentValue: value,
      threshold: rule.threshold,
      onTime: now,
      colors: rule.colors,
    };

    ruleState.alarm = alarm;
    ruleState.actionsExecuted = false;

    this.logger.log(
      `ALARM ACTIVE: tenant=${tenantId} rule=${rule.name} severity=${rule.severity} value=${value} threshold=${rule.threshold}`,
    );

    // Persist
    void this.storage.saveAlarm(tenantId, this.instanceToEntity(alarm)).catch((err: Error) => {
      this.logger.error(`activateAlarm: persist failed — ${err.message}`);
    });

    // Execute alarm actions
    if (rule.actions && rule.actions.length > 0 && !ruleState.actionsExecuted) {
      this.executeActions(tenantId, state, rule, alarm);
      ruleState.actionsExecuted = true;
    }

    // Notifications
    void this.notification.processAlarm(alarm, state.notificationConfigs).catch((err: Error) => {
      this.logger.error(`activateAlarm: notification failed — ${err.message}`);
    });
  }

  private reactivateAlarm(
    tenantId: string,
    alarm: AlarmInstance,
    value: number,
    ruleState: RuleEvalState,
  ): void {
    alarm.status = 'active';
    alarm.currentValue = value;
    alarm.offTime = undefined;
    alarm.ackTime = undefined;
    alarm.ackUserId = undefined;
    ruleState.actionsExecuted = false;

    this.logger.log(`ALARM REACTIVATED: id=${alarm.id} rule=${alarm.ruleName}`);

    void this.storage.saveAlarm(tenantId, this.instanceToEntity(alarm)).catch((err: Error) => {
      this.logger.error(`reactivateAlarm: persist failed — ${err.message}`);
    });
  }

  private clearAlarm(
    tenantId: string,
    alarm: AlarmInstance,
    value: number,
    now: number,
    rule: AlarmRuleRuntime,
    ruleState: RuleEvalState,
  ): void {
    alarm.currentValue = value;
    alarm.offTime = now;

    if (rule.ackMode === 'float') {
      // Auto-clear — no ack needed
      alarm.status = 'inactive';
      this.resolveAlarm(tenantId, alarm, ruleState);
    } else {
      alarm.status = 'cleared';
      void this.storage.saveAlarm(tenantId, this.instanceToEntity(alarm)).catch((err: Error) => {
        this.logger.error(`clearAlarm: persist failed — ${err.message}`);
      });
      this.logger.log(`ALARM CLEARED: id=${alarm.id} rule=${alarm.ruleName}`);
    }
  }

  private resolveAlarm(tenantId: string, alarm: AlarmInstance, ruleState: RuleEvalState): void {
    this.logger.log(`ALARM RESOLVED: id=${alarm.id} rule=${alarm.ruleName}`);

    // Archive to chronicle
    void this.storage
      .saveToChronicle(tenantId, this.instanceToChronicle(alarm))
      .catch((err: Error) => {
        this.logger.error(`resolveAlarm: chronicle failed — ${err.message}`);
      });

    // Remove from active table
    void this.storage.deleteAlarm(tenantId, alarm.id).catch((err: Error) => {
      this.logger.error(`resolveAlarm: delete failed — ${err.message}`);
    });

    // Clear notification rate-limit records
    this.notification.clearAlarmRecords(alarm.id);

    ruleState.alarm = null;
    ruleState.actionsExecuted = false;
    ruleState.conditionTrueAt = null;
  }

  /* ---------------------------------------------------------------- */
  /*  Public ACK methods                                                */
  /* ---------------------------------------------------------------- */

  /** Operator acknowledged a single alarm (from the SCADA gateway). */
  @OnEvent(SCADA_ALARM_ACK_EVENT)
  async handleAlarmAckEvent(req: AlarmAckRequest): Promise<void> {
    await this.acknowledgeAlarm(req.tenantId, req.alarmInstanceId, req.userId);
  }

  /** Operator acknowledged all alarms (from the SCADA gateway). */
  @OnEvent(SCADA_ALARM_ACK_ALL_EVENT)
  async handleAlarmAckAllEvent(req: AlarmAckAllRequest): Promise<void> {
    await this.acknowledgeAll(req.tenantId, req.userId);
  }

  async acknowledgeAlarm(tenantId: string, alarmId: string, userId: string): Promise<void> {
    const state = this.tenants.get(tenantId);
    if (!state) {
      this.logger.warn(`acknowledgeAlarm: tenant=${tenantId} not active — ack ignored`);
      return;
    }

    const now = Date.now();
    let found = false;

    for (const [, ruleState] of state.evalState) {
      if (!ruleState.alarm || ruleState.alarm.id !== alarmId) continue;

      const alarm = ruleState.alarm;

      // Validate ACK mode
      const rule = state.rules.find((r) => r.id === alarm.ruleId);
      if (!rule) break;

      if (rule.ackMode === 'ackPassive' && alarm.status !== 'cleared') {
        this.logger.warn(
          `acknowledgeAlarm: ackPassive alarm ${alarmId} is not yet cleared — ack rejected`,
        );
        break;
      }

      alarm.ackTime = now;
      alarm.ackUserId = userId;
      alarm.status = 'acknowledged';
      found = true;

      this.logger.log(
        `ALARM ACKNOWLEDGED: tenant=${tenantId} id=${alarmId} userId=${userId} rule=${alarm.ruleName}`,
      );

      await this.storage.saveAlarm(tenantId, this.instanceToEntity(alarm)).catch((err: Error) => {
        this.logger.error(`acknowledgeAlarm: persist failed — ${err.message}`);
      });

      // If condition is already clear, resolve immediately
      if (alarm.offTime != null) {
        this.resolveAlarm(tenantId, alarm, ruleState);
      }

      break;
    }

    if (!found) {
      this.logger.warn(
        `acknowledgeAlarm: alarm id=${alarmId} not found in tenant=${tenantId} active set`,
      );
    }

    this.pushStatusSummary(tenantId, state);
  }

  async acknowledgeAll(tenantId: string, userId: string): Promise<void> {
    const state = this.tenants.get(tenantId);
    if (!state) {
      this.logger.warn(`acknowledgeAll: tenant=${tenantId} not active — ack ignored`);
      return;
    }

    const now = Date.now();
    let count = 0;

    for (const [, ruleState] of state.evalState) {
      if (!ruleState.alarm) continue;
      if (ruleState.alarm.status === 'acknowledged') continue;

      const alarm = ruleState.alarm;
      const rule = state.rules.find((r) => r.id === alarm.ruleId);
      if (!rule) continue;

      // ackPassive requires alarm to be cleared first
      if (rule.ackMode === 'ackPassive' && alarm.status !== 'cleared') continue;

      alarm.ackTime = now;
      alarm.ackUserId = userId;
      alarm.status = 'acknowledged';
      count++;

      await this.storage.saveAlarm(tenantId, this.instanceToEntity(alarm)).catch((err: Error) => {
        this.logger.error(`acknowledgeAll: persist failed id=${alarm.id} — ${err.message}`);
      });

      if (alarm.offTime != null) {
        this.resolveAlarm(tenantId, alarm, ruleState);
      }
    }

    this.logger.log(
      `acknowledgeAll: tenant=${tenantId} acknowledged ${count} alarm(s) by userId=${userId}`,
    );
    this.pushStatusSummary(tenantId, state);
  }

  /* ---------------------------------------------------------------- */
  /*  Query methods                                                     */
  /* ---------------------------------------------------------------- */

  getActiveAlarms(tenantId: string): AlarmInstance[] {
    const state = this.tenants.get(tenantId);
    if (!state) return [];

    const alarms: AlarmInstance[] = [];
    for (const [, ruleState] of state.evalState) {
      if (ruleState.alarm && ruleState.alarm.status !== 'inactive') {
        alarms.push({ ...ruleState.alarm });
      }
    }
    return alarms.sort((a, b) => {
      const order: AlarmRuntimeStatus[] = ['active', 'cleared', 'acknowledged'];
      const ai = order.indexOf(a.status);
      const bi = order.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.onTime - b.onTime;
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Gateway push                                                      */
  /* ---------------------------------------------------------------- */

  private pushStatusSummary(tenantId: string, state: TenantAlarmState): void {
    const activeAlarms = this.getActiveAlarms(tenantId);
    const actions = state.pendingActions.splice(0);

    const summary: AlarmStatusSummary = {
      critical: activeAlarms.filter((a) => a.severity === 'critical').length,
      high: activeAlarms.filter((a) => a.severity === 'high').length,
      warning: activeAlarms.filter((a) => a.severity === 'warning').length,
      info: activeAlarms.filter((a) => a.severity === 'info').length,
      activeAlarms,
      pendingActions: actions.length > 0 ? actions : undefined,
    };

    try {
      this.gateway.pushAlarmStatus(tenantId, summary);
    } catch (error) {
      this.logger.error(`pushStatusSummary: gateway push failed — ${(error as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Alarm actions                                                     */
  /* ---------------------------------------------------------------- */

  private executeActions(
    tenantId: string,
    state: TenantAlarmState,
    rule: AlarmRuleRuntime,
    alarm: AlarmInstance,
  ): void {
    if (!rule.actions) return;

    for (const action of rule.actions) {
      try {
        switch (action.type) {
          case 'toastMessage': {
            const cmd: AlarmActionCommand = {
              type: 'toastMessage',
              message: String(action.params['message'] ?? alarm.message),
              severity: alarm.severity,
              toastType: this.severityToToastType(alarm.severity),
            };
            state.pendingActions.push(cmd);
            break;
          }

          case 'popup': {
            const cmd: AlarmActionCommand = {
              type: 'popup',
              message: String(action.params['message'] ?? alarm.message),
              severity: alarm.severity,
            };
            state.pendingActions.push(cmd);
            break;
          }

          case 'setView': {
            const viewId = String(action.params['viewId'] ?? '');
            if (viewId) {
              const cmd: AlarmActionCommand = {
                type: 'setView',
                viewId,
              };
              state.pendingActions.push(cmd);
            }
            break;
          }

          case 'setValue': {
            const tagId = String(action.params['tagId'] ?? '');
            const value = action.params['value'];
            if (tagId && value !== undefined) {
              // The write is routed to the tenant that owns the rule — an
              // alarm action can never actuate another tenant's device.
              this.tagManager.writeTagValue(tagId, value, 'alarm-engine', tenantId);
            }
            break;
          }

          case 'runScript': {
            // Stub: emit internal event for script engine integration
            this.logger.debug(
              `executeActions: runScript stub for scriptId=${action.params['scriptId']}`,
            );
            break;
          }

          default:
            this.logger.warn(`executeActions: unknown action type '${action.type}'`);
        }
      } catch (error) {
        this.logger.error(
          `executeActions: action type=${action.type} failed — ${(error as Error).message}`,
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Condition evaluation                                              */
  /* ---------------------------------------------------------------- */

  private evaluateCondition(
    value: number,
    condition: AlarmRuleRuntime['condition'],
    threshold: number,
  ): boolean {
    // Delegates to the drift-zero alarm-core kernel (shared with the Rust edge
    // engine via WebAssembly). `==`/`!=` use the canonical 1e-4 epsilon.
    return coreEvaluateCondition(condition, value, threshold);
  }

  /**
   * Returns true if the value is far enough from the threshold to
   * allow the alarm to clear (deadband hysteresis) — delegated to the shared
   * alarm-core kernel (exclusive boundaries, no hidden floor, deadband 0 clears).
   */
  private isOutsideDeadband(value: number, rule: AlarmRuleRuntime): boolean {
    return coreIsOutsideDeadband(rule.condition, value, rule.threshold, rule.deadband ?? 0);
  }

  /* ---------------------------------------------------------------- */
  /*  Entity mapping                                                    */
  /* ---------------------------------------------------------------- */

  private instanceToEntity(alarm: AlarmInstance): ScadaAlarm {
    return {
      id: alarm.id,
      ruleId: alarm.ruleId,
      ruleName: alarm.ruleName,
      severity: alarm.severity,
      status: alarm.status,
      message: alarm.message,
      group: alarm.group,
      currentValue: alarm.currentValue,
      threshold: alarm.threshold,
      onTime: alarm.onTime,
      offTime: alarm.offTime,
      ackTime: alarm.ackTime,
      ackUserId: alarm.ackUserId,
      colors: alarm.colors,
    };
  }

  private instanceToChronicle(alarm: AlarmInstance): ScadaAlarmChronicle {
    return {
      id: alarm.id,
      ruleId: alarm.ruleId,
      ruleName: alarm.ruleName,
      severity: alarm.severity,
      status: alarm.status,
      message: alarm.message,
      group: alarm.group,
      currentValue: alarm.currentValue,
      threshold: alarm.threshold,
      onTime: alarm.onTime,
      offTime: alarm.offTime,
      ackTime: alarm.ackTime,
      ackUserId: alarm.ackUserId,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                           */
  /* ---------------------------------------------------------------- */

  private severityToToastType(
    severity: AlarmInstance['severity'],
  ): 'error' | 'warning' | 'success' | 'info' {
    switch (severity) {
      case 'critical':
        return 'error';
      case 'high':
        return 'error';
      case 'warning':
        return 'warning';
      case 'info':
        return 'info';
      default:
        return 'info';
    }
  }
}
