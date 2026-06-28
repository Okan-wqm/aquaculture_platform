/**
 * Training lifecycle command-handler tests.
 *
 * Covers RenewCertification (transactional), StartTraining + WithdrawFromTraining
 * (self-service ownership + state machine) and BulkEnrollInTraining (transactional
 * per-employee tolerant batch). London-school: repos + DataSource/queryRunner/manager
 * mocked. Each handler gets happy-path + a guard/validation path + tenant/ownership.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EventBus } from '@nestjs/cqrs';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { RenewCertificationHandler } from '../handlers/renew-certification.handler';
import { StartTrainingHandler } from '../handlers/start-training.handler';
import { WithdrawFromTrainingHandler } from '../handlers/withdraw-from-training.handler';
import { BulkEnrollInTrainingHandler } from '../handlers/bulk-enroll-in-training.handler';

import { RenewCertificationCommand } from '../commands/renew-certification.command';
import { StartTrainingCommand } from '../commands/start-training.command';
import { WithdrawFromTrainingCommand } from '../commands/withdraw-from-training.command';
import { BulkEnrollInTrainingCommand } from '../commands/bulk-enroll-in-training.command';

import {
  EmployeeCertification,
  CertificationStatus,
} from '../entities/employee-certification.entity';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';
import { TrainingCourse } from '../entities/training-course.entity';
import { Employee } from '../../hr/entities/employee.entity';

const TENANT = 'tenant-aquafarm-001';
const USER = 'user-admin-001';
const EMPLOYEE = 'emp-001';
const OTHER_EMPLOYEE = 'emp-002';

interface MockManager {
  findOne: jest.Mock;
  find: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
}

function makeManager(): MockManager {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((_e: unknown, data: unknown) => ({ ...(data as object) })),
    save: jest.fn().mockImplementation(async (_e: unknown, r: unknown) => ({ id: 'saved-id', ...(r as object) })),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function makeQueryRunner(manager: MockManager) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
}

function makeRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    create: jest.fn().mockImplementation((data: unknown) => ({ ...(data as object) })),
    save: jest.fn().mockImplementation(async (e: unknown) => ({ id: 'saved-id', ...(e as object) })),
  };
}

// ===========================================================================
describe('RenewCertificationHandler', () => {
  let manager: MockManager;
  let handler: RenewCertificationHandler;
  let eventBus: { publish: jest.Mock };

  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  beforeEach(async () => {
    manager = makeManager();
    const qr = makeQueryRunner(manager);
    eventBus = { publish: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RenewCertificationHandler,
        { provide: DataSource, useValue: { createQueryRunner: jest.fn().mockReturnValue(qr) } },
        { provide: EventBus, useValue: eventBus },
      ],
    }).compile();
    handler = module.get(RenewCertificationHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('retires the old cert and creates a linked renewal (isRenewal=true)', async () => {
    const existing = {
      id: 'cert-1',
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      certificationTypeId: 'ct-1',
      status: CertificationStatus.ACTIVE,
      isDeleted: false,
    } as EmployeeCertification;

    // 1st findOne: existing cert; later findOne: re-fetch with relations.
    manager.findOne
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({ ...existing, id: 'saved-id', isRenewal: true });

    const result = await handler.execute(
      new RenewCertificationCommand(TENANT, USER, 'cert-1', futureDate, 'CERT-NEW-1', 'https://x/cert.pdf'),
    );

    // old cert retired
    expect(manager.save).toHaveBeenCalledWith(
      EmployeeCertification,
      expect.objectContaining({ id: 'cert-1', status: CertificationStatus.EXPIRED }),
    );
    // new cert created with renewal linkage
    expect(manager.create).toHaveBeenCalledWith(
      EmployeeCertification,
      expect.objectContaining({
        previousCertificationId: 'cert-1',
        isRenewal: true,
        status: CertificationStatus.ACTIVE,
        certificationNumber: 'CERT-NEW-1',
      }),
    );
    expect(eventBus.publish).toHaveBeenCalled();
    expect(result.isRenewal).toBe(true);
  });

  it('rejects a past expiry date', async () => {
    await expect(
      handler.execute(new RenewCertificationCommand(TENANT, USER, 'cert-1', '2000-01-01')),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFound when the cert is absent in the tenant', async () => {
    manager.findOne.mockResolvedValueOnce(null);
    await expect(
      handler.execute(new RenewCertificationCommand(TENANT, USER, 'missing', futureDate)),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses to renew a REVOKED cert', async () => {
    manager.findOne.mockResolvedValueOnce({
      id: 'cert-1',
      tenantId: TENANT,
      status: CertificationStatus.REVOKED,
    } as EmployeeCertification);
    await expect(
      handler.execute(new RenewCertificationCommand(TENANT, USER, 'cert-1', futureDate)),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===========================================================================
describe('StartTrainingHandler', () => {
  let enrollmentRepo: jest.Mocked<Repository<TrainingEnrollment>>;
  let handler: StartTrainingHandler;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StartTrainingHandler,
        // useValue takes the bare makeRepo() subset without a cast;
        // module.get(token) returns the typed mock the handler was injected with.
        { provide: getRepositoryToken(TrainingEnrollment), useValue: makeRepo() },
      ],
    }).compile();
    enrollmentRepo = module.get(getRepositoryToken(TrainingEnrollment));
    handler = module.get(StartTrainingHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('transitions ENROLLED -> IN_PROGRESS and stamps startedAt', async () => {
    enrollmentRepo.findOne.mockResolvedValue({
      id: 'enr-1',
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      status: EnrollmentStatus.ENROLLED,
      isDeleted: false,
    } as TrainingEnrollment);

    const result = await handler.execute(
      new StartTrainingCommand(TENANT, USER, 'enr-1', EMPLOYEE),
    );

    expect(result.status).toBe(EnrollmentStatus.IN_PROGRESS);
    expect(result.startedAt).toBeInstanceOf(Date);
  });

  it('forbids starting another employee\'s enrollment (ownership)', async () => {
    enrollmentRepo.findOne.mockResolvedValue({
      id: 'enr-1',
      tenantId: TENANT,
      employeeId: OTHER_EMPLOYEE,
      status: EnrollmentStatus.ENROLLED,
      isDeleted: false,
    } as TrainingEnrollment);

    await expect(
      handler.execute(new StartTrainingCommand(TENANT, USER, 'enr-1', EMPLOYEE)),
    ).rejects.toThrow(ForbiddenException);
    expect(enrollmentRepo.save).not.toHaveBeenCalled();
  });

  it('rejects starting from a non-ENROLLED status (state machine)', async () => {
    enrollmentRepo.findOne.mockResolvedValue({
      id: 'enr-1',
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      status: EnrollmentStatus.COMPLETED,
      isDeleted: false,
    } as TrainingEnrollment);

    await expect(
      handler.execute(new StartTrainingCommand(TENANT, USER, 'enr-1', EMPLOYEE)),
    ).rejects.toThrow(BadRequestException);
  });

  it('scopes the lookup to the calling tenant', async () => {
    enrollmentRepo.findOne.mockResolvedValue({
      id: 'enr-1',
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      status: EnrollmentStatus.ENROLLED,
      isDeleted: false,
    } as TrainingEnrollment);
    await handler.execute(new StartTrainingCommand(TENANT, USER, 'enr-1', EMPLOYEE));
    expect(enrollmentRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'enr-1', tenantId: TENANT }) }),
    );
  });
});

// ===========================================================================
describe('WithdrawFromTrainingHandler', () => {
  let enrollmentRepo: jest.Mocked<Repository<TrainingEnrollment>>;
  let handler: WithdrawFromTrainingHandler;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawFromTrainingHandler,
        // useValue takes the bare makeRepo() subset without a cast;
        // module.get(token) returns the typed mock the handler was injected with.
        { provide: getRepositoryToken(TrainingEnrollment), useValue: makeRepo() },
      ],
    }).compile();
    enrollmentRepo = module.get(getRepositoryToken(TrainingEnrollment));
    handler = module.get(WithdrawFromTrainingHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('transitions IN_PROGRESS -> WITHDRAWN and records the reason', async () => {
    enrollmentRepo.findOne.mockResolvedValue({
      id: 'enr-1',
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      status: EnrollmentStatus.IN_PROGRESS,
      isDeleted: false,
    } as TrainingEnrollment);

    const result = await handler.execute(
      new WithdrawFromTrainingCommand(TENANT, USER, 'enr-1', EMPLOYEE, 'Schedule conflict'),
    );

    expect(result.status).toBe(EnrollmentStatus.WITHDRAWN);
    expect(result.notes).toContain('Schedule conflict');
  });

  it('forbids withdrawing another employee\'s enrollment (ownership)', async () => {
    enrollmentRepo.findOne.mockResolvedValue({
      id: 'enr-1',
      tenantId: TENANT,
      employeeId: OTHER_EMPLOYEE,
      status: EnrollmentStatus.ENROLLED,
      isDeleted: false,
    } as TrainingEnrollment);

    await expect(
      handler.execute(new WithdrawFromTrainingCommand(TENANT, USER, 'enr-1', EMPLOYEE)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects withdrawal from a terminal status', async () => {
    enrollmentRepo.findOne.mockResolvedValue({
      id: 'enr-1',
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      status: EnrollmentStatus.COMPLETED,
      isDeleted: false,
    } as TrainingEnrollment);

    await expect(
      handler.execute(new WithdrawFromTrainingCommand(TENANT, USER, 'enr-1', EMPLOYEE)),
    ).rejects.toThrow(BadRequestException);
  });
});

// ===========================================================================
describe('BulkEnrollInTrainingHandler', () => {
  let manager: MockManager;
  let handler: BulkEnrollInTrainingHandler;

  beforeEach(async () => {
    manager = makeManager();
    const qr = makeQueryRunner(manager);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkEnrollInTrainingHandler,
        { provide: DataSource, useValue: { createQueryRunner: jest.fn().mockReturnValue(qr) } },
      ],
    }).compile();
    handler = module.get(BulkEnrollInTrainingHandler);
  });

  afterEach(() => jest.clearAllMocks());

  const activeCourse = { id: 'tc-1', tenantId: TENANT, name: 'WQ', isActive: true, isDeleted: false } as TrainingCourse;

  it('enrols new employees, counts already-enrolled and failed', async () => {
    // manager.findOne is called: course, then per-employee (employee, existing enrollment) x N
    manager.findOne.mockImplementation(async (entity: unknown, opts: { where?: unknown }) => {
      if (entity === TrainingCourse) return activeCourse;
      if (entity === Employee) {
        const where = opts.where as { id: string };
        // emp-002 does not exist -> failed
        return where.id === OTHER_EMPLOYEE ? null : ({ id: where.id, tenantId: TENANT } as Employee);
      }
      if (entity === TrainingEnrollment) {
        // emp-003 already enrolled
        const conds = opts.where as Array<{ employeeId: string }>;
        const employeeId = Array.isArray(conds) ? conds[0]!.employeeId : (conds as { employeeId: string }).employeeId;
        return employeeId === 'emp-003' ? ({ id: 'existing' } as TrainingEnrollment) : null;
      }
      return null;
    });

    const result = await handler.execute(
      new BulkEnrollInTrainingCommand(TENANT, USER, 'tc-1', [EMPLOYEE, OTHER_EMPLOYEE, 'emp-003']),
    );

    expect(result.enrolled).toBe(1); // emp-001
    expect(result.alreadyEnrolled).toBe(1); // emp-003
    expect(result.failed).toBe(1); // emp-002
    expect(result.errors).toHaveLength(1);
  });

  it('throws NotFound when the course does not exist in the tenant', async () => {
    manager.findOne.mockResolvedValueOnce(null);
    await expect(
      handler.execute(new BulkEnrollInTrainingCommand(TENANT, USER, 'missing', [EMPLOYEE])),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects an empty employee list', async () => {
    await expect(
      handler.execute(new BulkEnrollInTrainingCommand(TENANT, USER, 'tc-1', [])),
    ).rejects.toThrow(BadRequestException);
  });
});
