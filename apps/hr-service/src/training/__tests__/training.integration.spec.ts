/**
 * Training Module Integration Tests
 *
 * E2E style integration tests for training and certification management.
 * Tests cover enrollment, completion, certification lifecycle, and event publishing.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventBus } from '@nestjs/cqrs';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// Handlers
import { EnrollInTrainingHandler } from '../handlers/enroll-in-training.handler';
import { CompleteTrainingHandler } from '../handlers/complete-training.handler';
import { AddEmployeeCertificationHandler } from '../handlers/add-employee-certification.handler';
import { RevokeCertificationHandler } from '../handlers/revoke-certification.handler';

// Entities
import { TrainingEnrollment, EnrollmentStatus } from '../entities/training-enrollment.entity';
import { TrainingCourse } from '../entities/training-course.entity';
import { EmployeeCertification, CertificationStatus, VerificationStatus } from '../entities/employee-certification.entity';
import { CertificationType } from '../entities/certification-type.entity';
import { Employee } from '../../hr/entities/employee.entity';

// Commands
import { EnrollInTrainingCommand } from '../commands/enroll-in-training.command';
import { CompleteTrainingCommand } from '../commands/complete-training.command';
import { AddEmployeeCertificationCommand } from '../commands/add-employee-certification.command';
import { RevokeCertificationCommand } from '../commands/revoke-certification.command';

// Events
import {
  CertificationAddedEvent,
  CertificationRevokedEvent,
  TrainingCompletedEvent,
} from '../events/training.events';

describe('Training Module Integration Tests', () => {
  // Test constants
  const TENANT_ID = 'tenant-aquafarm-001';
  const USER_ID = 'user-admin-001';
  const EMPLOYEE_ID = 'emp-001';
  const COURSE_ID = 'course-001';
  const CERT_TYPE_ID = 'cert-type-001';

  // Mock repositories
  let enrollmentRepository: jest.Mocked<Repository<TrainingEnrollment>>;
  let courseRepository: jest.Mocked<Repository<TrainingCourse>>;
  let certificationRepository: jest.Mocked<Repository<EmployeeCertification>>;
  let certificationTypeRepository: jest.Mocked<Repository<CertificationType>>;
  let employeeRepository: jest.Mocked<Repository<Employee>>;
  let eventBus: jest.Mocked<EventBus>;

  // Handlers
  let enrollHandler: EnrollInTrainingHandler;
  let completeHandler: CompleteTrainingHandler;
  let addCertHandler: AddEmployeeCertificationHandler;
  let revokeCertHandler: RevokeCertificationHandler;

  // Test data factories
  const createMockEmployee = (overrides = {}): Partial<Employee> => ({
    id: EMPLOYEE_ID,
    tenantId: TENANT_ID,
    firstName: 'John',
    lastName: 'Doe',
    email: 'john.doe@aquafarm.com',
    isDeleted: false,
    ...overrides,
  });

  const createMockCourse = (overrides = {}): Partial<TrainingCourse> => ({
    id: COURSE_ID,
    tenantId: TENANT_ID,
    name: 'Water Quality Management',
    description: 'Advanced training on water quality monitoring',
    isActive: true,
    requiresAssessment: false,
    passingScore: 70,
    maxAttempts: 3,
    durationHours: 8,
    isDeleted: false,
    ...overrides,
  });

  const createMockEnrollment = (overrides = {}): Partial<TrainingEnrollment> => ({
    id: 'enrollment-001',
    tenantId: TENANT_ID,
    employeeId: EMPLOYEE_ID,
    trainingCourseId: COURSE_ID,
    status: EnrollmentStatus.ENROLLED,
    enrollmentDate: new Date('2025-01-15'),
    progressPercent: 0,
    attemptCount: 0,
    isDeleted: false,
    ...overrides,
  });

  const createMockCertificationType = (overrides = {}): Partial<CertificationType> => ({
    id: CERT_TYPE_ID,
    tenantId: TENANT_ID,
    name: 'Aquaculture Safety Certification',
    code: 'ASC-001',
    issuingAuthority: 'Aquaculture Standards Board',
    validityPeriodMonths: 24,
    renewalReminderDays: 60,
    isActive: true,
    isDeleted: false,
    ...overrides,
  });

  const createMockCertification = (overrides = {}): Partial<EmployeeCertification> => ({
    id: 'cert-001',
    tenantId: TENANT_ID,
    employeeId: EMPLOYEE_ID,
    certificationTypeId: CERT_TYPE_ID,
    certificationNumber: 'CERT-2025-00001',
    issueDate: new Date('2025-01-01'),
    expiryDate: new Date('2027-01-01'),
    status: CertificationStatus.ACTIVE,
    verificationStatus: VerificationStatus.PENDING_VERIFICATION,
    isDeleted: false,
    ...overrides,
  });

  beforeEach(async () => {
    // Create mock repositories
    const createMockRepo = () => ({
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    });

    enrollmentRepository = createMockRepo() as any;
    courseRepository = createMockRepo() as any;
    certificationRepository = createMockRepo() as any;
    certificationTypeRepository = createMockRepo() as any;
    employeeRepository = createMockRepo() as any;

    eventBus = {
      publish: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollInTrainingHandler,
        CompleteTrainingHandler,
        AddEmployeeCertificationHandler,
        RevokeCertificationHandler,
        { provide: getRepositoryToken(TrainingEnrollment), useValue: enrollmentRepository },
        { provide: getRepositoryToken(TrainingCourse), useValue: courseRepository },
        { provide: getRepositoryToken(EmployeeCertification), useValue: certificationRepository },
        { provide: getRepositoryToken(CertificationType), useValue: certificationTypeRepository },
        { provide: getRepositoryToken(Employee), useValue: employeeRepository },
        { provide: EventBus, useValue: eventBus },
      ],
    }).compile();

    enrollHandler = module.get<EnrollInTrainingHandler>(EnrollInTrainingHandler);
    completeHandler = module.get<CompleteTrainingHandler>(CompleteTrainingHandler);
    addCertHandler = module.get<AddEmployeeCertificationHandler>(AddEmployeeCertificationHandler);
    revokeCertHandler = module.get<RevokeCertificationHandler>(RevokeCertificationHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // Training Enrollment Tests
  // ============================================================================

  describe('Training Enrollment', () => {
    describe('EnrollInTrainingHandler', () => {
      it('should successfully enroll an employee in a training course', async () => {
        const employee = createMockEmployee();
        const course = createMockCourse();
        const expectedEnrollment = createMockEnrollment();

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        courseRepository.findOne.mockResolvedValue(course as TrainingCourse);
        enrollmentRepository.findOne.mockResolvedValue(null); // No existing enrollment
        enrollmentRepository.create.mockReturnValue(expectedEnrollment as TrainingEnrollment);
        enrollmentRepository.save.mockResolvedValue(expectedEnrollment as TrainingEnrollment);

        const command = new EnrollInTrainingCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          COURSE_ID,
          '2025-02-15', // dueDate
          undefined, // sessionId
          'Dr. Smith', // instructor
          'Training Room A', // location
        );

        const result = await enrollHandler.execute(command);

        expect(result).toBeDefined();
        expect(result.status).toBe(EnrollmentStatus.ENROLLED);
        expect(enrollmentRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: TENANT_ID,
            employeeId: EMPLOYEE_ID,
            trainingCourseId: COURSE_ID,
            status: EnrollmentStatus.ENROLLED,
            instructor: 'Dr. Smith',
            location: 'Training Room A',
          }),
        );
      });

      it('should reject enrollment if employee not found', async () => {
        employeeRepository.findOne.mockResolvedValue(null);

        const command = new EnrollInTrainingCommand(
          TENANT_ID,
          USER_ID,
          'non-existent-emp',
          COURSE_ID,
        );

        await expect(enrollHandler.execute(command)).rejects.toThrow(NotFoundException);
        expect(enrollmentRepository.save).not.toHaveBeenCalled();
      });

      it('should reject enrollment if course not found', async () => {
        const employee = createMockEmployee();
        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        courseRepository.findOne.mockResolvedValue(null);

        const command = new EnrollInTrainingCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          'non-existent-course',
        );

        await expect(enrollHandler.execute(command)).rejects.toThrow(NotFoundException);
      });

      it('should reject enrollment if course is inactive', async () => {
        const employee = createMockEmployee();
        const inactiveCourse = createMockCourse({ isActive: false });

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        courseRepository.findOne.mockResolvedValue(inactiveCourse as TrainingCourse);

        const command = new EnrollInTrainingCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          COURSE_ID,
        );

        await expect(enrollHandler.execute(command)).rejects.toThrow(BadRequestException);
        await expect(enrollHandler.execute(command)).rejects.toThrow(/not active/);
      });

      it('should reject duplicate enrollment', async () => {
        const employee = createMockEmployee();
        const course = createMockCourse();
        const existingEnrollment = createMockEnrollment();

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        courseRepository.findOne.mockResolvedValue(course as TrainingCourse);
        enrollmentRepository.findOne.mockResolvedValue(existingEnrollment as TrainingEnrollment);

        const command = new EnrollInTrainingCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          COURSE_ID,
        );

        await expect(enrollHandler.execute(command)).rejects.toThrow(BadRequestException);
        await expect(enrollHandler.execute(command)).rejects.toThrow(/already enrolled/);
      });

      it('should reject enrollment if training is already in progress', async () => {
        const employee = createMockEmployee();
        const course = createMockCourse();

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        courseRepository.findOne.mockResolvedValue(course as TrainingCourse);

        // First call for ENROLLED status returns null
        // Second call for IN_PROGRESS status returns existing enrollment
        enrollmentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(createMockEnrollment({
            status: EnrollmentStatus.IN_PROGRESS,
          }) as TrainingEnrollment);

        const command = new EnrollInTrainingCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          COURSE_ID,
        );

        await expect(enrollHandler.execute(command)).rejects.toThrow(BadRequestException);
        await expect(enrollHandler.execute(command)).rejects.toThrow(/in progress/);
      });
    });
  });

  // ============================================================================
  // Training Completion Tests
  // ============================================================================

  describe('Training Completion', () => {
    describe('CompleteTrainingHandler', () => {
      it('should complete non-assessment training successfully', async () => {
        const enrollment = createMockEnrollment({
          status: EnrollmentStatus.IN_PROGRESS,
          trainingCourse: createMockCourse({ requiresAssessment: false }),
        });

        enrollmentRepository.findOne.mockResolvedValue(enrollment as TrainingEnrollment);
        enrollmentRepository.save.mockImplementation(async (e) => e as TrainingEnrollment);

        const command = new CompleteTrainingCommand(
          TENANT_ID,
          USER_ID,
          'enrollment-001',
          undefined, // no score for non-assessment
          'Great training!',
          5,
        );

        const result = await completeHandler.execute(command);

        expect(result.status).toBe(EnrollmentStatus.COMPLETED);
        expect(result.progressPercent).toBe(100);
        expect(result.completedAt).toBeDefined();
        expect(result.feedback).toBe('Great training!');
        expect(result.feedbackRating).toBe(5);

        // Event should be published
        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.any(TrainingCompletedEvent),
        );
      });

      it('should handle assessment-based training with passing score', async () => {
        const course = createMockCourse({
          requiresAssessment: true,
          passingScore: 70,
          maxAttempts: 3,
        });
        const enrollment = createMockEnrollment({
          status: EnrollmentStatus.IN_PROGRESS,
          trainingCourse: course,
          attemptCount: 0,
          assessmentAttempts: [],
        });

        enrollmentRepository.findOne.mockResolvedValue(enrollment as TrainingEnrollment);
        enrollmentRepository.save.mockImplementation(async (e) => e as TrainingEnrollment);

        const command = new CompleteTrainingCommand(
          TENANT_ID,
          USER_ID,
          'enrollment-001',
          85, // passing score
        );

        const result = await completeHandler.execute(command);

        expect(result.status).toBe(EnrollmentStatus.PASSED);
        expect(result.finalScore).toBe(85);
        expect(result.attemptCount).toBe(1);
        expect(result.assessmentAttempts).toHaveLength(1);
        expect(result.assessmentAttempts![0].passed).toBe(true);
        expect(eventBus.publish).toHaveBeenCalled();
      });

      it('should handle assessment-based training with failing score and remaining attempts', async () => {
        const course = createMockCourse({
          requiresAssessment: true,
          passingScore: 70,
          maxAttempts: 3,
        });
        const enrollment = createMockEnrollment({
          status: EnrollmentStatus.IN_PROGRESS,
          trainingCourse: course,
          attemptCount: 0,
        });

        enrollmentRepository.findOne.mockResolvedValue(enrollment as TrainingEnrollment);
        enrollmentRepository.save.mockImplementation(async (e) => e as TrainingEnrollment);

        const command = new CompleteTrainingCommand(
          TENANT_ID,
          USER_ID,
          'enrollment-001',
          55, // failing score
        );

        const result = await completeHandler.execute(command);

        expect(result.status).toBe(EnrollmentStatus.IN_PROGRESS); // Still has attempts
        expect(result.finalScore).toBe(55);
        expect(result.attemptCount).toBe(1);
        expect(result.completedAt).toBeUndefined();

        // No completion event for failed attempt with retries remaining
        expect(eventBus.publish).not.toHaveBeenCalled();
      });

      it('should mark training as failed when max attempts reached', async () => {
        const course = createMockCourse({
          requiresAssessment: true,
          passingScore: 70,
          maxAttempts: 2,
        });
        const enrollment = createMockEnrollment({
          status: EnrollmentStatus.IN_PROGRESS,
          trainingCourse: course,
          attemptCount: 1, // Already attempted once
          assessmentAttempts: [{
            attemptNumber: 1,
            score: 50,
            passed: false,
            attemptedAt: new Date('2025-01-10'),
          }],
        });

        enrollmentRepository.findOne.mockResolvedValue(enrollment as TrainingEnrollment);
        enrollmentRepository.save.mockImplementation(async (e) => e as TrainingEnrollment);

        const command = new CompleteTrainingCommand(
          TENANT_ID,
          USER_ID,
          'enrollment-001',
          60, // Still failing
        );

        const result = await completeHandler.execute(command);

        expect(result.status).toBe(EnrollmentStatus.FAILED);
        expect(result.attemptCount).toBe(2);
        expect(result.completedAt).toBeDefined();
      });

      it('should reject completion of already completed training', async () => {
        const enrollment = createMockEnrollment({
          status: EnrollmentStatus.COMPLETED,
        });

        enrollmentRepository.findOne.mockResolvedValue(enrollment as TrainingEnrollment);

        const command = new CompleteTrainingCommand(
          TENANT_ID,
          USER_ID,
          'enrollment-001',
        );

        await expect(completeHandler.execute(command)).rejects.toThrow(BadRequestException);
        await expect(completeHandler.execute(command)).rejects.toThrow(/already completed/);
      });

      it('should reject completion if enrollment not found', async () => {
        enrollmentRepository.findOne.mockResolvedValue(null);

        const command = new CompleteTrainingCommand(
          TENANT_ID,
          USER_ID,
          'non-existent',
        );

        await expect(completeHandler.execute(command)).rejects.toThrow(NotFoundException);
      });
    });
  });

  // ============================================================================
  // Certification Management Tests
  // ============================================================================

  describe('Certification Management', () => {
    describe('AddEmployeeCertificationHandler', () => {
      it('should add a new certification successfully', async () => {
        const employee = createMockEmployee();
        const certType = createMockCertificationType();
        const expectedCert = createMockCertification();

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        certificationTypeRepository.findOne.mockResolvedValue(certType as CertificationType);
        certificationRepository.findOne.mockResolvedValue(null); // No existing cert
        certificationRepository.create.mockReturnValue(expectedCert as EmployeeCertification);
        certificationRepository.save.mockResolvedValue(expectedCert as EmployeeCertification);

        const command = new AddEmployeeCertificationCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          CERT_TYPE_ID,
          '2025-01-15',
          '2027-01-15',
          'Aquaculture Standards Board',
          'EXT-CERT-12345',
          'Certified with distinction',
        );

        const result = await addCertHandler.execute(command);

        expect(result).toBeDefined();
        expect(certificationRepository.create).toHaveBeenCalled();
        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.any(CertificationAddedEvent),
        );
      });

      it('should set status to EXPIRED if expiry date is in the past', async () => {
        const employee = createMockEmployee();
        const certType = createMockCertificationType();
        const expiredCert = createMockCertification({
          status: CertificationStatus.EXPIRED,
        });

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        certificationTypeRepository.findOne.mockResolvedValue(certType as CertificationType);
        certificationRepository.findOne.mockResolvedValue(null);
        certificationRepository.create.mockReturnValue(expiredCert as EmployeeCertification);
        certificationRepository.save.mockResolvedValue(expiredCert as EmployeeCertification);

        const command = new AddEmployeeCertificationCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          CERT_TYPE_ID,
          '2020-01-01', // Past issue date
          '2022-01-01', // Past expiry date
        );

        await addCertHandler.execute(command);

        expect(certificationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            status: CertificationStatus.EXPIRED,
          }),
        );
      });

      it('should set status to EXPIRING_SOON if within reminder period', async () => {
        const employee = createMockEmployee();
        const certType = createMockCertificationType({ renewalReminderDays: 30 });

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        certificationTypeRepository.findOne.mockResolvedValue(certType as CertificationType);
        certificationRepository.findOne.mockResolvedValue(null);
        certificationRepository.create.mockImplementation((data) => data as EmployeeCertification);
        certificationRepository.save.mockImplementation(async (data) => data as EmployeeCertification);

        // Expiry date within 30 days
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 15);

        const command = new AddEmployeeCertificationCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          CERT_TYPE_ID,
          '2024-01-01',
          expiryDate.toISOString().split('T')[0],
        );

        await addCertHandler.execute(command);

        expect(certificationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            status: CertificationStatus.EXPIRING_SOON,
          }),
        );
      });

      it('should reject if employee already has active certification of same type', async () => {
        const employee = createMockEmployee();
        const certType = createMockCertificationType();
        const existingCert = createMockCertification({
          status: CertificationStatus.ACTIVE,
        });

        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        certificationTypeRepository.findOne.mockResolvedValue(certType as CertificationType);
        certificationRepository.findOne.mockResolvedValue(existingCert as EmployeeCertification);

        const command = new AddEmployeeCertificationCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          CERT_TYPE_ID,
          '2025-01-15',
        );

        await expect(addCertHandler.execute(command)).rejects.toThrow(BadRequestException);
        await expect(addCertHandler.execute(command)).rejects.toThrow(/already has an active/);
      });

      it('should reject if employee not found', async () => {
        employeeRepository.findOne.mockResolvedValue(null);

        const command = new AddEmployeeCertificationCommand(
          TENANT_ID,
          USER_ID,
          'non-existent-emp',
          CERT_TYPE_ID,
          '2025-01-15',
        );

        await expect(addCertHandler.execute(command)).rejects.toThrow(NotFoundException);
      });

      it('should reject if certification type not found', async () => {
        const employee = createMockEmployee();
        employeeRepository.findOne.mockResolvedValue(employee as Employee);
        certificationTypeRepository.findOne.mockResolvedValue(null);

        const command = new AddEmployeeCertificationCommand(
          TENANT_ID,
          USER_ID,
          EMPLOYEE_ID,
          'non-existent-type',
          '2025-01-15',
        );

        await expect(addCertHandler.execute(command)).rejects.toThrow(NotFoundException);
      });
    });

    describe('RevokeCertificationHandler', () => {
      it('should revoke an active certification', async () => {
        const activeCert = createMockCertification({
          status: CertificationStatus.ACTIVE,
        });

        certificationRepository.findOne.mockResolvedValue(activeCert as EmployeeCertification);
        certificationRepository.save.mockImplementation(async (cert) => cert as EmployeeCertification);

        const command = new RevokeCertificationCommand(
          TENANT_ID,
          USER_ID,
          'cert-001',
          'Failed to maintain required standards',
        );

        const result = await revokeCertHandler.execute(command);

        expect(result.status).toBe(CertificationStatus.REVOKED);
        expect(result.revokedBy).toBe(USER_ID);
        expect(result.revokedAt).toBeDefined();
        expect(result.revocationReason).toBe('Failed to maintain required standards');
        expect(eventBus.publish).toHaveBeenCalledWith(
          expect.any(CertificationRevokedEvent),
        );
      });

      it('should reject revoking already revoked certification', async () => {
        const revokedCert = createMockCertification({
          status: CertificationStatus.REVOKED,
        });

        certificationRepository.findOne.mockResolvedValue(revokedCert as EmployeeCertification);

        const command = new RevokeCertificationCommand(
          TENANT_ID,
          USER_ID,
          'cert-001',
          'Another revocation attempt',
        );

        await expect(revokeCertHandler.execute(command)).rejects.toThrow(BadRequestException);
        await expect(revokeCertHandler.execute(command)).rejects.toThrow(/already revoked/);
      });

      it('should reject if certification not found', async () => {
        certificationRepository.findOne.mockResolvedValue(null);

        const command = new RevokeCertificationCommand(
          TENANT_ID,
          USER_ID,
          'non-existent',
          'Revocation reason',
        );

        await expect(revokeCertHandler.execute(command)).rejects.toThrow(NotFoundException);
      });
    });
  });

  // ============================================================================
  // Complete Workflow Tests (E2E Style)
  // ============================================================================

  describe('Complete Training Workflow', () => {
    it('should handle full training lifecycle: enroll -> progress -> complete', async () => {
      // Step 1: Enroll employee
      const employee = createMockEmployee();
      const course = createMockCourse({ requiresAssessment: true, passingScore: 70 });

      employeeRepository.findOne.mockResolvedValue(employee as Employee);
      courseRepository.findOne.mockResolvedValue(course as TrainingCourse);
      enrollmentRepository.findOne.mockResolvedValue(null);

      const newEnrollment = createMockEnrollment({
        id: 'enroll-workflow-001',
        trainingCourse: course,
      });

      enrollmentRepository.create.mockReturnValue(newEnrollment as TrainingEnrollment);
      enrollmentRepository.save.mockResolvedValue(newEnrollment as TrainingEnrollment);

      const enrollCommand = new EnrollInTrainingCommand(
        TENANT_ID,
        USER_ID,
        EMPLOYEE_ID,
        COURSE_ID,
      );

      const enrollResult = await enrollHandler.execute(enrollCommand);
      expect(enrollResult.status).toBe(EnrollmentStatus.ENROLLED);

      // Step 2: First attempt - fail
      const afterFirstAttempt = {
        ...newEnrollment,
        status: EnrollmentStatus.IN_PROGRESS,
        attemptCount: 1,
        assessmentAttempts: [{
          attemptNumber: 1,
          score: 50,
          passed: false,
          attemptedAt: new Date(),
        }],
      };

      enrollmentRepository.findOne.mockResolvedValue(afterFirstAttempt as TrainingEnrollment);
      enrollmentRepository.save.mockImplementation(async (e) => e as TrainingEnrollment);

      const failCommand = new CompleteTrainingCommand(
        TENANT_ID,
        USER_ID,
        'enroll-workflow-001',
        50,
      );

      const failResult = await completeHandler.execute(failCommand);
      expect(failResult.status).toBe(EnrollmentStatus.IN_PROGRESS);
      expect(failResult.attemptCount).toBe(2); // Handler increments

      // Step 3: Second attempt - pass
      const afterSecondAttempt = {
        ...afterFirstAttempt,
        attemptCount: 1, // Reset for this test
      };

      enrollmentRepository.findOne.mockResolvedValue(afterSecondAttempt as TrainingEnrollment);

      const passCommand = new CompleteTrainingCommand(
        TENANT_ID,
        USER_ID,
        'enroll-workflow-001',
        85,
        'Excellent course content!',
        5,
      );

      const passResult = await completeHandler.execute(passCommand);
      expect(passResult.status).toBe(EnrollmentStatus.PASSED);
      expect(passResult.finalScore).toBe(85);
      expect(passResult.feedback).toBe('Excellent course content!');
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(TrainingCompletedEvent));
    });

    it('should handle full certification lifecycle: add -> verify -> revoke', async () => {
      // Step 1: Add certification
      const employee = createMockEmployee();
      const certType = createMockCertificationType();

      employeeRepository.findOne.mockResolvedValue(employee as Employee);
      certificationTypeRepository.findOne.mockResolvedValue(certType as CertificationType);
      certificationRepository.findOne.mockResolvedValue(null);

      const newCert = createMockCertification({
        id: 'cert-lifecycle-001',
        status: CertificationStatus.ACTIVE,
        verificationStatus: VerificationStatus.PENDING_VERIFICATION,
      });

      certificationRepository.create.mockReturnValue(newCert as EmployeeCertification);
      certificationRepository.save.mockResolvedValue(newCert as EmployeeCertification);

      const addCommand = new AddEmployeeCertificationCommand(
        TENANT_ID,
        USER_ID,
        EMPLOYEE_ID,
        CERT_TYPE_ID,
        '2025-01-15',
        '2027-01-15',
      );

      const addResult = await addCertHandler.execute(addCommand);
      expect(addResult.status).toBe(CertificationStatus.ACTIVE);
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(CertificationAddedEvent));

      jest.clearAllMocks();

      // Step 2: Revoke certification
      const activeCert = {
        ...newCert,
        status: CertificationStatus.ACTIVE,
      };

      certificationRepository.findOne.mockResolvedValue(activeCert as EmployeeCertification);
      certificationRepository.save.mockImplementation(async (c) => c as EmployeeCertification);

      const revokeCommand = new RevokeCertificationCommand(
        TENANT_ID,
        USER_ID,
        'cert-lifecycle-001',
        'Fraudulent documentation discovered',
      );

      const revokeResult = await revokeCertHandler.execute(revokeCommand);
      expect(revokeResult.status).toBe(CertificationStatus.REVOKED);
      expect(revokeResult.revocationReason).toBe('Fraudulent documentation discovered');
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(CertificationRevokedEvent));
    });
  });

  // ============================================================================
  // Multi-Tenant Isolation Tests
  // ============================================================================

  describe('Multi-Tenant Isolation', () => {
    it('should not allow enrollment of employee from different tenant', async () => {
      const employee = createMockEmployee({ tenantId: 'different-tenant' });
      employeeRepository.findOne.mockResolvedValue(null); // Query should not find cross-tenant

      const command = new EnrollInTrainingCommand(
        TENANT_ID,
        USER_ID,
        EMPLOYEE_ID,
        COURSE_ID,
      );

      await expect(enrollHandler.execute(command)).rejects.toThrow(NotFoundException);
    });

    it('should not allow certification for employee from different tenant', async () => {
      employeeRepository.findOne.mockResolvedValue(null);

      const command = new AddEmployeeCertificationCommand(
        TENANT_ID,
        USER_ID,
        EMPLOYEE_ID,
        CERT_TYPE_ID,
        '2025-01-15',
      );

      await expect(addCertHandler.execute(command)).rejects.toThrow(NotFoundException);
    });
  });

  // ============================================================================
  // Event Publishing Tests
  // ============================================================================

  describe('Event Publishing', () => {
    it('should publish TrainingCompletedEvent with correct data', async () => {
      const enrollment = createMockEnrollment({
        id: 'event-test-001',
        status: EnrollmentStatus.IN_PROGRESS,
        trainingCourse: createMockCourse({ requiresAssessment: false }),
      });

      enrollmentRepository.findOne.mockResolvedValue(enrollment as TrainingEnrollment);
      enrollmentRepository.save.mockImplementation(async (e) => e as TrainingEnrollment);

      const command = new CompleteTrainingCommand(
        TENANT_ID,
        USER_ID,
        'event-test-001',
      );

      await completeHandler.execute(command);

      expect(eventBus.publish).toHaveBeenCalledTimes(1);
      const publishedEvent = (eventBus.publish as jest.Mock).mock.calls[0][0];
      expect(publishedEvent).toBeInstanceOf(TrainingCompletedEvent);
      expect(publishedEvent.enrollmentId).toBe('event-test-001');
      expect(publishedEvent.tenantId).toBe(TENANT_ID);
    });

    it('should publish CertificationAddedEvent with correct data', async () => {
      const employee = createMockEmployee();
      const certType = createMockCertificationType();
      const cert = createMockCertification({ id: 'cert-event-001' });

      employeeRepository.findOne.mockResolvedValue(employee as Employee);
      certificationTypeRepository.findOne.mockResolvedValue(certType as CertificationType);
      certificationRepository.findOne.mockResolvedValue(null);
      certificationRepository.create.mockReturnValue(cert as EmployeeCertification);
      certificationRepository.save.mockResolvedValue(cert as EmployeeCertification);

      const command = new AddEmployeeCertificationCommand(
        TENANT_ID,
        USER_ID,
        EMPLOYEE_ID,
        CERT_TYPE_ID,
        '2025-01-15',
      );

      await addCertHandler.execute(command);

      expect(eventBus.publish).toHaveBeenCalledTimes(1);
      const publishedEvent = (eventBus.publish as jest.Mock).mock.calls[0][0];
      expect(publishedEvent).toBeInstanceOf(CertificationAddedEvent);
      expect(publishedEvent.certificationId).toBe('cert-event-001');
      expect(publishedEvent.employeeId).toBe(EMPLOYEE_ID);
    });

    it('should publish CertificationRevokedEvent with correct data', async () => {
      const cert = createMockCertification({
        id: 'cert-revoke-event',
        status: CertificationStatus.ACTIVE,
      });

      certificationRepository.findOne.mockResolvedValue(cert as EmployeeCertification);
      certificationRepository.save.mockImplementation(async (c) => c as EmployeeCertification);

      const command = new RevokeCertificationCommand(
        TENANT_ID,
        USER_ID,
        'cert-revoke-event',
        'Test revocation',
      );

      await revokeCertHandler.execute(command);

      expect(eventBus.publish).toHaveBeenCalledTimes(1);
      const publishedEvent = (eventBus.publish as jest.Mock).mock.calls[0][0];
      expect(publishedEvent).toBeInstanceOf(CertificationRevokedEvent);
      expect(publishedEvent.certificationId).toBe('cert-revoke-event');
    });
  });
});
