/**
 * Training configuration command-handler tests.
 *
 * Covers the certification-type and training-course CRUD handlers added to close
 * the FE↔supergraph drift (Create/Update CertificationType + TrainingCourse).
 * London-school: the TypeORM repository is the mocked collaborator. Each handler
 * gets happy-path + a validation/conflict path + tenant-scoping assertions.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { CreateCertificationTypeHandler } from '../handlers/create-certification-type.handler';
import { UpdateCertificationTypeHandler } from '../handlers/update-certification-type.handler';
import { CreateTrainingCourseHandler } from '../handlers/create-training-course.handler';
import { UpdateTrainingCourseHandler } from '../handlers/update-training-course.handler';

import { CreateCertificationTypeCommand } from '../commands/create-certification-type.command';
import { UpdateCertificationTypeCommand } from '../commands/update-certification-type.command';
import { CreateTrainingCourseCommand } from '../commands/create-training-course.command';
import { UpdateTrainingCourseCommand } from '../commands/update-training-course.command';

import {
  CertificationType,
  CertificationCategory,
  CertificationRequirement,
} from '../entities/certification-type.entity';
import {
  TrainingCourse,
  TrainingType,
  TrainingLevel,
} from '../entities/training-course.entity';

const TENANT = 'tenant-aquafarm-001';
const USER = 'user-admin-001';

function makeRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    // create() echoes the partial it was given; save() returns it with an id.
    create: jest.fn().mockImplementation((data: unknown) => ({ ...(data as object) })),
    save: jest.fn().mockImplementation(async (e: unknown) => ({ id: 'generated-id', ...(e as object) })),
  };
}

describe('Training configuration CRUD handlers', () => {
  let certTypeRepo: jest.Mocked<Repository<CertificationType>>;
  let courseRepo: jest.Mocked<Repository<TrainingCourse>>;

  let createCertType: CreateCertificationTypeHandler;
  let updateCertType: UpdateCertificationTypeHandler;
  let createCourse: CreateTrainingCourseHandler;
  let updateCourse: UpdateTrainingCourseHandler;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateCertificationTypeHandler,
        UpdateCertificationTypeHandler,
        CreateTrainingCourseHandler,
        UpdateTrainingCourseHandler,
        // useValue is loosely typed, so the bare makeRepo() subset is accepted
        // without a cast; module.get(token) then yields the typed mock the
        // handler was actually injected with — cast-free.
        { provide: getRepositoryToken(CertificationType), useValue: makeRepo() },
        { provide: getRepositoryToken(TrainingCourse), useValue: makeRepo() },
      ],
    }).compile();

    certTypeRepo = module.get(getRepositoryToken(CertificationType));
    courseRepo = module.get(getRepositoryToken(TrainingCourse));

    createCertType = module.get(CreateCertificationTypeHandler);
    updateCertType = module.get(UpdateCertificationTypeHandler);
    createCourse = module.get(CreateTrainingCourseHandler);
    updateCourse = module.get(UpdateTrainingCourseHandler);
  });

  afterEach(() => jest.clearAllMocks());

  // ------------------------------------------------------------------
  describe('CreateCertificationTypeHandler', () => {
    const input = {
      code: 'DIVE-1',
      name: 'Commercial Diving',
      category: CertificationCategory.DIVING,
      requirement: CertificationRequirement.MANDATORY,
      isOffshoreRequired: true,
    };

    it('creates a certification type stamped with tenant + audit user', async () => {
      certTypeRepo.findOne.mockResolvedValue(null);

      const result = await createCertType.execute(
        new CreateCertificationTypeCommand(TENANT, USER, input as never),
      );

      expect(certTypeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'DIVE-1',
          tenantId: TENANT,
          createdBy: USER,
          updatedBy: USER,
        }),
      );
      expect(result.tenantId).toBe(TENANT);
    });

    it('rejects a duplicate per-tenant code (409)', async () => {
      certTypeRepo.findOne.mockResolvedValue({ id: 'existing' } as CertificationType);

      await expect(
        createCertType.execute(new CreateCertificationTypeCommand(TENANT, USER, input as never)),
      ).rejects.toThrow(ConflictException);
      expect(certTypeRepo.save).not.toHaveBeenCalled();
    });

    it('scopes the uniqueness lookup to the calling tenant', async () => {
      certTypeRepo.findOne.mockResolvedValue(null);
      await createCertType.execute(new CreateCertificationTypeCommand(TENANT, USER, input as never));
      expect(certTypeRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT, code: 'DIVE-1' }) }),
      );
    });
  });

  // ------------------------------------------------------------------
  describe('UpdateCertificationTypeHandler', () => {
    it('applies only supplied keys and leaves others untouched', async () => {
      const existing = {
        id: 'ct-1',
        tenantId: TENANT,
        code: 'DIVE-1',
        name: 'Old Name',
        isActive: true,
        isDeleted: false,
      } as CertificationType;
      certTypeRepo.findOne.mockResolvedValue(existing);

      await updateCertType.execute(
        new UpdateCertificationTypeCommand(TENANT, USER, { id: 'ct-1', name: 'New Name' } as never),
      );

      expect(certTypeRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ct-1', name: 'New Name', code: 'DIVE-1', updatedBy: USER }),
      );
    });

    it('throws NotFound when the row is absent in the tenant', async () => {
      certTypeRepo.findOne.mockResolvedValue(null);
      await expect(
        updateCertType.execute(
          new UpdateCertificationTypeCommand(TENANT, USER, { id: 'missing' } as never),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('scopes the lookup to the calling tenant (no cross-tenant update)', async () => {
      certTypeRepo.findOne.mockResolvedValue({ id: 'ct-1', tenantId: TENANT } as CertificationType);
      await updateCertType.execute(
        new UpdateCertificationTypeCommand(TENANT, USER, { id: 'ct-1', name: 'X' } as never),
      );
      expect(certTypeRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'ct-1', tenantId: TENANT }) }),
      );
    });
  });

  // ------------------------------------------------------------------
  describe('CreateTrainingCourseHandler', () => {
    const input = {
      code: 'WQ-101',
      name: 'Water Quality',
      trainingType: TrainingType.ONLINE,
      level: TrainingLevel.BEGINNER,
      durationMinutes: 90,
    };

    it('creates a course stamped with tenant + audit user', async () => {
      courseRepo.findOne.mockResolvedValue(null);
      const result = await createCourse.execute(
        new CreateTrainingCourseCommand(TENANT, USER, input as never),
      );
      expect(courseRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'WQ-101', tenantId: TENANT, createdBy: USER }),
      );
      expect(result.tenantId).toBe(TENANT);
    });

    it('rejects a duplicate per-tenant code (409)', async () => {
      courseRepo.findOne.mockResolvedValue({ id: 'existing' } as TrainingCourse);
      await expect(
        createCourse.execute(new CreateTrainingCourseCommand(TENANT, USER, input as never)),
      ).rejects.toThrow(ConflictException);
      expect(courseRepo.save).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  describe('UpdateTrainingCourseHandler', () => {
    it('applies a partial patch and stamps updatedBy', async () => {
      courseRepo.findOne.mockResolvedValue({
        id: 'tc-1',
        tenantId: TENANT,
        code: 'WQ-101',
        name: 'Old',
        isActive: true,
        isDeleted: false,
      } as TrainingCourse);

      await updateCourse.execute(
        new UpdateTrainingCourseCommand(TENANT, USER, { id: 'tc-1', isActive: false } as never),
      );

      expect(courseRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tc-1', isActive: false, code: 'WQ-101', updatedBy: USER }),
      );
    });

    it('throws NotFound when the course is absent in the tenant', async () => {
      courseRepo.findOne.mockResolvedValue(null);
      await expect(
        updateCourse.execute(new UpdateTrainingCourseCommand(TENANT, USER, { id: 'missing' } as never)),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
