/**
 * Performance Management GraphQL Operations
 */

import { gql } from 'graphql-tag';
import {
  PERFORMANCE_REVIEW_FRAGMENT,
  GOAL_FRAGMENT,
  EMPLOYEE_BASIC_FRAGMENT,
} from './fragments';

// =====================
// Performance Review Queries
// =====================

export const GET_PERFORMANCE_REVIEWS = gql`
  query GetPerformanceReviews(
    $filter: PerformanceReviewFilterInput
    $pagination: PaginationInput
  ) {
    performanceReviews(filter: $filter, pagination: $pagination) {
      items {
        ...PerformanceReviewFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const GET_PERFORMANCE_REVIEW = gql`
  query GetPerformanceReview($id: ID!) {
    performanceReview(id: $id) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const GET_MY_PERFORMANCE_REVIEWS = gql`
  query GetMyPerformanceReviews($filter: PerformanceReviewFilterInput) {
    myPerformanceReviews(filter: $filter) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const GET_PENDING_REVIEWS = gql`
  query GetPendingReviews($reviewerId: ID!) {
    pendingReviews(reviewerId: $reviewerId) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const GET_TEAM_PERFORMANCE_OVERVIEW = gql`
  query GetTeamPerformanceOverview($departmentId: ID!) {
    teamPerformanceOverview(departmentId: $departmentId) {
      departmentId
      departmentName
      totalEmployees
      reviewsCompleted
      reviewsPending
      averageRating
      topPerformers {
        employee {
          ...EmployeeBasic
        }
        rating
      }
      needsAttention {
        employee {
          ...EmployeeBasic
        }
        rating
      }
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const GET_PERFORMANCE_SUMMARY = gql`
  query GetPerformanceSummary($employeeId: ID!) {
    performanceSummary(employeeId: $employeeId) {
      employeeId
      currentReview {
        id
        status
        periodType
        periodStart
        periodEnd
        finalRating
      }
      previousReview {
        id
        periodType
        periodStart
        periodEnd
        finalRating
      }
      activeGoals
      completedGoals
      overdueGoals
      averageGoalProgress
      kpiAchievement
      ratingTrend
    }
  }
`;

export const GET_REVIEW_CYCLE_STATUS = gql`
  query GetReviewCycleStatus($periodType: ReviewPeriodType!, $year: Int!) {
    reviewCycleStatus(periodType: $periodType, year: $year) {
      totalEmployees
      notStarted
      selfAssessmentPending
      managerReviewPending
      calibrationPending
      finalized
      acknowledged
      completionRate
    }
  }
`;

// =====================
// Goal Queries
// =====================

export const GET_GOALS = gql`
  query GetGoals(
    $filter: GoalFilterInput
    $pagination: PaginationInput
  ) {
    goals(filter: $filter, pagination: $pagination) {
      items {
        ...GoalFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${GOAL_FRAGMENT}
`;

export const GET_GOAL = gql`
  query GetGoal($id: ID!) {
    goal(id: $id) {
      ...GoalFull
      parentGoal {
        id
        title
      }
      childGoals {
        id
        title
        status
        progressPercent
      }
    }
  }
  ${GOAL_FRAGMENT}
`;

export const GET_MY_GOALS = gql`
  query GetMyGoals($filter: GoalFilterInput) {
    myGoals(filter: $filter) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const GET_TEAM_GOALS = gql`
  query GetTeamGoals($managerId: ID!, $filter: GoalFilterInput) {
    teamGoals(managerId: $managerId, filter: $filter) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const GET_OVERDUE_GOALS = gql`
  query GetOverdueGoals($departmentId: ID) {
    overdueGoals(departmentId: $departmentId) {
      ...GoalFull
      daysOverdue
    }
  }
  ${GOAL_FRAGMENT}
`;

export const GET_GOAL_PROGRESS_TREND = gql`
  query GetGoalProgressTrend(
    $employeeId: ID!
    $startDate: String!
    $endDate: String!
  ) {
    goalProgressTrend(
      employeeId: $employeeId
      startDate: $startDate
      endDate: $endDate
    ) {
      date
      totalGoals
      completedGoals
      averageProgress
    }
  }
`;

// =====================
// KPI Queries
// =====================

export const GET_EMPLOYEE_KPIS = gql`
  query GetEmployeeKPIs($employeeId: ID!, $periodStart: String, $periodEnd: String) {
    employeeKPIs(
      employeeId: $employeeId
      periodStart: $periodStart
      periodEnd: $periodEnd
    ) {
      id
      name
      description
      category
      targetValue
      currentValue
      unit
      periodStart
      periodEnd
      weight
      achievementPercent
    }
  }
`;

export const GET_DEPARTMENT_KPIS = gql`
  query GetDepartmentKPIs($departmentId: ID!, $periodStart: String!, $periodEnd: String!) {
    departmentKPIs(
      departmentId: $departmentId
      periodStart: $periodStart
      periodEnd: $periodEnd
    ) {
      category
      averageAchievement
      employees {
        employeeId
        employeeName
        achievement
      }
    }
  }
`;

// =====================
// Performance Review Mutations
// =====================

export const CREATE_PERFORMANCE_REVIEW = gql`
  mutation CreatePerformanceReview($input: CreatePerformanceReviewInput!) {
    createPerformanceReview(input: $input) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const SUBMIT_SELF_ASSESSMENT = gql`
  mutation SubmitSelfAssessment($input: SubmitSelfAssessmentInput!) {
    submitSelfAssessment(input: $input) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const SUBMIT_MANAGER_ASSESSMENT = gql`
  mutation SubmitManagerAssessment($input: SubmitManagerAssessmentInput!) {
    submitManagerAssessment(input: $input) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const FINALIZE_REVIEW = gql`
  mutation FinalizeReview($input: FinalizeReviewInput!) {
    finalizeReview(input: $input) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const ACKNOWLEDGE_REVIEW = gql`
  mutation AcknowledgeReview($reviewId: ID!, $comments: String) {
    acknowledgeReview(reviewId: $reviewId, comments: $comments) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const REOPEN_REVIEW = gql`
  mutation ReopenReview($reviewId: ID!, $reason: String!) {
    reopenReview(reviewId: $reviewId, reason: $reason) {
      ...PerformanceReviewFull
    }
  }
  ${PERFORMANCE_REVIEW_FRAGMENT}
`;

export const BULK_CREATE_REVIEWS = gql`
  mutation BulkCreateReviews($input: BulkCreateReviewsInput!) {
    bulkCreateReviews(input: $input) {
      created
      skipped
      errors
    }
  }
`;

// =====================
// Goal Mutations
// =====================

export const CREATE_GOAL = gql`
  mutation CreateGoal($input: CreateGoalInput!) {
    createGoal(input: $input) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const UPDATE_GOAL = gql`
  mutation UpdateGoal($input: UpdateGoalInput!) {
    updateGoal(input: $input) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const UPDATE_GOAL_PROGRESS = gql`
  mutation UpdateGoalProgress($input: UpdateGoalProgressInput!) {
    updateGoalProgress(input: $input) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const COMPLETE_GOAL = gql`
  mutation CompleteGoal($goalId: ID!, $completionNotes: String) {
    completeGoal(goalId: $goalId, completionNotes: $completionNotes) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const CANCEL_GOAL = gql`
  mutation CancelGoal($goalId: ID!, $reason: String!) {
    cancelGoal(goalId: $goalId, reason: $reason) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const DEFER_GOAL = gql`
  mutation DeferGoal($goalId: ID!, $newTargetDate: String!, $reason: String) {
    deferGoal(goalId: $goalId, newTargetDate: $newTargetDate, reason: $reason) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const ADD_KEY_RESULT = gql`
  mutation AddKeyResult($goalId: ID!, $keyResult: KeyResultInput!) {
    addKeyResult(goalId: $goalId, keyResult: $keyResult) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const UPDATE_KEY_RESULT = gql`
  mutation UpdateKeyResult(
    $goalId: ID!
    $keyResultId: ID!
    $currentValue: Float!
  ) {
    updateKeyResult(
      goalId: $goalId
      keyResultId: $keyResultId
      currentValue: $currentValue
    ) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const ADD_MILESTONE = gql`
  mutation AddMilestone($goalId: ID!, $milestone: MilestoneInput!) {
    addMilestone(goalId: $goalId, milestone: $milestone) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;

export const COMPLETE_MILESTONE = gql`
  mutation CompleteMilestone($goalId: ID!, $milestoneId: ID!) {
    completeMilestone(goalId: $goalId, milestoneId: $milestoneId) {
      ...GoalFull
    }
  }
  ${GOAL_FRAGMENT}
`;
