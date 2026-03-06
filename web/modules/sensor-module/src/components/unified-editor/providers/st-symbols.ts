/**
 * ST Document Symbol Provider
 *
 * DocumentSymbolProvider: provides outline/breadcrumb data.
 * Sends code to backend via WebSocket, gets back symbol tree.
 */

import type * as Monaco from 'monaco-editor';
import { stWebSocketService } from '../../../services/st-websocket.service';
import type { STOutlineNode } from '../../../types/st-editor.types';

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Map outline icon types to Monaco SymbolKind */
const SYMBOL_KIND_MAP: Record<string, number> = {
  box: 1,         // SymbolKind.File -> PROGRAM
  boxes: 4,       // SymbolKind.Class -> FUNCTION_BLOCK
  function: 11,   // SymbolKind.Function -> FUNCTION
  braces: 10,     // SymbolKind.Namespace -> VAR block
  variable: 12,   // SymbolKind.Variable
  'git-branch': 13, // SymbolKind.Boolean -> IF/CASE (control flow)
  repeat: 17,     // SymbolKind.Array -> FOR/WHILE/REPEAT
  type: 4,        // SymbolKind.Class -> TYPE/STRUCT/ENUM
  play: 5,        // SymbolKind.Method -> FB instance
  'arrow-right': 12, // SymbolKind.Variable -> assignment
};

/**
 * Convert backend STOutlineNode tree to Monaco DocumentSymbol tree.
 */
function toDocumentSymbol(
  node: STOutlineNode,
): Monaco.languages.DocumentSymbol {
  const range = {
    startLineNumber: node.line,
    startColumn: node.character ?? 1,
    endLineNumber: node.line,
    endColumn: (node.character ?? 1) + (node.label?.length ?? 1),
  };

  return {
    name: node.label,
    detail: node.detail ?? '',
    kind: SYMBOL_KIND_MAP[node.icon] ?? 12,
    range,
    selectionRange: range,
    tags: [],
    children: node.children?.map(toDocumentSymbol) ?? [],
  };
}

/**
 * Creates a Monaco DocumentSymbolProvider that uses the ST language service
 * via WebSocket to provide outline data.
 */
export function createSTDocumentSymbolProvider(): Monaco.languages.DocumentSymbolProvider {
  return {
    provideDocumentSymbols(
      model: Monaco.editor.ITextModel,
      _token: Monaco.CancellationToken,
    ): Monaco.languages.ProviderResult<Monaco.languages.DocumentSymbol[]> {
      if (!stWebSocketService.isConnected()) {
        return [];
      }

      const code = model.getValue();

      return stWebSocketService
        .request({
          type: 'outline',
          requestId: generateRequestId(),
          code,
        })
        .then((response) => {
          const nodes = (response.data as STOutlineNode[]) ?? [];
          return nodes.map(toDocumentSymbol);
        })
        .catch(() => []);
    },
  };
}
