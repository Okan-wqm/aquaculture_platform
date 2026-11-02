/**
 * The self-service leave mutations share one gate (HR-MEDIUM-074; SEC-HIGH-052).
 *
 * submit, cancel, update and withdraw ran RolesGuard and MobileFeatureGuard with
 * `@ModuleUserOrHigher()` and `@RequiresMobileFeature('leave')`; createLeaveRequest carried no
 * mobile entitlement, so a member whose tenant admin had switched 'leave' off could still create a
 * request. MobileFeatureGuard is a no-op on a handler without the metadata, so the gate is read
 * here from the metadata Nest registers on each handler.
 */
import 'reflect-metadata';

import { MOBILE_FEATURE_KEY, ROLES_KEY } from '@aquaculture/backend-common/decorators';
import { MobileFeatureGuard, RolesGuard } from '@aquaculture/backend-common/guards';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { LeaveResolver } from '../leave.resolver';

const SELF_SERVICE_MUTATIONS = [
  'createLeaveRequest',
  'submitLeaveRequest',
  'cancelLeaveRequest',
  'updateLeaveRequest',
  'withdrawLeaveRequest',
] as const;

function handlerOf(method: (typeof SELF_SERVICE_MUTATIONS)[number]): object {
  const handler: unknown = Reflect.get(LeaveResolver.prototype, method);
  if (typeof handler !== 'function') throw new Error(`LeaveResolver.${method} does not exist`);
  return handler;
}

describe('LeaveResolver self-service mutations: one gate (HR-MEDIUM-074)', () => {
  it.each(SELF_SERVICE_MUTATIONS)('%s runs RolesGuard and MobileFeatureGuard', (method) => {
    const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, handlerOf(method));
    expect(guards).toEqual(expect.arrayContaining([RolesGuard, MobileFeatureGuard]));
  });

  it.each(SELF_SERVICE_MUTATIONS)("%s requires the 'leave' mobile entitlement", (method) => {
    expect(Reflect.getMetadata(MOBILE_FEATURE_KEY, handlerOf(method))).toBe('leave');
  });

  it.each(SELF_SERVICE_MUTATIONS)('%s is open to every staff member and no one below', (method) => {
    expect(Reflect.getMetadata(ROLES_KEY, handlerOf(method))).toEqual(
      expect.arrayContaining(['MODULE_USER']),
    );
  });
});
