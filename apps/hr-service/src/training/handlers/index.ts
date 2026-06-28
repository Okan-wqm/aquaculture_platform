export * from './add-employee-certification.handler';
export * from './verify-certification.handler';
export * from './revoke-certification.handler';
export * from './enroll-in-training.handler';
export * from './complete-training.handler';
export * from './create-certification-type.handler';
export * from './update-certification-type.handler';
export * from './create-training-course.handler';
export * from './update-training-course.handler';
export * from './renew-certification.handler';
export * from './start-training.handler';
export * from './withdraw-from-training.handler';
export * from './bulk-enroll-in-training.handler';

import { AddEmployeeCertificationHandler } from './add-employee-certification.handler';
import { VerifyCertificationHandler } from './verify-certification.handler';
import { RevokeCertificationHandler } from './revoke-certification.handler';
import { EnrollInTrainingHandler } from './enroll-in-training.handler';
import { CompleteTrainingHandler } from './complete-training.handler';
import { CreateCertificationTypeHandler } from './create-certification-type.handler';
import { UpdateCertificationTypeHandler } from './update-certification-type.handler';
import { CreateTrainingCourseHandler } from './create-training-course.handler';
import { UpdateTrainingCourseHandler } from './update-training-course.handler';
import { RenewCertificationHandler } from './renew-certification.handler';
import { StartTrainingHandler } from './start-training.handler';
import { WithdrawFromTrainingHandler } from './withdraw-from-training.handler';
import { BulkEnrollInTrainingHandler } from './bulk-enroll-in-training.handler';

export const TrainingCommandHandlers = [
  AddEmployeeCertificationHandler,
  VerifyCertificationHandler,
  RevokeCertificationHandler,
  EnrollInTrainingHandler,
  CompleteTrainingHandler,
  CreateCertificationTypeHandler,
  UpdateCertificationTypeHandler,
  CreateTrainingCourseHandler,
  UpdateTrainingCourseHandler,
  RenewCertificationHandler,
  StartTrainingHandler,
  WithdrawFromTrainingHandler,
  BulkEnrollInTrainingHandler,
];
