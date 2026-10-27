import type { ModuleAccess } from '@aquaculture/shared-contracts';

import {
  buildGatewayVerifiedUserAssertion,
  type GatewayVerifiedUserAssertionInput,
} from '../gateway-verified-user-assertion';

/** The keys of T a value must name (an optional key may be left out). */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Compile-time row: every assertion builder names the claim. A gateway call site that forgets
 * `moduleAccess` does not compile, so no route can drop the grants on the way to a subgraph.
 */
const moduleAccessIsRequired: 'moduleAccess' extends RequiredKeys<GatewayVerifiedUserAssertionInput>
  ? true
  : false = true;

function decode(assertion: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(assertion, 'base64url').toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  return { ...parsed };
}

/**
 * RBAC-HIGH-028 (ADR-051 §2 Transport): the gateway assertion always carries `moduleAccess`,
 * inside the base64 body the X-Service-Assertion-Hash binds into the service-identity HMAC —
 * `{}` when the caller holds no grant, so a subgraph never has to tell "no grants" from "a
 * gateway that dropped them".
 */
describe('buildGatewayVerifiedUserAssertion — moduleAccess (RBAC-HIGH-028)', () => {
  it('requires every builder to name the claim', () => {
    expect(moduleAccessIsRequired).toBe(true);
  });

  it('carries the grants it is given', () => {
    const grants: ModuleAccess = { farm: 'MODULE_MANAGER', sensor: 'MODULE_USER' };

    const assertion = decode(
      buildGatewayVerifiedUserAssertion({ subject: 'user-1', moduleAccess: grants }),
    );

    expect(assertion['moduleAccess']).toEqual({ farm: 'MODULE_MANAGER', sensor: 'MODULE_USER' });
  });

  it('carries an empty claim, never none, for a token that predates moduleAccess', () => {
    const assertion = decode(
      buildGatewayVerifiedUserAssertion({ subject: 'user-1', moduleAccess: undefined }),
    );

    expect(assertion['moduleAccess']).toEqual({});
  });
});
