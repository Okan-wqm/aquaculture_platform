/**
 * AutoRule Trigger Engine
 *
 * Event-driven service that listens to domain events and automatically
 * creates tasks when conditions match active AutoRules.
 *
 * IMPORTANT: NATS event handlers and scheduled jobs run OUTSIDE HTTP request
 * context: there is NO AsyncLocalStorage context and NO TenantSchemaMiddleware.
 * `auto_rules` and `tasks` are under FORCE row-level security, so a runner with
 * only a `search_path` reads zero rows and has every write refused (FARM-HIGH-481:
 * no AutoRule ever fired). Every database operation therefore runs inside
 * `runInTenantTransaction` / `runInTenantRead` / the tenant-bound fan-out, which
 * pin the schema AND bind `app.current_tenant`.
 *
 * Supported trigger types:
 * - STOCK_LOW: inventory.lowStock events
 * - MAINTENANCE_DUE: maintenance.schedule.due events
 * - WATER_PARAM_ALERT: alert.waterQuality events
 * - EXPIRY_NEAR: feeding.expiryWarning events
 * - SCHEDULE: cron-based (hourly check)
 * - LICENSE_EXPIRY: reserved for future implementation
 *
 * @module Task/Services
 */
import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { NatsEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import {
  forEachVerifiedTenantSchema,
  isValidUUID,
  runInTenantRead,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { AutoRule, AutoRuleTrigger } from '../entities/auto-rule.entity';
import { Task, TaskStatus } from '../entities/task.entity';

// Map trigger types to the NATS event subjects they listen for
const TRIGGER_EVENT_MAP: Record<string, AutoRuleTrigger> = {
  'inventory.lowStock': AutoRuleTrigger.STOCK_LOW,
  'maintenance.schedule.due': AutoRuleTrigger.MAINTENANCE_DUE,
  'alert.waterQuality': AutoRuleTrigger.WATER_PARAM_ALERT,
  'feeding.expiryWarning': AutoRuleTrigger.EXPIRY_NEAR,
};

// UUID validation imported from @aquaculture/backend-common (isValidUUID)

/** What a rule reads from the event that fired it (a SCHEDULE rule has none). */
type RuleTriggerEvent = { userId?: string; assignedTo?: string } & Record<string, unknown>;

@Injectable()
export class AutoRuleTriggerService implements OnModuleInit {
  private readonly logger = new Logger(AutoRuleTriggerService.name);

  constructor(
    @InjectRepository(AutoRule)
    private readonly autoRuleRepository: Repository<AutoRule>,
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    private readonly dataSource: DataSource,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn('EVENT_BUS not available — AutoRule triggers will not fire from events');
      return;
    }

    // Subscribe to all relevant events
    for (const eventName of Object.keys(TRIGGER_EVENT_MAP)) {
      try {
        await this.eventBus.subscribe(eventName, {
          getEventType: () => eventName,
          handle: (event: any): Promise<HandlerOutcome> => this.handleEvent(eventName, event),
        } as IEventHandler<any>);
        this.logger.log(`Subscribed to ${eventName} for AutoRule triggers`);
      } catch (err) {
        this.logger.warn(`Failed to subscribe to ${eventName}: ${(err as Error).message}`);
      }
    }
  }

  // getTenantSchemaName imported from @aquaculture/backend-common

  /**
   * Handle an incoming NATS domain event and check for matching AutoRules.
   *
   * NATS handlers run outside HTTP request context -- no AsyncLocalStorage,
   * no TenantSchemaMiddleware. We must use a dedicated QueryRunner with
   * explicit SET search_path for tenant schema isolation.
   */
  async handleEvent(eventName: string, event: any): Promise<HandlerOutcome> {
    const tenantId = event?.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${eventName} has no tenantId, skipping`);
      return HandlerOutcome.terminate(`${eventName}: missing tenantId`);
    }

    // Validate UUID format to prevent SQL injection via search_path
    if (!isValidUUID(tenantId)) {
      this.logger.error(`Event ${eventName} has invalid tenantId format: ${tenantId}`);
      return HandlerOutcome.terminate(`${eventName}: invalid tenantId`);
    }

    const triggerType = TRIGGER_EVENT_MAP[eventName];
    if (!triggerType) return HandlerOutcome.ack();

    this.logger.debug(`Processing ${eventName} for tenant ${tenantId}`);

    try {
      // Find active rules matching this trigger type for this tenant
      const matchingRules = await runInTenantRead(
        this.dataSource,
        'farm',
        tenantId,
        (queryRunner) =>
          queryRunner.manager.find(AutoRule, {
            where: {
              tenantId,
              trigger: triggerType,
              isActive: true,
            },
          }),
      );

      for (const rule of matchingRules) {
        try {
          await this.executeRule(rule, event);
        } catch (err) {
          // One rule failing must not block its siblings; the failure is
          // logged per rule and the trigger is acknowledged (a rule's task is
          // recreated by the next matching trigger, not by redelivery).
          this.logger.error(`Failed to execute AutoRule ${rule.id}: ${(err as Error).message}`);
        }
      }
      return HandlerOutcome.ack();
    } catch (err) {
      this.logger.error(
        `Failed to process ${eventName} for tenant ${tenantId}: ${(err as Error).message}`,
      );
      // The rule lookup itself failed (search_path / DB) — retry within the
      // delivery budget instead of acknowledging a lost trigger.
      return HandlerOutcome.retry(`${eventName}: auto-rule lookup failed`, err);
    }
  }

  /**
   * Execute one AutoRule: its task and its stats commit in ONE tenant
   * transaction (a rule that fails leaves nothing behind and cannot poison its
   * siblings), and the TaskCreated event is published only after that commit.
   */
  private async executeRule(rule: AutoRule, triggerEvent: RuleTriggerEvent): Promise<void> {
    const saved = await runInTenantTransaction(
      this.dataSource,
      'farm',
      rule.tenantId,
      (queryRunner) => this.createTaskForRule(rule, triggerEvent, queryRunner),
    );
    await this.publishTaskCreated(rule, saved);
  }

  /** Create the rule's task and bump the rule's stats on the caller's tenant transaction. */
  private async createTaskForRule(
    rule: AutoRule,
    triggerEvent: RuleTriggerEvent,
    queryRunner: QueryRunner,
  ): Promise<Task> {
    // Build task title with context from trigger event
    const taskTitle = this.interpolateTitle(rule.taskTitle, triggerEvent);

    const task = queryRunner.manager.create(Task, {
      tenantId: rule.tenantId,
      title: taskTitle,
      description: rule.taskDescription || undefined,
      category: rule.taskCategory,
      priority: rule.taskPriority,
      status: TaskStatus.PENDING,
      assignedTo: rule.assignTo || triggerEvent.userId || triggerEvent.assignedTo,
      assignedToName: 'Otomatik Atama',
      createdBy: rule.assignTo || triggerEvent.userId || 'system',
      dueDate: new Date(), // Due today
      checklistItems: [],
      notes: [],
      isAutoGenerated: true,
      isRecurring: false,
    });

    const saved = await queryRunner.manager.save(Task, task);

    // Update rule stats
    rule.lastTriggered = new Date();
    rule.triggerCount += 1;
    await queryRunner.manager.save(AutoRule, rule);

    return saved;
  }

  /** Publish TaskCreated for the notification fan-out, after the task is committed. */
  private async publishTaskCreated(rule: AutoRule, saved: Task): Promise<void> {
    if (this.eventBus && saved.assignedTo) {
      try {
        await this.eventBus.publish({
          ...createBaseEvent('TaskCreated', rule.tenantId),
          taskId: saved.id,
          title: saved.title,
          assignedTo: saved.assignedTo,
          assignedToName: saved.assignedToName,
          category: saved.category,
          priority: saved.priority,
          dueDate: saved.dueDate?.toISOString(),
          createdBy: 'auto-rule',
        });
      } catch (eventError) {
        this.logger.warn(
          `Failed to publish TaskCreated event for auto-rule task: ${(eventError as Error).message}`,
        );
      }
    }

    this.logger.log(
      `AutoRule "${rule.name}" triggered — created task "${saved.title}" (${saved.id})`,
    );
  }

  /**
   * Interpolate trigger event data into task title
   * Supports {eventField} placeholders
   */
  private interpolateTitle(template: string, event: RuleTriggerEvent): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => {
      return String(event[key] ?? key);
    });
  }

  // getTenantSchemas and getTenantSchemaName imported from @aquaculture/backend-common

  /**
   * SCHEDULE trigger type — runs every hour and checks for SCHEDULE-type rules.
   * These are simple time-based rules without external event triggers.
   *
   * Cron jobs also run outside HTTP request context, so we must iterate
   * tenant schemas with dedicated QueryRunners (same pattern as cron-jobs.service.ts).
   */
  @ScheduledJob({ name: 'task.process-schedule-rules', cron: '0 0 * * * *' })
  async processScheduleRules(): Promise<void> {
    this.logger.debug('Checking SCHEDULE-type AutoRules...');

    const now = new Date();
    const dueRules: AutoRule[] = [];

    // Phase 1 — find what is due, per tenant, on the tenant-bound fan-out
    // (read only; a tenant whose lookup fails is reported and the others go on).
    const results = await forEachVerifiedTenantSchema(
      this.dataSource,
      async ({ queryRunner }) => {
        const scheduleRules = await queryRunner.manager.find(AutoRule, {
          where: {
            trigger: AutoRuleTrigger.SCHEDULE,
            isActive: true,
          },
        });

        for (const rule of scheduleRules) {
          // Check if enough time has passed since last trigger
          // triggerCondition for SCHEDULE type contains interval in hours (e.g., "24", "48")
          const intervalHours = parseInt(rule.triggerCondition, 10);
          if (isNaN(intervalHours) || intervalHours <= 0) {
            this.logger.warn(
              `Invalid SCHEDULE interval for rule ${rule.id}: "${rule.triggerCondition}"`,
            );
            continue;
          }

          if (rule.lastTriggered) {
            const elapsed = (now.getTime() - new Date(rule.lastTriggered).getTime()) / 3600000;
            if (elapsed < intervalHours) continue;
          }

          dueRules.push(rule);
        }
      },
      { logger: this.logger },
    );

    for (const failed of results.filter((result) => result.outcome !== 'ok')) {
      this.logger.error(
        `SCHEDULE rules processing ${failed.outcome} for schema ${failed.schemaName}: ${failed.error?.message}`,
      );
    }

    // Phase 2 — each due rule in its own tenant transaction.
    for (const rule of dueRules) {
      try {
        await this.executeRule(rule, { tenantId: rule.tenantId });
      } catch (err) {
        this.logger.error(`Failed to process SCHEDULE rule ${rule.id}: ${(err as Error).message}`);
      }
    }
  }
}
