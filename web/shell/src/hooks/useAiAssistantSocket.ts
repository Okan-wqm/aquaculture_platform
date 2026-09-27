/**
 * useAiAssistantSocket — Socket.IO client for the AI assistant (`/ai` namespace).
 *
 * The gateway AiChatGateway bridges `ai:chat` to ai-service over NATS
 * (request.ai.chat) and streams `ai:response` / `ai:error` back — the same
 * real-time path messaging uses. Identity is the JWT in the handshake; the
 * server enforces ai_assistant:use, so a denied user gets `ai:error FORBIDDEN`.
 *
 * Persona: the drawer may pin a catalogue persona id (`null` = the tenant's
 * default, resolved by ai-service). ai-service pins a conversation to the
 * persona that opened it, so switching persona starts a new conversation here
 * rather than tripping that server-side mismatch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '@aquaculture/shared-ui';

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Present on failed assistant turns so the UI can steer to AI settings. */
  errorCode?: string;
}

export type AiAssistantStatus = 'connecting' | 'ready' | 'thinking' | 'offline';

interface AiResponsePayload {
  content: string;
  conversationId: string | null;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
  metadata?: Record<string, unknown> | null;
}
interface AiErrorPayload {
  code: string;
  message: string;
}

const RECONNECT_ATTEMPTS = 10;

let messageSeq = 0;
const nextId = (): string => `m${Date.now()}-${messageSeq++}`;

export function useAiAssistantSocket(active: boolean) {
  const { token, isAuthenticated } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const personaRef = useRef<string | null>(null);

  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [status, setStatus] = useState<AiAssistantStatus>('offline');
  const [persona, setPersonaState] = useState<string | null>(null);

  // Connect only while the drawer is open + authenticated — no idle socket.
  useEffect(() => {
    if (!active || !isAuthenticated || !token) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setStatus('offline');
      return;
    }

    setStatus('connecting');
    const socket = io('/ai', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: RECONNECT_ATTEMPTS,
    });
    socketRef.current = socket;

    socket.on('ai:connected', () => setStatus('ready'));
    socket.on('ai:thinking', () => setStatus('thinking'));
    socket.on('ai:response', (payload: AiResponsePayload) => {
      conversationIdRef.current = payload.conversationId ?? conversationIdRef.current;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: payload.content },
      ]);
      setStatus('ready');
    });
    socket.on('ai:error', (payload: AiErrorPayload) => {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: payload.message,
          errorCode: payload.code,
        },
      ]);
      setStatus('ready');
    });
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [active, isAuthenticated, token]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    const socket = socketRef.current;
    if (!trimmed || !socket) return;
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: trimmed }]);
    setStatus('thinking');
    socket.emit('ai:chat', {
      message: trimmed,
      conversationId: conversationIdRef.current ?? undefined,
      persona: personaRef.current,
    });
  }, []);

  const reset = useCallback(() => {
    conversationIdRef.current = null;
    setMessages([]);
  }, []);

  const setPersona = useCallback(
    (next: string | null) => {
      if (next === personaRef.current) return;
      personaRef.current = next;
      setPersonaState(next);
      reset();
    },
    [reset],
  );

  return { messages, status, persona, setPersona, sendMessage, reset };
}
