/**
 * ST Language Providers - Barrel Export + Lazy Registration
 *
 * Registers all Monaco language providers for the 'st' language.
 * Split into two phases:
 *   - Static providers: no backend dependency (completion, snippets, hover, formatting)
 *   - Dynamic providers: require WS backend (diagnostics, definition, references, symbols)
 */

import type * as Monaco from 'monaco-editor';
import { STDiagnosticsManager } from './st-diagnostics';
import { createSTDefinitionProvider } from './st-definition';
import { createSTReferenceProvider } from './st-references';
import { createSTDocumentSymbolProvider } from './st-symbols';
import { createStCompletionProvider } from '../StCompletionProvider';
import { createStSnippetProvider } from './st-snippets';
import { createStHoverProvider } from './st-hover';
import { createStFormattingProvider } from './st-formatting';
import type { STDiagnostic } from '../../../types/st-editor.types';

// Dynamic provider exports
export { STDiagnosticsManager } from './st-diagnostics';
export { createSTDefinitionProvider } from './st-definition';
export { createSTReferenceProvider } from './st-references';
export { createSTDocumentSymbolProvider } from './st-symbols';

// Static provider exports
export { createStSnippetProvider } from './st-snippets';
export { createStHoverProvider } from './st-hover';
export { createStFormattingProvider, formatSTCode } from './st-formatting';
export { ST_SNIPPETS } from './st-snippets';

const ST_LANGUAGE_ID = 'st';

interface RegisterOptions {
  onDiagnosticsChange?: (diagnostics: STDiagnostic[]) => void;
  onAnalyzingChange?: (analyzing: boolean) => void;
}

interface RegisterResult {
  diagnosticsManager: STDiagnosticsManager;
  dispose: () => void;
}

/**
 * Register all static ST providers that do NOT require backend.
 * Call this once after Monaco is initialized and the language is registered.
 *
 * @param monaco - The Monaco editor instance
 * @param languageId - Language ID (defaults to 'st')
 * @returns Array of IDisposable handles for cleanup
 */
export function registerSTStaticProviders(
  monaco: typeof Monaco,
  languageId: string = ST_LANGUAGE_ID,
): Monaco.IDisposable[] {
  const disposables: Monaco.IDisposable[] = [];

  // Completion provider (keywords, functions, FBs, types, type conversions, tags)
  disposables.push(
    monaco.languages.registerCompletionItemProvider(languageId, createStCompletionProvider()),
  );

  // Snippet provider (36 code templates)
  disposables.push(
    monaco.languages.registerCompletionItemProvider(languageId, createStSnippetProvider()),
  );

  // Hover provider (documentation tooltips)
  disposables.push(
    monaco.languages.registerHoverProvider(languageId, createStHoverProvider()),
  );

  // Formatting provider (keyword case, indentation, alignment)
  disposables.push(
    monaco.languages.registerDocumentFormattingEditProvider(languageId, createStFormattingProvider()),
  );

  return disposables;
}

/**
 * Register all dynamic ST providers that require WebSocket backend.
 * Call this after Monaco editor is initialized and a model is available.
 *
 * Returns a dispose function to clean up all registrations.
 */
export function registerSTDynamicProviders(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  options?: RegisterOptions,
): RegisterResult {
  const disposables: Monaco.IDisposable[] = [];

  // Definition provider (Ctrl+Click)
  disposables.push(
    monaco.languages.registerDefinitionProvider(ST_LANGUAGE_ID, createSTDefinitionProvider()),
  );

  // Reference provider (Find All References)
  disposables.push(
    monaco.languages.registerReferenceProvider(ST_LANGUAGE_ID, createSTReferenceProvider()),
  );

  // Document Symbol provider (Outline / Breadcrumb)
  disposables.push(
    monaco.languages.registerDocumentSymbolProvider(ST_LANGUAGE_ID, createSTDocumentSymbolProvider()),
  );

  // Diagnostics manager (not a standard Monaco provider - manages markers)
  const diagnosticsManager = new STDiagnosticsManager({
    onDiagnosticsChange: options?.onDiagnosticsChange,
    onAnalyzingChange: options?.onAnalyzingChange,
  });
  diagnosticsManager.start(monaco, model);

  const dispose = () => {
    diagnosticsManager.dispose();
    for (const d of disposables) {
      d.dispose();
    }
  };

  return { diagnosticsManager, dispose };
}
