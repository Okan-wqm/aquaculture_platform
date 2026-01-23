/**
 * Certification & Training Hooks
 * TanStack Query hooks for certification and training operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import {
  GET_CERTIFICATION_TYPES,
  GET_EMPLOYEE_CERTIFICATIONS,
  GET_EXPIRING_CERTIFICATIONS,
  GET_EXPIRED_CERTIFICATIONS,
  GET_CERTIFICATION_COMPLIANCE_REPORT,
  GET_EMPLOYEE_CERTIFICATION_STATUS,
  GET_TRAINING_COURSES,
  GET_TRAINING_ENROLLMENTS,
  GET_MY_TRAINING_ENROLLMENTS,
  GET_MANDATORY_TRAINING_STATUS,
  ADD_EMPLOYEE_CERTIFICATION,
  VERIFY_CERTIFICATION,
  REVOKE_CERTIFICATION,
  RENEW_CERTIFICATION,
  ENROLL_IN_TRAINING,
  START_TRAINING,
  COMPLETE_TRAINING,
  WITHDRAW_FROM_TRAINING,
} from '../graphql';
import type {
  CertificationType,
  EmployeeCertification,
  TrainingCourse,
  TrainingEnrollment,
  CertificationComplianceReport,
  MandatoryTrainingStatus,
  CertificationFilterInput,
  TrainingFilterInput,
  AddEmployeeCertificationInput,
  VerifyCertificationInput,
  RevokeCertificationInput,
  EnrollInTrainingInput,
  CompleteTrainingInput,
  CertificationCategory,
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys
export const certificationKeys = {
  all: ['certifications'] as const,
  types: () => [...certificationKeys.all, 'types'] as const,
  typeList: (filter?: { category?: CertificationCategory; isActive?: boolean }) =>
    [...certificationKeys.types(), { filter }] as const,
  employee: (employeeId: string) =>
    [...certificationKeys.all, 'employee', employeeId] as const,
  employeeList: (employeeId: string, filter?: CertificationFilterInput) =>
    [...certificationKeys.employee(employeeId), { filter }] as const,
  expiring: (daysUntilExpiry: number, departmentId?: string) =>
    [...certificationKeys.all, 'expiring', daysUntilExpiry, departmentId] as const,
  expired: (departmentId?: string) =>
    [...certificationKeys.all, 'expired', departmentId] as const,
  compliance: (departmentId?: string) =>
    [...certificationKeys.all, 'compliance', departmentId] as const,
  status: (employeeId: string) =>
    [...certificationKeys.all, 'status', employeeId] as const,
};

export const trainingKeys = {
  all: ['training'] as const,
  courses: () => [...trainingKeys.all, 'courses'] as const,
  courseList: (filter?: { category?: CertificationCategory; isMandatory?: boolean; isActive?: boolean }) =>
    [...trainingKeys.courses(), { filter }] as const,
  enrollments: () => [...trainingKeys.all, 'enrollments'] as const,
  enrollmentList: (filter?: TrainingFilterInput, pagination?: PaginationInput) =>
    [...trainingKeys.enrollments(), { filter, pagination }] as const,
  myEnrollments: (filter?: TrainingFilterInput) =>
    [...trainingKeys.all, 'myEnrollments', { filter }] as const,
  mandatoryStatus: (employeeId: string) =>
    [...trainingKeys.all, 'mandatoryStatus', employeeId] as const,
};

// =====================
// Certification Type Queries
// =====================

export function useCertificationTypes(filter?: {
  category?: CertificationCategory;
  isActive?: boolean;
}) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: certificationKeys.typeList(filter),
    queryFn: () =>
      graphqlRequest<{ certificationTypes: CertificationType[] }, unknown>(
        client,
        GET_CERTIFICATION_TYPES.loc?.source.body || '',
        { filter }
      ),
    select: (data) => data.certificationTypes,
  });
}

// =====================
// Employee Certification Queries
// =====================

export function useEmployeeCertifications(
  employeeId: string,
  filter?: CertificationFilterInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: certificationKeys.employeeList(employeeId, filter),
    queryFn: () =>
      graphqlRequest<{ employeeCertifications: EmployeeCertification[] }, unknown>(
        client,
        GET_EMPLOYEE_CERTIFICATIONS.loc?.source.body || '',
        { employeeId, filter }
      ),
    select: (data) => data.employeeCertifications,
    enabled: !!employeeId,
  });
}

export function useExpiringCertifications(
  daysUntilExpiry: number,
  departmentId?: string
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: certificationKeys.expiring(daysUntilExpiry, departmentId),
    queryFn: () =>
      graphqlRequest<{
        expiringCertifications: (EmployeeCertification & { daysUntilExpiry: number })[];
      }, unknown>(client, GET_EXPIRING_CERTIFICATIONS.loc?.source.body || '', {
        daysUntilExpiry,
        departmentId,
      }),
    select: (data) => data.expiringCertifications,
  });
}

export function useExpiredCertifications(departmentId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: certificationKeys.expired(departmentId),
    queryFn: () =>
      graphqlRequest<{
        expiredCertifications: (EmployeeCertification & { daysSinceExpiry: number })[];
      }, unknown>(client, GET_EXPIRED_CERTIFICATIONS.loc?.source.body || '', {
        departmentId,
      }),
    select: (data) => data.expiredCertifications,
  });
}

export function useCertificationComplianceReport(departmentId?: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: certificationKeys.compliance(departmentId),
    queryFn: () =>
      graphqlRequest<{
        certificationComplianceReport: CertificationComplianceReport;
      }, unknown>(client, GET_CERTIFICATION_COMPLIANCE_REPORT.loc?.source.body || '', {
        departmentId,
      }),
    select: (data) => data.certificationComplianceReport,
  });
}

export function useEmployeeCertificationStatus(employeeId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: certificationKeys.status(employeeId),
    queryFn: () =>
      graphqlRequest<{
        employeeCertificationStatus: {
          isFullyCompliant: boolean;
          totalRequired: number;
          totalHeld: number;
          expiringSoon: {
            certificationTypeId: string;
            certificationTypeName: string;
            expiryDate: string;
            daysUntilExpiry: number;
          }[];
          missing: {
            certificationTypeId: string;
            certificationTypeName: string;
            category: CertificationCategory;
            isMandatory: boolean;
            requiredForOffshore: boolean;
          }[];
        };
      }, unknown>(client, GET_EMPLOYEE_CERTIFICATION_STATUS.loc?.source.body || '', {
        employeeId,
      }),
    select: (data) => data.employeeCertificationStatus,
    enabled: !!employeeId,
  });
}

// =====================
// Training Course Queries
// =====================

export function useTrainingCourses(filter?: {
  category?: CertificationCategory;
  isMandatory?: boolean;
  isActive?: boolean;
}) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: trainingKeys.courseList(filter),
    queryFn: () =>
      graphqlRequest<{ trainingCourses: TrainingCourse[] }, unknown>(
        client,
        GET_TRAINING_COURSES.loc?.source.body || '',
        { filter }
      ),
    select: (data) => data.trainingCourses,
  });
}

// =====================
// Training Enrollment Queries
// =====================

export function useTrainingEnrollments(
  filter?: TrainingFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: trainingKeys.enrollmentList(filter, pagination),
    queryFn: () =>
      graphqlRequest<{
        trainingEnrollments: PaginatedResponse<TrainingEnrollment>;
      }, unknown>(client, GET_TRAINING_ENROLLMENTS.loc?.source.body || '', {
        filter,
        pagination,
      }),
    select: (data) => data.trainingEnrollments,
  });
}

export function useMyTrainingEnrollments(filter?: TrainingFilterInput) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: trainingKeys.myEnrollments(filter),
    queryFn: () =>
      graphqlRequest<{ myTrainingEnrollments: TrainingEnrollment[] }, unknown>(
        client,
        GET_MY_TRAINING_ENROLLMENTS.loc?.source.body || '',
        { filter }
      ),
    select: (data) => data.myTrainingEnrollments,
  });
}

export function useMandatoryTrainingStatus(employeeId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: trainingKeys.mandatoryStatus(employeeId),
    queryFn: () =>
      graphqlRequest<{
        mandatoryTrainingStatus: MandatoryTrainingStatus[];
      }, unknown>(client, GET_MANDATORY_TRAINING_STATUS.loc?.source.body || '', {
        employeeId,
      }),
    select: (data) => data.mandatoryTrainingStatus,
    enabled: !!employeeId,
  });
}

// =====================
// Certification Mutations
// =====================

export function useAddEmployeeCertification() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddEmployeeCertificationInput) =>
      graphqlRequest<{ addEmployeeCertification: EmployeeCertification }, unknown>(
        client,
        ADD_EMPLOYEE_CERTIFICATION.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: certificationKeys.employee(data.addEmployeeCertification.employeeId),
      });
      queryClient.invalidateQueries({ queryKey: certificationKeys.compliance() });
    },
  });
}

export function useVerifyCertification() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: VerifyCertificationInput) =>
      graphqlRequest<{ verifyCertification: EmployeeCertification }, unknown>(
        client,
        VERIFY_CERTIFICATION.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: certificationKeys.employee(data.verifyCertification.employeeId),
      });
    },
  });
}

export function useRevokeCertification() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RevokeCertificationInput) =>
      graphqlRequest<{ revokeCertification: EmployeeCertification }, unknown>(
        client,
        REVOKE_CERTIFICATION.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: certificationKeys.employee(data.revokeCertification.employeeId),
      });
      queryClient.invalidateQueries({ queryKey: certificationKeys.compliance() });
    },
  });
}

export function useRenewCertification() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      certificationId,
      newExpiryDate,
      certificateNumber,
      attachmentUrl,
    }: {
      certificationId: string;
      newExpiryDate: string;
      certificateNumber?: string;
      attachmentUrl?: string;
    }) =>
      graphqlRequest<{ renewCertification: EmployeeCertification }, unknown>(
        client,
        RENEW_CERTIFICATION.loc?.source.body || '',
        { certificationId, newExpiryDate, certificateNumber, attachmentUrl }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: certificationKeys.employee(data.renewCertification.employeeId),
      });
      queryClient.invalidateQueries({ queryKey: [...certificationKeys.all, 'expiring'] });
    },
  });
}

// =====================
// Training Mutations
// =====================

export function useEnrollInTraining() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: EnrollInTrainingInput) =>
      graphqlRequest<{ enrollInTraining: TrainingEnrollment }, unknown>(
        client,
        ENROLL_IN_TRAINING.loc?.source.body || '',
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainingKeys.enrollments() });
      queryClient.invalidateQueries({ queryKey: trainingKeys.myEnrollments() });
    },
  });
}

export function useStartTraining() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enrollmentId: string) =>
      graphqlRequest<{ startTraining: TrainingEnrollment }, unknown>(
        client,
        START_TRAINING.loc?.source.body || '',
        { enrollmentId }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainingKeys.enrollments() });
      queryClient.invalidateQueries({ queryKey: trainingKeys.myEnrollments() });
    },
  });
}

export function useCompleteTraining() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CompleteTrainingInput) =>
      graphqlRequest<{ completeTraining: TrainingEnrollment }, unknown>(
        client,
        COMPLETE_TRAINING.loc?.source.body || '',
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: trainingKeys.enrollments() });
      queryClient.invalidateQueries({ queryKey: trainingKeys.myEnrollments() });
      queryClient.invalidateQueries({
        queryKey: trainingKeys.mandatoryStatus(data.completeTraining.employeeId),
      });
    },
  });
}

export function useWithdrawFromTraining() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ enrollmentId, reason }: { enrollmentId: string; reason?: string }) =>
      graphqlRequest<{ withdrawFromTraining: TrainingEnrollment }, unknown>(
        client,
        WITHDRAW_FROM_TRAINING.loc?.source.body || '',
        { enrollmentId, reason }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainingKeys.enrollments() });
      queryClient.invalidateQueries({ queryKey: trainingKeys.myEnrollments() });
    },
  });
}
