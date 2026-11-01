import type { PostProcessResult, OutputSafetyStream } from '../../../safety/ai-safety.middleware';
import type {
  LlmChatParams,
  LlmChatResult,
  LlmCredential,
} from '../../providers/llm-provider.interface';

type ProviderChat = (params: LlmChatParams, credential: LlmCredential) => Promise<LlmChatResult>;

/**
 * A provider double that keeps the streaming contract: it streams the text
 * blocks of the result `chat` returns to `onText`, as every real provider
 * does. `chat` stays the spy a spec programs and inspects.
 */
export function streamsItsText(chat: ProviderChat): ProviderChat {
  return async (params, credential) => {
    const result = await chat(params, credential);
    result.content.forEach((block, index) => {
      if (block.type === 'text') params.onText({ block: index, text: block.text });
    });
    return result;
  };
}

/** The output safety stage with nothing to redact; `piiRedacted` reports as given. */
export function passThroughOutput(report: Partial<PostProcessResult> = {}): OutputSafetyStream {
  return {
    push: (text) => text,
    end: () => ({ outputText: '', piiRedacted: false, ...report }),
  };
}
