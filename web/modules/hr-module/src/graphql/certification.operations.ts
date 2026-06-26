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
  query GetCertificationTypes($category: CertificationCategory, $isActive: Boolean) {
    certificationTypes(category: $category, isActive: $isActive) {
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
    $status: CertificationStatus
  ) {
    employeeCertifications(employeeId: $employeeId, status: $status) {
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
      daysUntilExpiry
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

// WHY: Backend allCertifications resolver declares employeeId/certificationTypeId as ID
// (@Args(..., { type: () => ID })), not String. GraphQL forbids passing a String variable
// into an ID position, so these variables must be declared as ID to match the schema.
export const GET_ALL_CERTIFICATIONS = gql`
  query GetAllCertifications(
    $status: CertificationStatus
    $category: CertificationCategory
    $employeeId: ID
    $certificationTypeId: ID
    $page: Int
    $limit: Int
  ) {
    allCertifications(
      status: $status
      category: $category
      employeeId: $employeeId
      certificationTypeId: $certificationTypeId
      page: $page
      limit: $limit
    ) {
      items {
        ...EmployeeCertificationFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

// =====================
// Training Queries
// =====================

export const GET_TRAINING_COURSES = gql`
  query GetTrainingCourses(
    $trainingType: TrainingType
    $isMandatory: Boolean
    $isActive: Boolean
    $page: Int
    $limit: Int
  ) {
    trainingCourses(
      trainingType: $trainingType
      isMandatory: $isMandatory
      isActive: $isActive
      page: $page
      limit: $limit
    ) {
      items {
        ...TrainingCourseFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
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
    $employeeId: ID
    $trainingCourseId: ID
    $status: EnrollmentStatus
    $page: Int
    $limit: Int
  ) {
    trainingEnrollments(
      employeeId: $employeeId
      trainingCourseId: $trainingCourseId
      status: $status
      page: $page
      limit: $limit
    ) {
      items {
        ...TrainingEnrollmentFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

// WHY: Backend myTrainingEnrollments resolver accepts (status, limit, page), not offset.
export const GET_MY_TRAINING_ENROLLMENTS = gql`
  query GetMyTrainingEnrollments($status: EnrollmentStatus, $limit: Int, $page: Int) {
    myTrainingEnrollments(status: $status, limit: $limit, page: $page) {
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
  mutation AddEmployeeCertification(
    $employeeId: ID!
    $certificationTypeId: ID!
    $issueDate: String!
    $expiryDate: String
    $issuingAuthority: String
    $externalCertificationId: String
    $notes: String
  ) {
    addEmployeeCertification(
      employeeId: $employeeId
      certificationTypeId: $certificationTypeId
      issueDate: $issueDate
      expiryDate: $expiryDate
      issuingAuthority: $issuingAuthority
      externalCertificationId: $externalCertificationId
      notes: $notes
    ) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

// NOTE: updateEmployeeCertification does not exist in backend.
// Use addEmployeeCertification for new certs or renewCertification for renewals.

export const VERIFY_CERTIFICATION = gql`
  mutation VerifyCertification($id: ID!, $notes: String) {
    verifyCertification(id: $id, notes: $notes) {
      ...EmployeeCertificationFull
    }
  }
  ${EMPLOYEE_CERTIFICATION_FRAGMENT}
`;

export const REVOKE_CERTIFICATION = gql`
  mutation RevokeCertification($id: ID!, $reason: String!) {
    revokeCertification(id: $id, reason: $reason) {
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
  mutation EnrollInTraining(
    $employeeId: ID!
    $trainingCourseId: ID!
    $dueDate: String
    $sessionId: String
    $instructor: String
    $location: String
  ) {
    enrollInTraining(
      employeeId: $employeeId
      trainingCourseId: $trainingCourseId
      dueDate: $dueDate
      sessionId: $sessionId
      instructor: $instructor
      location: $location
    ) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

// NOTE: startTraining does not exist in backend resolver yet.
// Kept as placeholder for future implementation.
export const START_TRAINING = gql`
  mutation StartTraining($enrollmentId: ID!) {
    startTraining(enrollmentId: $enrollmentId) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

export const COMPLETE_TRAINING = gql`
  mutation CompleteTraining(
    $enrollmentId: ID!
    $score: Float
    $feedback: String
    $feedbackRating: Int
  ) {
    completeTraining(
      enrollmentId: $enrollmentId
      score: $score
      feedback: $feedback
      feedbackRating: $feedbackRating
    ) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

// NOTE: withdrawFromTraining does not exist in backend resolver yet.
// Kept as placeholder for future implementation.
export const WITHDRAW_FROM_TRAINING = gql`
  mutation WithdrawFromTraining($enrollmentId: ID!, $reason: String) {
    withdrawFromTraining(enrollmentId: $enrollmentId, reason: $reason) {
      ...TrainingEnrollmentFull
    }
  }
  ${TRAINING_ENROLLMENT_FRAGMENT}
`;

// NOTE: bulkEnrollInTraining does not exist in backend resolver yet.
// Kept as placeholder for future implementation.
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
