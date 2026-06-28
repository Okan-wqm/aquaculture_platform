/**
 * GetTrainingCalendar query-handler tests.
 *
 * Covers the training-calendar read path: scheduled sessions over a date range,
 * with derived enrolledCount / availableSlots and resolved courseName. London-school:
 * repositories (and their query builders) are mocked collaborators. Happy path +
 * date-range validation + tenant-scoping + optional workArea filter.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GetTrainingCalendarHandler } from '../query-handlers/get-training-calendar.handler';
import { GetTrainingCalendarQuery } from '../queries/get-training-calendar.query';

import {
  TrainingSession,
  TrainingSessionStatus,
} from '../entities/training-session.entity';
import { TrainingCourse } from '../entities/training-course.entity';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';
import { WorkArea } from '../../aquaculture/entities/work-area.entity';

const TENANT = 'tenant-aquafarm-001';

function makeRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };
}

/** Minimal chainable query-builder returning the supplied rows from getMany(). */
function makeQb(rows: unknown[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'addOrderBy']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

function session(overrides: Partial<TrainingSession> = {}): TrainingSession {
  const s = new TrainingSession();
  Object.assign(
    s,
    {
      id: 'ses-1',
      tenantId: TENANT,
      trainingCourseId: 'tc-1',
      sessionDate: new Date('2026-07-10'),
      startTime: '09:00',
      endTime: '12:00',
      location: 'Room A',
      instructor: 'Dr. Smith',
      maxParticipants: 10,
      status: TrainingSessionStatus.SCHEDULED,
      isDeleted: false,
    },
    overrides,
  );
  return s;
}

describe('GetTrainingCalendarHandler', () => {
  let sessionRepo: ReturnType<typeof makeRepo>;
  let courseRepo: ReturnType<typeof makeRepo>;
  let enrollmentRepo: ReturnType<typeof makeRepo>;
  let workAreaRepo: ReturnType<typeof makeRepo>;
  let handler: GetTrainingCalendarHandler;

  beforeEach(async () => {
    sessionRepo = makeRepo();
    courseRepo = makeRepo();
    enrollmentRepo = makeRepo();
    workAreaRepo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetTrainingCalendarHandler,
        { provide: getRepositoryToken(TrainingSession), useValue: sessionRepo },
        { provide: getRepositoryToken(TrainingCourse), useValue: courseRepo },
        { provide: getRepositoryToken(TrainingEnrollment), useValue: enrollmentRepo },
        { provide: getRepositoryToken(WorkArea), useValue: workAreaRepo },
      ],
    }).compile();
    handler = module.get(GetTrainingCalendarHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns sessions over the range with enrolledCount, availableSlots and courseName', async () => {
    sessionRepo.createQueryBuilder.mockReturnValue(makeQb([session()]));
    courseRepo.find.mockResolvedValue([{ id: 'tc-1', name: 'Water Quality' } as TrainingCourse]);
    // 3 active enrolments reference the session; 1 withdrawn (excluded).
    enrollmentRepo.find.mockResolvedValue([
      { sessionId: 'ses-1', status: EnrollmentStatus.ENROLLED } as TrainingEnrollment,
      { sessionId: 'ses-1', status: EnrollmentStatus.IN_PROGRESS } as TrainingEnrollment,
      { sessionId: 'ses-1', status: EnrollmentStatus.COMPLETED } as TrainingEnrollment,
      { sessionId: 'ses-1', status: EnrollmentStatus.WITHDRAWN } as TrainingEnrollment,
    ]);

    const result = await handler.execute(
      new GetTrainingCalendarQuery(TENANT, '2026-07-01', '2026-07-31'),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.courseName).toBe('Water Quality');
    expect(result[0]!.courseId).toBe('tc-1');
    expect(result[0]!.enrolledCount).toBe(3);
    expect(result[0]!.availableSlots).toBe(7); // 10 cap - 3 enrolled
  });

  it('rejects an inverted date range (start after end)', async () => {
    await expect(
      handler.execute(new GetTrainingCalendarQuery(TENANT, '2026-08-01', '2026-07-01')),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an invalid date', async () => {
    await expect(
      handler.execute(new GetTrainingCalendarQuery(TENANT, 'not-a-date', '2026-07-31')),
    ).rejects.toThrow(BadRequestException);
  });

  it('scopes the session query to the calling tenant', async () => {
    const qb = makeQb([]);
    sessionRepo.createQueryBuilder.mockReturnValue(qb);
    await handler.execute(new GetTrainingCalendarQuery(TENANT, '2026-07-01', '2026-07-31'));
    expect(qb.where).toHaveBeenCalledWith('ts.tenantId = :tenantId', { tenantId: TENANT });
  });

  it('returns [] when the optional work area requires no certifications', async () => {
    workAreaRepo.findOne.mockResolvedValue({
      id: 'wa-1',
      tenantId: TENANT,
      requiredCertifications: [] as string[],
      isDeleted: false,
    } as WorkArea);
    const result = await handler.execute(
      new GetTrainingCalendarQuery(TENANT, '2026-07-01', '2026-07-31', undefined, 'wa-1'),
    );
    expect(result).toEqual([]);
    expect(sessionRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown work area filter', async () => {
    workAreaRepo.findOne.mockResolvedValue(null);
    await expect(
      handler.execute(
        new GetTrainingCalendarQuery(TENANT, '2026-07-01', '2026-07-31', undefined, 'missing'),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('leaves availableSlots undefined when the session has no capacity cap', async () => {
    sessionRepo.createQueryBuilder.mockReturnValue(
      makeQb([session({ maxParticipants: undefined })]),
    );
    courseRepo.find.mockResolvedValue([{ id: 'tc-1', name: 'WQ' } as TrainingCourse]);
    enrollmentRepo.find.mockResolvedValue([]);
    const result = await handler.execute(
      new GetTrainingCalendarQuery(TENANT, '2026-07-01', '2026-07-31'),
    );
    expect(result[0]!.availableSlots).toBeUndefined();
    expect(result[0]!.enrolledCount).toBe(0);
  });
});
