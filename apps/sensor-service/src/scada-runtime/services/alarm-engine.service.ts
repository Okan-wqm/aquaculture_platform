/**
 * AlarmEngineService
 *
 * Server-side alarm evaluation loop (FUXA pattern).
 *
 * Architecture
 * ─────────────
 * • 1-second evaluation tick (setInterval).
 * • For each enabled AlarmRuleRuntime: read tag value from TagManagerService,
 *   apply bitmask if configured, compare against threshold.
 * • 4-state machine per rule:
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
 *     setValue → written to TagManagerService
 *     runScript → TODO stub (emits internal event for script engine)
 * • AlarmStatusSummary pushed to all tenant clients via gateway every tick.
 * • Alarm rules are loaded from the store via setAlarmRules() called
 *   externally (e.g., from a project-load event); this service does not
 *   own the rule definitions.
 *
 * Separation of concerns
 * ──────────────────────
 * Engine  → evaluates conditions, manages state machine
 * Storage → persists to DB (AlarmStorageService)
 * Notify  → delivers email/webhook (NotificationService)
 * Gateway → pushes WebSocket events (ScadaRuntimeGateway)
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type {
  AlarmRuleRuntime,
  AlarmInstance,
  AlarmStatusSummary,
  AlarmRuntimeStatus,
  AlarmActionCommand,
  NotificationConfig,
} from '../scada-types';

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
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const EVAL_INTERVAL_MS = 1_000;

/* ------------------------------------------------------------------ */
/*  Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class AlarmEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlarmEngineService.name);

  /** Alarm rules loaded from the project. */
  private rules: AlarmRuleRuntime[] = [];

  /** Notification configs loaded from the project. */
  private notificationConfigs: NotificationConfig[] = [];

  /** Per-rule evaluation state. */
  private readonly evalState = new Map<string, RuleEvalState>();

  /**
   * Tenant this engine instance is bound to. Persistence and broadcast are
   * tenant-scoped (DB-SENSOR-CRITICAL-001), so the engine starts UNBOUND
   * (null) and refuses to persist or broadcast until an activation binds a
   * real tenant via setTenantId(). This makes the cross-tenant leak
   * structurally impossible: an unbound engine writes nothing and reads
   * nothing rather than defaulting to a shared 'default' bucket every tenant
   * would collide in.
   */
  private tenantId: string | null = null;

  private evalInterval: ReturnType<typeof setInterval> | null = null;

  /** Pending action commands to attach to the next alarm status push. */
  private pendingActions: AlarmActionCommand[] = [];

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
  /*  Configuration injection                                           */
  /* ---------------------------------------------------------------- */

  /** Called by the project-load handler to inject alarm rules. */
  setAlarmRules(rules: AlarmRuleRuntime[]): void {
    this.rules = rules;
    // Remove stale eval state for rules that no longer exist
    const ruleIds = new Set(rules.map((r) => r.id));
    for (const [id] of this.evalState) {
      if (!ruleIds.has(id)) {
        this.evalState.delete(id);
      }
    }
    this.logger.log(`AlarmEngineService: loaded ${rules.length} alarm rule(s)`);
  }

  /** Called by the project-load handler to inject notification configs. */
  setNotificationConfigs(configs: NotificationConfig[]): void {
    this.notificationConfigs = configs;
  }

  /** Bind this engine to a tenant. Required before any persistence/broadcast. */
  setTenantId(tenantId: string): void {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error('AlarmEngineService.setTenantId: a non-empty tenantId is required');
    }
    this.tenantId = tenantId;
  }

  /**
   * Return the bound tenant or throw. Every storage write flows through here
   * so an unbound engine fails closed instead of persisting cross-tenant.
   */
  private requireTenant(): string {
    if (this.tenantId == null) {
      throw new Error(
        'AlarmEngineService: no tenant bound — call setTenantId() before evaluating alarms',
      );
    }
    return this.tenantId;
  }

  /* ---------------------------------------------------------------- */
  /*  Main evaluation tick                                              */
  /* ---------------------------------------------------------------- */

  private evaluateTick(): void {
    // Fail-closed: an engine with no bound tenant is not activated for anyone.
    // Skipping the tick (rather than persisting to a shared bucket) is what
    // keeps SCADA alarm state from ever crossing tenants.
    if (this.tenantId == null) return;

    const now = Date.now();

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      this.evaluateRule(rule, now);
    }

    // Push status summary to all clients
    this.pushStatusSummary();
  }

  private evaluateRule(rule: AlarmRuleRuntime, now: number): void {
    // Get tag value from cache
    const tagChange = this.tagManager.getTagValue(rule.tagId);
    if (!tagChange) return; // no data yet

    let rawValue = typeof tagChange.value === 'number'
      ? tagChange.value
      : parseFloat(String(tagChange.value));

    if (isNaN(rawValue)) return;

    // Apply bitmask if configured
    if (rule.bitmask != null) {
      rawValue = rawValue & rule.bitmask;
    }

    // Evaluate condition
    const conditionMet = this.evaluateCondition(rawValue, rule.condition, rule.threshold);

    // Ensure eval state exists
    let state = this.evalState.get(rule.id);
    if (!state) {
      state = { conditionTrueAt: null, alarm: null, actionsExecuted: false };
      this.evalState.set(rule.id, state);
    }

    const currentAlarm = state.alarm;

    if (conditionMet) {
      if (currentAlarm == null || currentAlarm.status === 'inactive') {
        // Condition just became true — start delay timer
        if (state.conditionTrueAt == null) {
          state.conditionTrueAt = now;
        }

        const delay = (rule.timeDelay ?? 0) * 1000;
        const elapsed = now - state.conditionTrueAt;

        if (elapsed >= delay) {
          // Delay satisfied — activate alarm
          this.activateAlarm(rule, rawValue, now, state);
        }
      } else if (
        currentAlarm.status === 'cleared' ||
        currentAlarm.status === 'acknowledged'
      ) {
        // Re-activation: condition became true again
        this.reactivateAlarm(currentAlarm, rawValue, now, state);
      }
      // else: already ACTIVE — update current value
      else if (currentAlarm.status === 'active') {
        currentAlarm.currentValue = rawValue;
        void this.storage
          .saveAlarm(this.requireTenant(), this.instanceToEntity(currentAlarm))
          .catch(() => undefined);
      }
    } else {
      // Condition not met — reset delay timer
      state.conditionTrueAt = null;

      if (currentAlarm == null) return;

      if (currentAlarm.status === 'active' || currentAlarm.status === 'acknowledged') {
        // Check deadband: must leave [threshold ± deadband] before clearing
        if (this.isOutsideDeadband(rawValue, rule)) {
          this.clearAlarm(currentAlarm, rawValue, now, rule, state);
        }
      } else if (currentAlarm.status === 'cleared') {
        // Auto-resolve float alarms with no ack required
        if (rule.ackMode === 'float') {
          this.resolveAlarm(currentAlarm, state);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  State transitions                                                 */
  /* ---------------------------------------------------------------- */

  private activateAlarm(
    rule: AlarmRuleRuntime,
    value: number,
    now: number,
    state: RuleEvalState,
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

    state.alarm = alarm;
    state.actionsExecuted = false;

    this.logger.log(
      `ALARM ACTIVE: rule=${rule.name} severity=${rule.severity} value=${value} threshold=${rule.threshold}`,
    );

    // Persist
    void this.storage
      .saveAlarm(this.requireTenant(), this.instanceToEntity(alarm))
      .catch((err: Error) => {
        this.logger.error(`activateAlarm: persist failed — ${err.message}`);
      });

    // Execute alarm actions
    if (rule.actions && rule.actions.length > 0 && !state.actionsExecuted) {
      this.executeActions(rule, alarm);
      state.actionsExecuted = true;
    }

    // Notifications
    void this.notification
      .processAlarm(alarm, this.notificationConfigs)
      .catch((err: Error) => {
        this.logger.error(`activateAlarm: notification failed — ${err.message}`);
      });
  }

  private reactivateAlarm(
    alarm: AlarmInstance,
    value: number,
    now: number,
    state: RuleEvalState,
  ): void {
    alarm.status = 'active';
    alarm.currentValue = value;
    alarm.offTime = undefined;
    alarm.ackTime = undefined;
    alarm.ackUserId = undefined;
    state.actionsExecuted = false;

    this.logger.log(`ALARM REACTIVATED: id=${alarm.id} rule=${alarm.ruleName}`);

    void this.storage
      .saveAlarm(this.requireTenant(), this.instanceToEntity(alarm))
      .catch((err: Error) => {
        this.logger.error(`reactivateAlarm: persist failed — ${err.message}`);
      });
  }

  private clearAlarm(
    alarm: AlarmInstance,
    value: number,
    now: number,
    rule: AlarmRuleRuntime,
    state: RuleEvalState,
  ): void {
    alarm.currentValue = value;
    alarm.offTime = now;

    if (rule.ackMode === 'float') {
      // Auto-clear — no ack needed
      alarm.status = 'inactive';
      this.resolveAlarm(alarm, state);
    } else {
      alarm.status = 'cleared';
      void this.storage
        .saveAlarm(this.requireTenant(), this.instanceToEntity(alarm))
        .catch((err: Error) => {
          this.logger.error(`clearAlarm: persist failed — ${err.message}`);
        });
      this.logger.log(`ALARM CLEARED: id=${alarm.id} rule=${alarm.ruleName}`);
    }
  }

  private resolveAlarm(alarm: AlarmInstance, state: RuleEvalState): void {
    this.logger.log(`ALARM RESOLVED: id=${alarm.id} rule=${alarm.ruleName}`);

    // Archive to chronicle
    const tenantId = this.requireTenant();
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

    state.alarm = null;
    state.actionsExecuted = false;
    state.conditionTrueAt = null;
  }

  /* ---------------------------------------------------------------- */
  /*  Public ACK methods                                                */
  /* ---------------------------------------------------------------- */

  async acknowledgeAlarm(alarmId: string, userId: string): Promise<void> {
    const now = Date.now();
    let found = false;

    for (const [, state] of this.evalState) {
      if (!state.alarm || state.alarm.id !== alarmId) continue;

      const alarm = state.alarm;

      // Validate ACK mode
      const rule = this.rules.find((r) => r.id === alarm.ruleId);
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
        `ALARM ACKNOWLEDGED: id=${alarmId} userId=${userId} rule=${alarm.ruleName}`,
      );

      await this.storage
        .saveAlarm(this.requireTenant(), this.instanceToEntity(alarm))
        .catch((err: Error) => {
          this.logger.error(`acknowledgeAlarm: persist failed — ${err.message}`);
        });

      // If condition is already clear, resolve immediately
      if (alarm.offTime != null) {
        this.resolveAlarm(alarm, state);
      }

      break;
    }

    if (!found) {
      this.logger.warn(`acknowledgeAlarm: alarm id=${alarmId} not found in active set`);
    }

    this.pushStatusSummary();
  }

  async acknowledgeAll(userId: string): Promise<void> {
    const now = Date.now();
    let count = 0;

    for (const [, state] of this.evalState) {
      if (!state.alarm) continue;
      if (state.alarm.status === 'acknowledged') continue;

      const alarm = state.alarm;
      const rule = this.rules.find((r) => r.id === alarm.ruleId);
      if (!rule) continue;

      // ackPassive requires alarm to be cleared first
      if (rule.ackMode === 'ackPassive' && alarm.status !== 'cleared') continue;

      alarm.ackTime = now;
      alarm.ackUserId = userId;
      alarm.status = 'acknowledged';
      count++;

      await this.storage
        .saveAlarm(this.requireTenant(), this.instanceToEntity(alarm))
        .catch((err: Error) => {
          this.logger.error(`acknowledgeAll: persist failed id=${alarm.id} — ${err.message}`);
        });

      if (alarm.offTime != null) {
        this.resolveAlarm(alarm, state);
      }
    }

    this.logger.log(`acknowledgeAll: acknowledged ${count} alarm(s) by userId=${userId}`);
    this.pushStatusSummary();
  }

  /* ---------------------------------------------------------------- */
  /*  Query methods                                                     */
  /* ---------------------------------------------------------------- */

  getActiveAlarms(): AlarmInstance[] {
    const alarms: AlarmInstance[] = [];
    for (const [, state] of this.evalState) {
      if (state.alarm && state.alarm.status !== 'inactive') {
        alarms.push({ ...state.alarm });
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

  private pushStatusSummary(): void {
    const activeAlarms = this.getActiveAlarms();
    const actions = this.pendingActions.splice(0);

    const summary: AlarmStatusSummary = {
      critical: activeAlarms.filter((a) => a.severity === 'critical').length,
      high: activeAlarms.filter((a) => a.severity === 'high').length,
      warning: activeAlarms.filter((a) => a.severity === 'warning').length,
      info: activeAlarms.filter((a) => a.severity === 'info').length,
      activeAlarms,
      pendingActions: actions.length > 0 ? actions : undefined,
    };

    if (this.tenantId == null) return; // unbound engine broadcasts to no tenant
    try {
      this.gateway.pushAlarmStatus(this.tenantId, summary);
    } catch (error) {
      this.logger.error(`pushStatusSummary: gateway push failed — ${(error as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Alarm actions                                                     */
  /* ---------------------------------------------------------------- */

  private executeActions(rule: AlarmRuleRuntime, alarm: AlarmInstance): void {
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
            this.pendingActions.push(cmd);
            break;
          }

          case 'popup': {
            const cmd: AlarmActionCommand = {
              type: 'popup',
              message: String(action.params['message'] ?? alarm.message),
              severity: alarm.severity,
            };
            this.pendingActions.push(cmd);
            break;
          }

          case 'setView': {
            const viewId = String(action.params['viewId'] ?? '');
            if (viewId) {
              const cmd: AlarmActionCommand = {
                type: 'setView',
                viewId,
              };
              this.pendingActions.push(cmd);
            }
            break;
          }

          case 'setValue': {
            const tagId = String(action.params['tagId'] ?? '');
            const value = action.params['value'];
            if (tagId && value !== undefined) {
              this.tagManager.writeTagValue(tagId, value, 'alarm-engine');
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
    switch (condition) {
      case '>':  return value > threshold;
      case '<':  return value < threshold;
      case '>=': return value >= threshold;
      case '<=': return value <= threshold;
      case '==': return Math.abs(value - threshold) < 0.0001;
      case '!=': return Math.abs(value - threshold) >= 0.0001;
      default:   return false;
    }
  }

  /**
   * Returns true if the value is far enough from the threshold to
   * allow the alarm to clear (deadband hysteresis).
   */
  private isOutsideDeadband(value: number, rule: AlarmRuleRuntime): boolean {
    const deadband = rule.deadband ?? 0;
    if (deadband === 0) return true;

    switch (rule.condition) {
      case '>':
      case '>=':
        return value < rule.threshold - deadband;
      case '<':
      case '<=':
        return value > rule.threshold + deadband;
      case '==':
        return Math.abs(value - rule.threshold) > deadband;
      case '!=':
        return Math.abs(value - rule.threshold) <= deadband;
      default:
        return true;
    }
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
      case 'critical': return 'error';
      case 'high':     return 'error';
      case 'warning':  return 'warning';
      case 'info':     return 'info';
      default:         return 'info';
    }
  }
}
