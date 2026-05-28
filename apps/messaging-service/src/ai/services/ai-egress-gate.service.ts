import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { AiPrivacyService } from './ai-privacy.service';

export type AiEgressPurpose =
  | 'sentiment'
  | 'semantic-search'
  | 'ai-chat'
  | 'custom-ai-chat'
  | 'knowledge-extraction'
  | 'embedding'
  | 'ai-action';

/**
 * Central fail-closed boundary for all tenant content leaving messaging
 * toward an AI system. Consent uncertainty is denial; callers must not
 * bypass this with local try/catch fallbacks.
 */
@Injectable()
export class AiEgressGateService {
  private readonly logger = new Logger(AiEgressGateService.name);

  constructor(private readonly privacyService: AiPrivacyService) {}

  async assertAllowed(
    tenantId: string,
    userId: string,
    purpose: AiEgressPurpose,
  ): Promise<void> {
    const allowed = await this.privacyService.canAnalyzeMessage(tenantId, userId);
    if (!allowed) {
      this.logger.warn(
        `AI egress denied: tenant=${tenantId} user=${userId} purpose=${purpose}`,
      );
      throw new ForbiddenException('AI processing consent is required');
    }
  }

  async isAllowed(
    tenantId: string,
    userId: string,
    purpose: AiEgressPurpose,
  ): Promise<boolean> {
    try {
      await this.assertAllowed(tenantId, userId, purpose);
      return true;
    } catch {
      return false;
    }
  }
}
