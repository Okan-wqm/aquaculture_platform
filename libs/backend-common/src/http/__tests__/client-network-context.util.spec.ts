import type {
  TenantRequest,
  VerifiedServiceIdentity,
} from '../../types/tenant-request.interface';
import { resolveClientNetworkContext } from '../client-network-context.util';

const GATEWAY_IDENTITY: VerifiedServiceIdentity = {
  serviceName: 'gateway-api',
  tenantId: '',
  effectiveTenantId: '',
  keyId: 'gateway-2026-05',
  nonce: 'nonce-1',
  version: 'v2',
};

function req(overrides: Partial<TenantRequest>): TenantRequest {
  return {
    ip: '::ffff:172.18.0.25', // the gateway container — the value that must NOT win
    headers: {},
    ...overrides,
  } as TenantRequest;
}

describe('resolveClientNetworkContext (ORPHAN-MEDIUM-319)', () => {
  it('tier 1: prefers the SIGNED assertion claim over everything else', () => {
    const ctx = resolveClientNetworkContext(
      req({
        verifiedIdentity: GATEWAY_IDENTITY,
        verifiedUserAssertion: {
          issuer: 'gateway-api',
          subject: 'user-1',
          tenantId: null,
          effectiveTenantId: null,
          roles: [],
          email: null,
          mfaVerified: false,
          issuedAt: new Date().toISOString(),
          clientIp: '193.212.164.37',
          clientUserAgent: 'Mozilla/5.0',
        },
        headers: { 'x-client-ip': '9.9.9.9', 'x-client-user-agent': 'other' },
      }),
    );
    expect(ctx).toEqual({
      ip: '193.212.164.37',
      userAgent: 'Mozilla/5.0',
      source: 'gateway-assertion',
    });
  });

  it('tier 2: trusts the gateway-minted header behind a VERIFIED gateway identity (pre-auth login path)', () => {
    const ctx = resolveClientNetworkContext(
      req({
        verifiedIdentity: GATEWAY_IDENTITY,
        headers: {
          'x-client-ip': '193.212.164.37',
          'x-client-user-agent': 'Mozilla/5.0 (Windows NT 10.0)',
        },
      }),
    );
    expect(ctx).toEqual({
      ip: '193.212.164.37',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      source: 'gateway-header',
    });
  });

  it('tier 2 gate: IGNORES x-client-ip without a verified gateway identity (spoof attempt)', () => {
    const ctx = resolveClientNetworkContext(
      req({
        headers: { 'x-client-ip': '6.6.6.6', 'user-agent': 'curl/8.5.0' },
      }),
    );
    expect(ctx).toEqual({
      ip: '::ffff:172.18.0.25',
      userAgent: 'curl/8.5.0',
      source: 'direct',
    });
  });

  it('tier 2 gate: IGNORES x-client-ip from a NON-gateway verified caller', () => {
    const ctx = resolveClientNetworkContext(
      req({
        verifiedIdentity: { ...GATEWAY_IDENTITY, serviceName: 'billing_service' },
        headers: { 'x-client-ip': '6.6.6.6' },
      }),
    );
    expect(ctx.source).toBe('direct');
    expect(ctx.ip).toBe('::ffff:172.18.0.25');
  });

  it('tier 3: direct connections use the socket peer and genuine user-agent', () => {
    const ctx = resolveClientNetworkContext(
      req({ ip: '10.0.0.7', headers: { 'user-agent': 'jest' } }),
    );
    expect(ctx).toEqual({ ip: '10.0.0.7', userAgent: 'jest', source: 'direct' });
  });

  it('handles array-valued headers (first value wins) and missing ip', () => {
    const ctx = resolveClientNetworkContext(
      req({
        ip: undefined,
        verifiedIdentity: GATEWAY_IDENTITY,
        headers: { 'x-client-ip': ['193.212.164.37', '8.8.8.8'] },
      }),
    );
    expect(ctx.ip).toBe('193.212.164.37');
    expect(ctx.source).toBe('gateway-header');
  });
});
