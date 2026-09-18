/**
 * HR-HIGH-008 — the payroll write path resolves currency through the SSoT.
 *
 * `CreatePayrollHandler` used to seed the row with
 * `input.currency || employee.currency || 'USD'`. The platform default is NOK
 * (`HR_PLATFORM_DEFAULT_CURRENCY`) and the real answer is per-tenant, projected
 * from the farm `finance_settings` SSoT into `hr_payroll_cost_settings` and
 * read through `PayrollCostSettingsService` — which the sibling
 * `CreateEmployeeHandler` has done since FARM-HIGH-151. So an employee row
 * without a currency produced a USD payroll for a NOK tenant, and
 * `ApprovePayrollHandler` then stamped that currency onto the
 * `PayrollProcessed` event crossing into the finance ledger.
 *
 * The precedence itself is the contract, so all three rungs are pinned: an
 * explicit input wins, then the employee's own currency, then the tenant
 * default — and never a literal.
 */
import { collaborator, stubMember } from '@aquaculture/testing';
import { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { CreatePayrollCommand } from '../../commands/create-payroll.command';
import { PayPeriodType } from '../../entities/payroll.entity';
import { Employee } from '../../entities/employee.entity';
import { Payroll } from '../../entities/payroll.entity';
import { CreatePayrollHandler } from '../../handlers/create-payroll.handler';
import { PayrollCostSettingsService } from '../../../finance/services/payroll-cost-settings.service';
import type { CreatePayrollInput } from '../../dto/create-payroll.input';

const TENANT_ID = 'tenant-uuid-001';
const EMPLOYEE_ID = 'emp-uuid-001';
const USER_ID = 'user-uuid-001';

/** The tenant's projected default — deliberately neither 'USD' nor the platform NOK. */
const TENANT_DEFAULT_CURRENCY = 'SEK';

function buildEmployee(overrides: Partial<Employee> = {}): Employee {
  return Object.assign(new Employee(), {
    id: EMPLOYEE_ID,
    tenantId: TENANT_ID,
    baseSalary: 48_000,
    currency: undefined,
    ...overrides,
  });
}

function buildInput(overrides: Partial<CreatePayrollInput> = {}): CreatePayrollInput {
  return {
    employeeId: EMPLOYEE_ID,
    payPeriodType: PayPeriodType.MONTHLY,
    payPeriodStart: '2026-03-01',
    payPeriodEnd: '2026-03-31',
    workHours: { regularHours: 160, overtimeHours: 0 },
    earnings: { baseSalary: 4_000 },
    ...overrides,
  } as CreatePayrollInput;
}

/**
 * The handler drives one query runner: it looks the employee up, runs an
 * overlap query, then creates and saves the Payroll and its audit row. Only
 * the created Payroll is under assertion here, so `create` echoes what it is
 * handed and `save` returns it with an id.
 */
function buildQueryRunner(employee: Employee): {
  queryRunner: QueryRunner;
  created: Array<Record<string, unknown>>;
} {
  const created: Array<Record<string, unknown>> = [];

  const overlapQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
  };

  // findOne / createQueryBuilder / create / save are overload sets on
  // EntityManager, so stubMember carries the one cast the repo sanctions for
  // exactly this; every other member stays checked against the real type.
  const manager = collaborator<EntityManager>(
    {
      findOne: stubMember<EntityManager['findOne']>(() => Promise.resolve(employee)),
      createQueryBuilder: stubMember<EntityManager['createQueryBuilder']>(
        () => overlapQueryBuilder,
      ),
      create: stubMember<EntityManager['create']>(
        (entity: unknown, data: Record<string, unknown>): unknown => {
          if (entity === Payroll) created.push(data);
          return data;
        },
      ),
      save: stubMember<EntityManager['save']>(
        (_entity: unknown, data: Record<string, unknown>): unknown =>
          Promise.resolve({ id: 'payroll-uuid-001', ...data }),
      ),
    },
    'EntityManager',
  );

  const queryRunner = collaborator<QueryRunner>(
    {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager,
    },
    'QueryRunner',
  );

  return { queryRunner, created };
}

function buildHandler(
  employee: Employee,
  defaultCurrency: string = TENANT_DEFAULT_CURRENCY,
): {
  handler: CreatePayrollHandler;
  created: Array<Record<string, unknown>>;
  settings: { getDefaultCurrencyInTx: jest.Mock };
  managerOf: () => EntityManager;
} {
  const { queryRunner, created } = buildQueryRunner(employee);
  const dataSource = collaborator<DataSource>(
    { createQueryRunner: jest.fn().mockReturnValue(queryRunner) },
    'DataSource',
  );
  const getDefaultCurrencyInTx = jest.fn().mockResolvedValue(defaultCurrency);
  const settings = collaborator<PayrollCostSettingsService>(
    { getDefaultCurrencyInTx },
    'PayrollCostSettingsService',
  );

  // The handler never touches the two injected repositories on this path — it
  // works through queryRunner.manager — so an empty collaborator is the honest
  // double: any use would throw MissingDoubleMemberError naming the member.
  const handler = new CreatePayrollHandler(
    collaborator<Repository<Payroll>>({}, 'Repository<Payroll>'),
    collaborator<Repository<Employee>>({}, 'Repository<Employee>'),
    dataSource,
    settings,
  );

  return {
    handler,
    created,
    settings: { getDefaultCurrencyInTx },
    managerOf: () => queryRunner.manager,
  };
}

describe('CreatePayrollHandler — currency SSoT (HR-HIGH-008)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('falls back to the tenant default from the settings SSoT, never to a literal', async () => {
    const { handler, created, settings, managerOf } = buildHandler(buildEmployee());

    await handler.execute(new CreatePayrollCommand(TENANT_ID, buildInput(), USER_ID));

    expect(settings.getDefaultCurrencyInTx).toHaveBeenCalledWith(managerOf(), TENANT_ID);
    expect(created).toHaveLength(1);
    expect(created[0]?.currency).toBe(TENANT_DEFAULT_CURRENCY);
    // The literal the handler used to carry. Asserting the SSoT value alone
    // would still pass if a `|| 'USD'` were left downstream of it.
    expect(created[0]?.currency).not.toBe('USD');
  });

  it("prefers the employee's own currency over the tenant default", async () => {
    const { handler, created } = buildHandler(buildEmployee({ currency: 'NOK' }));

    await handler.execute(new CreatePayrollCommand(TENANT_ID, buildInput(), USER_ID));

    expect(created[0]?.currency).toBe('NOK');
  });

  it('prefers an explicit input currency over everything', async () => {
    const { handler, created } = buildHandler(buildEmployee({ currency: 'NOK' }));

    await handler.execute(
      new CreatePayrollCommand(TENANT_ID, buildInput({ currency: 'EUR' }), USER_ID),
    );

    expect(created[0]?.currency).toBe('EUR');
  });

  it('resolves the default inside the handler transaction, not on a separate connection', async () => {
    // getDefaultCurrencyInTx caches per tenant; passing the handler's own
    // manager is what keeps the read inside the payroll transaction rather
    // than opening a second one that could see a different snapshot.
    const { handler, settings, managerOf } = buildHandler(buildEmployee());

    await handler.execute(new CreatePayrollCommand(TENANT_ID, buildInput(), USER_ID));

    expect(settings.getDefaultCurrencyInTx).toHaveBeenCalledTimes(1);
    expect(settings.getDefaultCurrencyInTx).toHaveBeenCalledWith(managerOf(), TENANT_ID);
  });
});
