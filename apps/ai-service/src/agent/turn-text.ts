import type { OutputSafetyStream, PostProcessResult } from '../safety/ai-safety.middleware';
import type { LlmTextDelta } from './providers/llm-provider.interface';

/**
 * One model turn's text on its way to the user. The provider's deltas are
 * joined as the turn's text is (its text blocks separated by '\n'), passed
 * through the output safety stage, and released as they become final.
 * Everything released, joined, is the turn's safe text: what the user
 * watched being written is what `end` returns to be stored.
 */
export class TurnText {
  private block: number | null = null;
  private released = '';

  constructor(
    private readonly safety: OutputSafetyStream,
    private readonly onRelease: (text: string) => void,
  ) {}

  add(delta: LlmTextDelta): void {
    const separator = this.block !== null && delta.block !== this.block ? '\n' : '';
    this.block = delta.block;
    this.release(this.safety.push(separator + delta.text));
  }

  /** The turn is over: releases the rest and returns the whole safe text. */
  end(): { text: string; safety: PostProcessResult } {
    const safety = this.safety.end();
    this.release(safety.outputText);
    return { text: this.released, safety };
  }

  private release(text: string): void {
    if (text === '') {
      return;
    }
    this.released += text;
    this.onRelease(text);
  }
}
