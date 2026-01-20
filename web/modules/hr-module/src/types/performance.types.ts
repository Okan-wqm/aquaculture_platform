/**
 * Performance Management domain types
 */

import type { BaseEntity, PaginatedResponse } from './common.types';
import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

export enum ReviewPeriodType {
  ANNUAL = 'annual',
  SEMI_ANNUAL = 'semi_annual',
  QUARTERLY = 'quarterly',
  PROBATION = 'probation',
  PROJECT = 'project',
}

export enum ReviewStatus {
  DRAFT = 'draft',
  SELF_ASSESSMENT = 'self_assessment',
  MANAGER_REVIEW = 'manager_review',
  CALIBRATION = 'calibration',
  FINALIZED = 'finalized',
  ACKNOWLEDGED = 'acknowledged',
}

export enum GoalStatus {
  NOT_STARTED = 'not_started',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  DEFERRED = 'deferred',
}

export enum GoalPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum RatingScale {
  EXCEEDS_EXPECTATIONS = 5,
  MEETS_EXPECTATIONS = 4,
  PARTIALLY_MEETS = 3,
  NEEDS_IMPROVEMENT = 2,
  UNSATISFACTORY = 1,
}

// =====================
// Interfaces
// =====================

export interface CompetencyRating {
  competencyId: string;
  competencyName: string;
  selfRating?: number;
  managerRating?: number;
  finalRating?: number;
  comments?: string;
}

export interface PerformanceReview extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  reviewerId: string;
  reviewer?: Employee;
  periodType: ReviewPeriodType;
  periodStart: string;
  periodEnd: string;
  status: ReviewStatus;
  selfAssessment?: string;
  selfRating?: number;
  managerAssessment?: string;
  managerRating?: number;
  finalRating?: number;
  competencyRatings?: CompetencyRating[];
  strengths?: string[];
  areasForImprovement?: string[];
  developmentPlan?: string;
  employeeComments?: string;
  reviewerComments?: string;
  calibrationNotes?: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  finalizedBy?: string;
  finalizedAt?: string;
}

export interface Goal extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  title: string;
  description?: string;
  category?: string;
  priority: GoalPriority;
  status: GoalStatus;
  startDate: string;
  targetDate: string;
  completedDate?: string;
  progressPercent: number;
  keyResults?: KeyResult[];
  alignedReviewId?: string;
  parentGoalId?: string;
  parentGoal?: Goal;
  milestones?: GoalMilestone[];
}

export interface KeyResult {
  id: string;
  description: string;
  targetValue: number;
  currentValue: number;
  unit?: string;
  isCompleted: boolean;
}

export interface GoalMilestone {
  id: string;
  title: string;
  targetDate: string;
  completedDate?: string;
  isCompleted: boolean;
}

export interface EmployeeKPI extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  name: string;
  description?: string;
  category: string;
  targetValue: number;
  currentValue: number;
  unit?: string;
  periodStart: string;
  periodEnd: string;
  weight: number;
  achievementPercent: number;
}

export interface PerformanceSummary {
  employeeId: string;
  employee?: Employee;
  currentReview?: PerformanceReview;
  previousReview?: PerformanceReview;
  activeGoals: number;
  completedGoals: number;
  overdueGoals: number;
  averageGoalProgress: number;
  kpiAchievement: number;
  ratingTrend: 'improving' | 'stable' | 'declining';
}

export interface TeamPerformanceOverview {
  departmentId: string;
  departmentName: string;
  totalEmployees: number;
  reviewsCompleted: number;
  reviewsPending: number;
  averageRating: number;
  topPerformers: { employee: Employee; rating: number }[];
  needsAttention: { employee: Employee; rating: number }[];
}

// =====================
// Input Types
// =====================

export interface CreatePerformanceReviewInput {
  employeeId: string;
  reviewerId: string;
  periodType: ReviewPeriodType;
  periodStart: string;
  periodEnd: string;
}

export interface SubmitSelfAssessmentInput {
  reviewId: string;
  selfAssessment: string;
  selfRating: number;
  competencyRatings?: { competencyId: string; rating: number; comments?: string }[];
}

export interface SubmitManagerAssessmentInput {
  reviewId: string;
  managerAssessment: string;
  managerRating: number;
  competencyRatings?: { competencyId: string; rating: number; comments?: string }[];
  strengths?: string[];
  areasForImprovement?: string[];
  developmentPlan?: string;
}

export interface FinalizeReviewInput {
  reviewId: string;
  finalRating: number;
  calibrationNotes?: string;
  reviewerComments?: string;
}

export interface CreateGoalInput {
  employeeId: string;
  title: string;
  description?: string;
  category?: string;
  priority: GoalPriority;
  startDate: string;
  targetDate: string;
  keyResults?: Omit<KeyResult, 'id' | 'isCompleted'>[];
  alignedReviewId?: string;
  parentGoalId?: string;
}

export interface UpdateGoalInput {
  id: string;
  title?: string;
  description?: string;
  priority?: GoalPriority;
  targetDate?: string;
  status?: GoalStatus;
}

export interface UpdateGoalProgressInput {
  goalId: string;
  progressPercent: number;
  keyResultUpdates?: { id: string; currentValue: number }[];
  notes?: string;
}

export interface PerformanceReviewFilterInput {
  employeeId?: string;
  reviewerId?: string;
  periodType?: ReviewPeriodType;
  status?: ReviewStatus;
  periodStart?: string;
  periodEnd?: string;
}

export interface GoalFilterInput {
  employeeId?: string;
  status?: GoalStatus;
  priority?: GoalPriority;
  category?: string;
  startDate?: string;
  endDate?: string;
}

// =====================
// Response Types
// =====================

export type PerformanceReviewConnection = PaginatedResponse<PerformanceReview>;
export type GoalConnection = PaginatedResponse<Goal>;
export type EmployeeKPIConnection = PaginatedResponse<EmployeeKPI>;

// =====================
// Display Helpers
// =====================

export const REVIEW_STATUS_CONFIG: Record<ReviewStatus, { label: string; variant: string }> = {
  [ReviewStatus.DRAFT]: { label: 'Draft', variant: 'default' },
  [ReviewStatus.SELF_ASSESSMENT]: { label: 'Self Assessment', variant: 'info' },
  [ReviewStatus.MANAGER_REVIEW]: { label: 'Manager Review', variant: 'warning' },
  [ReviewStatus.CALIBRATION]: { label: 'Calibration', variant: 'warning' },
  [ReviewStatus.FINALIZED]: { label: 'Finalized', variant: 'success' },
  [ReviewStatus.ACKNOWLEDGED]: { label: 'Acknowledged', variant: 'success' },
};

export const GOAL_STATUS_CONFIG: Record<GoalStatus, { label: string; variant: string }> = {
  [GoalStatus.NOT_STARTED]: { label: 'Not Started', variant: 'default' },
  [GoalStatus.IN_PROGRESS]: { label: 'In Progress', variant: 'warning' },
  [GoalStatus.COMPLETED]: { label: 'Completed', variant: 'success' },
  [GoalStatus.CANCELLED]: { label: 'Cancelled', variant: 'default' },
  [GoalStatus.DEFERRED]: { label: 'Deferred', variant: 'info' },
};

export const GOAL_PRIORITY_CONFIG: Record<GoalPriority, { label: string; variant: string }> = {
  [GoalPriority.LOW]: { label: 'Low', variant: 'default' },
  [GoalPriority.MEDIUM]: { label: 'Medium', variant: 'info' },
  [GoalPriority.HIGH]: { label: 'High', variant: 'warning' },
  [GoalPriority.CRITICAL]: { label: 'Critical', variant: 'error' },
};

export const REVIEW_PERIOD_TYPE_LABELS: Record<ReviewPeriodType, string> = {
  [ReviewPeriodType.ANNUAL]: 'Annual Review',
  [ReviewPeriodType.SEMI_ANNUAL]: 'Semi-Annual Review',
  [ReviewPeriodType.QUARTERLY]: 'Quarterly Review',
  [ReviewPeriodType.PROBATION]: 'Probation Review',
  [ReviewPeriodType.PROJECT]: 'Project Review',
};

export const RATING_SCALE_CONFIG: Record<RatingScale, { label: string; description: string }> = {
  [RatingScale.EXCEEDS_EXPECTATIONS]: {
    label: 'Exceeds Expectations',
    description: 'Consistently delivers exceptional results beyond requirements',
  },
  [RatingScale.MEETS_EXPECTATIONS]: {
    label: 'Meets Expectations',
    description: 'Fully meets all job requirements and expectations',
  },
  [RatingScale.PARTIALLY_MEETS]: {
    label: 'Partially Meets',
    description: 'Meets some expectations but has room for improvement',
  },
  [RatingScale.NEEDS_IMPROVEMENT]: {
    label: 'Needs Improvement',
    description: 'Performance falls short of expectations',
  },
  [RatingScale.UNSATISFACTORY]: {
    label: 'Unsatisfactory',
    description: 'Performance is below acceptable standards',
  },
};

/**
 * Get rating color based on value
 */
export function getRatingColor(rating: number): string {
  if (rating >= 4.5) return 'green';
  if (rating >= 3.5) return 'blue';
  if (rating >= 2.5) return 'yellow';
  if (rating >= 1.5) return 'orange';
  return 'red';
}

/**
 * Calculate goal completion percentage
 */
export function calculateGoalCompletion(goal: Goal): number {
  if (goal.status === GoalStatus.COMPLETED) return 100;
  if (!goal.keyResults?.length) return goal.progressPercent;

  const completedKeyResults = goal.keyResults.filter((kr) => kr.isCompleted).length;
  return Math.round((completedKeyResults / goal.keyResults.length) * 100);
}
