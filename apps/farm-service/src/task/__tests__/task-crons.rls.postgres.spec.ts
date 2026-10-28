/**
 * The task crons and the AutoRule engine under the production row security, on
 * REAL Postgres (FARM-HIGH-481).
 *
 * ## The defect this pins
 *
 * Every tenant table (`tasks`, `recurring_templates`, `auto_rules`, …) carries
 * FORCED row-level security: the policy reads `app.current_tenant`. A cron tick
 * or a NATS handler has no request, so the pool is deny-by-default. The crons
 * listed the `tenant_*` schemas and opened a bare QueryRunner with only a
 * `search_path`, so on production `farm_service` saw 0 of the test tenant's 8
 * tasks: `task.detect-overdue` never found an overdue task, `task.generate-due`
 * never generated one, and no AutoRule ever fired (neither the hourly SCHEDULE
 * sweep nor the event path). No unit spec could see it — a mocked QueryRunner
 * enforces no policy — and the other farm postgres specs run as the owner role,
 * which bypasses RLS.
 *
 * ## The stage
 *
 * Non-owner runtime role (what `farm_service` is), FORCE RLS armed by the
 * platform helper exactly as db-migrate arms it, the platform tenant↔schema
 * mapping the cross-tenant workers read, three tenants (two active, one
 * suspended), the REAL entities as the tables and the REAL services. Only the
 * collaborators that are not under test (the outbox transport, the event bus)
 * are doubles. Every refusal is paired with an acceptance on the same stage, so
 * a deny-everything implementation fails this spec as surely as a leaky one.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import {
  armTenantRls,
  publishActiveTenantMappings,
  publishRetainedTenantMappings,
} from '@aquaculture/backend-common/database/testing';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { stub } from '@aquaculture/testing';
import { HandlerOutcome, type NatsEventBus } from '@platform/event-bus';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, type Repository } from 'typeorm';

import { AutoRule, AutoRuleTrigger } from '../entities/auto-rule.entity';
import { RecurrenceFrequency, RecurringTemplate } from '../entities/recurring-template.entity';
import { Task, TaskCategory, TaskPriority, TaskStatus } from '../entities/task.entity';
import { AutoRuleTriggerService } from '../services/auto-rule-trigger.service';
import { RecurringTaskService } from '../services/recurring-task.service';
import { TaskService } from '../services/task.service';

const ACTIVE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTIVE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** Suspended by the platform: it has a schema and rows, but it is not served. */
const SUSPENDED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = '11111111-1111-4111-8111-111111111111';

const ACTIVE = [ACTIVE_A, ACTIVE_B];
const ALL = [ACTIVE_A, ACTIVE_B, SUSPENDED];
const ENTITIES = [Task, RecurringTemplate, AutoRule];

jest.setTimeout(300_000);

interface Stage {
  readonly harness: HarnessContext;
  /** Owner connection, bypasses RLS: seeding and ground truth only. */
  readonly admin: DataSource;
  /** The same owner, with the entities registered (the harness connection has none). */
  readonly owner: DataSource;
  readonly runtime: DataSource;
}

async function bootStage(): Promise<Stage> {
  const harness = await bootPostgresContainer({ startTimeoutMs: 180_000 });
  const admin = harness.dataSource;
  const role = `farm_task_rls_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');

  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await admin.query('CREATE SCHEMA IF NOT EXISTS platform');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);

  for (const tenantId of ALL) {
    const schema = getTenantSchemaName(tenantId);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    // The real entities create the real tables, in this tenant's schema.
    const ddl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `task-rls-ddl-${schema}`,
      schema,
      entities: ENTITIES,
      synchronize: true,
      logging: false,
    });
    await ddl.initialize();
    await ddl.destroy();
    await armTenantRls(admin, { schemaOverride: schema });
    await admin.query(
      `GRANT USAGE ON SCHEMA "${schema}" TO ${role};
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`,
    );
  }

  await publishActiveTenantMappings(admin, ACTIVE);
  await publishRetainedTenantMappings(admin, ALL);
  await admin.query(
    `GRANT USAGE ON SCHEMA platform TO ${role};
     GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${role};
     GRANT EXECUTE ON FUNCTION platform.list_retained_tenant_schema_mappings() TO ${role}`,
  );

  const owner = new DataSource({
    type: 'postgres',
    ...harness.connectionOptions,
    name: `task-rls-owner-${role}`,
    entities: ENTITIES,
    synchronize: false,
    logging: false,
  });
  await owner.initialize();

  const runtime = new DataSource({
    type: 'postgres',
    ...harness.connectionOptions,
    username: role,
    password,
    name: `task-rls-runtime-${role}`,
    entities: ENTITIES,
    synchronize: false,
    logging: false,
  });
  await runtime.initialize();
  return { harness, admin, owner, runtime };
}

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('task crons and the AutoRule engine under FORCE RLS (real Postgres, non-owner role)', () => {
  let stage: Stage;
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const publish = jest.fn().mockResolvedValue(undefined);
  let tasks: TaskService;
  let recurring: RecurringTaskService;
  let autoRules: AutoRuleTriggerService;

  /** Run `work` on the owner connection with `tenantId`'s schema first on the path. */
  async function asOwner<T>(
    tenantId: string,
    work: (manager: DataSource['manager']) => Promise<T>,
  ): Promise<T> {
    const runner = stage.owner.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${getTenantSchemaName(tenantId)}", public`);
      return await work(runner.manager);
    } finally {
      await runner.release();
    }
  }

  const taskRow = (tenantId: string, overrides: Partial<Task>): Partial<Task> => ({
    tenantId,
    title: 'Check the aerators',
    category: TaskCategory.GENERAL,
    priority: TaskPriority.MEDIUM,
    status: TaskStatus.PENDING,
    assignedTo: USER,
    assignedToName: 'Operator',
    createdBy: USER,
    dueDate: YESTERDAY,
    notes: [],
    checklistItems: [],
    ...overrides,
  });

  const statusOf = (tenantId: string, title: string): Promise<string | undefined> =>
    asOwner(tenantId, async (manager) => {
      const rows: Array<{ status: string }> = await manager.query(
        `SELECT status FROM tasks WHERE title = $1`,
        [title],
      );
      return rows[0]?.status;
    });

  const countTasks = (tenantId: string, where = 'true'): Promise<number> =>
    asOwner(tenantId, async (manager) => {
      const rows: Array<{ n: string }> = await manager.query(
        `SELECT count(*) AS n FROM tasks WHERE ${where}`,
      );
      return Number(rows[0]?.n);
    });

  beforeAll(async () => {
    stage = await bootStage();
    const outbox = stub<OutboxPublisher>({ enqueue });
    const executor = createScheduledJobTestExecutor().executor;
    tasks = new TaskService(
      stub<Repository<Task>>({}),
      stub<Repository<RecurringTemplate>>({}),
      stage.runtime,
      outbox,
      stub<MobileCommandReceiptService>({}),
      executor,
    );
    recurring = new RecurringTaskService(
      stub<Repository<RecurringTemplate>>({}),
      stub<Repository<Task>>({}),
      stage.runtime,
      outbox,
      executor,
    );
    autoRules = new AutoRuleTriggerService(
      stub<Repository<AutoRule>>({}),
      stub<Repository<Task>>({}),
      stage.runtime,
      executor,
      stub<NatsEventBus>({ subscribe: jest.fn(), publish }),
    );

    // ---- seeds (owner connection) ----
    await asOwner(ACTIVE_A, async (manager) => {
      await manager.save(Task, manager.create(Task, taskRow(ACTIVE_A, { title: 'A overdue' })));
      await manager.save(
        Task,
        manager.create(Task, taskRow(ACTIVE_A, { title: 'A future', dueDate: TOMORROW })),
      );
      await manager.save(
        Task,
        manager.create(Task, taskRow(ACTIVE_A, { title: 'A done', status: TaskStatus.COMPLETED })),
      );
    });
    await asOwner(ACTIVE_B, async (manager) => {
      await manager.save(
        Task,
        manager.create(
          Task,
          taskRow(ACTIVE_B, { title: 'B overdue', status: TaskStatus.IN_PROGRESS }),
        ),
      );
    });
    await asOwner(SUSPENDED, async (manager) => {
      await manager.save(Task, manager.create(Task, taskRow(SUSPENDED, { title: 'S overdue' })));
    });
  });

  afterAll(async () => {
    if (stage?.runtime.isInitialized) await stage.runtime.destroy();
    if (stage?.owner.isInitialized) await stage.owner.destroy();
    if (stage) await shutdownHarness(stage.harness);
  });

  beforeEach(() => {
    enqueue.mockClear();
    publish.mockClear();
  });

  describe('task.detect-overdue', () => {
    it("flips every ACTIVE tenant's overdue task and no other, and enqueues TaskOverdue for each", async () => {
      await tasks.detectOverdueTasks();

      expect(await statusOf(ACTIVE_A, 'A overdue')).toBe(TaskStatus.OVERDUE);
      expect(await statusOf(ACTIVE_B, 'B overdue')).toBe(TaskStatus.OVERDUE);
      // acceptance's other half: what is not overdue, or not served, is untouched
      expect(await statusOf(ACTIVE_A, 'A future')).toBe(TaskStatus.PENDING);
      expect(await statusOf(ACTIVE_A, 'A done')).toBe(TaskStatus.COMPLETED);
      expect(await statusOf(SUSPENDED, 'S overdue')).toBe(TaskStatus.PENDING);

      const events = enqueue.mock.calls.map(
        ([event]) => event as { eventType: string; tenantId: string },
      );
      expect(events.map((event) => [event.eventType, event.tenantId]).sort()).toEqual([
        ['TaskOverdue', ACTIVE_A],
        ['TaskOverdue', ACTIVE_B],
      ]);
    });

    it('is idempotent: a second tick finds nothing new', async () => {
      enqueue.mockClear();

      await tasks.detectOverdueTasks();

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('task.generate-due', () => {
    beforeAll(async () => {
      const template = (
        tenantId: string,
        title: string,
        nextGeneration: Date,
      ): Partial<RecurringTemplate> => ({
        tenantId,
        title,
        category: TaskCategory.CLEANING,
        priority: TaskPriority.LOW,
        frequency: RecurrenceFrequency.DAILY,
        assignedTo: USER,
        assignedToName: 'Operator',
        isActive: true,
        nextGeneration,
        checklistItems: [],
        tags: [],
      });
      await asOwner(ACTIVE_A, async (manager) => {
        await manager.save(
          RecurringTemplate,
          manager.create(RecurringTemplate, template(ACTIVE_A, 'Weekly clean (due)', YESTERDAY)),
        );
        await manager.save(
          RecurringTemplate,
          manager.create(RecurringTemplate, template(ACTIVE_A, 'Weekly clean (later)', TOMORROW)),
        );
      });
      await asOwner(SUSPENDED, async (manager) => {
        await manager.save(
          RecurringTemplate,
          manager.create(RecurringTemplate, template(SUSPENDED, 'S weekly clean', YESTERDAY)),
        );
      });
    });

    it('generates a task from each DUE template of an active tenant, only', async () => {
      enqueue.mockClear();

      const generated = await recurring.generateDueTasks();

      expect(generated.map((task) => [task.tenantId, task.title])).toEqual([
        [ACTIVE_A, 'Weekly clean (due)'],
      ]);
      expect(await countTasks(ACTIVE_A, `"recurringTemplateId" IS NOT NULL`)).toBe(1);
      expect(await countTasks(SUSPENDED, `"recurringTemplateId" IS NOT NULL`)).toBe(0);
      expect(
        enqueue.mock.calls.map(([event]) => (event as { eventType: string }).eventType),
      ).toEqual(['TaskCreated']);
    });

    it('moves the template on: the same template is not generated twice', async () => {
      const generated = await recurring.generateDueTasks();

      expect(generated).toEqual([]);
    });
  });

  describe('AutoRule engine', () => {
    beforeAll(async () => {
      const rule = (tenantId: string, over: Partial<AutoRule>): Partial<AutoRule> => ({
        tenantId,
        name: 'rule',
        trigger: AutoRuleTrigger.SCHEDULE,
        triggerCondition: '24',
        taskTitle: 'Auto: {item}',
        taskCategory: TaskCategory.STOCK_MANAGEMENT,
        taskPriority: TaskPriority.HIGH,
        isActive: true,
        ...over,
      });
      await asOwner(ACTIVE_A, async (manager) => {
        await manager.save(
          AutoRule,
          manager.create(
            AutoRule,
            rule(ACTIVE_A, { name: 'A schedule', taskTitle: 'A scheduled', assignTo: USER }),
          ),
        );
        await manager.save(
          AutoRule,
          manager.create(
            AutoRule,
            rule(ACTIVE_A, {
              name: 'A low stock',
              trigger: AutoRuleTrigger.STOCK_LOW,
              triggerCondition: 'low',
              taskTitle: 'Reorder {item}',
            }),
          ),
        );
      });
      await asOwner(SUSPENDED, async (manager) => {
        await manager.save(
          AutoRule,
          manager.create(
            AutoRule,
            rule(SUSPENDED, { name: 'S schedule', taskTitle: 'S scheduled', assignTo: USER }),
          ),
        );
      });
    });

    it("the hourly SCHEDULE sweep fires a due rule of an active tenant, once, and not a suspended tenant's", async () => {
      await autoRules.processScheduleRules();

      expect(await countTasks(ACTIVE_A, `title = 'A scheduled'`)).toBe(1);
      expect(await countTasks(SUSPENDED, `title = 'S scheduled'`)).toBe(0);
      const stats = await asOwner(ACTIVE_A, (manager) =>
        manager.query(
          `SELECT "triggerCount", "lastTriggered" FROM auto_rules WHERE name = 'A schedule'`,
        ),
      );
      expect(Number(stats[0].triggerCount)).toBe(1);
      expect(stats[0].lastTriggered).not.toBeNull();
    });

    it('does not fire the same SCHEDULE rule again inside its interval', async () => {
      await autoRules.processScheduleRules();

      expect(await countTasks(ACTIVE_A, `title = 'A scheduled'`)).toBe(1);
    });

    it("an event fires the matching rule of ITS tenant: the task lands in that tenant's schema and TaskCreated follows the commit", async () => {
      const outcome = await autoRules.handleEvent('inventory.lowStock', {
        tenantId: ACTIVE_A,
        item: 'feed',
        userId: USER,
      });

      expect(outcome).toEqual(HandlerOutcome.ack());
      expect(await countTasks(ACTIVE_A, `title = 'Reorder feed'`)).toBe(1);
      expect(await countTasks(ACTIVE_B, `title = 'Reorder feed'`)).toBe(0);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.[0]).toMatchObject({
        eventType: 'TaskCreated',
        tenantId: ACTIVE_A,
        title: 'Reorder feed',
      });
    });

    it('an event for a tenant with no matching rule creates nothing', async () => {
      const outcome = await autoRules.handleEvent('inventory.lowStock', {
        tenantId: ACTIVE_B,
        item: 'feed',
      });

      expect(outcome).toEqual(HandlerOutcome.ack());
      expect(await countTasks(ACTIVE_B, `"isAutoGenerated" = true`)).toBe(0);
      expect(publish).not.toHaveBeenCalled();
    });
  });
});
