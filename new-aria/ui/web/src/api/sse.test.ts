import { describe, expect, it } from 'vitest';
import { createSseParser, parseGovernanceRow, type SseMessage } from './sse.ts';

function collect(): { messages: SseMessage[]; parser: ReturnType<typeof createSseParser> } {
  const messages: SseMessage[] = [];
  const parser = createSseParser((message) => messages.push(message));
  return { messages, parser };
}

describe('createSseParser', () => {
  it('dispatches a data line on the blank-line boundary', () => {
    const { messages, parser } = collect();
    parser.push('data: {"event":"cycle_started"}\n\n');
    expect(messages).toEqual([{ event: null, data: '{"event":"cycle_started"}', id: null }]);
  });

  it('reassembles lines split across chunks', () => {
    const { messages, parser } = collect();
    parser.push('data: {"eve');
    parser.push('nt":"a"}\n');
    expect(messages).toHaveLength(0);
    parser.push('\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('{"event":"a"}');
  });

  it('joins multi-line data with newline, honours event/id fields and ignores comments', () => {
    const { messages, parser } = collect();
    parser.push(': keep-alive\nevent: governance\nid: 7\ndata: line1\ndata: line2\n\n');
    expect(messages).toEqual([{ event: 'governance', data: 'line1\nline2', id: '7' }]);
  });

  it('tolerates CRLF line endings and a missing space after the colon', () => {
    const { messages, parser } = collect();
    parser.push('data:{"x":1}\r\n\r\n');
    expect(messages[0]?.data).toBe('{"x":1}');
  });

  it('flush() dispatches a trailing message with no final blank line', () => {
    const { messages, parser } = collect();
    parser.push('data: tail');
    expect(messages).toHaveLength(0);
    parser.flush();
    expect(messages).toEqual([{ event: null, data: 'tail', id: null }]);
  });

  it('does not dispatch empty events (blank line without data)', () => {
    const { messages, parser } = collect();
    parser.push('event: ping\n\n');
    expect(messages).toHaveLength(0);
  });
});

describe('parseGovernanceRow', () => {
  it('accepts objects with a string event field', () => {
    const row = parseGovernanceRow('{"event":"profile_changed","at":"2026-09-03T00:00:00Z","details":{"to":"strict"}}');
    expect(row?.event).toBe('profile_changed');
    expect(row?.details).toEqual({ to: 'strict' });
  });

  it('rejects malformed JSON and rows without an event', () => {
    expect(parseGovernanceRow('not json')).toBeNull();
    expect(parseGovernanceRow('{"at":"x"}')).toBeNull();
    expect(parseGovernanceRow('[1,2]')).toBeNull();
  });
});
