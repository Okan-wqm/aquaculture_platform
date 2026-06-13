/**
 * AiEgressGateService — the single fail-closed boundary for tenant content
 * leaving messaging toward any AI system.
 *
 * WHY: consent enforcement was duplicated across every egress path
 * (sentiment analysis, embedding, …), each re-implementing the
 * `AiPrivacyService.canAnalyzeMessage` check with its own ad-hoc handling
 * (one `if (!canAnalyze) return`, one inline `.catch(() => false)`). A
 * scattered gate is a gate you can forget to add. This service makes the
 * dual-consent check a single SSoT that every AI egress path routes
 * through.
 *
 * WHAT: `assertAllowed` throws ForbiddenException when consent is absent or
 * uncertain (the privacy check rejecting OR erroring both deny — consent
 * uncertainty is denial, never a fail-open). `isAllowed` is the boolean
 * convenience for batch paths that filter rather than throw. Callers MUST
 * route AI egress through one of these two methods and MUST NOT re-add a
 * local try/catch fallback that swallows a denial into an allow.
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { AiPrivacyService } from './ai-privacy.service';

/** The AI-egress purpose, for audit-grade denial logging. */
export type AiEgressPurpose =
  | 'sentiment'
  | 'semantic-search'
  | 'ai-chat'
  | 'custom-ai-chat'
  | 'knowledge-extraction'
  | 'embedding'
  | 'ai-action';

@Injectable()
export class AiEgressGateService {
  private readonly logger = new Logger(AiEgressGateService.name);

  constructor(private readonly privacyService: AiPrivacyService) {}

  /**
   * Throw ForbiddenException unless the (tenant, user) pair has consented to
   * AI processing. Consent uncertainty (the privacy check throwing) is
   * treated as denial — fail-closed.
   */
  async assertAllowed(
    tenantId: string,
    userId: string,
    purpose: AiEgressPurpose,
  ): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.privacyService.canAnalyzeMessage(tenantId, userId);
    } catch (error) {
      // A failure to resolve consent is NOT permission — fail closed.
      this.logger.warn(
        `AI egress consent check errored (treated as denial): ` +
          `tenant=${tenantId} user=${userId} purpose=${purpose} — ` +
          `${(error as Error).message}`,
      );
      throw new ForbiddenException('AI processing consent is required');
    }
    if (!allowed) {
      this.logger.debug(
        `AI egress denied: tenant=${tenantId} user=${userId} purpose=${purpose}`,
      );
      throw new ForbiddenException('AI processing consent is required');
    }
  }

  /**
   * Boolean form for batch paths that filter consented items rather than
   * throw. Encapsulates the fail-closed try/catch so callers stop
   * hand-rolling `.catch(() => false)`.
   */
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
