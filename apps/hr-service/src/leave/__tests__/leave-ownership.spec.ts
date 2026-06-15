/**
 * SEC-MEDIUM-051 — leave submit/cancel ownership invariant + explicit @Roles gate.
 *
 * The handlers ALREADY enforce ownership (isCreator || isOwner); these tests PIN
 * that invariant so it cannot silently regress, and assert the resolver now carries
 * the reflectable ROLES_KEY metadata that the finding required.
 *
 * London-school: DataSource/queryRunner/manager + OutboxPublisher mocked. The
 * handler is built through a NestJS testing module with typed providers so there
 * are NO banned casts (the husky banned-construct gate scans spec files too).
 */
import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { EventBus } from '@nestjs/cqrs';

import { SubmitLeaveRequestCommand } from '../commands/submit-leave-request.command';
import { SubmitLeaveRequestHandler } from '../handlers/submit-leave-request.handler';
import { CancelLeaveRequestCommand } from '../commands/cancel-leave-request.command';
import { CancelLeaveRequestHandler } from '../handlers/cancel-leave-request.handler';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { LeaveResolver } from '../leave.resolver';

const TENANT = 'tenant-1';
const OWNER_USER = 'user-owner';
const OTHER_USER = 'user-other';
const OWNER_EMPLOYEE = 'emp-owner';

async function buildSubmitHandler(managerFindOne: jest.Mock): Promise<{
  handler: SubmitLeaveRequestHandler;
  managerSave: jest.Mock;
}> {
  const managerSave = jest
    .fn()
    .mockImplementation((_e: unknown, r: unknown) => Promise.resolve(r));
  const manager = { findOne: managerFindOne, save: managerSave };
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
  const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  // useValue providers accept loose doubles, so no cast is needed in test code.
  const moduleRef = await Test.createTestingModule({
    providers: [
      SubmitLeaveRequestHandler,
      { provide: getRepositoryToken(LeaveRequest), useValue: {} },
      { provide: OutboxPublisher, useValue: outbox },
      { provide: DataSource, useValue: dataSource },
    ],
  }).compile();

  return { handler: moduleRef.get(SubmitLeaveRequestHandler), managerSave };
}

async function buildCancelHandler(managerFindOne: jest.Mock): Promise<{
  handler: CancelLeaveRequestHandler;
  managerSave: jest.Mock;
}> {
  const managerSave = jest
    .fn()
    .mockImplementation((_e: unknown, r: unknown) => Promise.resolve(r));
  const manager = { findOne: managerFindOne, save: managerSave };
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
  const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
  const eventBus = { publish: jest.fn().mockResolvedValue(undefined) };

  const moduleRef = await Test.createTestingModule({
    providers: [
      CancelLeaveRequestHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: EventBus, useValue: eventBus },
    ],
  }).compile();

  return { handler: moduleRef.get(CancelLeaveRequestHandler), managerSave };
}

function draftRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  const r = new LeaveRequest();
  Object.assign(
    r,
    {
      id: 'leave-1',
      tenantId: TENANT,
      employeeId: OWNER_EMPLOYEE,
      createdBy: OWNER_USER,
      status: LeaveRequestStatus.DRAFT,
      approvalHistory: [],
      isDeleted: false,
    },
    overrides,
  );
  return r;
}

function ownerEmployee(id: string): Employee {
  const e = new Employee();
  Object.assign(e, { id, tenantId: TENANT, userId: OWNER_USER });
  return e;
}

describe('SubmitLeaveRequestHandler — SEC-MEDIUM-051 ownership invariant', () => {
  it('rejects a non-owner non-creator submit (ForbiddenException)', async () => {
    const findOne = jest
      .fn()
      // 1) leave request lookup
      .mockResolvedValueOnce(draftRequest({ createdBy: OWNER_USER }))
      // 2) submitter employee lookup (other user maps to a DIFFERENT employee)
      .mockResolvedValueOnce(ownerEmployee('emp-other'));
    const { handler, managerSave } = await buildSubmitHandler(findOne);

    await expect(
      handler.execute(new SubmitLeaveRequestCommand(TENANT, OTHER_USER, 'leave-1')),
    ).rejects.toThrow(ForbiddenException);
    expect(managerSave).not.toHaveBeenCalled();
  });

  it('allows the owner (employeeId match via Employee.userId) to submit', async () => {
    const findOne = jest
      .fn()
      .mockResolvedValueOnce(draftRequest({ createdBy: 'someone-else' }))
      // submitter resolves to the OWNER employee -> isOwner true
      .mockResolvedValueOnce(ownerEmployee(OWNER_EMPLOYEE));
    const { handler } = await buildSubmitHandler(findOne);

    const result = await handler.execute(
      new SubmitLeaveRequestCommand(TENANT, OWNER_USER, 'leave-1'),
    );
    expect(result.status).toBe(LeaveRequestStatus.PENDING);
  });

  it('allows the creator to submit even without an employee record match', async () => {
    const findOne = jest
      .fn()
      .mockResolvedValueOnce(draftRequest({ createdBy: OWNER_USER }))
      .mockResolvedValueOnce(null);
    const { handler } = await buildSubmitHandler(findOne);

    const result = await handler.execute(
      new SubmitLeaveRequestCommand(TENANT, OWNER_USER, 'leave-1'),
    );
    expect(result.status).toBe(LeaveRequestStatus.PENDING);
  });
});

describe('CancelLeaveRequestHandler — SEC-MEDIUM-051 ownership invariant', () => {
  it('rejects a non-owner non-creator cancel (ForbiddenException) before any mutation', async () => {
    const findOne = jest
      .fn()
      // 1) leave request lookup (PENDING, created by the owner)
      .mockResolvedValueOnce(
        draftRequest({ status: LeaveRequestStatus.PENDING, createdBy: OWNER_USER }),
      )
      // 2) canceller employee lookup -> a DIFFERENT employee (not the owner)
      .mockResolvedValueOnce(ownerEmployee('emp-other'));
    const { handler, managerSave } = await buildCancelHandler(findOne);

    await expect(
      handler.execute(new CancelLeaveRequestCommand(TENANT, OTHER_USER, 'leave-1')),
    ).rejects.toThrow(ForbiddenException);
    // Fail-closed: the request is never mutated when the caller is not the owner.
    expect(managerSave).not.toHaveBeenCalled();
  });
});

describe('LeaveResolver — SEC-MEDIUM-051 reflectable @Roles metadata', () => {
  it('submitLeaveRequest carries ROLES_KEY metadata (ModuleUserOrHigher)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, LeaveResolver.prototype.submitLeaveRequest);
    expect(roles).toEqual([
      Role.SUPER_ADMIN,
      Role.TENANT_ADMIN,
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
    ]);
  });

  it('cancelLeaveRequest carries ROLES_KEY metadata (ModuleUserOrHigher)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, LeaveResolver.prototype.cancelLeaveRequest);
    expect(roles).toEqual([
      Role.SUPER_ADMIN,
      Role.TENANT_ADMIN,
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
    ]);
  });
});
