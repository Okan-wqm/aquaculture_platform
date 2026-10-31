import type { AiChatReplyFrame, AiChatResultFrame } from '@aquaculture/shared-contracts';
import { lastValueFrom, type Observable } from 'rxjs';

/** The result frame a `request.ai.chat` reply ends with. */
export async function resultOf(frames: Observable<AiChatReplyFrame>): Promise<AiChatResultFrame> {
  const last = await lastValueFrom(frames);
  if (last.type !== 'result') {
    throw new Error(`the reply ended with a ${last.type} frame, not the result`);
  }
  return last;
}
