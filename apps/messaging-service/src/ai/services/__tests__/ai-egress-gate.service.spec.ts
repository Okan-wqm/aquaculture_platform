/**
 * AiEgressGateService — the single fail-closed AI-egress consent boundary.
 *
 * Pins the three behaviours that make it a trustworthy SSoT:
 *   1. consent granted  -> assertAllowed resolves / isAllowed true
 *   2. consent denied    -> assertAllowed throws Forbidden / isAllowed false
 *   3. consent UNCERTAIN (privacy check errors) -> denial, never fail-open
 */
import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiEgressGateService } from '../ai-egress-gate.service';
import { AiPrivacyService } from '../ai-privacy.service';

describe('AiEgressGateService', () => {
  let service: AiEgressGateService;
  let privacyService: jest.Mocked<Pick<AiPrivacyService, 'canAnalyzeMessage'>>;

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  beforeEach(async () => {
    privacyService = {
      canAnalyzeMessage: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiEgressGateService,
        { provide: AiPrivacyService, useValue: privacyService },
      ],
    }).compile();

    service = module.get(AiEgressGateService);
  });

  describe('assertAllowed', () => {
    it('resolves when consent is granted', async () => {
      privacyService.canAnalyzeMessage.mockResolvedValue(true);
      await expect(
        service.assertAllowed(TENANT, USER, 'sentiment'),
      ).resolves.toBeUndefined();
      expect(privacyService.canAnalyzeMessage).toHaveBeenCalledWith(TENANT, USER);
    });

    it('throws ForbiddenException when consent is denied', async () => {
      privacyService.canAnalyzeMessage.mockResolvedValue(false);
      await expect(
        service.assertAllowed(TENANT, USER, 'embedding'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('fails closed (throws) when the consent check itself errors', async () => {
      privacyService.canAnalyzeMessage.mockRejectedValue(new Error('redis down'));
      await expect(
        service.assertAllowed(TENANT, USER, 'semantic-search'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('isAllowed', () => {
    it('returns true when consent is granted', async () => {
      privacyService.canAnalyzeMessage.mockResolvedValue(true);
      await expect(service.isAllowed(TENANT, USER, 'sentiment')).resolves.toBe(true);
    });

    it('returns false when consent is denied', async () => {
      privacyService.canAnalyzeMessage.mockResolvedValue(false);
      await expect(service.isAllowed(TENANT, USER, 'embedding')).resolves.toBe(false);
    });

    it('returns false (fail closed) when the consent check errors', async () => {
      privacyService.canAnalyzeMessage.mockRejectedValue(new Error('redis down'));
      await expect(
        service.isAllowed(TENANT, USER, 'embedding'),
      ).resolves.toBe(false);
    });
  });
});
