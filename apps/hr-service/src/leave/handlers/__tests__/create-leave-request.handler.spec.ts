import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { EventBus } from '@nestjs/cqrs';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Employee } from '../../../hr/entities/employee.entity';
import { CreateLeaveRequestCommand } from '../../commands/create-leave-request.command';
import { LeaveBalance } from '../../entities/leave-balance.entity';
import { LeaveRequest } from '../../entities/leave-request.entity';
import { LeaveType } from '../../entities/leave-type.entity';
import { CreateLeaveRequestHandler } from '../create-leave-request.handler';

describe('CreateLeaveRequestHandler (SEC-MEDIUM-076 — 2026-08-23 scan №21: totalDays is server-authoritative)', () => {
  let handler: CreateLeaveRequestHandler;
  let queryBusExecute: jest.Mock;
  let balanceSave: jest.Mock;
  let requestCreate: jest.Mock;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'user-1';
  const employeeId = 'emp-1';
  const leaveTypeId = 'lt-1';

  /** Captured manager mocks so assertions see what the handler really persisted. */
  let managerCreate: jest.Mock;
  let managerSave: jest.Mock;

  const buildQueryRunner = (): Partial<QueryRunner> => {
    managerCreate = jest.fn((data: LeaveRequest) => data);
    managerSave = jest.fn().mockImplementation(async (entity: unknown) => entity);
    const manager: Partial<EntityManager> = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null), // no overlap
      }),
      findOne: jest.fn().mockResolvedValue({
        // accrued balance row for the pessimistic_write path
        availableBalance: 30,
        pending: 0,
      }),
      save: managerSave,
      create: managerCreate,
    };
    return {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: manager as EntityManager,
    };
  };

  beforeEach(async () => {
    queryBusExecute = jest.fn().mockResolvedValue({
      totalDays: 5,
      workingDays: 5,
      weekends: 0,
      holidays: 0,
    });
    balanceSave = jest.fn();
    requestCreate = jest.fn((data: LeaveRequest) => data);

    const leaveBalance = {
      availableBalance: 30,
      pending: 0,
      leaveTypeId,
      year: 2026,
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CreateLeaveRequestHandler,
        {
          provide: getRepositoryToken(LeaveRequest),
          useValue: { create: requestCreate, save: jest.fn() },
        },
        {
          provide: getRepositoryToken(LeaveType),
          useValue: {
            findOne: jest
              .fn()
              .mockResolvedValue({ id: leaveTypeId, isAccrued: true, name: 'Annual' }),
          },
        },
        { provide: getRepositoryToken(LeaveBalance), useValue: { save: balanceSave } },
        {
          provide: getRepositoryToken(Employee),
          useValue: { findOne: jest.fn().mockResolvedValue({ id: employeeId }) },
        },
        {
          provide: DataSource,
          useValue: { createQueryRunner: jest.fn().mockReturnValue(buildQueryRunner()) },
        },
        { provide: EventBus, useValue: { publish: jest.fn() } },
        { provide: QueryBus, useValue: { execute: queryBusExecute } },
        {
          provide: MobileCommandReceiptService,
          useValue: {
            begin: jest.fn().mockResolvedValue({ mode: 'record' }),
            complete: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    handler = moduleRef.get(CreateLeaveRequestHandler);
    void leaveBalance;
  });

  it('ignores the client-supplied totalDays and stores the calendar-computed figure', async () => {
    // The attack from the scan: 30 calendar days claimed as 0.5 to dodge the
    // balance. The server computes 5 (mocked calendar SSoT) and uses THAT.
    const command = new CreateLeaveRequestCommand(
      tenantId,
      userId,
      employeeId,
      leaveTypeId,
      '2026-03-02',
      '2026-03-06',
      0.5, // client lie
    );

    const result = await handler.execute(command);

    expect(queryBusExecute).toHaveBeenCalledTimes(1);
    // The persisted request carries the SERVER-computed figure (5), never 0.5
    const created = managerCreate.mock.calls
      .map((call) => call[call.length - 1] as LeaveRequest)
      .find((entity) => entity && 'totalDays' in entity);
    expect(created?.totalDays).toBe(5);
    // Balance reservation uses the computed figure too: pending 0 -> 5
    const savedBalance = managerSave.mock.calls
      .map((call) => call[call.length - 1])
      .find((entity: unknown) => entity && typeof (entity as LeaveBalance).pending === 'number');
    expect(Number(savedBalance.pending)).toBe(5);
    void balanceSave;
  });

  it('rejects an unknown employee (tenant-scoped lookup)', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CreateLeaveRequestHandler,
        { provide: getRepositoryToken(LeaveRequest), useValue: {} },
        { provide: getRepositoryToken(LeaveType), useValue: {} },
        { provide: getRepositoryToken(LeaveBalance), useValue: {} },
        {
          provide: getRepositoryToken(Employee),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: DataSource, useValue: {} },
        { provide: EventBus, useValue: {} },
        { provide: QueryBus, useValue: { execute: queryBusExecute } },
        { provide: MobileCommandReceiptService, useValue: {} },
      ],
    }).compile();

    await expect(
      moduleRef
        .get(CreateLeaveRequestHandler)
        .execute(
          new CreateLeaveRequestCommand(
            tenantId,
            userId,
            'ghost',
            leaveTypeId,
            '2026-03-02',
            '2026-03-06',
            1,
          ),
        ),
    ).rejects.toThrow(NotFoundException);
  });
});
