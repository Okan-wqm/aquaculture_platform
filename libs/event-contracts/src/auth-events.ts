import { BaseEvent } from './base-event';

// ==================== Auth Events ====================

/**
 * User Registered Event
 * Published when a new user registers in the system
 */
export interface UserRegisteredEvent extends BaseEvent {
  eventType: 'UserRegistered';
  userId: string;
  email?: string;
  role?: string;
}

/**
 * User Logged In Event
 * Published when a user successfully logs in
 */
export interface UserLoggedInEvent extends BaseEvent {
  eventType: 'UserLoggedIn';
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Invitation Accepted Event
 * Published when a user accepts a tenant invitation
 */
export interface InvitationAcceptedEvent extends BaseEvent {
  eventType: 'InvitationAccepted';
  userId: string;
  invitationId?: string;
  email?: string;
}

/**
 * Password Reset Requested Event
 * Published when a user requests a password reset.
 * The notification service listens to this event to send the reset email.
 *
 * // SECURITY: SEC-C01 — never expose raw tokens on event bus.
 * actionUrl is built server-side (auth-service) and contains the full reset link.
 */
export interface PasswordResetRequestedEvent extends BaseEvent {
  eventType: 'PasswordResetRequested';
  userId: string;
  email: string;
  actionUrl: string;
  firstName?: string;
}

/**
 * Password Reset Completed Event
 * Published when a user successfully resets their password
 */
export interface PasswordResetCompletedEvent extends BaseEvent {
  eventType: 'PasswordResetCompleted';
  userId: string;
}

// ==================== Type Union ====================

/**
 * Union type for all auth events
 */
export type AuthEvent =
  | UserRegisteredEvent
  | UserLoggedInEvent
  | InvitationAcceptedEvent
  | PasswordResetRequestedEvent
  | PasswordResetCompletedEvent;
