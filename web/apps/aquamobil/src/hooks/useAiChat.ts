// ============================================================================
// useAiChat — Hook for AI channel chat interactions
// ============================================================================

/**
 * WHY: AI channels (type === 'ai') require special handling compared to
 * regular chat rooms. This hook manages:
 * - Detecting whether a channel is an AI channel
 * - Tracking AI response streaming state (thinking, delayed)
 * - Managing action cards (proposed write actions) with confirm/cancel
 * - 60-second timeout with fallback UX
 *
 * MOB-HIGH-001: action cards are DERIVED from the AI messages that carry the
 * proposal metadata ai-service persists (status:'proposed' + actionId +
 * actionDescription) — server truth, not an imperative add that nothing ever
 * called. Confirm executes the REAL confirmAiAction mutation (messaging-service
 * membership check → ai-service executes the persisted proposal row):
 *   true  → completed; false → failed (with a message);
 *   network error → the card REVERTS to proposed so the user can retry —
 * the old "Confirming... forever" dead-end is structurally gone.
 *
 * @param channelId - Target channel ID
 * @param channelType - The channel's type ('direct' | 'group' | 'ai')
 * @param messages - The channel's messages (proposal metadata source)
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import type { AiActionStatus } from '@/components/messaging/AiActionCard';
import { MOBILE_CONFIRM_AI_ACTION } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { ChannelType } from '@/types/messaging';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents a single AI-proposed action card. */
export interface AiAction {
  /** The proposal MESSAGE id — what confirmAiAction takes as its argument. */
  id: string;
  description: string;
  status: AiActionStatus;
  resultMessage?: string;
}

/** The slice of a channel message the proposal cards derive from. */
export interface ProposalSourceMessage {
  id: string;
  metadata: Record<string, unknown> | null;
}

interface UseAiChatReturn {
  /** Whether this channel is an AI channel. */
  isAiChannel: boolean;
  /** Whether AI is currently generating a response. */
  isAiThinking: boolean;
  /** Whether the AI response has exceeded the 60s timeout. */
  isAiDelayed: boolean;
  /** Proposed/terminal action cards derived from the channel's AI messages. */
  actions: AiAction[];
  /** Signal that the AI started generating a response. */
  startAiThinking: () => void;
  /** Signal that the AI finished generating a response. */
  stopAiThinking: () => void;
  /** Confirm an action (by its proposal MESSAGE id) — runs the real mutation. */
  confirmAction: (actionId: string) => Promise<void>;
  /** Locally dismiss an action card. */
  cancelAction: (actionId: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout in ms before showing "AI is taking longer" message. */
const AI_TIMEOUT_MS = 60_000;

/** Local per-card override while a confirm is in flight or after it settles. */
interface ActionOverride {
  status: AiActionStatus | 'cancelled';
  resultMessage?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAiChat(
  channelId: string | undefined,
  channelType: ChannelType | undefined,
  messages: readonly ProposalSourceMessage[] = [],
): UseAiChatReturn {
  const isAiChannel = channelType === 'ai';

  const [isAiThinking, setIsAiThinking] = useState(false);
  const [isAiDelayed, setIsAiDelayed] = useState(false);
  const [overrides, setOverrides] = useState<Map<string, ActionOverride>>(() => new Map());

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state when channel changes
  useEffect(() => {
    setIsAiThinking(false);
    setIsAiDelayed(false);
    setOverrides(new Map());
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [channelId]);

  const startAiThinking = useCallback(() => {
    setIsAiThinking(true);
    setIsAiDelayed(false);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setIsAiDelayed(true);
    }, AI_TIMEOUT_MS);
  }, []);

  const stopAiThinking = useCallback(() => {
    setIsAiThinking(false);
    setIsAiDelayed(false);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const setOverride = useCallback((actionId: string, override: ActionOverride) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(actionId, override);
      return next;
    });
  }, []);

  const clearOverride = useCallback((actionId: string) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      next.delete(actionId);
      return next;
    });
  }, []);

  /**
   * MOB-HIGH-001: derive the cards from message metadata (server truth) and
   * fold in the local in-flight overrides. `status` values written by the
   * bridge: proposed / confirmed / failed.
   */
  const actions = useMemo<AiAction[]>(() => {
    const cards: AiAction[] = [];
    for (const message of messages) {
      const metadata = message.metadata;
      const serverStatus = metadata?.['status'];
      if (
        serverStatus !== 'proposed' &&
        serverStatus !== 'confirmed' &&
        serverStatus !== 'failed'
      ) {
        continue;
      }
      const override = overrides.get(message.id);
      if (override?.status === 'cancelled') continue;

      const description =
        typeof metadata?.['actionDescription'] === 'string'
          ? metadata['actionDescription']
          : 'AI-proposed action';
      const baseStatus: AiActionStatus =
        serverStatus === 'confirmed'
          ? 'completed'
          : serverStatus === 'failed'
            ? 'failed'
            : 'proposed';

      cards.push({
        id: message.id,
        description,
        status: override ? override.status : baseStatus,
        resultMessage: override?.resultMessage,
      });
    }
    return cards;
  }, [messages, overrides]);

  const confirmAction = useCallback(
    async (actionId: string): Promise<void> => {
      setOverride(actionId, { status: 'confirming' });
      try {
        const data = await graphqlRequest(MOBILE_CONFIRM_AI_ACTION, { actionId });
        if (data.confirmAiAction) {
          setOverride(actionId, {
            status: 'completed',
            resultMessage: 'Action executed. The result will appear in the chat.',
          });
        } else {
          setOverride(actionId, {
            status: 'failed',
            resultMessage: 'The action could not be executed. Ask the AI to propose it again.',
          });
        }
      } catch {
        // Network failure (e.g. offline): revert to proposed — a confirmation
        // is a real-time human decision, so it does NOT ride the offline queue;
        // the card stays actionable for a retry once connectivity returns.
        clearOverride(actionId);
      }
    },
    [setOverride, clearOverride],
  );

  const cancelAction = useCallback(
    (actionId: string) => {
      setOverride(actionId, { status: 'cancelled' });
    },
    [setOverride],
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return {
    isAiChannel,
    isAiThinking,
    isAiDelayed,
    actions,
    startAiThinking,
    stopAiThinking,
    confirmAction,
    cancelAction,
  };
}
