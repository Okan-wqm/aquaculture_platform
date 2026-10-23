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
  const heldTrustAnchors = jest.fn();
  let resolver: EdgeRolloutResolver;

  beforeEach(() => {
    jest.resetAllMocks();
    resolver = new EdgeRolloutResolver(
      collaborator<EdgeRolloutService>(
        { create, approve, cancel, heldTrustAnchors },
        'EdgeRolloutService',
      ),
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

    it('plans a site config from the operator’s files, with none as a refresh of config.yaml and the RBAC manifest', async () => {
      create.mockResolvedValue({ id: 'r1' });
      await resolver.createEdgeRollout(
        TENANT,
        USER,
        input({
          kind: EdgeRolloutKind.SITE_CONFIG,
          version: undefined,
          terms: undefined,
          siteFiles: [{ path: 'io-config.yaml', contentBase64: 'dGFnczogW10K' }],
        }),
      );
      expect(create).toHaveBeenLastCalledWith(
        TENANT,
        'user-7',
        'Canary',
        expect.objectContaining({
          kind: 'site-config',
          files: { 'io-config.yaml': 'dGFnczogW10K' },
        }),
      );
      await resolver.createEdgeRollout(
        TENANT,
        USER,
        input({ kind: EdgeRolloutKind.SITE_CONFIG, version: undefined, terms: undefined }),
      );
      expect(create).toHaveBeenLastCalledWith(
        TENANT,
        'user-7',
        'Canary',
        expect.objectContaining({ kind: 'site-config', files: {} }),
      );
    });

    it('plans a site policy only from a policy the contract admits', async () => {
      create.mockResolvedValue({ id: 'r1' });
      const policy = {
        interfaces: [],
        ot_rules: [
          { id: 'plc', proto: 'tcp', dst: '10.0.0.0/24', ports: [{ from: 502, to: 502 }] },
        ],
        time_sources: [],
      };
      await resolver.createEdgeRollout(
        TENANT,
        USER,
        input({
          kind: EdgeRolloutKind.SITE_NETPOLICY,
          version: undefined,
          terms: undefined,
          netpolicy: policy,
        }),
      );
      expect(create).toHaveBeenCalledWith(
        TENANT,
        'user-7',
        'Canary',
        expect.objectContaining({ kind: 'site-netpolicy', policy }),
      );
      for (const bad of [
        { ...policy, extra: [] },
        { ...policy, ot_rules: [{ id: 'X', proto: 'tcp', dst: '10.0.0.0/24', ports: [] }] },
        { interfaces: [] },
      ]) {
        await expect(
          resolver.createEdgeRollout(
            TENANT,
            USER,
            input({
              kind: EdgeRolloutKind.SITE_NETPOLICY,
              version: undefined,
              terms: undefined,
              netpolicy: bad,
            }),
          ),
        ).rejects.toThrow(/not one the contract admits/);
      }
    });

    it('plans the trust-anchors bundle the cloud holds, by its digest and bundle_seq, and nothing the caller names', async () => {
      create.mockResolvedValue({ id: 'r1' });
      heldTrustAnchors.mockReturnValue({ bundleDigest: 'ab'.repeat(32), bundleSeq: 4 });
      await resolver.createEdgeRollout(
        TENANT,
        USER,
        input({ kind: EdgeRolloutKind.TRUST_ANCHORS, version: undefined, terms: undefined }),
      );
      expect(heldTrustAnchors).toHaveBeenCalledWith(TENANT);
      expect(create).toHaveBeenCalledWith(
        TENANT,
        'user-7',
        'Canary',
        expect.objectContaining({
          kind: 'trust-anchors',
          bundleDigest: 'ab'.repeat(32),
          bundleSeq: 4,
        }),
      );
      await expect(
        resolver.createEdgeRollout(TENANT, USER, input({ kind: EdgeRolloutKind.TRUST_ANCHORS })),
      ).rejects.toThrow(/does not take version or terms/);
    });

    it.each([
      [
        'a site config that names a version',
        { kind: EdgeRolloutKind.SITE_CONFIG, terms: undefined },
      ],
      ['a site config that names terms', { kind: EdgeRolloutKind.SITE_CONFIG, version: undefined }],
      [
        'a site policy without a policy',
        { kind: EdgeRolloutKind.SITE_NETPOLICY, version: undefined, terms: undefined },
      ],
    ])('refuses %s', async (_name, over) => {
      await expect(
        resolver.createEdgeRollout(TENANT, USER, input(over as Partial<CreateEdgeRolloutInput>)),
      ).rejects.toThrow(/needs|does not take/);
      expect(create).not.toHaveBeenCalled();
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
      ).rejects.toThrow(/needs|does not take/);
      expect(create).not.toHaveBeenCalled();
    });
  });
});
