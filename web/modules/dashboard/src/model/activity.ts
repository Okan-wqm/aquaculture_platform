/**
 * Recent activity's view-model: who did what, in words.
 *
 * WHY: auth-service records an action as a code (LOGIN_SUCCESS,
 * USER_ROLE_CHANGED, …) and the actor as a user id, with the e-mail only
 * where the writer kept one. A tenant admin reads people and deeds, not codes
 * and UUIDs: each code auth-service writes into a tenant's audit log has its
 * own phrase (en + tr), and the actor is named from the tenant's users (the
 * list the inbox already reads), else by the recorded e-mail. An action with
 * no phrase yet is shown as what it is — a recorded code — and an actor the
 * tenant does not list is said to be outside its users, never shown as an id.
 *
 * WHAT: the audit entry and user shapes (the supergraph's), the action
 * phrases, actorOf and initialsOf.
 */
import type { MessageKey } from '@aquaculture/shared-ui';
import type { AuditLogEntryResponse, User } from '@platform/shared-ui/generated/graphql-types';

import { userDisplayName } from './inbox';

export type AuditEntry = Pick<
  AuditLogEntryResponse,
  'id' | 'action' | 'entityType' | 'performedBy' | 'performedByEmail' | 'createdAt'
>;

export type ActivityUser = Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>;

/**
 * The actions auth-service writes into a tenant's audit log (its
 * logSecurityEvent, MFA, user, role and policy writers), each with its phrase.
 */
const ACTION_KEYS = {
  LOGIN_SUCCESS: 'dashboard.activity.action.LOGIN_SUCCESS',
  LOGIN_FAILED: 'dashboard.activity.action.LOGIN_FAILED',
  LOGIN_FAILED_INVALID_PASSWORD: 'dashboard.activity.action.LOGIN_FAILED',
  LOGIN_BLOCKED_ACCOUNT_LOCKED: 'dashboard.activity.action.LOGIN_BLOCKED_ACCOUNT_LOCKED',
  ACCOUNT_LOCKED: 'dashboard.activity.action.ACCOUNT_LOCKED',
  INVITATION_ACCEPTED: 'dashboard.activity.action.INVITATION_ACCEPTED',
  PASSWORD_RESET_REQUESTED: 'dashboard.activity.action.PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_SUCCESS: 'dashboard.activity.action.PASSWORD_RESET_SUCCESS',
  MFA_ENABLED: 'dashboard.activity.action.MFA_ENABLED',
  MFA_DISABLED: 'dashboard.activity.action.MFA_DISABLED',
  MFA_RECOVERY_CODES_REGENERATED: 'dashboard.activity.action.MFA_RECOVERY_CODES_REGENERATED',
  MFA_VERIFY_FAILED: 'dashboard.activity.action.MFA_VERIFY_FAILED',
  USER_CREATED: 'dashboard.activity.action.USER_CREATED',
  USER_DELETED: 'dashboard.activity.action.USER_DELETED',
  USER_ACTIVATED: 'dashboard.activity.action.USER_ACTIVATED',
  USER_DEACTIVATED: 'dashboard.activity.action.USER_DEACTIVATED',
  USER_UNLOCKED: 'dashboard.activity.action.USER_UNLOCKED',
  USER_ROLE_CHANGED: 'dashboard.activity.action.USER_ROLE_CHANGED',
  USER_SITE_ASSIGNED: 'dashboard.activity.action.USER_SITE_ASSIGNED',
  USER_SITE_UNASSIGNED: 'dashboard.activity.action.USER_SITE_UNASSIGNED',
  ROLE_CREATED: 'dashboard.activity.action.ROLE_CREATED',
  ROLE_UPDATED: 'dashboard.activity.action.ROLE_UPDATED',
  ROLE_DELETED: 'dashboard.activity.action.ROLE_DELETED',
  TENANT_SECURITY_POLICY_UPDATED: 'dashboard.activity.action.TENANT_SECURITY_POLICY_UPDATED',
} as const satisfies Readonly<Record<string, MessageKey>>;

type KnownAction = keyof typeof ACTION_KEYS;

function isKnownAction(action: string): action is KnownAction {
  return Object.prototype.hasOwnProperty.call(ACTION_KEYS, action);
}

/** The phrase of a recorded action, or null for a code with no phrase yet. */
export function actionKeyOf(action: string): MessageKey | null {
  return isKnownAction(action) ? ACTION_KEYS[action] : null;
}

/** Who did it: the tenant's user by id, else the recorded e-mail, else null (outside the tenant's users). */
export function actorOf(
  entry: Pick<AuditEntry, 'performedBy' | 'performedByEmail'>,
  users: ReadonlyMap<string, ActivityUser>,
): string | null {
  const user = users.get(entry.performedBy);
  if (user !== undefined) return userDisplayName(user);
  return entry.performedByEmail ?? null;
}

/** Two letters for the actor's mark: a name's initials, an e-mail's local part. */
export function initialsOf(actor: string): string {
  const local = actor.split('@')[0] ?? actor;
  const parts = local.split(/[\s._-]+/).filter((part) => part !== '');
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : local.slice(0, 2);
  return letters.toUpperCase();
}
