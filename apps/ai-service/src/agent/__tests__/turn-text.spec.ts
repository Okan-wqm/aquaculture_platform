import { OutputPiiScannerService } from '@aquaculture/backend-common/ai-safety';

import type { OutputSafetyStream } from '../../safety/ai-safety.middleware';
import { TurnText } from '../turn-text';

const TENANT = '00000000-0000-4000-8000-000000000001';

/** The output stage as AiSafetyMiddleware builds it with redaction on. */
function redacting(): OutputSafetyStream {
  const redaction = new OutputPiiScannerService().redactStream(TENANT);
  return {
    push: (text) => redaction.push(text),
    end: () => {
      const { text, scanResult } = redaction.end();
      return { outputText: text, piiScan: scanResult, piiRedacted: scanResult.hasPii };
    },
  };
}

describe('TurnText', () => {
  it('joins the text blocks with a newline, as the stored reply joins them', () => {
    const released: string[] = [];
    const turn = new TurnText(redacting(), (text) => released.push(text));

    turn.add({ block: 0, text: 'Tank 4 is ' });
    turn.add({ block: 0, text: 'fine.' });
    turn.add({ block: 2, text: 'Feed at noon.' });

    expect(turn.end().text).toBe('Tank 4 is fine.\nFeed at noon.');
    expect(released.join('')).toBe('Tank 4 is fine.\nFeed at noon.');
  });

  it('releases only safe text, and what it released is what it returns', () => {
    const released: string[] = [];
    const turn = new TurnText(redacting(), (text) => released.push(text));

    turn.add({ block: 0, text: 'Ask ops@exa' });
    expect(released).toEqual(['Ask ']);
    turn.add({ block: 0, text: 'mple.com today' });

    const { text, safety } = turn.end();
    expect(text).toBe('Ask [REDACTED] today');
    expect(released.join('')).toBe(text);
    expect(safety.piiRedacted).toBe(true);
  });

  it('returns empty text for a turn that wrote none, and releases nothing', () => {
    const onRelease = jest.fn();
    expect(new TurnText(redacting(), onRelease).end().text).toBe('');
    expect(onRelease).not.toHaveBeenCalled();
  });
});
