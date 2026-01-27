import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '@platform/backend-common';
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

  constructor(
    @InjectRepository(AlertIncident)
    private readonly incidentRepository: Repository<AlertIncident>,
    private readonly policyService: EscalationPolicyService,
    private readonly eventEmitter: EventEmitter2,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    // Restore active escalation timers on startup
    await this.restoreActiveTimers();

    // Start periodic timer check to handle missed escalations
    this.timerCheckInterval = setInterval(() => {
      this.checkMissedEscalations();
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
      const activeIds = await this.redisService.getJson<string[]>(REDIS_KEYS.ACTIVE) || [];

      for (const incidentId of activeIds) {
        const state = await this.getEscalationState(incidentId);
        if (state && !state.isComplete) {
          const incident = await this.incidentRepository.findOne({
            where: { id: incidentId },
          });

          if (incident) {
            const policy = await this.policyService.getPolicy(state.policyId, incident.tenantId);
            if (policy) {
              this.setEscalationTimeout(incidentId, policy);
              this.logger.log(`Restored timer for incident ${incidentId}`);
            }
          }
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
      const activeIds = await this.redisService.getJson<string[]>(REDIS_KEYS.ACTIVE) || [];

      for (const incidentId of activeIds) {
        const state = await this.getEscalationState(incidentId);
        if (!state || state.isComplete) continue;

        // Check if escalation should have happened
        const timerInfo = await this.redisService.getJson<{ nextEscalationAt: string }>(
          `${REDIS_KEYS.TIMER}${incidentId}`
        );

        if (timerInfo && new Date(timerInfo.nextEscalationAt) < new Date()) {
          // Missed escalation - trigger it now
          this.logger.warn(`Triggering missed escalation for incident ${incidentId}`);
          await this.escalateToNextLevel(incidentId);
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

    // Update active list
    const activeIds = await this.redisService.getJson<string[]>(REDIS_KEYS.ACTIVE) || [];
    if (!state.isComplete && !activeIds.includes(state.incidentId)) {
      activeIds.push(state.incidentId);
      await this.redisService.setJson(REDIS_KEYS.ACTIVE, activeIds);
    } else if (state.isComplete && activeIds.includes(state.incidentId)) {
      const updatedIds = activeIds.filter(id => id !== state.incidentId);
      await this.redisService.setJson(REDIS_KEYS.ACTIVE, updatedIds);
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
    this.setEscalationTimeout(incident.id, policy);

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

      // Update incident
      await this.updateIncidentEscalation(incident, level, policy);

      // Emit event
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
    this.setEscalationTimeout(incidentId, policy);

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
    this.cancelEscalationTimeout(incidentId);

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
    this.cancelEscalationTimeout(incidentId);

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

    this.cancelEscalationTimeout(incidentId);
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

    const policy = await this.policyService.getPolicy(state.policyId, incident.tenantId);
    this.setEscalationTimeout(incidentId, policy);

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

    await this.incidentRepository.save(incident);
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
    this.cancelEscalationTimeout(incidentId);

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
    const stateKeys = await this.redisService.keys('escalation:state:*');

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
   * Get all active escalations
   */
  async getActiveEscalations(): Promise<EscalationState[]> {
    const activeIds = await this.redisService.getJson<string[]>(REDIS_KEYS.ACTIVE) || [];
    const states: EscalationState[] = [];

    for (const incidentId of activeIds) {
      const state = await this.getEscalationState(incidentId);
      if (state && !state.isComplete) {
        states.push(state);
      }
    }

    return states;
  }

  /**
   * Get escalation statistics
   */
  async getStatistics(): Promise<Record<string, number>> {
    const stateKeys = await this.redisService.keys('escalation:state:*');
    let total = 0;
    let active = 0;
    let completed = 0;
    let acknowledged = 0;

    for (const key of stateKeys) {
      const incidentId = key.replace('escalation:state:', '');
      const state = await this.getEscalationState(incidentId);
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
