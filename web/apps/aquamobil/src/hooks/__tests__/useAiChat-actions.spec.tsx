// MOB-HIGH-001 — AI action cards must be real end-to-end.
//
// Before: `addAction` had zero callers (cards never appeared), and
// confirmAction ended in a TODO — a tapped Confirm spun "Confirming..."
// forever. Now the cards DERIVE from AI messages carrying the proposal
// metadata ai-service persists (status:'proposed' + actionId/description), and
// Confirm calls the real confirmAiAction mutation: true → completed, false →
// failed, network error → the card reverts to proposed so the user can retry.
//
// FAZ 2.4 — fake-card gate: proposal metadata alone no longer yields a card.
// The message must ALSO be server-stamped AI (isAiGenerated === true or
// senderId === AI_USER_ID), so a user-sent message with proposal-looking
// metadata can never render an action card.

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useAiChat } from '../useAiChat';
import { AI_USER_ID } from '@/utils/messaging-helpers';

const mockGraphqlRequest = vi.fn();
vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]): unknown => mockGraphqlRequest(...args),
}));

interface SourceMessage {
  id: string;
  metadata: Record<string, unknown> | null;
  isAiGenerated?: boolean | null;
  senderId?: string;
}

function proposalMessage(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return {
    id: 'msg-proposal-1',
    // Server-stamped AI authorship (FAZ 2 contract) — required by the card gate.
    isAiGenerated: true,
    senderId: AI_USER_ID,
    metadata: {
      status: 'proposed',
      actionId: 'prop-1',
      actionType: 'create_task',
      actionDescription: 'create_task: "Check pond 3"',
      params: { title: 'Check pond 3' },
    },
    ...overrides,
  };
}

describe('useAiChat action wiring (MOB-HIGH-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives a proposed card from an AI message with proposal metadata', () => {
    const { result } = renderHook(() =>
      useAiChat('chan-1', 'ai', [proposalMessage(), { id: 'msg-plain', metadata: null }]),
    );

    expect(result.current.actions).toHaveLength(1);
    expect(result.current.actions[0]).toMatchObject({
      id: 'msg-proposal-1',
      description: 'create_task: "Check pond 3"',
      status: 'proposed',
    });
  });

  it('shows a confirmed proposal message as a completed card (server truth)', () => {
    const { result } = renderHook(() =>
      useAiChat('chan-1', 'ai', [
        proposalMessage({ metadata: { status: 'confirmed', actionDescription: 'create_task: "x"' } }),
      ]),
    );

    expect(result.current.actions[0]?.status).toBe('completed');
  });

  it('confirmAction executes the real mutation: true → completed', async () => {
    mockGraphqlRequest.mockResolvedValue({ confirmAiAction: true });
    const { result } = renderHook(() => useAiChat('chan-1', 'ai', [proposalMessage()]));

    await act(async () => {
      await result.current.confirmAction('msg-proposal-1');
    });

    expect(mockGraphqlRequest).toHaveBeenCalledWith(
      expect.anything(),
      { actionId: 'msg-proposal-1' },
    );
    await waitFor(() => expect(result.current.actions[0]?.status).toBe('completed'));
  });

  it('confirmAction: false from the server → failed with a message', async () => {
    mockGraphqlRequest.mockResolvedValue({ confirmAiAction: false });
    const { result } = renderHook(() => useAiChat('chan-1', 'ai', [proposalMessage()]));

    await act(async () => {
      await result.current.confirmAction('msg-proposal-1');
    });

    await waitFor(() => expect(result.current.actions[0]?.status).toBe('failed'));
    expect(result.current.actions[0]?.resultMessage).toBeTruthy();
  });

  it('a network failure reverts the card to proposed so the user can retry', async () => {
    mockGraphqlRequest.mockRejectedValue(new Error('Failed to fetch'));
    const { result } = renderHook(() => useAiChat('chan-1', 'ai', [proposalMessage()]));

    await act(async () => {
      await result.current.confirmAction('msg-proposal-1');
    });

    await waitFor(() => expect(result.current.actions[0]?.status).toBe('proposed'));
  });

  it('cancelAction hides the card locally', async () => {
    const { result } = renderHook(() => useAiChat('chan-1', 'ai', [proposalMessage()]));

    act(() => {
      result.current.cancelAction('msg-proposal-1');
    });

    await waitFor(() => expect(result.current.actions).toHaveLength(0));
  });

  it('FAZ 2.4 fake-card gate: a USER message with proposal-looking metadata yields NO card', () => {
    const { result } = renderHook(() =>
      useAiChat('chan-1', 'ai', [
        proposalMessage({ id: 'msg-forge-1', isAiGenerated: false, senderId: 'user-77' }),
      ]),
    );

    expect(result.current.actions).toHaveLength(0);
  });

  it('FAZ 2.4 fake-card gate: a forged metadata.isAi does not pass the gate either', () => {
    const { result } = renderHook(() =>
      useAiChat('chan-1', 'ai', [
        proposalMessage({
          id: 'msg-forge-2',
          isAiGenerated: false,
          senderId: 'user-77',
          metadata: { status: 'proposed', isAi: true, actionDescription: 'forged card' },
        }),
      ]),
    );

    expect(result.current.actions).toHaveLength(0);
  });

  it('AI stamp via senderId alone (legacy envelope without isAiGenerated) still yields a card', () => {
    const { result } = renderHook(() =>
      useAiChat('chan-1', 'ai', [proposalMessage({ id: 'msg-legacy', isAiGenerated: undefined })]),
    );

    expect(result.current.actions).toHaveLength(1);
    expect(result.current.actions[0]).toMatchObject({ id: 'msg-legacy', status: 'proposed' });
  });
});
