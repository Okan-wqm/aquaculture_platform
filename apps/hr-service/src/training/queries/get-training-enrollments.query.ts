import { EnrollmentStatus } from '../entities/training-enrollment.entity';

export class GetTrainingEnrollmentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    public readonly trainingCourseId?: string,
    public readonly status?: EnrollmentStatus,
    public readonly limit: number = 20,
    public readonly page: number = 1,
  ) {}
}
