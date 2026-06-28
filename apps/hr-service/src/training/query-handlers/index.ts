export * from './get-certification-types.handler';
export * from './get-employee-certifications.handler';
export * from './get-expiring-certifications.handler';
export * from './get-expired-certifications.handler';
export * from './get-all-certifications.handler';
export * from './get-training-courses.handler';
export * from './get-training-enrollments.handler';
export * from './get-certification-type.handler';
export * from './get-training-course.handler';
export * from './get-employee-certification-status.handler';
export * from './get-certification-compliance-report.handler';
export * from './get-certifications-for-work-area.handler';
export * from './get-mandatory-training-status.handler';
export * from './get-training-calendar.handler';

import { GetCertificationTypesHandler } from './get-certification-types.handler';
import { GetEmployeeCertificationsHandler } from './get-employee-certifications.handler';
import { GetExpiringCertificationsHandler } from './get-expiring-certifications.handler';
import { GetExpiredCertificationsHandler } from './get-expired-certifications.handler';
import { GetAllCertificationsHandler } from './get-all-certifications.handler';
import { GetTrainingCoursesHandler } from './get-training-courses.handler';
import { GetTrainingEnrollmentsHandler } from './get-training-enrollments.handler';
import { GetCertificationTypeHandler } from './get-certification-type.handler';
import { GetTrainingCourseHandler } from './get-training-course.handler';
import { GetEmployeeCertificationStatusHandler } from './get-employee-certification-status.handler';
import { GetCertificationComplianceReportHandler } from './get-certification-compliance-report.handler';
import { GetCertificationsForWorkAreaHandler } from './get-certifications-for-work-area.handler';
import { GetMandatoryTrainingStatusHandler } from './get-mandatory-training-status.handler';
import { GetTrainingCalendarHandler } from './get-training-calendar.handler';

export const TrainingQueryHandlers = [
  GetCertificationTypesHandler,
  GetEmployeeCertificationsHandler,
  GetExpiringCertificationsHandler,
  GetExpiredCertificationsHandler,
  GetAllCertificationsHandler,
  GetTrainingCoursesHandler,
  GetTrainingEnrollmentsHandler,
  GetCertificationTypeHandler,
  GetTrainingCourseHandler,
  GetEmployeeCertificationStatusHandler,
  GetCertificationComplianceReportHandler,
  GetCertificationsForWorkAreaHandler,
  GetMandatoryTrainingStatusHandler,
  GetTrainingCalendarHandler,
];
