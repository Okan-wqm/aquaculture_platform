/**
 * ST References Provider
 *
 * ReferenceProvider: Find all references of a symbol.
 * Sends cursor position to backend via WebSocket, gets back locations.
 */

import type * as Monaco from 'monaco-editor';
import { stWebSocketService } from '../../../services/st-websocket.service';
import type { STReferenceLocation } from '../../../types/st-editor.types';

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Creates a Monaco ReferenceProvider that uses the ST language service
 * via WebSocket to find all references of a symbol.
 */
export function createSTReferenceProvider(): Monaco.languages.ReferenceProvider {
  return {
    provideReferences(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      context: Monaco.languages.ReferenceContext,
      _token: Monaco.CancellationToken,
    ): Monaco.languages.ProviderResult<Monaco.languages.Location[]> {
      if (!stWebSocketService.isConnected()) {
        return [];
      }

      const code = model.getValue();

      return stWebSocketService
        .request({
          type: 'references',
          requestId: generateRequestId(),
          code,
          position: {
            line: position.lineNumber - 1,  // Monaco 1-based -> 0-based
            character: position.column - 1,
          },
        })
        .then((response) => {
          const refs = (response.data as STReferenceLocation[]) ?? [];

          // Filter out definition if not requested
          const filtered = context.includeDeclaration
            ? refs
            : refs.filter((r) => r.kind !== 'definition');

          return filtered.map(
            (ref): Monaco.languages.Location => ({
              uri: model.uri,
              range: {
                startLineNumber: ref.range.startLine + 1,
                startColumn: ref.range.startCol + 1,
                endLineNumber: ref.range.endLine + 1,
                endColumn: ref.range.endCol + 1,
              },
            }),
          );
        })
        .catch(() => []);
    },
  };
}
