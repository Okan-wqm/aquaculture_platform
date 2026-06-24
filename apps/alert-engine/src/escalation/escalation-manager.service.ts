import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, AlertEscalatedEvent } from '@platform/event-contracts';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  EscalationPolicy,
  EscalationLevel,
  EscalationActionType,
  NotificationChannel,
} from '../database/entities/escalation-policy.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../database/entities/alert-incident.entity';
import { AlertSeverity } from '../database/entities/alert-rule.entity';
import { EscalationPolicyService } from './escalation-policy.service';

/**
 * Escalation state for an incident
 */
export interface EscalationState {
  incidentId: string;
  policyId: string;
  currentLevel: number;
  startedAt: Date;
  lastEscalatedAt: Date;
  escalationCount: number;
  acknowledgments: AcknowledgmentRecord[];
  notifications: NotificationRecord[];
  isComplete: boolean;
}

/**
 * Acknowledgment record
 */
export interface AcknowledgmentRecord {
  userId: string;
  timestamp: Date;
  level: number;
  message?: string;
}

/**
 * Notification record
 */
export interface NotificationRecord {
  id: string;
  userId: string;
  channel: NotificationChannel;
  level: number;
  sentAt: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  error?: string;
}

/**
 * Escalation action
 */
export interface EscalationAction {
  type: EscalationActionType;
  level: number;
  targetUsers: string[];
  targetTeams?: string[];
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
   * Restore active timers from Redis on startup
   */
  private async restoreActiveTimers(): Promise<void> {
    try {
      const activeIds = await this.redisService.smembers(REDIS_KEYS.ACTIVE) || [];

      for (const incidentId of activeIds) {
        // Distributed lock: only one replica restores the timer for each incident
        const lockKey = `${REDIS_KEYS.LOCK}${incidentId}`;
        const acquired = await this.redisService.setNx(lockKey, this.instanceId, 300);
        if (!acquired) continue;

        try {
          const state = await this.getEscalationState(incidentId);
          if (state && !state.isComplete) {
            const incident = await this.incidentRepository.findOne({
              where: { id: incidentId },
            });

            if (incident) {
              const policy = await this.policyService.getPolicy(state.policyId, incident.tenantId);
              if (policy) {
                await this.setEscalationTimeout(incidentId, policy);
                this.logger.log(`Restored timer for incident ${incidentId}`);
              }
            }
          }
        } finally {
          await this.redisService.del(lockKey);
        }
      }
    } catch (error) {
      this.logger.error('Failed to restore active timers', error);
    }
  }

  /**
   * Check for missed escalations (in case of server restart during timeout)
   */
  private async checkMissedEscalations(): Promise<void> {
    try {
      const activeIds = await this.redisService.smembers(REDIS_KEYS.ACTIVE) || [];

      for (const incidentId of activeIds) {
        // Distributed lock: only one replica handles each incident's escalation check
        const lockKey = `${REDIS_KEYS.LOCK}${incidentId}`;
        const acquired = await this.redisService.setNx(lockKey, this.instanceId, 300);
        if (!acquired) continue; // another instance is handling this incident

        try {
          const state = await this.getEscalationState(incidentId);
          if (!state || state.isComplete) continue;

          // Check if escalation should have happened
          const timerInfo = await this.redisService.getJson<{ nextEscalationAt: string }>(
            `${REDIS_KEYS.TIMER}${incidentId}`
          );

          if (timerInfo && new Date(timerInfo.nextEscalationAt) < new Date()) {
            // Check that the incident has not been acknowledged or resolved since the timer was set
            const incident = await this.incidentRepository.findOne({ where: { id: incidentId } });
            if (
              incident &&
              incident.status !== IncidentStatus.ACKNOWLEDGED &&
              incident.status !== IncidentStatus.RESOLVED &&
              incident.status !== IncidentStatus.CLOSED
            ) {
              // Missed escalation - trigger it now
              this.logger.warn(`Triggering missed escalation for incident ${incidentId}`);
              await this.escalateToNextLevel(incidentId);
            } else {
              this.logger.log(
                `Skipping missed escalation for incident ${incidentId} — status is ${incident?.status ?? 'not found'}`,
              );
            }
          }
        } finally {
          // Release lock after processing
          await this.redisService.del(lockKey);
        }
      }
    } catch (error) {
      this.logger.error('Error checking missed escalations', error);
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
   * Start escalation for an incident
   */
  async startEscalation(
    incident: AlertIncident,
    severity: AlertSeverity,
    ruleId?: string,
    farmId?: string,
  ): Promise<EscalationState | null> {
    this.logger.log(`Starting escalation for incident ${incident.id}`);

    // Find matching policy
    const policy = await this.policyService.findMatchingPolicy(
      incident.tenantId,
      severity,
      ruleId,
      farmId,
    );

    if (!policy) {
      this.logger.warn(`No escalation policy found for incident ${incident.id}`);
      return null;
    }

    // Check if in suppression window
    if (policy.isInSuppressionWindow()) {
      this.logger.log(`Incident ${incident.id} suppressed due to suppression window`);
      this.eventEmitter.emit(ESCALATION_EVENTS.SUPPRESSED, {
        incidentId: incident.id,
        policyId: policy.id,
      });
      return null;
    }

    // Initialize escalation state
    const state: EscalationState = {
      incidentId: incident.id,
      policyId: policy.id,
      currentLevel: 1,
      startedAt: new Date(),
      lastEscalatedAt: new Date(),
      escalationCount: 0,
      acknowledgments: [],
      notifications: [],
      isComplete: false,
    };

    await this.saveState(state);

    // Execute first level escalation
    await this.executeEscalationLevel(incident, policy, 1);

    // Set timeout for next level
    await this.setEscalationTimeout(incident.id, policy);

    return state;
  }

  /**
   * Execute escalation for a specific level
   */
  async executeEscalationLevel(
    incident: AlertIncident,
    policy: EscalationPolicy,
    level: number,
  ): Promise<EscalationResult> {
    const levelConfig = policy.getLevel(level);

    if (!levelConfig) {
      return {
        success: false,
        incidentId: incident.id,
        fromLevel: level - 1,
        toLevel: level,
        actions: [],
        errors: [`Level ${level} not found in policy`],
      };
    }

    this.logger.log(`Executing escalation level ${level} for incident ${incident.id}`);

    const actions: EscalationAction[] = [];
    const errors: string[] = [];

    try {
      // Get target users
      const targetUsers = this.resolveTargetUsers(policy, levelConfig);

      // Create escalation action
      const action: EscalationAction = {
        type: levelConfig.action,
        level,
        targetUsers,
        targetTeams: levelConfig.notifyTeamIds,
        channels: levelConfig.channels,
        message: this.formatEscalationMessage(incident, levelConfig, policy),
        metadata: {
          policyId: policy.id,
          policyName: policy.name,
          levelName: levelConfig.name,
        },
      };

      actions.push(action);

      // Update state
      const state = await this.getEscalationState(incident.id);
      if (state) {
        state.currentLevel = level;
        state.lastEscalatedAt = new Date();
        state.escalationCount++;
        await this.saveState(state);
      }

      // LIFE-SAFETY (ALERT-CRITICAL-001): the incident escalation-level write
      // and the AlertEscalated event commit atomically via the transactional
      // outbox. notification-service consumes AlertEscalated to widen the
      // operator notification fan-out as an incident climbs the escalation
      // ladder; a publish dropped after the incident write committed (the
      // previous fire-and-forget behaviour) left the incident escalated but
      // the wider on-call group never paged. No try/catch wraps the enqueue —
      // a failed enqueue rolls back the escalation-level write so they stay
      // consistent.
      const event = this.buildAlertEscalatedEvent(incident, level, action);
      await this.dataSource.transaction(async (manager) => {
        await this.updateIncidentEscalation(manager, incident, level, policy);
        await this.outboxPublisher.enqueue(event, manager);
      });

      // Emit local event AFTER the durable commit so in-process listeners
      // never observe an escalation that later rolled back.
      this.eventEmitter.emit(ESCALATION_EVENTS.ESCALATED, {
        incidentId: incident.id,
        level,
        action,
      });

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
    }

    return {
      success: errors.length === 0,
      incidentId: incident.id,
      fromLevel: level - 1,
      toLevel: level,
      actions,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Escalate to next level
   */
  async escalateToNextLevel(incidentId: string): Promise<EscalationResult | null> {
    const state = await this.getEscalationState(incidentId);
    if (!state || state.isComplete) {
      return null;
    }

    const incident = await this.incidentRepository.findOne({
      where: { id: incidentId },
    });

    if (!incident) {
      return null;
    }

    const policy = await this.policyService.getPolicy(state.policyId, incident.tenantId);

    // Safety check: if policy was deleted while escalation was in progress
    if (!policy) {
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
        // Repeat current level
        return this.executeEscalationLevel(incident, policy, state.currentLevel);
      } else {
        // Escalation complete
        await this.completeEscalation(incidentId, 'max_repeats_reached');
        return null;
      }
    }

    const result = await this.executeEscalationLevel(incident, policy, nextLevel);

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
    const incident = await this.incidentRepository.findOne({
      where: { id: incidentId },
    });

    if (incident) {
      incident.acknowledge(userId);
      await this.incidentRepository.save(incident);
    }

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
    return this.redisService.getJson<EscalationState>(`${REDIS_KEYS.STATE}${incidentId}`);
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

    const incident = await this.incidentRepository.findOne({
      where: { id: incidentId },
    });

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
  private resolveTargetUsers(policy: EscalationPolicy, level: EscalationLevel): string[] {
    const users: Set<string> = new Set();

    // Add configured users
    for (const userId of level.notifyUserIds) {
      users.add(userId);
    }

    // Check on-call schedule
    const onCallUser = policy.getCurrentOnCall();
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
    policy: EscalationPolicy,
  ): string {
    if (level.messageTemplate) {
      return level.messageTemplate
        .replace('{{incidentId}}', incident.id)
        .replace('{{title}}', incident.title)
        .replace('{{level}}', level.level.toString())
        .replace('{{levelName}}', level.name)
        .replace('{{policyName}}', policy.name);
    }

    return `[Escalation Level ${level.level}] ${incident.title} - Action required`;
  }

  /**
   * Update incident with escalation info
   */
  private async updateIncidentEscalation(
    manager: EntityManager,
    incident: AlertIncident,
    level: number,
    policy: EscalationPolicy,
  ): Promise<void> {
    incident.escalationLevel = level;
    incident.addTimelineEvent({
      type: TimelineEventType.ESCALATED,
      userId: 'system',
      data: {
        level,
        policyId: policy.id,
        policyName: policy.name,
      },
    });

    await manager.save(AlertIncident, incident);
  }

  /**
   * Build the AlertEscalated domain event.
   *
   * Pure builder: performs NO I/O. The caller enqueues the returned event on
   * the transaction manager so it commits atomically with the incident
   * escalation-level write (ALERT-CRITICAL-001).
   */
  private buildAlertEscalatedEvent(
    incident: AlertIncident,
    level: number,
    action: EscalationAction,
  ): AlertEscalatedEvent {
    return {
      ...createBaseEvent<AlertEscalatedEvent>('AlertEscalated', incident.tenantId, {
        aggregateId: incident.id,
        aggregateType: 'AlertIncident',
      }),
      alertId: incident.id,
      escalationLevel: level,
      escalatedTo: action.targetUsers,
      reason: action.message,
    };
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

    // Set new timer
    const timer = setTimeout(async () => {
      this.logger.log(`Escalation timeout for incident ${incidentId}`);

      const currentState = await this.getEscalationState(incidentId);
      this.eventEmitter.emit(ESCALATION_EVENTS.TIMEOUT, {
        incidentId,
        level: currentState?.currentLevel,
      });

      await this.escalateToNextLevel(incidentId);
    }, timeoutMs);

    this.escalationTimers.set(incidentId, timer);
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
