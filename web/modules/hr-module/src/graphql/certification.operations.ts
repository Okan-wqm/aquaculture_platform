/**
 * Certification & Training GraphQL Operations
 */

import { gql } from 'graphql-tag';
import {
  CERTIFICATION_TYPE_FRAGMENT,
  EMPLOYEE_CERTIFICATION_FRAGMENT,
  TRAINING_COURSE_FRAGMENT,
  TRAINING_ENROLLMENT_FRAGMENT,
} from './fragments';

// =====================
// Certification Queries
// =====================

export const GET_CERTIFICATION_TYPES = gql`
  query GetCertificationTypes($filter: CertificationTypeFilterInput) {
    certificationTypes(filter: $filter) {
      ...CertificationTypeFull
    }
  }
  ${CERTIFICATION_TYPE_FRAGMENT}
`;

export const GET_CERTIFICATION_TYPE = gql`
  query GetCertificationType($id: ID!) {
    certificationType(id: $id) {
      ...CertificationTypeFull
      prerequisites {
        id
        code
        name
      }
    }
  }
  ${CERTIFICATION_TYPE_FRAGMENT}
`;

export const GET_EMPLOYEE_CERTIFICATIONS = gql`
  query GetEmployeeCertifications(
    $employeeId: ID!
    $filter: CertificationFilterInput
  ) {
    employeeCertifications(employeeId: $employeeId, filter: $filter) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const GET_EXPIRING_CERTIFICATIONS = gql`
  query GetExpiringCertifications(
    $daysUntilExpiry: Int!
    $departmentId: ID
  ) {
    expiringCertifications(
      daysUntilExpiry: $daysUntilExpiry
      departmentId: $departmentId
    ) {
      ...EmployeeCertificationFull
      daysUntilExpiry
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const GET_EXPIRED_CERTIFICATIONS = gql`
  query GetExpiredCertifications($departmentId: ID) {
    expiredCertifications(departmentId: $departmentId) {
      ...EmployeeCertificationFull
      daysSinceExpiry
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const GET_CERTIFICATION_COMPLIANCE_REPORT = gql`
  query GetCertificationComplianceReport($departmentId: ID) {
    certificationComplianceReport(departmentId: $departmentId) {
      totalEmployees
      compliantEmployees
      nonCompliantEmployees
      complianceRate
      expiringWithin30Days
      expiringWithin60Days
      expiringWithin90Days
      expiredCount
      byCategory {
        category
        totalRequired
        totalCertified
        complianceRate
        expiringCount
      }
    }
  }
`;

export const GET_EMPLOYEE_CERTIFICATION_STATUS = gql`
  query GetEmployeeCertificationStatus($employeeId: ID!) {
    employeeCertificationStatus(employeeId: $employeeId) {
      isFullyCompliant
      totalRequired
      totalHeld
      expiringSoon {
        certificationTypeId
        certificationTypeName
        expiryDate
        daysUntilExpiry
      }
      missing {
        certificationTypeId
        certificationTypeName
        category
        isMandatory
        requiredForOffshore
      }
    }
  }
`;

export const GET_CERTIFICATIONS_FOR_WORK_AREA = gql`
  query GetCertificationsForWorkArea($workAreaId: ID!) {
    certificationsForWorkArea(workAreaId: $workAreaId) {
      ...CertificationTypeFull
    }
  }
  ${CERTIFICATION_TYPE_FRAGMENT}
`;

// =====================
// Training Queries
// =====================

export const GET_TRAINING_COURSES = gql`
  query GetTrainingCourses($filter: TrainingCourseFilterInput) {
    trainingCourses(filter: $filter) {
      ...TrainingCourseFull
    }
  }
  ${TRAINING_COURSE_FRAGMENT}
`;

export const GET_TRAINING_COURSE = gql`
  query GetTrainingCourse($id: ID!) {
    trainingCourse(id: $id) {
      ...TrainingCourseFull
      prerequisites {
        id
        code
        name
      }
      certificationType {
        id
        code
        name
      }
      enrollmentCount
      completionRate
    }
  }
  ${TRAINING_COURSE_FRAGMENT}
`;

export const GET_TRAINING_ENROLLMENTS = gql`
  query GetTrainingEnrollments(
    $filter: TrainingEnrollmentFilterInput
    $pagination: PaginationInput
  ) {
    trainingEnrollments(filter: $filter, pagination: $pagination) {
      items {
        ...TrainingEnrollmentFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

export const GET_MY_TRAINING_ENROLLMENTS = gql`
  query GetMyTrainingEnrollments($filter: TrainingEnrollmentFilterInput) {
    myTrainingEnrollments(filter: $filter) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

export const GET_MANDATORY_TRAINING_STATUS = gql`
  query GetMandatoryTrainingStatus($employeeId: ID!) {
    mandatoryTrainingStatus(employeeId: $employeeId) {
      courseId
      courseName
      isMandatory
      status
      completedAt
      dueDate
      daysOverdue
    }
  }
`;

export const GET_TRAINING_CALENDAR = gql`
  query GetTrainingCalendar($startDate: String!, $endDate: String!) {
    trainingCalendar(startDate: $startDate, endDate: $endDate) {
      id
      courseId
      courseName
      sessionDate
      startTime
      endTime
      location
      instructor
      enrolledCount
      maxParticipants
      availableSlots
    }
  }
`;

// =====================
// Certification Mutations
// =====================

export const CREATE_CERTIFICATION_TYPE = gql`
  mutation CreateCertificationType($input: CreateCertificationTypeInput!) {
    createCertificationType(input: $input) {
      ...CertificationTypeFull
    }
  }
  ${CERTIFICATION_TYPE_FRAGMENT}
`;

export const UPDATE_CERTIFICATION_TYPE = gql`
  mutation UpdateCertificationType($input: UpdateCertificationTypeInput!) {
    updateCertificationType(input: $input) {
      ...CertificationTypeFull
    }
  }
  ${CERTIFICATION_TYPE_FRAGMENT}
`;

export const ADD_EMPLOYEE_CERTIFICATION = gql`
  mutation AddEmployeeCertification($input: AddEmployeeCertificationInput!) {
    addEmployeeCertification(input: $input) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const UPDATE_EMPLOYEE_CERTIFICATION = gql`
  mutation UpdateEmployeeCertification($input: UpdateEmployeeCertificationInput!) {
    updateEmployeeCertification(input: $input) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const VERIFY_CERTIFICATION = gql`
  mutation VerifyCertification($input: VerifyCertificationInput!) {
    verifyCertification(input: $input) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const REVOKE_CERTIFICATION = gql`
  mutation RevokeCertification($input: RevokeCertificationInput!) {
    revokeCertification(input: $input) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const RENEW_CERTIFICATION = gql`
  mutation RenewCertification(
    $certificationId: ID!
    $newExpiryDate: String!
    $certificateNumber: String
    $attachmentUrl: String
  ) {
    renewCertification(
      certificationId: $certificationId
      newExpiryDate: $newExpiryDate
      certificateNumber: $certificateNumber
      attachmentUrl: $attachmentUrl
    ) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

// =====================
// Training Mutations
// =====================

export const CREATE_TRAINING_COURSE = gql`
  mutation CreateTrainingCourse($input: CreateTrainingCourseInput!) {
    createTrainingCourse(input: $input) {
      ...TrainingCourseFull
    }
  }
  ${TRAINING_COURSE_FRAGMENT}
`;

export const UPDATE_TRAINING_COURSE = gql`
  mutation UpdateTrainingCourse($input: UpdateTrainingCourseInput!) {
    updateTrainingCourse(input: $input) {
      ...TrainingCourseFull
    }
  }
  ${TRAINING_COURSE_FRAGMENT}
`;

export const ENROLL_IN_TRAINING = gql`
  mutation EnrollInTraining($input: EnrollInTrainingInput!) {
    enrollInTraining(input: $input) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

export const START_TRAINING = gql`
  mutation StartTraining($enrollmentId: ID!) {
    startTraining(enrollmentId: $enrollmentId) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

export const COMPLETE_TRAINING = gql`
  mutation CompleteTraining($input: CompleteTrainingInput!) {
    completeTraining(input: $input) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

export const WITHDRAW_FROM_TRAINING = gql`
  mutation WithdrawFromTraining($enrollmentId: ID!, $reason: String) {
    withdrawFromTraining(enrollmentId: $enrollmentId, reason: $reason) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

export const BULK_ENROLL_IN_TRAINING = gql`
  mutation BulkEnrollInTraining($courseId: ID!, $employeeIds: [ID!]!) {
    bulkEnrollInTraining(courseId: $courseId, employeeIds: $employeeIds) {
      enrolled
      alreadyEnrolled
      failed
      errors
    }
  }
`;
