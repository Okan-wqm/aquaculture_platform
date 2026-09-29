import type {
  LlmChatParams,
  LlmChatResult,
  LlmResultBlock,
} from '../../../../apps/ai-service/src/agent/providers/llm-provider.interface';

const USAGE = { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 };

/** A model turn that calls one tool. */
export function toolCall(id: string, name: string, input: Record<string, unknown>): LlmChatResult {
  const block: LlmResultBlock = { type: 'tool_use', id, name, input };
  return { content: [block], stopReason: 'tool_use', usage: USAGE };
}

/** The model's closing turn. */
export function finalAnswer(text: string): LlmChatResult {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: USAGE };
}

/**
 * The attacking "model": replays a scripted list of turns — the tool calls a
 * model steered by a leak, a guess or a prompt injection would make — and
 * records every message list it is shown.
 *
 * WHY scripted instead of a real model: the boundary must hold for ANY model
 * output. A script lets the spec name the exact hostile call and assert on
 * the exact text that came back, with no sampling in the proof.
 */
export class ScriptedAttacker {
  private readonly script: LlmChatResult[];
  /** Every `messages` array the runner sent, serialised at call time. */
  readonly shown: string[] = [];

  readonly chat = jest.fn((params: LlmChatParams): Promise<LlmChatResult> => {
    this.shown.push(JSON.stringify(params.messages));
    const next = this.script.shift();
    if (next === undefined) {
      return Promise.reject(new Error('the attacker script ran out of turns'));
    }
    return Promise.resolve(next);
  });

  constructor(script: readonly LlmChatResult[]) {
    this.script = [...script];
  }

  /** Everything the model was ever shown, as one string. */
  get everythingShown(): string {
    return this.shown.join('\n');
  }
}
