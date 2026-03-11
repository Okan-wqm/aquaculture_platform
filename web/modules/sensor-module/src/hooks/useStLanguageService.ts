/**
 * useStLanguageService - WebSocket hook for ST language service
 *
 * Manages WS connection lifecycle (auto-connect/disconnect),
 * provides debounced methods for analyze, complete, hover, format,
 * outline, definition, references.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getAccessToken } from '@aquaculture/shared-ui';
import { stWebSocketService } from '../services/st-websocket.service';
import type {
  STRequest,
  STResponse,
  STServerPush,
  STPosition,
  STDiagnostic,
  STHoverInfo,
  STCompletionItem,
  STOutlineNode,
  STDefinitionLocation,
  STReferenceLocation,
  STConnectionStatus,
} from '../types/st-editor.types';

function generateRequestId(): string {
  // crypto.randomUUID is available in modern browsers
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface UseStLanguageServiceReturn {
  isConnected: boolean;
  connectionStatus: STConnectionStatus;
  analyze: (code: string, programId?: string) => Promise<STDiagnostic[]>;
  complete: (code: string, position: STPosition, programId?: string) => Promise<STCompletionItem[]>;
  hover: (code: string, position: STPosition, programId?: string) => Promise<STHoverInfo | null>;
  format: (code: string, programId?: string) => Promise<string>;
  outline: (code: string, programId?: string) => Promise<STOutlineNode[]>;
  definition: (code: string, position: STPosition, programId?: string) => Promise<STDefinitionLocation | null>;
  references: (code: string, position: STPosition, programId?: string) => Promise<STReferenceLocation[]>;
  onPush: (handler: (push: STServerPush) => void) => () => void;
}

export function useStLanguageService(): UseStLanguageServiceReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<STConnectionStatus>('disconnected');
  const mountedRef = useRef(true);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    mountedRef.current = true;
    setConnectionStatus('connecting');

    const token = getAccessToken();
    if (token) {
      stWebSocketService.connect(token);
    }

    const unsubConnection = stWebSocketService.onConnectionChange((connected) => {
      if (!mountedRef.current) return;
      setIsConnected(connected);
      setConnectionStatus(connected ? 'connected' : 'disconnected');
    });

    // Check if already connected
    if (stWebSocketService.isConnected()) {
      setIsConnected(true);
      setConnectionStatus('connected');
    }

    return () => {
      mountedRef.current = false;
      unsubConnection();
      stWebSocketService.disconnect();
    };
  }, []);

  const makeRequest = useCallback(
    async (type: STRequest['type'], code: string, position?: STPosition, programId?: string): Promise<STResponse> => {
      const req: STRequest = {
        type,
        requestId: generateRequestId(),
        code,
        ...(programId && { programId }),
        ...(position && { position }),
      };

      return stWebSocketService.request(req);
    },
    [],
  );

  const analyze = useCallback(
    async (code: string, programId?: string): Promise<STDiagnostic[]> => {
      try {
        const response = await makeRequest('analyze', code, undefined, programId);
        const payload = response.data as { diagnostics?: STDiagnostic[] } | STDiagnostic[] | null;
        if (Array.isArray(payload)) return payload;
        return (payload as { diagnostics?: STDiagnostic[] })?.diagnostics ?? [];
      } catch (err) {
        console.warn('[STLanguageService] analyze failed:', (err as Error).message);
        return [];
      }
    },
    [makeRequest],
  );

  const complete = useCallback(
    async (code: string, position: STPosition, programId?: string): Promise<STCompletionItem[]> => {
      try {
        const response = await makeRequest('complete', code, position, programId);
        const payload = response.data as { completions?: STCompletionItem[] } | STCompletionItem[] | null;
        if (Array.isArray(payload)) return payload;
        return (payload as { completions?: STCompletionItem[] })?.completions ?? [];
      } catch (err) {
        console.warn('[STLanguageService] complete failed:', (err as Error).message);
        return [];
      }
    },
    [makeRequest],
  );

  const hover = useCallback(
    async (code: string, position: STPosition, programId?: string): Promise<STHoverInfo | null> => {
      try {
        const response = await makeRequest('hover', code, position, programId);
        const payload = response.data as STHoverInfo | { contents?: string; range?: STHoverInfo['range'] } | null;
        if (!payload) return null;
        if ('contents' in payload && typeof payload.contents === 'string') return payload as STHoverInfo;
        return null;
      } catch (err) {
        console.warn('[STLanguageService] hover failed:', (err as Error).message);
        return null;
      }
    },
    [makeRequest],
  );

  const format = useCallback(
    async (code: string, programId?: string): Promise<string> => {
      try {
        const response = await makeRequest('format', code, undefined, programId);
        const payload = response.data as { formattedCode?: string } | string | null;
        if (typeof payload === 'string') return payload;
        return (payload as { formattedCode?: string })?.formattedCode ?? code;
      } catch (err) {
        console.warn('[STLanguageService] format failed:', (err as Error).message);
        return code;
      }
    },
    [makeRequest],
  );

  const outline = useCallback(
    async (code: string, programId?: string): Promise<STOutlineNode[]> => {
      try {
        const response = await makeRequest('outline', code, undefined, programId);
        const payload = response.data as { outline?: STOutlineNode[] } | STOutlineNode[] | null;
        if (Array.isArray(payload)) return payload;
        return (payload as { outline?: STOutlineNode[] })?.outline ?? [];
      } catch (err) {
        console.warn('[STLanguageService] outline failed:', (err as Error).message);
        return [];
      }
    },
    [makeRequest],
  );

  const definition = useCallback(
    async (code: string, position: STPosition, programId?: string): Promise<STDefinitionLocation | null> => {
      try {
        const response = await makeRequest('definition', code, position, programId);
        const payload = response.data as { location?: STDefinitionLocation } | STDefinitionLocation | null;
        if (!payload) return null;
        if ('range' in payload) return payload as STDefinitionLocation;
        return (payload as { location?: STDefinitionLocation }).location ?? null;
      } catch (err) {
        console.warn('[STLanguageService] definition failed:', (err as Error).message);
        return null;
      }
    },
    [makeRequest],
  );

  const references = useCallback(
    async (code: string, position: STPosition, programId?: string): Promise<STReferenceLocation[]> => {
      try {
        const response = await makeRequest('references', code, position, programId);
        const payload = response.data as { references?: STReferenceLocation[] } | STReferenceLocation[] | null;
        if (Array.isArray(payload)) return payload;
        return (payload as { references?: STReferenceLocation[] })?.references ?? [];
      } catch (err) {
        console.warn('[STLanguageService] references failed:', (err as Error).message);
        return [];
      }
    },
    [makeRequest],
  );

  const onPush = useCallback((handler: (push: STServerPush) => void) => {
    return stWebSocketService.onPush(handler);
  }, []);

  return {
    isConnected,
    connectionStatus,
    analyze,
    complete,
    hover,
    format,
    outline,
    definition,
    references,
    onPush,
  };
}
