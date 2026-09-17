import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

import { OpenAiProvider } from './openai.provider';
import type { LlmProviderId } from './llm-provider.interface';

/**
 * Z.ai (Zhipu GLM) provider (BYOK) — the tenant's OWN key, their bill.
 *
 * Z.ai exposes an OpenAI-COMPATIBLE Chat Completions API at
 * https://api.z.ai/api/paas/v4, so this provider extends OpenAiProvider and
 * overrides ONLY the client construction (baseURL + defaultHeaders). The
 * entire normalized-contract translation (tool_use/tool_result flattening,
 * stop-reason mapping, streaming-free chat) is inherited unchanged — the
 * agent loop and every guard see a third first-class provider with zero
 * duplicated translation logic.
 *
 * Default model: the persona defaults are Anthropic-named; agent-profile
 * resolution maps provider `zai` without a tenant chatModel override to
 * ZAI_DEFAULT_MODEL ('glm-4.6').
 */
export const ZAI_DEFAULT_MODEL = 'glm-4.6';

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

@Injectable()
export class ZaiProvider extends OpenAiProvider {
  override readonly id: 'zai' = 'zai';
  protected override readonly logger = new Logger('ZaiProvider');

  protected override newClient(apiKey: string): OpenAI {
    return new OpenAI({ apiKey, baseURL: ZAI_BASE_URL });
  }

  /**
   * Credential probe override: the OpenAI-compatible models.list endpoint is
   * not guaranteed to exist on every relay — a 404 there means "endpoint
   * absent", NOT "bad key". 401 remains a hard reject; everything else is
   * transient (not a key verdict), exactly like the parent.
   */
  override async validateCredential(credential: {
    provider: LlmProviderId;
    apiKey: string;
  }): Promise<boolean> {
    try {
      return await super.validateCredential(credential);
    } catch (err) {
      if (err instanceof OpenAI.NotFoundError) {
        this.logger.warn(
          'Z.ai key probe hit 404 on models.list (relay endpoint absent) — accepting the key as valid',
        );
        return true;
      }
      throw err;
    }
  }
}
