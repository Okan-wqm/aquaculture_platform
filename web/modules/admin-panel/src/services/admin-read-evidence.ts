import { AdminHttpContractError } from '@platform/admin-http-contracts';

import { isAdminApiError } from './http-client';

export const ADMIN_READ_EVIDENCE_SCHEMA_VERSION = 'admin-read-evidence.v1' as const;

export type AdminReadCoordinateValue = string | number | boolean | null;
export type AdminReadCoordinates = Readonly<Record<string, AdminReadCoordinateValue>>;

export type AdminReadFailureKind =
  | 'HTTP_REJECTION'
  | 'CONTRACT_REJECTION'
  | 'TRANSPORT_REJECTION'
  | 'UNKNOWN_REJECTION';

interface AdminReadEvidenceBaseV1 {
  readonly schemaVersion: typeof ADMIN_READ_EVIDENCE_SCHEMA_VERSION;
  readonly authority: string;
  readonly coordinates: AdminReadCoordinates;
}

export interface AdminReadPendingEvidenceV1 extends AdminReadEvidenceBaseV1 {
  readonly outcome: 'PENDING';
}

export interface AdminReadVerifiedEvidenceV1 extends AdminReadEvidenceBaseV1 {
  readonly outcome: 'VERIFIED';
  readonly contractValidated: true;
}

export interface AdminReadFailureEvidenceV1 {
  readonly kind: AdminReadFailureKind;
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
}

export interface AdminReadRejectedEvidenceV1 extends AdminReadEvidenceBaseV1 {
  readonly outcome: 'REJECTED';
  readonly contractValidated: false;
  readonly failure: AdminReadFailureEvidenceV1;
}

export interface AdminReadPending {
  readonly outcome: 'PENDING';
  readonly evidence: AdminReadPendingEvidenceV1;
}

export interface AdminReadVerified<T> {
  readonly outcome: 'VERIFIED';
  readonly evidence: AdminReadVerifiedEvidenceV1;
  readonly value: T;
}

export interface AdminReadRejected {
  readonly outcome: 'REJECTED';
  readonly evidence: AdminReadRejectedEvidenceV1;
}

export type AdminReadState<T> = AdminReadPending | AdminReadVerified<T> | AdminReadRejected;

export function beginAdminRead(
  authority: string,
  coordinates: AdminReadCoordinates,
): AdminReadPending {
  return Object.freeze({
    outcome: 'PENDING',
    evidence: Object.freeze({
      schemaVersion: ADMIN_READ_EVIDENCE_SCHEMA_VERSION,
      authority,
      coordinates: Object.freeze({ ...coordinates }),
      outcome: 'PENDING',
    }),
  });
}

export function verifyAdminRead<T>(pending: AdminReadPending, value: T): AdminReadVerified<T> {
  return Object.freeze({
    outcome: 'VERIFIED',
    evidence: Object.freeze({
      ...pending.evidence,
      outcome: 'VERIFIED',
      contractValidated: true,
    }),
    value,
  });
}

function adminReadFailure(error: unknown): AdminReadFailureEvidenceV1 {
  if (isAdminApiError(error)) {
    return Object.freeze({
      kind: 'HTTP_REJECTION',
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    });
  }

  if (error instanceof AdminHttpContractError) {
    return Object.freeze({
      kind: 'CONTRACT_REJECTION',
      message: error.message,
    });
  }

  if (error instanceof Error) {
    return Object.freeze({
      kind: 'TRANSPORT_REJECTION',
      message: error.message,
    });
  }

  return Object.freeze({
    kind: 'UNKNOWN_REJECTION',
    message: 'The read authority rejected without a typed error payload',
  });
}

export function rejectAdminRead(pending: AdminReadPending, error: unknown): AdminReadRejected {
  return Object.freeze({
    outcome: 'REJECTED',
    evidence: Object.freeze({
      ...pending.evidence,
      outcome: 'REJECTED',
      contractValidated: false,
      failure: adminReadFailure(error),
    }),
  });
}

export function settleAdminRead<T>(
  pending: AdminReadPending,
  result: PromiseSettledResult<T>,
): AdminReadVerified<T> | AdminReadRejected {
  return result.status === 'fulfilled'
    ? verifyAdminRead(pending, result.value)
    : rejectAdminRead(pending, result.reason);
}

export function isRejectedAdminRead(state: AdminReadState<unknown>): state is AdminReadRejected {
  return state.outcome === 'REJECTED';
}
