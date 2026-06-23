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
 * @param channelId - Target channel ID
 * @param channelType - The channel's type ('direct' | 'group' | 'ai')
 */

import { useState, useCallback, useRef, useEffect } from 'react';

import type { AiActionStatus } from '@/components/messaging/AiActionCard';
import type { ChannelType } from '@/types/messaging';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents a single AI-proposed action card. */
export interface AiAction {
  id: string;
  description: string;
  status: AiActionStatus;
  resultMessage?: string;
}

interface UseAiChatReturn {
  /** Whether this channel is an AI channel. */
  isAiChannel: boolean;
  /** Whether AI is currently generating a response. */
  isAiThinking: boolean;
  /** Whether the AI response has exceeded the 60s timeout. */
  isAiDelayed: boolean;
  /** List of proposed actions from the AI. */
  actions: AiAction[];
  /** Signal that the AI started generating a response. */
  startAiThinking: () => void;
  /** Signal that the AI finished generating a response. */
  stopAiThinking: () => void;
  /** Add a new action card from an AI response. */
  addAction: (id: string, description: string) => void;
  /** Confirm an action by ID. */
  confirmAction: (actionId: string) => void;
  /** Cancel an action by ID. */
  cancelAction: (actionId: string) => void;
  /** Mark an action as completed with a result message. */
  completeAction: (actionId: string, resultMessage: string) => void;
  /** Mark an action as failed with an error message. */
  failAction: (actionId: string, errorMessage: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout in ms before showing "AI is taking longer" message. */
const AI_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAiChat(
  channelId: string | undefined,
  channelType: ChannelType | undefined,
): UseAiChatReturn {
  const isAiChannel = channelType === 'ai';

  const [isAiThinking, setIsAiThinking] = useState(false);
  const [isAiDelayed, setIsAiDelayed] = useState(false);
  const [actions, setActions] = useState<AiAction[]>([]);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state when channel changes
  useEffect(() => {
    setIsAiThinking(false);
    setIsAiDelayed(false);
    setActions([]);
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

  const addAction = useCallback((id: string, description: string) => {
    setActions((prev) => [
      ...prev,
      { id, description, status: 'proposed' },
    ]);
  }, []);

  const confirmAction = useCallback((actionId: string) => {
    setActions((prev) =>
      prev.map((a) =>
        a.id === actionId ? { ...a, status: 'confirming' as const } : a,
      ),
    );

    // TODO: Call backend API to execute the action
    // The caller should handle the actual mutation and call completeAction/failAction
  }, []);

  const cancelAction = useCallback((actionId: string) => {
    setActions((prev) => prev.filter((a) => a.id !== actionId));
  }, []);

  const completeAction = useCallback((actionId: string, resultMessage: string) => {
    setActions((prev) =>
      prev.map((a) =>
        a.id === actionId
          ? { ...a, status: 'completed' as const, resultMessage }
          : a,
      ),
    );
  }, []);

  const failAction = useCallback((actionId: string, errorMessage: string) => {
    setActions((prev) =>
      prev.map((a) =>
        a.id === actionId
          ? { ...a, status: 'failed' as const, resultMessage: errorMessage }
          : a,
      ),
    );
  }, []);

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
    addAction,
    confirmAction,
    cancelAction,
    completeAction,
    failAction,
  };
}
