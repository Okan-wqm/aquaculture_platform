/**
 * TrainingResolver self-service operations (HR-HIGH-056).
 *
 * The auth user id (JWT `sub`) and the HR employee id are two different uuids, linked only by
 * `Employee.userId`. `myCertifications` and `myTrainingEnrollments` used to hand the `sub` to
 * queries that compare it with `employeeId`, so they never matched a row. Every self-service
 * operation now bridges the viewer to their employee record once (`findViewerEmployee`) and acts
 * on that employee's id; a viewer with no employee record has no certifications or enrollments,
 * and is never answered with a tenant-wide list.
 *
 * London-school: the buses and the employee repository are doubles; nothing here touches a DB.
 */
import { NotFoundException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { collaborator, stub } from '@aquaculture/testing';
import { createPaginatedQueryResult } from '@platform/cqrs';
import type { EntityManager, Repository } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { StartTrainingCommand } from '../commands/start-training.command';
import { WithdrawFromTrainingCommand } from '../commands/withdraw-from-training.command';
import {
  EmployeeCertification,
  CertificationStatus,
} from '../entities/employee-certification.entity';
import { EnrollmentStatus, TrainingEnrollment } from '../entities/training-enrollment.entity';
import { GetEmployeeCertificationsQuery } from '../queries/get-employee-certifications.query';
import { GetTrainingEnrollmentsQuery } from '../queries/get-training-enrollments.query';
import { TrainingResolver } from '../training.resolver';

const TENANT_ID = 'tenant-aquafarm-001';
// Deliberately two different uuids: the auth user and the HR employee they are linked to.
const USER_ID = '6f1c1a7e-2b0d-4f55-9a43-0d6f3b8c1e21';
const EMPLOYEE_ID = 'c3a9d8f4-77be-4c0e-8f1a-5e2b9d4a6c10';
const ENROLLMENT_ID = '9b2e4d60-1c3f-4a8b-b7d5-3f6a0e8c2d14';

const context = { req: { user: { sub: USER_ID, tenantId: TENANT_ID } } };

describe('TrainingResolver self-service operations', () => {
  let commandBus: { execute: jest.Mock };
  let queryBus: { execute: jest.Mock };
  let managerFindOne: jest.Mock;
  let resolver: TrainingResolver;

  beforeEach(() => {
    commandBus = { execute: jest.fn() };
    queryBus = { execute: jest.fn() };
    managerFindOne = jest.fn();
    const manager = collaborator<EntityManager>({ findOne: managerFindOne }, 'EntityManager');
    resolver = new TrainingResolver(
      collaborator<CommandBus>(commandBus, 'CommandBus'),
      collaborator<QueryBus>(queryBus, 'QueryBus'),
      collaborator<Repository<Employee>>({ manager }, 'Repository<Employee>'),
    );
  });

  function viewerHasEmployeeRecord(): void {
    managerFindOne.mockResolvedValue(stub<Employee>({ id: EMPLOYEE_ID, departmentHrId: null }));
  }

  function viewerHasNoEmployeeRecord(): void {
    managerFindOne.mockResolvedValue(null);
  }

  function lookedUpByUserIdWithinTheTenant(): void {
    expect(managerFindOne).toHaveBeenCalledWith(
      Employee,
      expect.objectContaining({
        where: { userId: USER_ID, tenantId: TENANT_ID, isDeleted: false },
      }),
    );
  }

  describe('myCertifications', () => {
    it('queries by the viewer employee id, never by the auth user id', async () => {
      viewerHasEmployeeRecord();
      const certifications = [stub<EmployeeCertification>({ id: 'cert-1' })];
      queryBus.execute.mockResolvedValue(certifications);

      const result = await resolver.getMyCertifications(context, CertificationStatus.ACTIVE);

      lookedUpByUserIdWithinTheTenant();
      expect(queryBus.execute).toHaveBeenCalledTimes(1);
      const [query] = queryBus.execute.mock.calls[0];
      expect(query).toBeInstanceOf(GetEmployeeCertificationsQuery);
      expect(query).toEqual(
        new GetEmployeeCertificationsQuery(TENANT_ID, EMPLOYEE_ID, CertificationStatus.ACTIVE),
      );
      expect(query.employeeId).not.toBe(USER_ID);
      expect(result).toBe(certifications);
    });

    it('answers a viewer with no employee record with an empty list and runs no query', async () => {
      viewerHasNoEmployeeRecord();

      const result = await resolver.getMyCertifications(context);

      lookedUpByUserIdWithinTheTenant();
      expect(result).toEqual([]);
      expect(queryBus.execute).not.toHaveBeenCalled();
    });
  });

  describe('myTrainingEnrollments', () => {
    it('queries by the viewer employee id, never by the auth user id', async () => {
      viewerHasEmployeeRecord();
      const enrollments = [stub<TrainingEnrollment>({ id: ENROLLMENT_ID })];
      queryBus.execute.mockResolvedValue(createPaginatedQueryResult(enrollments, 2, 5, 6));

      const result = await resolver.getMyTrainingEnrollments(
        context,
        EnrollmentStatus.ENROLLED,
        5,
        2,
      );

      lookedUpByUserIdWithinTheTenant();
      expect(queryBus.execute).toHaveBeenCalledTimes(1);
      const [query] = queryBus.execute.mock.calls[0];
      expect(query).toBeInstanceOf(GetTrainingEnrollmentsQuery);
      expect(query).toEqual(
        new GetTrainingEnrollmentsQuery(
          TENANT_ID,
          EMPLOYEE_ID,
          undefined,
          EnrollmentStatus.ENROLLED,
          5,
          2,
        ),
      );
      expect(query.employeeId).not.toBe(USER_ID);
      expect(result).toBe(enrollments);
    });

    it('answers a viewer with no employee record with an empty list and runs no query', async () => {
      viewerHasNoEmployeeRecord();

      const result = await resolver.getMyTrainingEnrollments(context);

      lookedUpByUserIdWithinTheTenant();
      expect(result).toEqual([]);
      expect(queryBus.execute).not.toHaveBeenCalled();
    });
  });

  describe('startTraining', () => {
    it('binds the command to the viewer employee id and the auth user id separately', async () => {
      viewerHasEmployeeRecord();
      const started = stub<TrainingEnrollment>({ id: ENROLLMENT_ID });
      commandBus.execute.mockResolvedValue(started);

      const result = await resolver.startTraining(ENROLLMENT_ID, context);

      lookedUpByUserIdWithinTheTenant();
      expect(commandBus.execute).toHaveBeenCalledWith(
        new StartTrainingCommand(TENANT_ID, USER_ID, ENROLLMENT_ID, EMPLOYEE_ID),
      );
      expect(result).toBe(started);
    });

    it('refuses a viewer with no employee record and sends no command', async () => {
      viewerHasNoEmployeeRecord();

      await expect(resolver.startTraining(ENROLLMENT_ID, context)).rejects.toThrow(
        NotFoundException,
      );
      expect(commandBus.execute).not.toHaveBeenCalled();
    });
  });

  describe('withdrawFromTraining', () => {
    it('binds the command to the viewer employee id and the auth user id separately', async () => {
      viewerHasEmployeeRecord();
      const withdrawn = stub<TrainingEnrollment>({ id: ENROLLMENT_ID });
      commandBus.execute.mockResolvedValue(withdrawn);

      const result = await resolver.withdrawFromTraining(ENROLLMENT_ID, context, 'Schedule clash');

      lookedUpByUserIdWithinTheTenant();
      expect(commandBus.execute).toHaveBeenCalledWith(
        new WithdrawFromTrainingCommand(
          TENANT_ID,
          USER_ID,
          ENROLLMENT_ID,
          EMPLOYEE_ID,
          'Schedule clash',
        ),
      );
      expect(result).toBe(withdrawn);
    });

    it('refuses a viewer with no employee record and sends no command', async () => {
      viewerHasNoEmployeeRecord();

      await expect(resolver.withdrawFromTraining(ENROLLMENT_ID, context)).rejects.toThrow(
        NotFoundException,
      );
      expect(commandBus.execute).not.toHaveBeenCalled();
    });
  });
});
