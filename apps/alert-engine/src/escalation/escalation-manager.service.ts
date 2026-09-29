import { Injectable, Logger, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxPublisher } from '@platform/outbox';
import { RedisService } from '@aquaculture/backend-common/redis';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { recordLifeSafetyAlarmDegraded } from '@aquaculture/backend-common/metrics';
import {
  EscalationPolicy,
  EscalationLevel,
  EscalationActionType,
  EscalationRoleTarget,
  NotificationChannel,
} from '../database/entities/escalation-policy.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../database/entities/alert-incident.entity';
import { AlertSeverity } from '../database/entities/alert-rule.entity';
import {
  AlertAuditService,
  AuditCategory,
  AuditEventType,
  AuditSeverity,
} from '../audit/alert-audit.service';
import { EscalationPolicyService } from './escalation-policy.service';
import { buildAlertEscalatedEvent } from './alert-escalated-event.builder';
import {
  parseEscalationState,
  type EscalationState,
  type NotificationRecord,
} from './escalation-state';
import { claimEscalationLevel, timelineEntry, type LevelClaim } from './incident-escalation-claim';
import { planFirstLevel, type DirectTargets } from './first-level-plan';

export type {
  AcknowledgmentRecord,
  EscalationState,
  NotificationRecord,
} from './escalation-state';
export type { DirectTargets } from './first-level-plan';

/**
 * What starts an incident's escalation.
 */
export interface EscalationStart {
  severity: AlertSeverity;
  /** Policy match key: the alert rule id, or the farm signal key. */
  matchKey?: string;
  farmId?: string;
  /** A sensor rule's own person recipients (decision 7) — joined to level 1. */
  directTargets?: DirectTargets;
}

/**
 * How a start ended. Only `escalated` means THIS call enqueued the page;
 * `already-claimed` means a concurrent delivery did.
 */
export type EscalationOutcome = 'escalated' | 'already-claimed' | 'suppressed' | 'not-covered';

/**
 * Escalation action
 */
export interface EscalationAction {
  type: EscalationActionType;
  level: number;
  targetUsers: string[];
  targetTeams?: string[];
  /** Role targets expanded to people by notification-service via auth-service. */
  targetRoles: EscalationRoleTarget[];
  channels: NotificationChannel[];
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Escalation result
 */
export interface EscalationResult {
  success: boolean;
  incidentId: string;
  fromLevel: number;
  toLevel: number;
  actions: EscalationAction[];
  errors?: string[];
}

/**
 * Event types emitted by escalation manager
 */
export const ESCALATION_EVENTS = {
  ESCALATED: 'escalation.escalated',
  ACKNOWLEDGED: 'escalation.acknowledged',
  COMPLETED: 'escalation.completed',
  TIMEOUT: 'escalation.timeout',
  SUPPRESSED: 'escalation.suppressed',
};

/**
 * Redis key prefixes for escalation state
 */
const REDIS_KEYS = {
  STATE: 'escalation:state:',
  TIMER: 'escalation:timer:',
  ACTIVE: 'escalation:active',
  LOCK: 'escalation:lock:',
};

/**
 * State TTL - 7 days (for completed escalations)
 */
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class EscalationManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EscalationManagerService.name);
  // Local timer cache - timers must be managed in-process
  private escalationTimers: Map<string, NodeJS.Timeout> = new Map();
  private timerCheckInterval: NodeJS.Timeout | null = null;
  // Unique instance ID for distributed locking
  private readonly instanceId = crypto.randomUUID();

  constructor(
    @InjectRepository(AlertIncident)
    private readonly incidentRepository: Repository<AlertIncident>,
    private readonly policyService: EscalationPolicyService,
    private readonly eventEmitter: EventEmitter2,
    private readonly redisService: RedisService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    // V-S1b-2: a suppressed HIGH (an admin's window) is audited.
    private readonly audit: AlertAuditService,
  ) {}

  async onModuleInit() {
    // Restore active escalation timers on startup
    await this.restoreActiveTimers();

    // Start periodic timer check to handle missed escalations
    this.timerCheckInterval = setInterval(() => {
      void this.checkMissedEscalations();
    }, 60000); // Check every minute
  }

  onModuleDestroy() {
    // Clear all local timers
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();

    if (this.timerCheckInterval) {
      clearInterval(this.timerCheckInterval);
    }
  }

  /**
   * Restore active timers from Redis on startup.
   *
   * V-S1b-3: every incident is handled on its own — a bad or legacy state is
   * logged and skipped, it never aborts the restore of the others.
   */
  private async restoreActiveTimers(): Promise<void> {
    let activeIds: string[];
    try {
      activeIds = (await this.redisService.smembers(REDIS_KEYS.ACTIVE)) || [];
    } catch (error) {
      this.logger.error('Failed to list active escalations for restore', error);
      return;
    }

    for (const incidentId of activeIds) {
      try {
        await this.withIncidentLock(incidentId, async () => {
          const state = await this.getEscalationState(incidentId);
          if (!state || state.isComplete) return;
          await this.inTenantOf(state, async () => {
            const incident = await this.incidentRepository.findOne({ where: { id: incidentId } });
            if (!incident) return;
            const policy = await this.policyService.getPolicy(state.policyId, incident.tenantId);
            await this.setEscalationTimeout(incidentId, policy);
            this.logger.log(`Restored timer for incident ${incidentId}`);
          });
        });
      } catch (error) {
        this.logger.error(
          `Failed to restore the escalation timer for incident ${incidentId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Check for missed escalations (in case of server restart during timeout).
   *
   * V-S1b-3: per-incident isolation, as in {@link restoreActiveTimers}.
   */
  private async checkMissedEscalations(): Promise<void> {
    let activeIds: string[];
    try {
      activeIds = (await this.redisService.smembers(REDIS_KEYS.ACTIVE)) || [];
    } catch (error) {
      this.logger.error('Error listing active escalations for the missed-escalation sweep', error);
      return;
    }

    for (const incidentId of activeIds) {
      try {
        await this.withIncidentLock(incidentId, () => this.sweepIncident(incidentId));
      } catch (error) {
        this.logger.error(
          `Missed-escalation check failed for incident ${incidentId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** One incident of the missed-escalation sweep. */
  private async sweepIncident(incidentId: string): Promise<void> {
    const state = await this.getEscalationState(incidentId);
    if (!state || state.isComplete) return;

    const timerInfo = await this.redisService.getJson<{ nextEscalationAt: string }>(
      `${REDIS_KEYS.TIMER}${incidentId}`,
    );
    if (!timerInfo || new Date(timerInfo.nextEscalationAt) >= new Date()) return;

    // The incident may have been acknowledged or resolved since the timer was set.
    const incident = await this.inTenantOf(state, () =>
      this.incidentRepository.findOne({ where: { id: incidentId } }),
    );
    if (
      incident &&
      incident.status !== IncidentStatus.ACKNOWLEDGED &&
      incident.status !== IncidentStatus.RESOLVED &&
      incident.status !== IncidentStatus.CLOSED
    ) {
      this.logger.warn(`Triggering missed escalation for incident ${incidentId}`);
      await this.escalateToNextLevel(incidentId);
    } else {
      this.logger.log(
        `Skipping missed escalation for incident ${incidentId} — status is ${incident?.status ?? 'not found'}`,
      );
    }
  }

  /** Run `fn` holding the per-incident distributed lock (one replica per incident). */
  private async withIncidentLock(incidentId: string, fn: () => Promise<void>): Promise<void> {
    const lockKey = `${REDIS_KEYS.LOCK}${incidentId}`;
    const acquired = await this.redisService.setNx(lockKey, this.instanceId, 300);
    if (!acquired) return;
    try {
      await fn();
    } finally {
      await this.redisService.del(lockKey);
    }
  }

  /**
   * Save escalation state to Redis
   */
  private async saveState(state: EscalationState): Promise<void> {
    const ttl = state.isComplete ? STATE_TTL_SECONDS : undefined;
    await this.redisService.setJson(`${REDIS_KEYS.STATE}${state.incidentId}`, state, ttl);

    // Update active set using atomic Redis SADD/SREM to avoid TOCTOU race
    if (!state.isComplete) {
      await this.redisService.sadd(REDIS_KEYS.ACTIVE, state.incidentId);
    } else {
      await this.redisService.srem(REDIS_KEYS.ACTIVE, state.incidentId);
    }
  }

  /**
   * Start an incident's escalation — the ONE entry for every incident source
   * (farm signals and sensor rules alike).
   *
   * WHAT (decisions 3, 5, 7):
   *   1. Match the policy; a window may silence it (never CRITICAL; HIGH only
   *      an admin's window — `EscalationPolicy.suppresses`), audited.
   *   2. Plan level 1 (`planFirstLevel`): the policy's level 1 ∪ the rule's own
   *      people; for CRITICAL/HIGH with NO policy, the hard floor (every active
   *      TENANT_ADMIN, push + e-mail) with an ERROR line and the alertable
   *      `life_safety_alarm_degraded_total{reason="no_policy_match"}`.
   *   3. Claim level 0 → 1 with a conditional UPDATE in the SAME transaction
   *      as the AlertEscalated outbox enqueue — exactly one caller pages (a
   *      severity rise resets the level to 0 in its own conditional UPDATE, so
   *      the new severity's ladder is claimed exactly once as well).
   *   4. A policy-driven ladder keeps its Redis state and timer for later levels.
   *
   * A failure THROWS: nothing was claimed or enqueued, so the consumer's
   * delivery budget re-drives the event and the retry claims again.
   */
  async startEscalation(incident: AlertIncident, start: EscalationStart): Promise<EscalationOutcome> {
    this.logger.log(`Starting escalation for incident ${incident.id}`);

    const policy = await this.policyService.findMatchingPolicy(
      incident.tenantId,
      start.severity,
      start.matchKey,
      start.farmId,
    );
    const suppressed = policy !== null && policy.suppresses(start.severity);
    if (policy && suppressed) {
      this.recordSuppression(incident, policy, start.severity);
    }

    const plan = planFirstLevel({
      severity: start.severity,
      policy,
      suppressed,
      direct: start.directTargets,
    });
    if (!plan) {
      this.logger.log(
        `No escalation covers incident ${incident.id} (severity ${start.severity}` +
          `${suppressed ? ', suppressed by a window' : ''}) — not escalated`,
      );
      return suppressed ? 'suppressed' : 'not-covered';
    }

    if (plan.origin === 'hard-floor') {
      this.logger.error(
        `${start.severity.toUpperCase()} incident ${incident.id} in tenant ` +
          `${incident.tenantId.substring(0, 8)}... matched NO escalation policy — paging every ` +
          'tenant admin (hard floor). The policy coverage invariant should have prevented this.',
      );
      recordLifeSafetyAlarmDegraded('alert-engine', 'no_policy_match', start.severity);
    }

    if (plan.policy) {
      await this.saveState({
        incidentId: incident.id,
        tenantId: incident.tenantId,
        policyId: plan.policy.id,
        currentLevel: 1,
        startedAt: new Date(),
        lastEscalatedAt: new Date(),
        escalationCount: 0,
        acknowledgments: [],
        notifications: [],
        isComplete: false,
      });
    }

    const claim: LevelClaim = { kind: 'first' };
    const claimed = await this.dispatchLevel(incident, plan.level, 1, claim, plan.policy, plan.origin);
    if (!claimed) {
      this.logger.log(`Incident ${incident.id} level 1 was already claimed by a concurrent delivery`);
      return 'already-claimed';
    }

    if (plan.policy) {
      const state = await this.getEscalationState(incident.id);
      if (state) {
        state.escalationCount++;
        await this.saveState(state);
      }
      await this.setEscalationTimeout(incident.id, plan.policy);
    }
    return 'escalated';
  }

  /**
   * Execute a timer-driven escalation level (the next level, or a repeat of the
   * current one) of a policy ladder. Returns a result instead of throwing: the
   * timer has no caller to hand a failure to (the sweep re-drives it).
   */
  async executeEscalationLevel(
    incident: AlertIncident,
    policy: EscalationPolicy,
    level: number,
    fromLevel: number,
  ): Promise<EscalationResult> {
    const levelConfig = policy.getLevel(level);
    if (!levelConfig) {
      return {
        success: false,
        incidentId: incident.id,
        fromLevel,
        toLevel: level,
        actions: [],
        errors: [`Level ${level} not found in policy`],
      };
    }

    try {
      const claimed = await this.dispatchLevel(
        incident,
        levelConfig,
        level,
        { kind: 'from', level: fromLevel },
        policy,
        'policy',
      );
      if (claimed) {
        const state = await this.getEscalationState(incident.id);
        if (state) {
          state.currentLevel = level;
          state.lastEscalatedAt = new Date();
          state.escalationCount++;
          await this.saveState(state);
        }
      }
      return { success: true, incidentId: incident.id, fromLevel, toLevel: level, actions: [] };
    } catch (error: unknown) {
      return {
        success: false,
        incidentId: incident.id,
        fromLevel,
        toLevel: level,
        actions: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * Claim `levelNumber` and enqueue its AlertEscalated in ONE transaction.
   * Returns false when the claim was already taken (nothing enqueued).
   */
  private async dispatchLevel(
    incident: AlertIncident,
    levelConfig: EscalationLevel,
    levelNumber: number,
    claim: LevelClaim,
    policy: EscalationPolicy | null,
    origin: 'policy' | 'hard-floor' | 'direct',
  ): Promise<boolean> {
    this.logger.log(`Executing escalation level ${levelNumber} for incident ${incident.id} (${origin})`);
    const policyName = policy?.name ?? (origin === 'hard-floor' ? 'Hard floor' : 'Rule recipients');
    const action: EscalationAction = {
      type: levelConfig.action,
      level: levelNumber,
      targetUsers: this.resolveTargetUsers(policy, levelConfig),
      targetTeams: levelConfig.notifyTeamIds,
      targetRoles: levelConfig.notifyRoles ?? [],
      channels: levelConfig.channels,
      message: this.formatEscalationMessage(incident, levelConfig, policyName),
      metadata: { policyId: policy?.id ?? null, policyName, levelName: levelConfig.name, origin },
    };

    const { event, undeliverableChannels, droppedUserIds, malformedUserIds } =
      buildAlertEscalatedEvent({
        incident,
        level: levelNumber,
        levelConfig,
        targetUsers: action.targetUsers,
        reason: action.message,
      });
    if (undeliverableChannels.length > 0) {
      this.logger.warn(
        `${policyName} level ${levelNumber} lists channels with no delivery path ` +
          `(${undeliverableChannels.join(', ')}) — delivered via ${event.channels.join(', ') || 'in-app only'}`,
      );
    }
    if (droppedUserIds.length > 0) {
      this.logger.warn(
        `${policyName} level ${levelNumber} names ${droppedUserIds.length} user(s) beyond the ` +
          'delivery cap — they were not paged',
      );
    }
    if (malformedUserIds.length > 0) {
      this.logger.warn(
        `${policyName} level ${levelNumber} names ${malformedUserIds.length} recipient id(s) that ` +
          'are not user ids — they were not paged; fix the policy or its on-call schedule',
      );
    }

    const entry = timelineEntry(TimelineEventType.ESCALATED, action.message, {
      level: levelNumber,
      policyId: policy?.id ?? null,
      policyName,
      origin,
    });
    // LIFE-SAFETY (ALERT-CRITICAL-001 + V-S1a-4): the claim and the event
    // commit atomically. No try/catch: a failed enqueue rolls the claim back.
    const claimed = await this.dataSource.transaction(async (manager) => {
      const won = await claimEscalationLevel(manager, incident.id, levelNumber, claim, entry);
      if (won) {
        await this.outboxPublisher.enqueue(event, manager);
      }
      return won;
    });
    if (!claimed) return false;

    incident.escalationLevel = levelNumber;
    // Emit AFTER the durable commit so in-process listeners never observe an
    // escalation that later rolled back.
    this.eventEmitter.emit(ESCALATION_EVENTS.ESCALATED, {
      incidentId: incident.id,
      level: levelNumber,
      action,
    });
    return true;
  }

  /** A window silenced this incident's policy — emitted and audited (V-S1b-2). */
  private recordSuppression(
    incident: AlertIncident,
    policy: EscalationPolicy,
    severity: AlertSeverity,
  ): void {
    this.logger.log(`Incident ${incident.id} (${severity}) suppressed by a window of ${policy.id}`);
    this.eventEmitter.emit(ESCALATION_EVENTS.SUPPRESSED, {
      incidentId: incident.id,
      policyId: policy.id,
    });
    this.audit.log({
      category: AuditCategory.INCIDENT,
      eventType: AuditEventType.INCIDENT_SUPPRESSED,
      severity: severity === AlertSeverity.HIGH ? AuditSeverity.WARNING : AuditSeverity.INFO,
      entityType: 'AlertIncident',
      entityId: incident.id,
      tenantId: incident.tenantId,
      action: 'escalation.suppressed',
      description: `${severity} incident escalation suppressed by a window of policy "${policy.name}"`,
      metadata: { policyId: policy.id, severity },
      success: true,
    });
  }

  /**
   * Escalate to next level
   */
  async escalateToNextLevel(incidentId: string): Promise<EscalationResult | null> {
    const state = await this.getEscalationState(incidentId);
    if (!state || state.isComplete) {
      return null;
    }
    return this.inTenantOf(state, () => this.escalateStateToNextLevel(state));
  }

  /** Body of {@link escalateToNextLevel}; runs inside the incident's tenant context. */
  private async escalateStateToNextLevel(state: EscalationState): Promise<EscalationResult | null> {
    const incidentId = state.incidentId;
    const incident = await this.incidentRepository.findOne({
      where: { id: incidentId },
    });

    if (!incident) {
      return null;
    }

    let policy: EscalationPolicy;
    try {
      policy = await this.policyService.getPolicy(state.policyId, incident.tenantId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      // The policy was deleted while its ladder was running.
      this.logger.warn(
        `Policy ${state.policyId} not found for incident ${incidentId}. Completing escalation gracefully.`,
      );
      await this.completeEscalation(incidentId, 'policy_not_found');
      return null;
    }

    const nextLevel = state.currentLevel + 1;

    if (!policy.hasNextLevel(state.currentLevel)) {
      // Max level reached, check for repeat
      if (state.escalationCount < policy.maxRepeats) {
        // Repeat current level (claimed only while the incident is still at it).
        return this.executeEscalationLevel(incident, policy, state.currentLevel, state.currentLevel);
      } else {
        // Escalation complete
        await this.completeEscalation(incidentId, 'max_repeats_reached');
        return null;
      }
    }

    const result = await this.executeEscalationLevel(
      incident,
      policy,
      nextLevel,
      state.currentLevel,
    );

    // Set timeout for next level
    await this.setEscalationTimeout(incidentId, policy);

    return result;
  }

  /**
   * Acknowledge escalation
   */
  async acknowledgeEscalation(
    incidentId: string,
    userId: string,
    message?: string,
  ): Promise<boolean> {
    const state = await this.getEscalationState(incidentId);
    if (!state || state.isComplete) {
      return false;
    }

    this.logger.log(`Escalation acknowledged for incident ${incidentId} by user ${userId}`);

    // Record acknowledgment
    state.acknowledgments.push({
      userId,
      timestamp: new Date(),
      level: state.currentLevel,
      message,
    });
    await this.saveState(state);

    // Cancel timeout
    await this.cancelEscalationTimeout(incidentId);

    // Update incident
    await this.inTenantOf(state, async () => {
      const incident = await this.incidentRepository.findOne({
        where: { id: incidentId },
      });

      if (incident) {
        incident.acknowledge(userId);
        await this.incidentRepository.save(incident);
      }
    });

    // Emit event
    this.eventEmitter.emit(ESCALATION_EVENTS.ACKNOWLEDGED, {
      incidentId,
      userId,
      level: state.currentLevel,
    });

    return true;
  }

  /**
   * Complete escalation (resolved/closed)
   */
  async completeEscalation(incidentId: string, reason: string): Promise<void> {
    const state = await this.getEscalationState(incidentId);
    if (!state) {
      return;
    }

    this.logger.log(`Completing escalation for incident ${incidentId}: ${reason}`);

    state.isComplete = true;
    await this.saveState(state);
    await this.cancelEscalationTimeout(incidentId);

    this.eventEmitter.emit(ESCALATION_EVENTS.COMPLETED, {
      incidentId,
      reason,
      finalLevel: state.currentLevel,
      totalEscalations: state.escalationCount,
    });
  }

  /**
   * Get escalation state
   */
  async getEscalationState(incidentId: string): Promise<EscalationState | null> {
    const raw = await this.redisService.getJson<unknown>(`${REDIS_KEYS.STATE}${incidentId}`);
    if (raw === null) return null;
    const parsed = parseEscalationState(raw);
    if (parsed.ok) return parsed.state;
    // V-S1b-3: a legacy (pre-tenant) or damaged state cannot be routed to a
    // tenant schema. It is reported once and retired from the active set, so
    // it neither aborts the sweep nor is re-read every minute.
    this.logger.warn(
      `Escalation state for incident ${incidentId} is unusable (${parsed.reason}) — ` +
        'retired from the active set',
    );
    await this.redisService.srem(REDIS_KEYS.ACTIVE, incidentId);
    return null;
  }

  /**
   * Check if incident is currently escalating
   */
  async isEscalating(incidentId: string): Promise<boolean> {
    const state = await this.getEscalationState(incidentId);
    return state !== null && !state.isComplete;
  }

  /**
   * Get acknowledgment status
   */
  async isAcknowledged(incidentId: string): Promise<boolean> {
    const state = await this.getEscalationState(incidentId);
    return state !== null && state.acknowledgments.length > 0;
  }

  /**
   * Get time until next escalation
   */
  async getTimeUntilNextEscalation(incidentId: string): Promise<number | null> {
    const state = await this.getEscalationState(incidentId);
    if (!state || state.isComplete) {
      return null;
    }

    const timerInfo = await this.redisService.getJson<{ nextEscalationAt: string }>(
      `${REDIS_KEYS.TIMER}${incidentId}`
    );

    if (!timerInfo) {
      return null;
    }

    const remaining = new Date(timerInfo.nextEscalationAt).getTime() - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Pause escalation
   */
  async pauseEscalation(incidentId: string): Promise<boolean> {
    const state = await this.getEscalationState(incidentId);
    if (!state || state.isComplete) {
      return false;
    }

    await this.cancelEscalationTimeout(incidentId);
    return true;
  }

  /**
   * Resume escalation
   */
  async resumeEscalation(incidentId: string): Promise<boolean> {
    const state = await this.getEscalationState(incidentId);
    if (!state || state.isComplete) {
      return false;
    }

    const incident = await this.inTenantOf(state, () =>
      this.incidentRepository.findOne({
        where: { id: incidentId },
      }),
    );

    if (!incident) {
      return false;
    }

    let policy: EscalationPolicy;
    try {
      policy = await this.policyService.getPolicy(state.policyId, incident.tenantId);
    } catch (error) {
      this.logger.warn(
        `Policy ${state.policyId} not found when resuming escalation for incident ${incidentId}. ` +
        'Cannot resume without a valid policy.',
        error,
      );
      return false;
    }

    await this.setEscalationTimeout(incidentId, policy);

    return true;
  }

  /**
   * Record notification sent
   */
  async recordNotification(
    incidentId: string,
    notification: Omit<NotificationRecord, 'id'>,
  ): Promise<void> {
    const state = await this.getEscalationState(incidentId);
    if (!state) {
      return;
    }

    state.notifications.push({
      ...notification,
      id: `${incidentId}-${Date.now()}`,
    });
    await this.saveState(state);
  }

  /**
   * Record notification delivery
   */
  async recordNotificationDelivery(
    incidentId: string,
    notificationId: string,
    delivered: boolean,
    error?: string,
  ): Promise<void> {
    const state = await this.getEscalationState(incidentId);
    if (!state) {
      return;
    }

    const notification = state.notifications.find(n => n.id === notificationId);
    if (notification) {
      if (delivered) {
        notification.deliveredAt = new Date();
      } else {
        notification.failedAt = new Date();
        notification.error = error;
      }
      await this.saveState(state);
    }
  }

  /**
   * Get escalation metrics for incident
   */
  async getEscalationMetrics(incidentId: string): Promise<Record<string, unknown> | null> {
    const state = await this.getEscalationState(incidentId);
    if (!state) {
      return null;
    }

    const totalNotifications = state.notifications.length;
    const deliveredNotifications = state.notifications.filter(n => n.deliveredAt).length;
    const failedNotifications = state.notifications.filter(n => n.failedAt).length;

    return {
      incidentId,
      policyId: state.policyId,
      currentLevel: state.currentLevel,
      escalationCount: state.escalationCount,
      isComplete: state.isComplete,
      isAcknowledged: state.acknowledgments.length > 0,
      acknowledgments: state.acknowledgments.length,
      notifications: {
        total: totalNotifications,
        delivered: deliveredNotifications,
        failed: failedNotifications,
        pending: totalNotifications - deliveredNotifications - failedNotifications,
      },
      duration: Date.now() - new Date(state.startedAt).getTime(),
    };
  }

  /**
   * Resolve target users for escalation level
   */
  private resolveTargetUsers(policy: EscalationPolicy | null, level: EscalationLevel): string[] {
    const users: Set<string> = new Set(level.notifyUserIds);
    // The on-call user of a policy-driven ladder is paged with every level.
    const onCallUser = policy?.getCurrentOnCall();
    if (onCallUser) {
      users.add(onCallUser);
    }
    return Array.from(users);
  }

  /**
   * Format escalation message
   */
  private formatEscalationMessage(
    incident: AlertIncident,
    level: EscalationLevel,
    policyName: string,
  ): string {
    if (level.messageTemplate) {
      return level.messageTemplate
        .replace('{{incidentId}}', incident.id)
        .replace('{{title}}', incident.title)
        .replace('{{level}}', level.level.toString())
        .replace('{{levelName}}', level.name)
        .replace('{{policyName}}', policyName);
    }

    return `[Escalation Level ${level.level}] ${incident.title} - Action required`;
  }

  /**
   * Set escalation timeout
   */
  private async setEscalationTimeout(incidentId: string, policy: EscalationPolicy): Promise<void> {
    const state = await this.getEscalationState(incidentId);
    if (!state) {
      return;
    }

    const currentLevel = policy.getLevel(state.currentLevel);
    if (!currentLevel) {
      return;
    }

    const timeoutMs = currentLevel.timeoutMinutes * 60 * 1000;
    const nextEscalationAt = new Date(Date.now() + timeoutMs);

    // Clear existing timer
    await this.cancelEscalationTimeout(incidentId);

    // Save timer info to Redis for recovery
    await this.redisService.setJson(
      `${REDIS_KEYS.TIMER}${incidentId}`,
      { nextEscalationAt: nextEscalationAt.toISOString() },
      Math.ceil(timeoutMs / 1000) + 60 // TTL slightly longer than timeout
    );

    // Set new timer. A Node timer has no caller to hand a rejection to, so the
    // callback owns its failure (logged) instead of leaking an unhandled one;
    // the missed-escalation sweep re-drives any tick that failed.
    const timer = setTimeout(() => {
      void this.handleEscalationTimeout(incidentId);
    }, timeoutMs);

    this.escalationTimers.set(incidentId, timer);
  }

  /** Timer tick: advance the ladder, never throwing out of the timer. */
  private async handleEscalationTimeout(incidentId: string): Promise<void> {
    try {
      this.logger.log(`Escalation timeout for incident ${incidentId}`);

      const currentState = await this.getEscalationState(incidentId);
      this.eventEmitter.emit(ESCALATION_EVENTS.TIMEOUT, {
        incidentId,
        level: currentState?.currentLevel,
      });

      await this.escalateToNextLevel(incidentId);
    } catch (error) {
      this.logger.error(
        `Escalation timeout handling failed for incident ${incidentId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Run `fn` inside the escalation's tenant context. WHY: every incident read
   * outside a request (timers, sweep, restore) must route to `tenant_<uuid>`;
   * the state carries the tenant so no caller has to remember it.
   */
  private inTenantOf<T>(state: EscalationState, fn: () => Promise<T>): Promise<T> {
    return withTenantContext(state.tenantId, fn);
  }

  /**
   * Cancel escalation timeout
   */
  private async cancelEscalationTimeout(incidentId: string): Promise<void> {
    const timer = this.escalationTimers.get(incidentId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(incidentId);
    }
    // Also delete timer info from Redis
    await this.redisService.del(`${REDIS_KEYS.TIMER}${incidentId}`);
  }

  /**
   * Clean up completed escalations
   * Note: Redis TTL handles automatic cleanup, this is for manual cleanup if needed
   */
  async cleanupCompletedEscalations(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    // Get all state keys
    const stateKeys = await this.redisService.scan('escalation:state:*');

    for (const key of stateKeys) {
      const incidentId = key.replace('escalation:state:', '');
      const state = await this.getEscalationState(incidentId);

      if (state && state.isComplete && now - new Date(state.startedAt).getTime() > maxAgeMs) {
        await this.redisService.del(`${REDIS_KEYS.STATE}${incidentId}`);
        await this.redisService.del(`${REDIS_KEYS.TIMER}${incidentId}`);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get all active escalations.
   * PE-19: Fetch all escalation states concurrently instead of sequentially.
   */
  async getActiveEscalations(): Promise<EscalationState[]> {
    const activeIds = await this.redisService.smembers(REDIS_KEYS.ACTIVE) || [];
    if (activeIds.length === 0) return [];

    const states = await Promise.all(activeIds.map(id => this.getEscalationState(id)));
    return states.filter((s): s is EscalationState => s !== null && !s.isComplete);
  }

  /**
   * Get escalation statistics.
   * PE-19: Fetch all states concurrently via Promise.all instead of sequential awaiting.
   */
  async getStatistics(): Promise<Record<string, number>> {
    const stateKeys = await this.redisService.scan('escalation:state:*');
    if (stateKeys.length === 0) {
      return { total: 0, active: 0, completed: 0, acknowledged: 0 };
    }

    const incidentIds = stateKeys.map(k => k.replace('escalation:state:', ''));
    const allStates = await Promise.all(incidentIds.map(id => this.getEscalationState(id)));

    let total = 0;
    let active = 0;
    let completed = 0;
    let acknowledged = 0;

    for (const state of allStates) {
      if (state) {
        total++;
        if (state.isComplete) {
          completed++;
        } else {
          active++;
        }
        if (state.acknowledgments.length > 0) {
          acknowledged++;
        }
      }
    }

    return { total, active, completed, acknowledged };
  }
}
