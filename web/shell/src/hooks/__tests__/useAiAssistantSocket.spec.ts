/**
 * useAiAssistantSocket persona threading (FE-MEDIUM-065): the pinned persona
 * rides on every `ai:chat` emit (null = tenant default), and switching persona
 * starts a fresh conversation — ai-service pins a conversation to the persona
 * that opened it.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emit, handlers } = vi.hoisted(() => ({
  emit: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    },
    emit,
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
  }),
}));

vi.mock('@aquaculture/shared-ui', () => ({
  useAuth: () => ({ token: 'jwt', isAuthenticated: true }),
}));

import { useAiAssistantSocket } from '../useAiAssistantSocket';

describe('useAiAssistantSocket persona', () => {
  beforeEach(() => {
    emit.mockClear();
    handlers.clear();
  });

  it('emits persona: null until one is pinned, then the pinned id', () => {
    const { result } = renderHook(() => useAiAssistantSocket(true));

    act(() => result.current.sendMessage('hello'));
    expect(emit).toHaveBeenLastCalledWith('ai:chat', {
      message: 'hello',
      conversationId: undefined,
      persona: null,
    });

    act(() => result.current.setPersona('expert-farm-production-v1'));
    act(() => result.current.sendMessage('fcr?'));
    expect(emit).toHaveBeenLastCalledWith('ai:chat', {
      message: 'fcr?',
      conversationId: undefined,
      persona: 'expert-farm-production-v1',
    });
    expect(result.current.persona).toBe('expert-farm-production-v1');
  });

  it('switching persona drops the conversation id and the transcript', () => {
    const { result } = renderHook(() => useAiAssistantSocket(true));
    act(() => result.current.sendMessage('hello'));
    act(() => handlers.get('ai:response')?.({ content: 'hi', conversationId: 'c1' }));
    expect(result.current.messages).toHaveLength(2);

    act(() => result.current.sendMessage('more'));
    expect(emit).toHaveBeenLastCalledWith(
      'ai:chat',
      expect.objectContaining({ conversationId: 'c1' }),
    );

    act(() => result.current.setPersona('operator-farm-operations-v1'));
    expect(result.current.messages).toEqual([]);

    act(() => result.current.sendMessage('tasks today'));
    expect(emit).toHaveBeenLastCalledWith('ai:chat', {
      message: 'tasks today',
      conversationId: undefined,
      persona: 'operator-farm-operations-v1',
    });
  });

  it('re-selecting the current persona keeps the conversation', () => {
    const { result } = renderHook(() => useAiAssistantSocket(true));
    act(() => result.current.setPersona('manager-v1'));
    act(() => result.current.sendMessage('hello'));
    act(() => handlers.get('ai:response')?.({ content: 'hi', conversationId: 'c2' }));

    act(() => result.current.setPersona('manager-v1'));
    expect(result.current.messages).toHaveLength(2);
  });
});

describe('useAiAssistantSocket reply draft (MSG-MEDIUM-089)', () => {
  beforeEach(() => {
    emit.mockClear();
    handlers.clear();
  });

  const draft = (turn: number, text: string) => ({ conversationId: null, turn, text });

  it('builds the reply as it is written and clears it when the reply arrives', () => {
    const { result } = renderHook(() => useAiAssistantSocket(true));

    act(() => handlers.get('ai:draft')?.(draft(1, 'Checking.')));
    act(() => handlers.get('ai:draft')?.(draft(2, 'Tank 4 ')));
    act(() => handlers.get('ai:draft')?.(draft(1, ' late')));
    act(() => handlers.get('ai:draft')?.(draft(2, 'is fine.')));
    expect(result.current.replyDraft).toEqual({ turn: 2, text: 'Tank 4 is fine.' });

    act(() => handlers.get('ai:response')?.({ content: 'Tank 4 is fine.', conversationId: 'c1' }));
    expect(result.current.replyDraft).toBeNull();
    expect(result.current.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Tank 4 is fine.',
    });
  });

  it('clears the draft on an error, and on a new conversation', () => {
    const { result } = renderHook(() => useAiAssistantSocket(true));

    act(() => handlers.get('ai:draft')?.(draft(1, 'Hm')));
    act(() => handlers.get('ai:error')?.({ code: 'INTERNAL', message: 'no' }));
    expect(result.current.replyDraft).toBeNull();

    act(() => handlers.get('ai:draft')?.(draft(1, 'Hm')));
    act(() => result.current.reset());
    expect(result.current.replyDraft).toBeNull();
  });
});
