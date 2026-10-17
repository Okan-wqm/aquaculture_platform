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
 * WHAT: pure builders over the fetched records; the panel decides which the
 * viewer may read before anything is fetched.
 */
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

export interface UserRecord {
  readonly id: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly mfaEnabled: boolean;
}

export interface AnnouncementRecord {
  readonly id: string;
  readonly title: string;
  readonly isActive: boolean;
  readonly publishAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['TENANT_ADMIN', 'MODULE_MANAGER']);

export function seatNotice(sources: SeatSources | null): SeatNotice | null {
  if (sources === null || sources.maxUsers <= 0) return null;
  const taken = sources.currentUsers + sources.pendingUsers;
  return taken >= sources.maxUsers - 1
    ? { used: sources.currentUsers, max: sources.maxUsers, pending: sources.pendingUsers }
    : null;
}

function displayName(user: UserRecord): string {
  const name = [user.firstName, user.lastName]
    .filter((part) => part !== null && part !== '')
    .join(' ');
  return name === '' ? user.email : name;
}

/** The names of active privileged users without two-factor sign-in. */
export function usersWithoutMfa(users: readonly UserRecord[]): string[] {
  return users
    .filter((user) => user.isActive && !user.mfaEnabled && PRIVILEGED_ROLES.has(user.role))
    .map(displayName);
}

export function maintenanceInForce(
  announcements: readonly AnnouncementRecord[],
  now: Date,
): AnnouncementRecord[] {
  const at = now.getTime();
  return announcements.filter(
    (announcement) =>
      announcement.isActive &&
      (announcement.publishAt === null || Date.parse(announcement.publishAt) <= at) &&
      (announcement.expiresAt === null || Date.parse(announcement.expiresAt) > at),
  );
}
