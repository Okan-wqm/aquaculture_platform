/**
 * Certification/training report + detail query-handler tests.
 *
 * Covers GetCertificationType, GetTrainingCourse, GetCertificationsForWorkArea,
 * GetMandatoryTrainingStatus, GetEmployeeCertificationStatus and
 * GetCertificationComplianceReport. London-school: repositories (and their query
 * builders) are mocked collaborators. Each handler gets happy-path + a not-found /
 * empty path + tenant-scoping evidence.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';

import { GetCertificationTypeHandler } from '../query-handlers/get-certification-type.handler';
import { GetTrainingCourseHandler } from '../query-handlers/get-training-course.handler';
import { GetCertificationsForWorkAreaHandler } from '../query-handlers/get-certifications-for-work-area.handler';
import { GetMandatoryTrainingStatusHandler } from '../query-handlers/get-mandatory-training-status.handler';
import { GetEmployeeCertificationStatusHandler } from '../query-handlers/get-employee-certification-status.handler';
import { GetCertificationComplianceReportHandler } from '../query-handlers/get-certification-compliance-report.handler';

import { GetCertificationTypeQuery } from '../queries/get-certification-type.query';
import { GetTrainingCourseQuery } from '../queries/get-training-course.query';
import { GetCertificationsForWorkAreaQuery } from '../queries/get-certifications-for-work-area.query';
import { GetMandatoryTrainingStatusQuery } from '../queries/get-mandatory-training-status.query';
import { GetEmployeeCertificationStatusQuery } from '../queries/get-employee-certification-status.query';
import { GetCertificationComplianceReportQuery } from '../queries/get-certification-compliance-report.query';

import {
  CertificationType,
  CertificationCategory,
  CertificationRequirement,
} from '../entities/certification-type.entity';
import {
  EmployeeCertification,
  CertificationStatus,
  VerificationStatus,
} from '../entities/employee-certification.entity';
import {
  TrainingCourse,
  TrainingType,
  TrainingLevel,
} from '../entities/training-course.entity';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';
import { WorkArea } from '../../aquaculture/entities/work-area.entity';
import { Employee, EmployeeStatus } from '../../hr/entities/employee.entity';

const TENANT = 'tenant-aquafarm-001';
const EMPLOYEE = 'emp-001';

function makeRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  };
}

/** Minimal chainable query-builder returning the supplied rows from getMany(). */
function makeQb(rows: unknown[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'select', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const futureIso = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/**
 * Typed EmployeeCertification factory for query-builder rows. Returning a real
 * EmployeeCertification (sane defaults + caller overrides) keeps the row mocks
 * cast-free — the query handlers only read a handful of these fields.
 * `certTypeName` populates the eager-joined certificationType relation (a real
 * CertificationType instance) without forcing callers to spell out the full
 * relation literal.
 */
const makeCert = (
  overrides: Partial<EmployeeCertification> = {},
  certTypeName?: string,
): EmployeeCertification => {
  const cert = new EmployeeCertification();
  Object.assign(cert, {
    id: 'cert-1',
    tenantId: TENANT,
    certificationNumber: 'CERT-2026-00001',
    employeeId: EMPLOYEE,
    certificationTypeId: 'ct-1',
    issueDate: new Date('2026-01-01'),
    status: CertificationStatus.ACTIVE,
    verificationStatus: VerificationStatus.VERIFIED,
    isRenewal: false,
    reminderSent: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    isDeleted: false,
    ...overrides,
  });
  if (certTypeName !== undefined) {
    cert.certificationType = Object.assign(new CertificationType(), { name: certTypeName });
  }
  return cert;
};

// ===========================================================================
describe('GetCertificationTypeHandler', () => {
  let repo: ReturnType<typeof makeRepo>;
  let handler: GetCertificationTypeHandler;

  beforeEach(async () => {
    repo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCertificationTypeHandler,
        { provide: getRepositoryToken(CertificationType), useValue: repo },
      ],
    }).compile();
    handler = module.get(GetCertificationTypeHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns the type with resolved prerequisite objects', async () => {
    repo.findOne.mockResolvedValue({
      id: 'ct-1',
      tenantId: TENANT,
      prerequisiteCertifications: ['ct-0'],
      isDeleted: false,
    } as CertificationType);
    repo.find.mockResolvedValue([{ id: 'ct-0', code: 'BASE', name: 'Base' } as CertificationType]);

    const result = await handler.execute(new GetCertificationTypeQuery(TENANT, 'ct-1'));
    expect(result.prerequisites).toEqual([{ id: 'ct-0', code: 'BASE', name: 'Base' }]);
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'ct-1', tenantId: TENANT }) }),
    );
  });

  it('throws NotFound when absent', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(handler.execute(new GetCertificationTypeQuery(TENANT, 'missing'))).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ===========================================================================
describe('GetTrainingCourseHandler', () => {
  let courseRepo: ReturnType<typeof makeRepo>;
  let certTypeRepo: ReturnType<typeof makeRepo>;
  let enrollmentRepo: ReturnType<typeof makeRepo>;
  let handler: GetTrainingCourseHandler;

  beforeEach(async () => {
    courseRepo = makeRepo();
    certTypeRepo = makeRepo();
    enrollmentRepo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetTrainingCourseHandler,
        { provide: getRepositoryToken(TrainingCourse), useValue: courseRepo },
        { provide: getRepositoryToken(CertificationType), useValue: certTypeRepo },
        { provide: getRepositoryToken(TrainingEnrollment), useValue: enrollmentRepo },
      ],
    }).compile();
    handler = module.get(GetTrainingCourseHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('assembles cert type, prerequisite courses and completion stats', async () => {
    courseRepo.findOne.mockResolvedValue({
      id: 'tc-1',
      tenantId: TENANT,
      certificationTypeId: 'ct-1',
      prerequisites: ['tc-0'],
      isDeleted: false,
    } as TrainingCourse);
    certTypeRepo.findOne.mockResolvedValue({ id: 'ct-1', code: 'C', name: 'Cert' } as CertificationType);
    courseRepo.find.mockResolvedValue([{ id: 'tc-0', code: 'P', name: 'Prereq' } as TrainingCourse]);
    enrollmentRepo.count
      .mockResolvedValueOnce(4) // total
      .mockResolvedValueOnce(3); // completed/passed

    const result = await handler.execute(new GetTrainingCourseQuery(TENANT, 'tc-1'));

    expect(result.certificationType?.id).toBe('ct-1');
    expect(result.prerequisiteCourses).toHaveLength(1);
    expect(result.enrollmentCount).toBe(4);
    expect(result.completionRate).toBe(75);
  });

  it('throws NotFound when the course is absent in the tenant', async () => {
    courseRepo.findOne.mockResolvedValue(null);
    await expect(handler.execute(new GetTrainingCourseQuery(TENANT, 'missing'))).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ===========================================================================
describe('GetCertificationsForWorkAreaHandler', () => {
  let workAreaRepo: ReturnType<typeof makeRepo>;
  let certTypeRepo: ReturnType<typeof makeRepo>;
  let handler: GetCertificationsForWorkAreaHandler;

  beforeEach(async () => {
    workAreaRepo = makeRepo();
    certTypeRepo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCertificationsForWorkAreaHandler,
        { provide: getRepositoryToken(WorkArea), useValue: workAreaRepo },
        { provide: getRepositoryToken(CertificationType), useValue: certTypeRepo },
      ],
    }).compile();
    handler = module.get(GetCertificationsForWorkAreaHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('resolves the required certification types for the work area', async () => {
    workAreaRepo.findOne.mockResolvedValue({
      id: 'wa-1',
      tenantId: TENANT,
      requiredCertifications: ['ct-1', 'ct-2'],
      isDeleted: false,
    } as WorkArea);
    certTypeRepo.find.mockResolvedValue([
      { id: 'ct-1' } as CertificationType,
      { id: 'ct-2' } as CertificationType,
    ]);

    const result = await handler.execute(new GetCertificationsForWorkAreaQuery(TENANT, 'wa-1'));
    expect(result).toHaveLength(2);
    expect(workAreaRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'wa-1', tenantId: TENANT }) }),
    );
  });

  it('returns [] when the work area requires no certifications', async () => {
    workAreaRepo.findOne.mockResolvedValue({
      id: 'wa-1',
      tenantId: TENANT,
      requiredCertifications: [] as string[],
      isDeleted: false,
    } as WorkArea);
    const result = await handler.execute(new GetCertificationsForWorkAreaQuery(TENANT, 'wa-1'));
    expect(result).toEqual([]);
    expect(certTypeRepo.find).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown work area', async () => {
    workAreaRepo.findOne.mockResolvedValue(null);
    await expect(
      handler.execute(new GetCertificationsForWorkAreaQuery(TENANT, 'missing')),
    ).rejects.toThrow(NotFoundException);
  });
});

// ===========================================================================
describe('GetMandatoryTrainingStatusHandler', () => {
  let courseRepo: ReturnType<typeof makeRepo>;
  let enrollmentRepo: ReturnType<typeof makeRepo>;
  let employeeRepo: ReturnType<typeof makeRepo>;
  let handler: GetMandatoryTrainingStatusHandler;

  beforeEach(async () => {
    courseRepo = makeRepo();
    enrollmentRepo = makeRepo();
    employeeRepo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetMandatoryTrainingStatusHandler,
        { provide: getRepositoryToken(TrainingCourse), useValue: courseRepo },
        { provide: getRepositoryToken(TrainingEnrollment), useValue: enrollmentRepo },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
      ],
    }).compile();
    handler = module.get(GetMandatoryTrainingStatusHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('classifies completed / overdue / not_started per mandatory course', async () => {
    employeeRepo.findOne.mockResolvedValue({ id: EMPLOYEE } as Employee);
    courseRepo.find.mockResolvedValue([
      { id: 'c-done', name: 'Done', isMandatory: true } as TrainingCourse,
      { id: 'c-overdue', name: 'Overdue', isMandatory: true } as TrainingCourse,
      { id: 'c-none', name: 'None', isMandatory: true } as TrainingCourse,
    ]);
    enrollmentRepo.find.mockResolvedValue([
      {
        trainingCourseId: 'c-done',
        status: EnrollmentStatus.COMPLETED,
        enrollmentDate: new Date('2026-01-01'),
        completedAt: new Date('2026-02-01'),
      } as TrainingEnrollment,
      {
        trainingCourseId: 'c-overdue',
        status: EnrollmentStatus.IN_PROGRESS,
        enrollmentDate: new Date('2026-01-01'),
        dueDate: new Date('2026-02-01'), // in the past
      } as TrainingEnrollment,
    ]);

    const result = await handler.execute(new GetMandatoryTrainingStatusQuery(TENANT, EMPLOYEE));
    const byId = Object.fromEntries(result.map((r) => [r.courseId, r.status]));
    expect(byId['c-done']).toBe('completed');
    expect(byId['c-overdue']).toBe('overdue');
    expect(byId['c-none']).toBe('not_started');
  });

  it('throws NotFound for an unknown employee', async () => {
    employeeRepo.findOne.mockResolvedValue(null);
    await expect(
      handler.execute(new GetMandatoryTrainingStatusQuery(TENANT, 'missing')),
    ).rejects.toThrow(NotFoundException);
  });
});

// ===========================================================================
describe('GetEmployeeCertificationStatusHandler', () => {
  let certTypeRepo: ReturnType<typeof makeRepo>;
  let certRepo: ReturnType<typeof makeRepo>;
  let employeeRepo: ReturnType<typeof makeRepo>;
  let handler: GetEmployeeCertificationStatusHandler;

  beforeEach(async () => {
    certTypeRepo = makeRepo();
    certRepo = makeRepo();
    employeeRepo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetEmployeeCertificationStatusHandler,
        { provide: getRepositoryToken(CertificationType), useValue: certTypeRepo },
        { provide: getRepositoryToken(EmployeeCertification), useValue: certRepo },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
      ],
    }).compile();
    handler = module.get(GetEmployeeCertificationStatusHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('reports missing mandatory certs and expiring-soon held certs', async () => {
    employeeRepo.findOne.mockResolvedValue({ id: EMPLOYEE } as Employee);
    certTypeRepo.find.mockResolvedValue([
      {
        id: 'ct-held',
        name: 'Held',
        category: CertificationCategory.SAFETY,
        requirement: CertificationRequirement.MANDATORY,
        isOffshoreRequired: false,
      } as CertificationType,
      {
        id: 'ct-missing',
        name: 'Missing',
        category: CertificationCategory.DIVING,
        requirement: CertificationRequirement.MANDATORY,
        isOffshoreRequired: true,
      } as CertificationType,
    ]);
    certRepo.createQueryBuilder.mockReturnValue(
      makeQb([
        makeCert(
          { certificationTypeId: 'ct-held', expiryDate: futureIso(20) },
          'Held',
        ),
      ]),
    );

    const result = await handler.execute(new GetEmployeeCertificationStatusQuery(TENANT, EMPLOYEE));

    expect(result.totalRequired).toBe(2);
    expect(result.totalHeld).toBe(1);
    expect(result.isFullyCompliant).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.certificationTypeId).toBe('ct-missing');
    expect(result.missing[0]!.requiredForOffshore).toBe(true);
    expect(result.expiringSoon).toHaveLength(1);
  });

  it('throws NotFound for an unknown employee', async () => {
    employeeRepo.findOne.mockResolvedValue(null);
    await expect(
      handler.execute(new GetEmployeeCertificationStatusQuery(TENANT, 'missing')),
    ).rejects.toThrow(NotFoundException);
  });
});

// ===========================================================================
describe('GetCertificationComplianceReportHandler', () => {
  let certTypeRepo: ReturnType<typeof makeRepo>;
  let certRepo: ReturnType<typeof makeRepo>;
  let employeeRepo: ReturnType<typeof makeRepo>;
  let handler: GetCertificationComplianceReportHandler;

  beforeEach(async () => {
    certTypeRepo = makeRepo();
    certRepo = makeRepo();
    employeeRepo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCertificationComplianceReportHandler,
        { provide: getRepositoryToken(CertificationType), useValue: certTypeRepo },
        { provide: getRepositoryToken(EmployeeCertification), useValue: certRepo },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
      ],
    }).compile();
    handler = module.get(GetCertificationComplianceReportHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('computes compliance rate over active employees vs mandatory certs', async () => {
    // 2 active employees in scope
    employeeRepo.createQueryBuilder.mockReturnValue(
      makeQb([{ id: 'e1' }, { id: 'e2' }]),
    );
    // 1 mandatory cert type
    certTypeRepo.find
      .mockResolvedValueOnce([
        {
          id: 'ct-1',
          category: CertificationCategory.SAFETY,
          requirement: CertificationRequirement.MANDATORY,
        } as CertificationType,
      ])
      // 2nd find() = all cert types for category lookup
      .mockResolvedValueOnce([
        { id: 'ct-1', category: CertificationCategory.SAFETY } as CertificationType,
      ]);
    // only e1 holds the mandatory cert -> 50% compliant
    certRepo.createQueryBuilder.mockReturnValue(
      makeQb([
        makeCert({ employeeId: 'e1', certificationTypeId: 'ct-1', expiryDate: futureIso(20) }),
      ]),
    );

    const result = await handler.execute(new GetCertificationComplianceReportQuery(TENANT));

    expect(result.totalEmployees).toBe(2);
    expect(result.compliantEmployees).toBe(1);
    expect(result.nonCompliantEmployees).toBe(1);
    expect(result.complianceRate).toBe(50);
    expect(result.expiringWithin30Days).toBe(1);
    expect(result.byCategory).toHaveLength(1);
  });

  it('scopes the employee query to the tenant (+ optional department)', async () => {
    const empQb = makeQb([]);
    employeeRepo.createQueryBuilder.mockReturnValue(empQb);
    certTypeRepo.find.mockResolvedValue([]);
    certRepo.createQueryBuilder.mockReturnValue(makeQb([]));

    await handler.execute(new GetCertificationComplianceReportQuery(TENANT, 'dept-1'));

    expect(empQb.where).toHaveBeenCalledWith('e.tenantId = :tenantId', { tenantId: TENANT });
    expect(empQb.andWhere).toHaveBeenCalledWith('e.departmentHrId = :departmentId', {
      departmentId: 'dept-1',
    });
  });

  it('treats everyone as compliant when there are no mandatory certs', async () => {
    employeeRepo.createQueryBuilder.mockReturnValue(makeQb([{ id: 'e1' }]));
    certTypeRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    certRepo.createQueryBuilder.mockReturnValue(makeQb([]));

    const result = await handler.execute(new GetCertificationComplianceReportQuery(TENANT));
    expect(result.compliantEmployees).toBe(1);
    expect(result.complianceRate).toBe(100);
  });
});
