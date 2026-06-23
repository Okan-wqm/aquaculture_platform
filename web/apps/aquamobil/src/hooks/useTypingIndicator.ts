// ============================================================================
// useTypingIndicator — Throttled typing indicator with auto-stop timer
// ============================================================================

/**
 * WHY: Manages typing indicator state for a channel. Throttles outgoing
 * typing events to max 1 per 3 seconds to avoid flooding the Socket.IO
 * server. Automatically sends a stop-typing event after 5 seconds of
 * inactivity (user stopped typing). Receives typing events from other
 * users and maintains a list of currently-typing user IDs.
 *
 * @param channelId - The channel to track typing for
 * @param socketRef - Ref to the Socket.IO socket from useMessageSocket
 * @param currentUserId - Current user's ID (to exclude from typingUsers)
 * @returns startTyping — call on each keystroke (internally throttled)
 * @returns stopTyping — call when the user clears input or sends a message
 * @returns typingUsers — array of user IDs currently typing in the channel
 */

import { useState, useCallback, useEffect, useRef } from 'react';

import type { TypingEvent } from '@/types/messaging';

/** Return shape of {@link useTypingIndicator}. */
export interface UseTypingIndicatorReturn {
  /** Call on each keystroke; internally throttled to 1 emit / 3 s. */
  startTyping: () => void;
  /** Call when the user clears input or sends a message. */
  stopTyping: () => void;
  /** User IDs currently typing in the channel (excluding the current user). */
  typingUsers: string[];
}

/** Minimum interval between outgoing typing events. */
const THROTTLE_INTERVAL_MS = 3_000;

/** Auto-stop typing after this many ms of inactivity. */
const AUTO_STOP_DELAY_MS = 5_000;

/** Remove a remote user's typing indicator after this timeout (failsafe). */
const REMOTE_TYPING_TIMEOUT_MS = 8_000;

type SocketLike = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  connected: boolean;
};

/**
 * Typing indicator hook with throttled emit and auto-stop.
 *
 * @param channelId - The channel to track typing for. Pass undefined to disable.
 * @param socketRef - Ref to the Socket.IO socket instance.
 * @param currentUserId - Current user's ID for filtering out own typing events.
 */
export function useTypingIndicator(
  channelId: string | undefined,
  socketRef: React.RefObject<SocketLike | null>,
  currentUserId: string | undefined,
): UseTypingIndicatorReturn {
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const lastEmitRef = useRef(0);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /**
   * Emit a typing event to the server. Throttled to max 1 per 3 seconds.
   */
  const startTyping = useCallback(() => {
    if (!channelId || !socketRef.current?.connected) return;

    const now = Date.now();
    if (now - lastEmitRef.current < THROTTLE_INTERVAL_MS) return;

    lastEmitRef.current = now;
    socketRef.current.emit('typing', { channelId, isTyping: true });

    // Reset the auto-stop timer
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
    }
    autoStopTimerRef.current = setTimeout(() => {
      if (socketRef.current?.connected && channelId) {
        socketRef.current.emit('typing', { channelId, isTyping: false });
      }
      lastEmitRef.current = 0;
    }, AUTO_STOP_DELAY_MS);
  }, [channelId, socketRef]);

  /**
   * Explicitly stop the typing indicator (e.g., on message send or input clear).
   */
  const stopTyping = useCallback(() => {
    if (!channelId || !socketRef.current?.connected) return;

    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }

    // Only emit if we previously emitted a startTyping
    if (lastEmitRef.current > 0) {
      socketRef.current.emit('typing', { channelId, isTyping: false });
      lastEmitRef.current = 0;
    }
  }, [channelId, socketRef]);

  // Subscribe to typing events from other users
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !channelId) return;

    const handleTyping = (...args: unknown[]): void => {
      const event = args[0] as TypingEvent | undefined;
      if (!event || event.channelId !== channelId) return;
      // Ignore own typing events
      if (event.userId === currentUserId) return;

      if (event.isTyping) {
        setTypingUsers((prev) => {
          if (prev.includes(event.userId)) return prev;
          return [...prev, event.userId];
        });

        // Set a failsafe timer to remove this user's typing indicator
        // in case we never receive the stop event (e.g., disconnect)
        const existingTimer = remoteTimersRef.current.get(event.userId);
        if (existingTimer) clearTimeout(existingTimer);
        remoteTimersRef.current.set(
          event.userId,
          setTimeout(() => {
            setTypingUsers((prev) => prev.filter((id) => id !== event.userId));
            remoteTimersRef.current.delete(event.userId);
          }, REMOTE_TYPING_TIMEOUT_MS),
        );
      } else {
        setTypingUsers((prev) => prev.filter((id) => id !== event.userId));
        const timer = remoteTimersRef.current.get(event.userId);
        if (timer) {
          clearTimeout(timer);
          remoteTimersRef.current.delete(event.userId);
        }
      }
    };

    socket.on('typing', handleTyping);

    return () => {
      socket.off('typing', handleTyping);
    };
  }, [socketRef, channelId, currentUserId]);

  // Cleanup timers on unmount or channel change
  useEffect(() => {
    return () => {
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current);
      }
      for (const timer of remoteTimersRef.current.values()) {
        clearTimeout(timer);
      }
      remoteTimersRef.current.clear();
      setTypingUsers([]);
    };
  }, [channelId]);

  return {
    startTyping,
    stopTyping,
    typingUsers,
  };
}
