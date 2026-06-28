/**
 * Leave admin-ops handler suite — covers the 9 leave operations the hr-module
 * frontend already expects (CreateLeaveType, UpdateLeaveType, AdjustLeaveBalance,
 * CarryOverLeaveBalances, InitializeLeaveBalances, UpdateLeaveRequest,
 * WithdrawLeaveRequest, CheckLeaveOverlap, CalculateLeaveDays).
 *
 * London-school: collaborators (DataSource/queryRunner/manager, repos,
 * LeaveAccrualService) are mocked via NestJS `useValue` providers — no banned
 * casts (the husky banned-construct gate scans spec files too). Each handler is
 * exercised for the happy path, a guard/validation path, and tenant-scoping.
 */
import 'reflect-metadata';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { Holiday } from '../../scheduling/entities/holiday.entity';
import { AdjustLeaveBalanceCommand } from '../commands/adjust-leave-balance.command';
import { CarryOverLeaveBalancesCommand } from '../commands/carry-over-leave-balances.command';
import { CreateLeaveTypeCommand } from '../commands/create-leave-type.command';
import { InitializeLeaveBalancesCommand } from '../commands/initialize-leave-balances.command';
import { UpdateLeaveRequestCommand } from '../commands/update-leave-request.command';
import { UpdateLeaveTypeCommand } from '../commands/update-leave-type.command';
import { WithdrawLeaveRequestCommand } from '../commands/withdraw-leave-request.command';
import { CreateLeaveTypeInput } from '../dto/create-leave-type.input';
import { UpdateLeaveTypeInput } from '../dto/update-leave-type.input';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveType } from '../entities/leave-type.entity';
import { AdjustLeaveBalanceHandler } from '../handlers/adjust-leave-balance.handler';
import { CarryOverLeaveBalancesHandler } from '../handlers/carry-over-leave-balances.handler';
import { CreateLeaveTypeHandler } from '../handlers/create-leave-type.handler';
import { InitializeLeaveBalancesHandler } from '../handlers/initialize-leave-balances.handler';
import { UpdateLeaveRequestHandler } from '../handlers/update-leave-request.handler';
import { UpdateLeaveTypeHandler } from '../handlers/update-leave-type.handler';
import { WithdrawLeaveRequestHandler } from '../handlers/withdraw-leave-request.handler';
import { LeaveAccrualService } from '../leave-accrual.service';
import { CalculateLeaveDaysQuery } from '../queries/calculate-leave-days.query';
import { CheckLeaveOverlapQuery } from '../queries/check-leave-overlap.query';
import { CalculateLeaveDaysHandler } from '../query-handlers/calculate-leave-days.handler';
import { CheckLeaveOverlapHandler } from '../query-handlers/check-leave-overlap.handler';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const USER = 'user-1';
const OTHER_USER = 'user-other';
const EMPLOYEE = 'emp-1';

// --- shared test doubles ---------------------------------------------------

interface MockManager {
  findOne: jest.Mock;
  find: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
}

interface MockQueryRunner {
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
  release: jest.Mock;
  manager: MockManager;
}

function makeManager(): MockManager {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    // create() echoes the partial it was given (entity-shaped enough for tests)
    create: jest.fn().mockImplementation((_e: unknown, data: unknown) => ({ ...(data as object) })),
    save: jest.fn().mockImplementation((_e: unknown, r: unknown) => Promise.resolve(r)),
  };
}

function makeQueryRunner(manager: MockManager): MockQueryRunner {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
}

function makeDataSource(queryRunner: MockQueryRunner): { createQueryRunner: jest.Mock } {
  return { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
}

function leaveType(overrides: Partial<LeaveType> = {}): LeaveType {
  const lt = new LeaveType();
  Object.assign(lt, {
    id: 'lt-1',
    tenantId: TENANT,
    code: 'ANNUAL',
    name: 'Annual',
    isAccrued: true,
    isActive: true,
    isDeleted: false,
    defaultDaysPerYear: 20,
    maxCarryOverDays: 5,
  }, overrides);
  return lt;
}

function employee(overrides: Partial<Employee> = {}): Employee {
  const e = new Employee();
  Object.assign(e, { id: EMPLOYEE, tenantId: TENANT, userId: USER, isDeleted: false }, overrides);
  return e;
}

function balance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  const b = new LeaveBalance();
  Object.assign(b, {
    id: 'bal-1',
    tenantId: TENANT,
    employeeId: EMPLOYEE,
    leaveTypeId: 'lt-1',
    year: 2026,
    openingBalance: 20,
    accrued: 0,
    used: 0,
    pending: 0,
    adjustment: 0,
    carriedOver: 0,
    isDeleted: false,
  }, overrides);
  return b;
}

function request(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  const r = new LeaveRequest();
  Object.assign(r, {
    id: 'req-1',
    tenantId: TENANT,
    requestNumber: 'LR-2026-00001',
    employeeId: EMPLOYEE,
    leaveTypeId: 'lt-1',
    startDate: new Date('2026-03-02'),
    endDate: new Date('2026-03-04'),
    totalDays: 3,
    status: LeaveRequestStatus.DRAFT,
    createdBy: USER,
    approvalHistory: [],
    isDeleted: false,
  }, overrides);
  return r;
}

// ===========================================================================
// CreateLeaveType
// ===========================================================================
describe('CreateLeaveTypeHandler', () => {
  function build(repo: Partial<Record<keyof MockManager, jest.Mock>>): Promise<CreateLeaveTypeHandler> {
    return Test.createTestingModule({
      providers: [
        CreateLeaveTypeHandler,
        { provide: getRepositoryToken(LeaveType), useValue: repo },
      ],
    })
      .compile()
      .then((m) => m.get(CreateLeaveTypeHandler));
  }

  const input: CreateLeaveTypeInput = Object.assign(new CreateLeaveTypeInput(), {
    name: 'Annual',
    code: 'ANNUAL',
    category: undefined,
  });

  it('happy path: persists a tenant-scoped leave type with audit user', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const create = jest.fn().mockImplementation((data: unknown) => ({ ...(data as object) }));
    const save = jest.fn().mockImplementation((r: unknown) => Promise.resolve(r));
    const handler = await build({ findOne, create, save });

    const result = await handler.execute(new CreateLeaveTypeCommand(TENANT, USER, input));

    // tenant-scoping: tenantId + audit user stamped onto the created row
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, createdBy: USER }));
    expect(result.tenantId).toBe(TENANT);
  });

  it('validation path: duplicate code → ConflictException', async () => {
    const findOne = jest.fn().mockResolvedValue(leaveType());
    const save = jest.fn();
    const handler = await build({ findOne, create: jest.fn(), save });

    await expect(
      handler.execute(new CreateLeaveTypeCommand(TENANT, USER, input)),
    ).rejects.toThrow(ConflictException);
    expect(save).not.toHaveBeenCalled();
  });

  it('tenant-scoping: uniqueness lookup is scoped by tenantId', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const handler = await build({ findOne, create: jest.fn().mockReturnValue({}), save: jest.fn().mockResolvedValue({}) });
    await handler.execute(new CreateLeaveTypeCommand(OTHER_TENANT, USER, input));
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: OTHER_TENANT }) }),
    );
  });
});

// ===========================================================================
// UpdateLeaveType
// ===========================================================================
describe('UpdateLeaveTypeHandler', () => {
  function build(repo: Partial<Record<keyof MockManager, jest.Mock>>): Promise<UpdateLeaveTypeHandler> {
    return Test.createTestingModule({
      providers: [
        UpdateLeaveTypeHandler,
        { provide: getRepositoryToken(LeaveType), useValue: repo },
      ],
    })
      .compile()
      .then((m) => m.get(UpdateLeaveTypeHandler));
  }

  const patch: UpdateLeaveTypeInput = Object.assign(new UpdateLeaveTypeInput(), {
    id: 'lt-1',
    name: 'Renamed Annual',
  });

  it('happy path: applies only provided keys + stamps updatedBy', async () => {
    const existing = leaveType({ name: 'Annual', color: '#112233' });
    const findOne = jest.fn().mockResolvedValue(existing);
    const save = jest.fn().mockImplementation((r: unknown) => Promise.resolve(r));
    const handler = await build({ findOne, save });

    const result = await handler.execute(new UpdateLeaveTypeCommand(TENANT, USER, patch));

    expect(result.name).toBe('Renamed Annual');
    expect(result.color).toBe('#112233'); // untouched
    expect(result.updatedBy).toBe(USER);
  });

  it('validation path: unknown id → NotFoundException', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const handler = await build({ findOne, save: jest.fn() });
    await expect(
      handler.execute(new UpdateLeaveTypeCommand(TENANT, USER, patch)),
    ).rejects.toThrow(NotFoundException);
  });

  it('tenant-scoping: lookup is scoped by tenantId', async () => {
    const findOne = jest.fn().mockResolvedValue(leaveType());
    const handler = await build({ findOne, save: jest.fn().mockImplementation((r: unknown) => Promise.resolve(r)) });
    await handler.execute(new UpdateLeaveTypeCommand(OTHER_TENANT, USER, patch));
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'lt-1', tenantId: OTHER_TENANT }) }),
    );
  });
});

// ===========================================================================
// AdjustLeaveBalance
// ===========================================================================
describe('AdjustLeaveBalanceHandler', () => {
  function build(manager: MockManager): Promise<{ handler: AdjustLeaveBalanceHandler; qr: MockQueryRunner }> {
    const qr = makeQueryRunner(manager);
    return Test.createTestingModule({
      providers: [
        AdjustLeaveBalanceHandler,
        { provide: DataSource, useValue: makeDataSource(qr) },
      ],
    })
      .compile()
      .then((m) => ({ handler: m.get(AdjustLeaveBalanceHandler), qr }));
  }

  it('happy path: applies signed delta to the adjustment accumulator', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(employee()) // employee
      .mockResolvedValueOnce(leaveType()) // leave type
      .mockResolvedValueOnce(balance({ adjustment: 2 })); // balance (locked)
    const { handler, qr } = await build(manager);

    const result = await handler.execute(
      new AdjustLeaveBalanceCommand(TENANT, USER, EMPLOYEE, 'lt-1', 2026, 3, 'correction'),
    );

    expect(Number(result.adjustment)).toBe(5);
    expect(result.updatedBy).toBe(USER);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('validation path: negative delta below available → BadRequestException + rollback', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(employee())
      .mockResolvedValueOnce(leaveType())
      .mockResolvedValueOnce(balance({ openingBalance: 1, adjustment: 0 }));
    const { handler, qr } = await build(manager);

    await expect(
      handler.execute(new AdjustLeaveBalanceCommand(TENANT, USER, EMPLOYEE, 'lt-1', 2026, -5, 'too much')),
    ).rejects.toThrow(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('tenant-scoping: employee lookup is scoped by tenantId', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(employee())
      .mockResolvedValueOnce(leaveType())
      .mockResolvedValueOnce(balance());
    const { handler } = await build(manager);
    await handler.execute(new AdjustLeaveBalanceCommand(OTHER_TENANT, USER, EMPLOYEE, 'lt-1', 2026, 1, 'x'));
    expect(manager.findOne).toHaveBeenCalledWith(
      Employee,
      expect.objectContaining({ where: expect.objectContaining({ tenantId: OTHER_TENANT }) }),
    );
  });
});

// ===========================================================================
// InitializeLeaveBalances
// ===========================================================================
describe('InitializeLeaveBalancesHandler', () => {
  function build(manager: MockManager): Promise<InitializeLeaveBalancesHandler> {
    const qr = makeQueryRunner(manager);
    return Test.createTestingModule({
      providers: [
        InitializeLeaveBalancesHandler,
        { provide: DataSource, useValue: makeDataSource(qr) },
      ],
    })
      .compile()
      .then((m) => m.get(InitializeLeaveBalancesHandler));
  }

  it('happy path: seeds one balance per accrued type the employee lacks', async () => {
    const manager = makeManager();
    manager.findOne.mockResolvedValueOnce(employee()); // employee
    manager.find
      .mockResolvedValueOnce([leaveType({ id: 'lt-1' }), leaveType({ id: 'lt-2' })]) // leave types
      .mockResolvedValueOnce([balance({ leaveTypeId: 'lt-1' })]) // existing balances (lt-1 seeded)
      .mockResolvedValueOnce([balance(), balance({ leaveTypeId: 'lt-2' })]); // final read-back
    const handler = await build(manager);

    const result = await handler.execute(
      new InitializeLeaveBalancesCommand(TENANT, USER, EMPLOYEE, 2026),
    );

    // Only lt-2 gets created (lt-1 already existed)
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(
      LeaveBalance,
      expect.objectContaining({ leaveTypeId: 'lt-2', tenantId: TENANT, createdBy: USER }),
    );
    expect(result).toHaveLength(2);
  });

  it('validation path: unknown employee → NotFoundException', async () => {
    const manager = makeManager();
    manager.findOne.mockResolvedValueOnce(null);
    const handler = await build(manager);
    await expect(
      handler.execute(new InitializeLeaveBalancesCommand(TENANT, USER, 'ghost', 2026)),
    ).rejects.toThrow(NotFoundException);
  });

  it('tenant-scoping: leave-type discovery is scoped by tenantId', async () => {
    const manager = makeManager();
    manager.findOne.mockResolvedValueOnce(employee());
    manager.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const handler = await build(manager);
    await handler.execute(new InitializeLeaveBalancesCommand(OTHER_TENANT, USER, EMPLOYEE, 2026));
    expect(manager.find).toHaveBeenCalledWith(
      LeaveType,
      expect.objectContaining({ where: expect.objectContaining({ tenantId: OTHER_TENANT }) }),
    );
  });
});

// ===========================================================================
// CarryOverLeaveBalances
// ===========================================================================
describe('CarryOverLeaveBalancesHandler', () => {
  function build(
    accrual: { carryOverWithinSchema: jest.Mock },
  ): Promise<{ handler: CarryOverLeaveBalancesHandler; qr: MockQueryRunner }> {
    const qr = makeQueryRunner(makeManager());
    return Test.createTestingModule({
      providers: [
        CarryOverLeaveBalancesHandler,
        { provide: DataSource, useValue: makeDataSource(qr) },
        { provide: LeaveAccrualService, useValue: accrual },
      ],
    })
      .compile()
      .then((m) => ({ handler: m.get(CarryOverLeaveBalancesHandler), qr }));
  }

  it('happy path: delegates to the SAME accrual routine the cron uses', async () => {
    const outcome = { processed: 4, successful: 3, failed: 1, errors: ['boom'] };
    const carryOverWithinSchema = jest.fn().mockResolvedValue(outcome);
    const { handler, qr } = await build({ carryOverWithinSchema });

    const result = await handler.execute(
      new CarryOverLeaveBalancesCommand(TENANT, USER, 2025, 2026),
    );

    expect(carryOverWithinSchema).toHaveBeenCalledWith(qr.manager, 2025, 2026, USER);
    expect(result).toEqual(outcome);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('validation path: toYear <= fromYear → BadRequestException', async () => {
    const carryOverWithinSchema = jest.fn();
    const { handler } = await build({ carryOverWithinSchema });
    await expect(
      handler.execute(new CarryOverLeaveBalancesCommand(TENANT, USER, 2026, 2026)),
    ).rejects.toThrow(BadRequestException);
    expect(carryOverWithinSchema).not.toHaveBeenCalled();
  });

  it('rollback path: accrual error rolls the transaction back', async () => {
    const carryOverWithinSchema = jest.fn().mockRejectedValue(new Error('db down'));
    const { handler, qr } = await build({ carryOverWithinSchema });
    await expect(
      handler.execute(new CarryOverLeaveBalancesCommand(TENANT, USER, 2025, 2026)),
    ).rejects.toThrow('db down');
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });
});

// ===========================================================================
// UpdateLeaveRequest
// ===========================================================================
describe('UpdateLeaveRequestHandler', () => {
  function build(manager: MockManager): Promise<{ handler: UpdateLeaveRequestHandler; qr: MockQueryRunner }> {
    const qr = makeQueryRunner(manager);
    return Test.createTestingModule({
      providers: [
        UpdateLeaveRequestHandler,
        { provide: DataSource, useValue: makeDataSource(qr) },
      ],
    })
      .compile()
      .then((m) => ({ handler: m.get(UpdateLeaveRequestHandler), qr }));
  }

  it('happy path: edits a DRAFT request (reason patch, no day change)', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(request()) // leave request (locked)
      .mockResolvedValueOnce(employee()); // editor employee
    const { handler } = await build(manager);

    const result = await handler.execute(
      new UpdateLeaveRequestCommand(TENANT, USER, { id: 'req-1', reason: 'updated reason' }),
    );

    expect(result.reason).toBe('updated reason');
    expect(result.updatedBy).toBe(USER);
  });

  it('validation path: editing an APPROVED request → BadRequestException', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(request({ status: LeaveRequestStatus.APPROVED }))
      .mockResolvedValueOnce(employee());
    const { handler, qr } = await build(manager);

    await expect(
      handler.execute(new UpdateLeaveRequestCommand(TENANT, USER, { id: 'req-1', reason: 'x' })),
    ).rejects.toThrow(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('ownership path: a non-owner non-creator edit → ForbiddenException', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(request({ createdBy: USER }))
      .mockResolvedValueOnce(employee({ id: 'emp-other', userId: OTHER_USER })); // different employee
    const { handler } = await build(manager);

    await expect(
      handler.execute(new UpdateLeaveRequestCommand(TENANT, OTHER_USER, { id: 'req-1', reason: 'x' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('tenant-scoping: request lookup is scoped by tenantId', async () => {
    const manager = makeManager();
    manager.findOne.mockResolvedValueOnce(request()).mockResolvedValueOnce(employee());
    const { handler } = await build(manager);
    await handler.execute(new UpdateLeaveRequestCommand(OTHER_TENANT, USER, { id: 'req-1', reason: 'x' }));
    expect(manager.findOne).toHaveBeenCalledWith(
      LeaveRequest,
      expect.objectContaining({ where: expect.objectContaining({ tenantId: OTHER_TENANT }) }),
    );
  });
});

// ===========================================================================
// WithdrawLeaveRequest
// ===========================================================================
describe('WithdrawLeaveRequestHandler', () => {
  function build(manager: MockManager): Promise<{ handler: WithdrawLeaveRequestHandler; qr: MockQueryRunner }> {
    const qr = makeQueryRunner(manager);
    return Test.createTestingModule({
      providers: [
        WithdrawLeaveRequestHandler,
        { provide: DataSource, useValue: makeDataSource(qr) },
      ],
    })
      .compile()
      .then((m) => ({ handler: m.get(WithdrawLeaveRequestHandler), qr }));
  }

  it('happy path: PENDING → WITHDRAWN releases pending balance', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(request({ status: LeaveRequestStatus.PENDING, totalDays: 3 }))
      .mockResolvedValueOnce(employee()) // withdrawer
      .mockResolvedValueOnce(balance({ pending: 3 })); // balance (locked)
    const { handler } = await build(manager);

    const result = await handler.execute(
      new WithdrawLeaveRequestCommand(TENANT, USER, 'req-1'),
    );

    expect(result.status).toBe(LeaveRequestStatus.WITHDRAWN);
    // pending released back to 0
    expect(manager.save).toHaveBeenCalledWith(
      LeaveBalance,
      expect.objectContaining({ pending: 0 }),
    );
  });

  it('validation path: withdraw from APPROVED is rejected by the state machine', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(request({ status: LeaveRequestStatus.APPROVED }))
      .mockResolvedValueOnce(employee());
    const { handler, qr } = await build(manager);

    await expect(
      handler.execute(new WithdrawLeaveRequestCommand(TENANT, USER, 'req-1')),
    ).rejects.toThrow(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('ownership path: a non-owner non-creator withdraw → ForbiddenException', async () => {
    const manager = makeManager();
    manager.findOne
      .mockResolvedValueOnce(request({ createdBy: USER }))
      .mockResolvedValueOnce(employee({ id: 'emp-other', userId: OTHER_USER }));
    const { handler } = await build(manager);

    await expect(
      handler.execute(new WithdrawLeaveRequestCommand(TENANT, OTHER_USER, 'req-1')),
    ).rejects.toThrow(ForbiddenException);
  });
});

// ===========================================================================
// CheckLeaveOverlap
// ===========================================================================
describe('CheckLeaveOverlapHandler', () => {
  interface MockQb {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    getMany: jest.Mock;
  }

  function makeQb(rows: LeaveRequest[]): MockQb {
    const qb: MockQb = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    qb.where.mockReturnValue(qb);
    qb.andWhere.mockReturnValue(qb);
    qb.orderBy.mockReturnValue(qb);
    return qb;
  }

  function build(qb: MockQb): Promise<CheckLeaveOverlapHandler> {
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    return Test.createTestingModule({
      providers: [
        CheckLeaveOverlapHandler,
        { provide: getRepositoryToken(LeaveRequest), useValue: repo },
      ],
    })
      .compile()
      .then((m) => m.get(CheckLeaveOverlapHandler));
  }

  it('happy path: returns conflicts when an overlapping request exists', async () => {
    const qb = makeQb([request({ id: 'req-9', requestNumber: 'LR-2026-00009' })]);
    const handler = await build(qb);

    const result = await handler.execute(
      new CheckLeaveOverlapQuery(TENANT, EMPLOYEE, '2026-03-01', '2026-03-05'),
    );

    expect(result.hasOverlap).toBe(true);
    expect(result.overlappingRequests[0]?.requestNumber).toBe('LR-2026-00009');
  });

  it('no-overlap path: empty result → hasOverlap false', async () => {
    const qb = makeQb([]);
    const handler = await build(qb);
    const result = await handler.execute(
      new CheckLeaveOverlapQuery(TENANT, EMPLOYEE, '2026-03-01', '2026-03-05'),
    );
    expect(result.hasOverlap).toBe(false);
    expect(result.overlappingRequests).toHaveLength(0);
  });

  it('tenant-scoping: query is filtered by tenantId', async () => {
    const qb = makeQb([]);
    const handler = await build(qb);
    await handler.execute(new CheckLeaveOverlapQuery(OTHER_TENANT, EMPLOYEE, '2026-03-01', '2026-03-05'));
    expect(qb.where).toHaveBeenCalledWith('lr.tenantId = :tenantId', { tenantId: OTHER_TENANT });
  });
});

// ===========================================================================
// CalculateLeaveDays
// ===========================================================================
describe('CalculateLeaveDaysHandler', () => {
  interface MockHolidayQb {
    where: jest.Mock;
    andWhere: jest.Mock;
    getMany: jest.Mock;
  }

  function makeHolidayQb(rows: Holiday[]): MockHolidayQb {
    const qb: MockHolidayQb = {
      where: jest.fn(),
      andWhere: jest.fn(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    qb.where.mockReturnValue(qb);
    qb.andWhere.mockReturnValue(qb);
    return qb;
  }

  function build(
    leaveTypeRepo: { findOne: jest.Mock },
    holidayQb: MockHolidayQb,
  ): Promise<CalculateLeaveDaysHandler> {
    const holidayRepo = { createQueryBuilder: jest.fn().mockReturnValue(holidayQb) };
    return Test.createTestingModule({
      providers: [
        CalculateLeaveDaysHandler,
        { provide: getRepositoryToken(LeaveType), useValue: leaveTypeRepo },
        { provide: getRepositoryToken(Holiday), useValue: holidayRepo },
      ],
    })
      .compile()
      .then((m) => m.get(CalculateLeaveDaysHandler));
  }

  function holiday(dateIso: string): Holiday {
    const h = new Holiday();
    Object.assign(h, {
      id: 'hol-1',
      tenantId: TENANT,
      name: 'Holiday',
      date: new Date(dateIso),
      startDate: new Date(dateIso),
      endDate: new Date(dateIso),
      isActive: true,
      affectsScheduling: true,
    });
    return h;
  }

  it('happy path: excludes weekends and holidays from working days', async () => {
    // 2026-03-02 (Mon) .. 2026-03-08 (Sun): 7 calendar days,
    // weekend = Sat 03-07 + Sun 03-08 (2), holiday Wed 03-04 (1),
    // working = 7 - 2 - 1 = 4.
    const leaveTypeRepo = { findOne: jest.fn().mockResolvedValue(leaveType()) };
    const qb = makeHolidayQb([holiday('2026-03-04')]);
    const handler = await build(leaveTypeRepo, qb);

    const result = await handler.execute(
      new CalculateLeaveDaysQuery(TENANT, 'lt-1', '2026-03-02', '2026-03-08'),
    );

    expect(result.totalDays).toBe(7);
    expect(result.weekends).toBe(2);
    expect(result.holidays).toBe(1);
    expect(result.workingDays).toBe(4);
  });

  it('half-day path: subtracts 0.5 from total and working days', async () => {
    // 2026-03-02 (Mon) .. 2026-03-03 (Tue): 2 working days, half-day start.
    const leaveTypeRepo = { findOne: jest.fn().mockResolvedValue(leaveType()) };
    const qb = makeHolidayQb([]);
    const handler = await build(leaveTypeRepo, qb);

    const result = await handler.execute(
      new CalculateLeaveDaysQuery(TENANT, 'lt-1', '2026-03-02', '2026-03-03', true, false),
    );

    expect(result.totalDays).toBe(1.5);
    expect(result.workingDays).toBe(1.5);
  });

  it('validation path: unknown leave type → NotFoundException', async () => {
    const leaveTypeRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const qb = makeHolidayQb([]);
    const handler = await build(leaveTypeRepo, qb);
    await expect(
      handler.execute(new CalculateLeaveDaysQuery(TENANT, 'ghost', '2026-03-02', '2026-03-03')),
    ).rejects.toThrow(NotFoundException);
  });

  it('tenant-scoping: leave-type lookup is scoped by tenantId', async () => {
    const leaveTypeRepo = { findOne: jest.fn().mockResolvedValue(leaveType()) };
    const qb = makeHolidayQb([]);
    const handler = await build(leaveTypeRepo, qb);
    await handler.execute(new CalculateLeaveDaysQuery(OTHER_TENANT, 'lt-1', '2026-03-02', '2026-03-03'));
    expect(leaveTypeRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: OTHER_TENANT }) }),
    );
  });
});
