import { MalformedCallerError, userCaller, type UserCaller } from '@aquaculture/shared-contracts';

import { TENANT_ID_REGEX } from '../constants/validation-patterns';

/**
 * The member a verified socket handshake token describes (ADR-051 §1, §2 Transport;
 * SEC-CRITICAL-206, SEC-CRITICAL-207).
 *
 * WHY one parse: a socket decides which rooms it may join from the token's `moduleAccess` and
 * `assignedSiteIds`, the same claims the gateway forwards to every subgraph. Each gateway read
 * them by hand, and the farm, sensor and ST-language gateways read none, so their rooms were
 * decided by tenant alone. Every socket gateway now builds its member here, and `decideAccess`
 * decides with the branded `UserCaller` it gets, which only `userCaller` can build.
 *
 * WHAT: the subject, the tenant (a canonical tenant id), a `UserCaller` from `roles`,
 * `moduleAccess` and `resourcePermissions`, and a frozen copy of the assigned sites. An absent
 * `moduleAccess` means no grants and absent sites mean none, as for a token minted before the
 * claims existed; a claim of any other shape refuses the handshake (null), exactly as the subgraph
 * middleware answers it with 400.
 */
export interface SocketMember {
  readonly caller: UserCaller;
  readonly tenantId: string;
  readonly assignedSiteIds: readonly string[];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** The member of a verified token's claims, or null when a claim is missing or malformed. */
export function socketMemberOf(claims: Readonly<Record<string, unknown>>): SocketMember | null {
  const userId = claims['sub'];
  const tenantId = claims['tenantId'];
  const sites = claims['assignedSiteIds'] === undefined ? [] : claims['assignedSiteIds'];
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (typeof tenantId !== 'string' || !TENANT_ID_REGEX.test(tenantId)) return null;
  if (!isStringArray(sites)) return null;
  try {
    const caller = userCaller({
      userId,
      tenantId,
      roles: claims['roles'],
      moduleAccess: claims['moduleAccess'],
      capabilities: claims['resourcePermissions'],
    });
    return Object.freeze({ caller, tenantId, assignedSiteIds: Object.freeze([...sites]) });
  } catch (error) {
    if (error instanceof MalformedCallerError) return null;
    throw error;
  }
}
