import { AUDITED_OPERATION_KEY } from '@aquaculture/backend-common/audit';
import { Role, ROLES_KEY } from '@aquaculture/backend-common/decorators';
import { collaborator } from '@aquaculture/testing';

import { type EdgeDeviceService } from '../../edge-device/edge-device.service';
import { type EdgeUpdateRequestService } from '../../edge-device/edge-update-request.service';
import { type CreateEdgeRolloutInput } from '../dto/edge-rollout.dto';
import { EdgeRolloutResolver } from '../edge-rollout.resolver';
import { type EdgeRolloutService } from '../edge-rollout.service';
import { EdgeRolloutKind } from '../entities/edge-rollout.entity';

/**
 * Who may do what with a rollout (ADR-048 DEC-2.4), and that the person who approves
 * is the authenticated user and nobody the request names.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = { sub: 'user-7', email: 'op@example.com', tenantId: TENANT, roles: ['TENANT_ADMIN'] };
const TERMS = { localApproval: false, blockersOverride: false, maxOutageSeconds: 120 };
const BUNDLE = {
  version: '1.1.0',
  rollbackFloor: '1.0.0',
  minCurrentVersion: '1.0.0',
  supportedAgentAbi: '1-2',
  url: 'https://edge-releases.example.com/os/1.1.0/suderra-os-revpi-connect4-1.1.0.raucb',
  sha256: '33'.repeat(32),
  sizeBytes: 201326592,
};
const WAVES = [['00000000-0000-4000-8000-000000000001']];

describe('EdgeRolloutResolver', () => {
  const create = jest.fn();
  const approve = jest.fn();
  const cancel = jest.fn();
  let resolver: EdgeRolloutResolver;

  beforeEach(() => {
    jest.resetAllMocks();
    resolver = new EdgeRolloutResolver(
      collaborator<EdgeRolloutService>({ create, approve, cancel }, 'EdgeRolloutService'),
      collaborator<EdgeUpdateRequestService>({}, 'EdgeUpdateRequestService'),
      collaborator<EdgeDeviceService>({}, 'EdgeDeviceService'),
    );
  });

  const roles = (handler: keyof EdgeRolloutResolver): unknown =>
    Reflect.getMetadata(ROLES_KEY, EdgeRolloutResolver.prototype[handler]);
  const audited = (handler: keyof EdgeRolloutResolver): unknown =>
    Reflect.getMetadata(AUDITED_OPERATION_KEY, EdgeRolloutResolver.prototype[handler]);

  it('only a tenant administrator approves; planning and cancelling also open to the module manager', () => {
    expect(roles('approveEdgeRollout')).toEqual([Role.TENANT_ADMIN]);
    expect(roles('createEdgeRollout')).toEqual([Role.TENANT_ADMIN, Role.MODULE_MANAGER]);
    expect(roles('cancelEdgeRollout')).toEqual([Role.TENANT_ADMIN, Role.MODULE_MANAGER]);
  });

  it('every read is open to the tenant administrator and the module manager only', () => {
    for (const read of ['edgeRollouts', 'edgeRollout', 'edgeUpdateRequests'] as const) {
      expect(roles(read)).toEqual([Role.TENANT_ADMIN, Role.MODULE_MANAGER]);
    }
  });

  it('every mutation is an audited operation', () => {
    expect(audited('createEdgeRollout')).toMatchObject({
      resource: 'EdgeRollout',
      action: 'CREATE',
    });
    expect(audited('approveEdgeRollout')).toMatchObject({
      resource: 'EdgeRollout',
      action: 'APPROVE',
    });
    expect(audited('cancelEdgeRollout')).toMatchObject({
      resource: 'EdgeRollout',
      action: 'CANCEL',
    });
  });

  it('approves as the authenticated user, in the authenticated tenant', async () => {
    approve.mockResolvedValue({ id: 'r1' });
    await resolver.approveEdgeRollout(TENANT, USER, 'r1', 'ab'.repeat(32));
    expect(approve).toHaveBeenCalledWith(TENANT, 'user-7', 'r1', 'ab'.repeat(32));
  });

  it('cancels as the authenticated user', async () => {
    cancel.mockResolvedValue({ id: 'r1' });
    await resolver.cancelEdgeRollout(TENANT, USER, 'r1', 'wrong release');
    expect(cancel).toHaveBeenCalledWith(TENANT, 'user-7', 'r1', 'wrong release');
  });

  describe('createEdgeRollout', () => {
    const input = (over: Partial<CreateEdgeRolloutInput>): CreateEdgeRolloutInput => ({
      name: 'Canary',
      kind: EdgeRolloutKind.EDGE_UPDATE,
      version: '1.7.0',
      terms: TERMS,
      windowSeconds: 7200,
      maxFailures: 0,
      waves: WAVES,
      ...over,
    });

    it('plans an agent release as the authenticated user', async () => {
      create.mockResolvedValue({ id: 'r1' });
      await resolver.createEdgeRollout(TENANT, USER, input({}));
      expect(create).toHaveBeenCalledWith(TENANT, 'user-7', 'Canary', {
        kind: 'edge-update',
        version: '1.7.0',
        terms: TERMS,
        windowNotBefore: null,
        windowSeconds: 7200,
        maxFailures: 0,
        waves: WAVES,
      });
    });

    it('plans an OS bundle', async () => {
      create.mockResolvedValue({ id: 'r1' });
      await resolver.createEdgeRollout(
        TENANT,
        USER,
        input({ kind: EdgeRolloutKind.OS_UPDATE, version: undefined, osBundle: BUNDLE }),
      );
      expect(create).toHaveBeenCalledWith(
        TENANT,
        'user-7',
        'Canary',
        expect.objectContaining({ kind: 'os-update', bundle: BUNDLE }),
      );
    });

    it.each([
      ['an agent release without a version', { version: undefined }],
      ['an agent release that also names an OS bundle', { osBundle: BUNDLE }],
      ['an OS bundle without a bundle', { kind: EdgeRolloutKind.OS_UPDATE, version: undefined }],
      [
        'an OS bundle that also names a version',
        { kind: EdgeRolloutKind.OS_UPDATE, osBundle: BUNDLE },
      ],
    ])('refuses %s', async (_name, over) => {
      await expect(
        resolver.createEdgeRollout(TENANT, USER, input(over as Partial<CreateEdgeRolloutInput>)),
      ).rejects.toThrow(/names/);
      expect(create).not.toHaveBeenCalled();
    });
  });
});
