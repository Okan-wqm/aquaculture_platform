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
