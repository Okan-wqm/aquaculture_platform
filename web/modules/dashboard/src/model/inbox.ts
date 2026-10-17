/**
 * The dashboard inbox: what is waiting for the viewer, from records only.
 *
 * WHY each rule:
 *  - seats: the plan's seat limit (billing) against the seats in use plus the
 *    pending invitations (auth). The notice appears once one more invitation
 *    would fill the plan — the design's "one more invitation fills the plan".
 *  - two-factor: active users who can approve changes (tenant admins and
 *    module managers) without two-factor sign-in.
 *  - maintenance: the maintenance announcements in force now (published,
 *    active, not expired).
 *
 * WHAT: pure builders over the fetched records (the supergraph's own
 * shapes); the panel decides which the viewer may read before anything is
 * fetched.
 */
import type { AnnouncementListItem, Role, User } from '@platform/shared-ui/generated/graphql-types';

export interface SeatSources {
  readonly maxUsers: number;
  readonly currentUsers: number;
  readonly pendingUsers: number;
}

export interface SeatNotice {
  readonly used: number;
  readonly max: number;
  readonly pending: number;
}

export type UserRecord = Pick<
  User,
  'id' | 'firstName' | 'lastName' | 'email' | 'role' | 'isActive' | 'mfaEnabled'
>;

export type AnnouncementRecord = Pick<
  AnnouncementListItem,
  'id' | 'title' | 'isActive' | 'publishAt' | 'expiresAt' | 'createdAt'
>;

const PRIVILEGED_ROLES: ReadonlySet<Role> = new Set<Role>(['TENANT_ADMIN', 'MODULE_MANAGER']);

export function seatNotice(sources: SeatSources | null): SeatNotice | null {
  if (sources === null || sources.maxUsers <= 0) return null;
  const taken = sources.currentUsers + sources.pendingUsers;
  return taken >= sources.maxUsers - 1
    ? { used: sources.currentUsers, max: sources.maxUsers, pending: sources.pendingUsers }
    : null;
}

/** A user as people name them: first and last name, else the e-mail. */
export function userDisplayName(
  user: Pick<UserRecord, 'firstName' | 'lastName' | 'email'>,
): string {
  const name = [user.firstName, user.lastName]
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(' ');
  return name === '' ? user.email : name;
}

/** The names of active privileged users without two-factor sign-in. */
export function usersWithoutMfa(users: readonly UserRecord[]): string[] {
  return users
    .filter((user) => user.isActive && !user.mfaEnabled && PRIVILEGED_ROLES.has(user.role))
    .map(userDisplayName);
}

export function maintenanceInForce(
  announcements: readonly AnnouncementRecord[],
  now: Date,
): AnnouncementRecord[] {
  const at = now.getTime();
  return announcements.filter(
    (announcement) =>
      announcement.isActive &&
      (announcement.publishAt === null ||
        announcement.publishAt === undefined ||
        Date.parse(announcement.publishAt) <= at) &&
      (announcement.expiresAt === null ||
        announcement.expiresAt === undefined ||
        Date.parse(announcement.expiresAt) > at),
  );
}
