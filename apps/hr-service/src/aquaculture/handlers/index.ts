export { CreateWorkAreaHandler } from './create-work-area.handler';
export { UpdateWorkAreaHandler } from './update-work-area.handler';
export { DeactivateWorkAreaHandler } from './deactivate-work-area.handler';
export { CreateWorkRotationHandler } from './create-work-rotation.handler';
export { UpdateWorkRotationHandler } from './update-work-rotation.handler';
export { StartRotationHandler } from './start-rotation.handler';
export { EndRotationHandler } from './end-rotation.handler';
export { CancelRotationHandler } from './cancel-rotation.handler';
export { ApproveRotationHandler } from './approve-rotation.handler';
export { CreateSafetyTrainingRecordHandler } from './create-safety-training-record.handler';
export { ConfirmSafetyTrainingAttendanceHandler } from './confirm-safety-training-attendance.handler';

import { CreateWorkAreaHandler } from './create-work-area.handler';
import { UpdateWorkAreaHandler } from './update-work-area.handler';
import { DeactivateWorkAreaHandler } from './deactivate-work-area.handler';
import { CreateWorkRotationHandler } from './create-work-rotation.handler';
import { UpdateWorkRotationHandler } from './update-work-rotation.handler';
import { StartRotationHandler } from './start-rotation.handler';
import { EndRotationHandler } from './end-rotation.handler';
import { CancelRotationHandler } from './cancel-rotation.handler';
import { ApproveRotationHandler } from './approve-rotation.handler';
import { CreateSafetyTrainingRecordHandler } from './create-safety-training-record.handler';
import { ConfirmSafetyTrainingAttendanceHandler } from './confirm-safety-training-attendance.handler';

export const AquacultureCommandHandlers = [
  CreateWorkAreaHandler,
  UpdateWorkAreaHandler,
  DeactivateWorkAreaHandler,
  CreateWorkRotationHandler,
  UpdateWorkRotationHandler,
  StartRotationHandler,
  EndRotationHandler,
  CancelRotationHandler,
  ApproveRotationHandler,
  CreateSafetyTrainingRecordHandler,
  ConfirmSafetyTrainingAttendanceHandler,
];
