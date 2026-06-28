export * from './create-performance-review.handler';
export * from './bulk-create-reviews.handler';
export * from './submit-self-assessment.handler';
export * from './submit-manager-assessment.handler';
export * from './finalize-review.handler';
export * from './acknowledge-review.handler';
export * from './reopen-review.handler';
export * from './create-goal.handler';
export * from './update-goal.handler';
export * from './update-goal-progress.handler';
export * from './complete-goal.handler';
export * from './cancel-goal.handler';
export * from './defer-goal.handler';
export * from './add-key-result.handler';
export * from './update-key-result.handler';
export * from './add-milestone.handler';
export * from './complete-milestone.handler';

import { CreatePerformanceReviewHandler } from './create-performance-review.handler';
import { BulkCreateReviewsHandler } from './bulk-create-reviews.handler';
import { SubmitSelfAssessmentHandler } from './submit-self-assessment.handler';
import { SubmitManagerAssessmentHandler } from './submit-manager-assessment.handler';
import { FinalizeReviewHandler } from './finalize-review.handler';
import { AcknowledgeReviewHandler } from './acknowledge-review.handler';
import { ReopenReviewHandler } from './reopen-review.handler';
import { CreateGoalHandler } from './create-goal.handler';
import { UpdateGoalHandler } from './update-goal.handler';
import { UpdateGoalProgressHandler } from './update-goal-progress.handler';
import { CompleteGoalHandler } from './complete-goal.handler';
import { CancelGoalHandler } from './cancel-goal.handler';
import { DeferGoalHandler } from './defer-goal.handler';
import { AddKeyResultHandler } from './add-key-result.handler';
import { UpdateKeyResultHandler } from './update-key-result.handler';
import { AddMilestoneHandler } from './add-milestone.handler';
import { CompleteMilestoneHandler } from './complete-milestone.handler';

export const PerformanceCommandHandlers = [
  CreatePerformanceReviewHandler,
  BulkCreateReviewsHandler,
  SubmitSelfAssessmentHandler,
  SubmitManagerAssessmentHandler,
  FinalizeReviewHandler,
  AcknowledgeReviewHandler,
  ReopenReviewHandler,
  CreateGoalHandler,
  UpdateGoalHandler,
  UpdateGoalProgressHandler,
  CompleteGoalHandler,
  CancelGoalHandler,
  DeferGoalHandler,
  AddKeyResultHandler,
  UpdateKeyResultHandler,
  AddMilestoneHandler,
  CompleteMilestoneHandler,
];
