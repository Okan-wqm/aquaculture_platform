import { BypassRlsService } from '@aquaculture/backend-common/database';
import { getRequestContext } from '@aquaculture/backend-common/logging';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AuthPayload } from '../dto/auth-response.dto';
import { User } from '../entities/user.entity';
import { PreAuthRlsFrameService } from '../services/pre-auth-rls-frame.service';
import { TokenService, type GenerateTokensOptions } from '../services/token.service';

/**
 * The pre-auth RLS boundary's own contract (SEC-HIGH-196/197, PROC-HIGH-048).
 *
 * AuthenticationService's specs pin WHERE the frame is used (operation names,
 * mint arguments); this suite pins WHAT the frame does: token flows delegate
 * to the audited BypassRlsService with the closed `auth-service:` label set,
 * tenant-principal mints run inside a tenant-scoped request frame WITHOUT any
 * bypass, platform-principal mints take the audited bypass, and
 * runTenantCredentialWrite binds the tenant context before the work runs.
 */
describe('PreAuthRlsFrameService (the pre-auth RLS boundary)', () => {
  const tenantUser = Object.assign(new User(), {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    isActive: true,
  });
  const platformUser = Object.assign(new User(), {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: null,
    isActive: true,
  });

  let bypassRls: BypassRlsService;
  let withBypassSpy: jest.SpyInstance;
  let frame: PreAuthRlsFrameService;
  let generateTokens: jest.Mock;
  let transaction: jest.Mock;
  let boundQueries: string[];

  beforeEach(async () => {
    generateTokens = jest.fn().mockResolvedValue({ accessToken: 'a' } as AuthPayload);
    boundQueries = [];
    transaction = jest.fn(async (work: (manager: { query: jest.Mock }) => Promise<unknown>) =>
      work({
        query: jest.fn(async (sql: string) => {
          boundQueries.push(sql);
          return undefined;
        }),
      }),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        BypassRlsService,
        PreAuthRlsFrameService,
        { provide: TokenService, useValue: { generateTokens } },
        { provide: DataSource, useValue: { transaction } },
      ],
    }).compile();
    bypassRls = moduleRef.get(BypassRlsService);
    frame = moduleRef.get(PreAuthRlsFrameService);
    // Forward through the real service so call sites under test keep working,
    // while the arguments stay observable for the label assertions below.
    withBypassSpy = jest.spyOn(bypassRls, 'withBypass');
    withBypassSpy.mockImplementation(async (_operation: string, callback: () => unknown) =>
      callback(),
    );
  });

  describe('runPreAuthTokenFlow', () => {
    const OPERATIONS = [
      'invitation-validation',
      'invitation-redemption',
      'password-reset-request',
      'password-reset-redemption',
    ] as const;
    it.each(OPERATIONS)(
      'delegates %s to the audited bypass with the service-prefixed label',
      async (operation: (typeof OPERATIONS)[number]) => {
        const work = jest.fn().mockResolvedValue('resolved');
        await expect(frame.runPreAuthTokenFlow(operation, work)).resolves.toBe('resolved');
        expect(work).toHaveBeenCalledTimes(1);
        expect(withBypassSpy).toHaveBeenCalledWith(
          `auth-service:${operation}`,
          expect.any(Function),
        );
      },
    );
  });

  describe('mintTokensForPrincipal', () => {
    it('mints a tenant principal inside a tenant-scoped frame, with NO bypass', async () => {
      generateTokens.mockImplementation(async () => {
        // Probe: inside the mint, the request context must carry the tenant.
        expect(getRequestContext().tenantId).toBe(tenantUser.tenantId);
        expect(getRequestContext().userId).toBe(tenantUser.id);
        return { accessToken: 'a' } as AuthPayload;
      });

      await frame.mintTokensForPrincipal(tenantUser, '10.0.0.1', 'jest');

      expect(generateTokens).toHaveBeenCalledWith(tenantUser, '10.0.0.1', 'jest', undefined);
      expect(withBypassSpy).not.toHaveBeenCalled();
    });

    it('mints a platform principal under the audited platform-session-mint bypass', async () => {
      await frame.mintTokensForPrincipal(platformUser, '10.0.0.2');

      expect(withBypassSpy).toHaveBeenCalledWith(
        'auth-service:platform-session-mint',
        expect.any(Function),
      );
      expect(generateTokens).toHaveBeenCalledWith(platformUser, '10.0.0.2', undefined, undefined);
    });

    it('forwards mint options untouched', async () => {
      const options: GenerateTokensOptions = { mfaVerified: true, rememberMe: true };
      await frame.mintTokensForPrincipal(tenantUser, undefined, undefined, options);
      expect(generateTokens).toHaveBeenCalledWith(tenantUser, undefined, undefined, options);
    });
  });

  describe('runTenantCredentialWrite', () => {
    it('binds the tenant context transaction-locally BEFORE the work runs', async () => {
      const seen: string[] = [];
      await frame.runTenantCredentialWrite(tenantUser.tenantId as string, async (manager) => {
        seen.push(...boundQueries);
        return 'written';
      });

      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen[0]).toContain('set_config');
      expect(transaction).toHaveBeenCalledTimes(1);
    });
  });
});
