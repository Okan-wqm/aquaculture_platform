/**
 * Canonical GDPR data request enums.
 *
 * Source of truth: backend-common `GdprDataRequest` entity.
 * Both backend GDPR handlers and frontend data-subject-rights UI MUST use these enums.
 *
 * ## Existing definitions reconciled
 * - backend-common `GdprDataRequest` entity: single backend definition (authoritative)
 *
 * Values are lowercase to match the database column values.
 */

/** Type of GDPR data subject request. Maps to GDPR Articles 15-20. */
export enum DataRequestType {
  /** Art. 15/20: Export all personal data held about the subject. */
  EXPORT = 'export',

  /** Art. 17: Right to erasure — delete all personal data. */
  DELETION = 'deletion',

  /** Art. 16: Right to rectification — correct inaccurate personal data. */
  RECTIFICATION = 'rectification',

  /** Art. 18: Right to restriction of processing. */
  RESTRICTION = 'restriction',

  /** Art. 20: Right to data portability — machine-readable export. */
  PORTABILITY = 'portability',
}

/** Processing status of a GDPR data request. */
export enum DataRequestStatus {
  /** Request submitted, awaiting processing. */
  PENDING = 'pending',

  /** Request is actively being processed by the system. */
  PROCESSING = 'processing',

  /** Request completed successfully. */
  COMPLETED = 'completed',

  /** Request processing failed — see errorMessage for details. */
  FAILED = 'failed',

  /** Request was cancelled by the subject or an admin before completion. */
  CANCELLED = 'cancelled',
}
