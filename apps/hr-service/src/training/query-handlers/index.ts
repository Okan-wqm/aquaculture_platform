export * from './get-certification-types.handler';
export * from './get-employee-certifications.handler';
export * from './get-expiring-certifications.handler';
export * from './get-training-courses.handler';
export * from './get-training-enrollments.handler';

import { GetCertificationTypesHandler } from './get-certification-types.handler';
import { GetEmployeeCertificationsHandler } from './get-employee-certifications.handler';
import { GetExpiringCertificationsHandler } from './get-expiring-certifications.handler';
import { GetTrainingCoursesHandler } from './get-training-courses.handler';
import { GetTrainingEnrollmentsHandler } from './get-training-enrollments.handler';

export const TrainingQueryHandlers = [
  GetCertificationTypesHandler,
  GetEmployeeCertificationsHandler,
  GetExpiringCertificationsHandler,
  GetTrainingCoursesHandler,
  GetTrainingEnrollmentsHandler,
];
