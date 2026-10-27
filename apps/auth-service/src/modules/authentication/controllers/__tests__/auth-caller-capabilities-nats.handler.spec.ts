import { Test } from '@nestjs/testing';
import {
  AUTH_USER_QUERY_SUBJECTS,
  type ResolveCallerCapabilitiesQuery,
  validateResolveCallerCapabilitiesResultSchema,
} from '@platform/event-contracts';

import { TokenService } from '../../services/token.service';
import { AuthCallerCapabilitiesNatsHandler } from '../auth-caller-capabilities-nats.handler';

/**
 * MSGFIX-FAZ2 2.3 — request.auth.user.resolveCallerCapabilities responder.
 *
 * Pins the no-oracle posture inherited from the membership queries:
 *   - AJV trust-boundary rejection (extra keys / bad shapes) BEFORE any read
 *   - tenant-scoped miss (`found:false`) identical for nonexistent and
 *     cross-tenant users
 *   - authorization-read failures surface success:false (callers fail closed)
 *   - the reply carries ONLY roles + resourcePermissions codes (no PII)
 */
describe('AuthCallerCapabilitiesNatsHandler (MSGFIX-FAZ2)', () => {
  const TENANT_ID = '11111111-1111-4111-8111-111111111111';
  const USER_ID = '22222222-2222-4222-8222-222222222222';

  const resolveCallerCapabilities = jest.fn();

  const validPayload: ResolveCallerCapabilitiesQuery = {
    tenantId: TENANT_ID,
    userId: USER_ID,
  };

  let handler: AuthCallerCapabilitiesNatsHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthCallerCapabilitiesNatsHandler,
        { provide: TokenService, useValue: { resolveCallerCapabilities } },
      ],
    }).compile();
    handler = moduleRef.get(AuthCallerCapabilitiesNatsHandler);
  });

  it('exposes the SSoT subject', () => {
    expect(AUTH_USER_QUERY_SUBJECTS.RESOLVE_CALLER_CAPABILITIES).toBe(
      'request.auth.user.resolveCallerCapabilities',
    );
  });

  it('maps the TokenService resolution through unchanged (no PII added)', async () => {
    resolveCallerCapabilities.mockResolvedValue({
      found: true,
      active: true,
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use', 'ai_personas:operator'],
    });

    const result = await handler.resolveCallerCapabilities(validPayload);

    expect(resolveCallerCapabilities).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(result).toEqual({
      success: true,
      found: true,
      active: true,
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use', 'ai_personas:operator'],
    });
  });

  it('reports found:false for a tenant-scoped miss (nonexistent OR cross-tenant)', async () => {
    resolveCallerCapabilities.mockResolvedValue({
      found: false,
      active: false,
      roles: [],
      resourcePermissions: [],
    });

    const result = await handler.resolveCallerCapabilities(validPayload);

    expect(result).toEqual({
      success: true,
      found: false,
      active: false,
      roles: [],
      resourcePermissions: [],
    });
  });

  it('rejects malformed payloads before any TokenService read (trust boundary)', async () => {
    // Deliberately malformed (extra key). Hoisting to a const avoids the
    // excess-property check: the object structurally satisfies the required
    // members, so NO cast is needed at all — the extra key rides along to the
    // AJV boundary where additionalProperties:false must reject it.
    const malformed = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      // extra key — additionalProperties:false must reject it
      resourcePermissions: ['ai_personas:supervisor'],
    };
    const result = await handler.resolveCallerCapabilities(malformed);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    expect(resolveCallerCapabilities).not.toHaveBeenCalled();
  });

  it('surfaces authorization-read failures as success:false INTERNAL_ERROR (fail closed)', async () => {
    resolveCallerCapabilities.mockRejectedValue(new Error('db down'));

    const result = await handler.resolveCallerCapabilities(validPayload);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INTERNAL_ERROR');
    expect(result.roles).toEqual([]);
    expect(result.resourcePermissions).toEqual([]);
    // RBAC-HIGH-028: a failure grants no module and no site.
    expect(result.moduleAccess).toEqual({});
    expect(result.assignedSiteIds).toEqual([]);
  });

  // RBAC-HIGH-028: the messaging AI bridge has no JWT; this reply is where it reads the sender's
  // module grants and sites, the same ones a fresh token would carry.
  it('answers the module grants and the sites the token mint would carry', async () => {
    resolveCallerCapabilities.mockResolvedValue({
      found: true,
      active: true,
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use'],
      moduleAccess: { farm: 'MODULE_USER' },
      assignedSiteIds: ['33333333-3333-4333-8333-333333333333'],
    });

    const result = await handler.resolveCallerCapabilities(validPayload);

    expect(result).toEqual({
      success: true,
      found: true,
      active: true,
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use'],
      moduleAccess: { farm: 'MODULE_USER' },
      assignedSiteIds: ['33333333-3333-4333-8333-333333333333'],
    });
    expect(validateResolveCallerCapabilitiesResultSchema(result)).toBe(true);
  });

  it('answers a schema-valid reply with no grant on a validation failure', async () => {
    const result = await handler.resolveCallerCapabilities({
      tenantId: 'not-a-uuid',
      userId: USER_ID,
    });

    expect(result.moduleAccess).toEqual({});
    expect(result.assignedSiteIds).toEqual([]);
    expect(validateResolveCallerCapabilitiesResultSchema(result)).toBe(true);
  });
});
