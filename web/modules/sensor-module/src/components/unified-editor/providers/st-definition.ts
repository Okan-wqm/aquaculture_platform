/**
 * ST Definition Provider
 *
 * DefinitionProvider: Ctrl+Click to go to definition.
 * Sends cursor position to backend via WebSocket, gets back location.
 */

import type * as Monaco from 'monaco-editor';
import { stWebSocketService } from '../../../services/st-websocket.service';
import type { STDefinitionLocation } from '../../../types/st-editor.types';

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Creates a Monaco DefinitionProvider that uses the ST language service
 * via WebSocket to resolve go-to-definition requests.
 */
export function createSTDefinitionProvider(): Monaco.languages.DefinitionProvider {
  return {
    provideDefinition(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
    ): Monaco.languages.ProviderResult<Monaco.languages.Definition> {
      if (!stWebSocketService.isConnected()) {
        return null;
      }

      const code = model.getValue();

      return stWebSocketService
        .request({
          type: 'definition',
          requestId: generateRequestId(),
          code,
          position: {
            line: position.lineNumber - 1,  // Monaco 1-based -> 0-based
            character: position.column - 1,
          },
        })
        .then((response) => {
          const location = response.data as STDefinitionLocation | null;
          if (!location) return null;

          // Return definition in the same model (same-file navigation)
          return {
            uri: model.uri,
            range: {
              startLineNumber: location.range.startLine + 1,
              startColumn: location.range.startCol + 1,
              endLineNumber: location.range.endLine + 1,
              endColumn: location.range.endCol + 1,
            },
          } satisfies Monaco.languages.Location;
        })
        .catch(() => null);
    },
  };
}
