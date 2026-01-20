export * from './add-employee-certification.handler';
export * from './verify-certification.handler';
export * from './revoke-certification.handler';
export * from './enroll-in-training.handler';
export * from './complete-training.handler';

import { AddEmployeeCertificationHandler } from './add-employee-certification.handler';
import { VerifyCertificationHandler } from './verify-certification.handler';
import { RevokeCertificationHandler } from './revoke-certification.handler';
import { EnrollInTrainingHandler } from './enroll-in-training.handler';
import { CompleteTrainingHandler } from './complete-training.handler';

export const TrainingCommandHandlers = [
  AddEmployeeCertificationHandler,
  VerifyCertificationHandler,
  RevokeCertificationHandler,
  EnrollInTrainingHandler,
  CompleteTrainingHandler,
];
