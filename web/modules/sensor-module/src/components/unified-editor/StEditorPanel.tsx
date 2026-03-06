/**
 * StEditorPanel - Bottom panel for PLC mode Structured Text editing
 *
 * Layout:
 *   Left  (w-48): Program list + "New Program" button
 *   Center:       Monaco Editor (ST language, vs-dark)
 *   Right (w-64): Compile output (errors/warnings)
 *   Top toolbar:  [New] [Open] | [Compile F5] [Validate F7] | [Deploy F9] | Program name
 *
 * Resizable height (200px – 60vh), collapse/expand with Ctrl+J.
 */

import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Plus,
  Play,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Upload,
  FileText,
  ChevronDown,
  ChevronUp,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useStEditor, CompileDiagnostic, CompileStatus } from '../../hooks/useStEditor';
import {
  ST_LANGUAGE_ID,
  stLanguageConfig,
  stTokensProvider,
} from './st-language-enhanced';
import { createStCompletionProvider } from './StCompletionProvider';
import { useEditorModeStore } from '../../store/editorModeStore';

const MonacoEditor = React.lazy(() => import('@monaco-editor/react'));

let languageRegistered = false;

const MIN_HEIGHT = 200;
const MAX_HEIGHT_RATIO = 0.6;

const StEditorPanel: React.FC = () => {
  const isBottomPanelOpen = useEditorModeStore((s) => s.isBottomPanelOpen);
  const toggleBottomPanel = useEditorModeStore((s) => s.toggleBottomPanel);
  const setBottomPanelOpen = useEditorModeStore((s) => s.setBottomPanelOpen);

  const {
    programs,
    activeProgramId,
    activeProgram,
    setActiveProgramId,
    createProgram,
    deleteProgram,
    updateSource,
    isDirty,
    save,
    compileStatus,
    diagnostics,
    compile,
    validate,
    clearMarkers,
    editorRef,
    monacoRef,
  } = useStEditor();

  // Panel height (resizable)
  const [panelHeight, setPanelHeight] = useState(320);
  const resizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // New program dialog
  const [showNewInput, setShowNewInput] = useState(false);
  const [newProgramName, setNewProgramName] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);

  // Ctrl+J toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'j') {
        e.preventDefault();
        toggleBottomPanel();
      }
      // F9 → deploy (placeholder)
      if (e.key === 'F9') {
        e.preventDefault();
        // TODO: deploy action
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleBottomPanel]);

  // Resize handlers
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = panelHeight;

      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const delta = startYRef.current - ev.clientY;
        const maxH = window.innerHeight * MAX_HEIGHT_RATIO;
        const next = Math.max(MIN_HEIGHT, Math.min(maxH, startHeightRef.current + delta));
        setPanelHeight(next);
      };

      const onUp = () => {
        resizingRef.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [panelHeight],
  );

  // Register ST language on Monaco mount
  const handleEditorMount = useCallback(
    (editor: any, monaco: any) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      if (!languageRegistered) {
        languageRegistered = true;
        monaco.languages.register({ id: ST_LANGUAGE_ID });
        monaco.languages.setMonarchTokensProvider(ST_LANGUAGE_ID, stTokensProvider);
        monaco.languages.setLanguageConfiguration(ST_LANGUAGE_ID, stLanguageConfig as any);
        monaco.languages.registerCompletionItemProvider(
          ST_LANGUAGE_ID,
          createStCompletionProvider() as any,
        );
      }

      editor.focus();
    },
    [editorRef, monacoRef],
  );

  // Handle new program creation
  const handleCreateProgram = useCallback(() => {
    const name = newProgramName.trim();
    if (!name) return;
    createProgram(name);
    setNewProgramName('');
    setShowNewInput(false);
    clearMarkers();
  }, [newProgramName, createProgram, clearMarkers]);

  if (!isBottomPanelOpen) {
    return (
      <button
        onClick={() => setBottomPanelOpen(true)}
        className="w-full h-7 bg-gray-800 border-t border-gray-700 flex items-center justify-center gap-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-750 transition-colors"
      >
        <ChevronUp className="w-3.5 h-3.5" />
        ST Editor (Ctrl+J)
      </button>
    );
  }

  return (
    <div
      className="flex flex-col bg-gray-900 border-t border-gray-700"
      style={{ height: panelHeight }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="h-1 bg-gray-700 hover:bg-cyan-600 cursor-row-resize flex-shrink-0"
      />

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-gray-800 border-b border-gray-700 flex-shrink-0">
        {/* New / Open */}
        <button
          onClick={() => {
            setShowNewInput(true);
            setTimeout(() => newInputRef.current?.focus(), 50);
          }}
          className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1"
          title="New Program"
        >
          <Plus className="w-3.5 h-3.5" />
          New
        </button>

        <div className="w-px h-4 bg-gray-600 mx-1" />

        {/* Compile */}
        <button
          onClick={() => compile()}
          disabled={compileStatus === 'compiling'}
          className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1 disabled:opacity-50"
          title="Compile (F5)"
        >
          {compileStatus === 'compiling' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          Compile
        </button>

        {/* Validate */}
        <button
          onClick={() => validate()}
          disabled={compileStatus === 'compiling'}
          className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1 disabled:opacity-50"
          title="Validate (F7)"
        >
          <CheckCircle className="w-3.5 h-3.5" />
          Validate
        </button>

        <div className="w-px h-4 bg-gray-600 mx-1" />

        {/* Deploy */}
        <button
          className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1"
          title="Deploy (F9)"
        >
          <Upload className="w-3.5 h-3.5" />
          Deploy
        </button>

        <div className="w-px h-4 bg-gray-600 mx-1" />

        {/* Program name + dirty */}
        <span className="text-xs text-gray-400 flex items-center gap-1 ml-auto">
          <FileText className="w-3.5 h-3.5" />
          {activeProgram?.name ?? '(no program)'}
          {isDirty && <span className="text-yellow-400">*</span>}
        </span>

        {/* Compile status badge */}
        <CompileStatusBadge status={compileStatus} count={diagnostics.length} />

        {/* Collapse */}
        <button
          onClick={toggleBottomPanel}
          className="px-1.5 py-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
          title="Collapse (Ctrl+J)"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main content: 3 columns */}
      <div className="flex flex-1 min-h-0">
        {/* Left: Program list */}
        <div className="w-48 border-r border-gray-700 flex flex-col flex-shrink-0 overflow-y-auto bg-gray-850">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
            Programs
          </div>

          {/* New program input */}
          {showNewInput && (
            <div className="px-2 pb-1 flex gap-1">
              <input
                ref={newInputRef}
                value={newProgramName}
                onChange={(e) => setNewProgramName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateProgram();
                  if (e.key === 'Escape') {
                    setShowNewInput(false);
                    setNewProgramName('');
                  }
                }}
                placeholder="Program name..."
                className="flex-1 bg-gray-700 text-xs text-white px-1.5 py-0.5 rounded border border-gray-600 focus:border-cyan-500 outline-none"
              />
              <button
                onClick={handleCreateProgram}
                className="text-xs text-cyan-400 hover:text-cyan-300 px-1"
              >
                OK
              </button>
            </div>
          )}

          {programs.map((prog) => (
            <div
              key={prog.id}
              onClick={() => {
                setActiveProgramId(prog.id);
                clearMarkers();
              }}
              className={`group flex items-center gap-1 px-2 py-1 text-xs cursor-pointer ${
                prog.id === activeProgramId
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`}
            >
              <FileText className="w-3 h-3 flex-shrink-0" />
              <span className="truncate flex-1">{prog.name}</span>
              {programs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteProgram(prog.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Center: Monaco Editor */}
        <div className="flex-1 min-w-0">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full bg-gray-900 text-gray-500 text-sm">
                Loading editor...
              </div>
            }
          >
            <MonacoEditor
              height="100%"
              language={ST_LANGUAGE_ID}
              theme="vs-dark"
              value={activeProgram?.source ?? ''}
              onChange={(val: string | undefined) => updateSource(val || '')}
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 2,
                automaticLayout: true,
                suggestOnTriggerCharacters: true,
                quickSuggestions: true,
                renderLineHighlight: 'all',
                bracketPairColorization: { enabled: true },
                padding: { top: 4 },
              }}
            />
          </Suspense>
        </div>

        {/* Right: Compile output */}
        <div className="w-64 border-l border-gray-700 flex flex-col flex-shrink-0 overflow-y-auto bg-gray-850">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-gray-500 font-semibold flex items-center justify-between">
            <span>Output</span>
            {diagnostics.length > 0 && (
              <button
                onClick={clearMarkers}
                className="text-gray-500 hover:text-gray-300 text-[10px]"
              >
                Clear
              </button>
            )}
          </div>

          {diagnostics.length === 0 && compileStatus === 'idle' && (
            <div className="px-2 py-4 text-xs text-gray-600 text-center">
              Press F5 to compile
            </div>
          )}

          {diagnostics.length === 0 && compileStatus === 'success' && (
            <div className="px-2 py-4 text-xs text-green-400 text-center flex flex-col items-center gap-1">
              <CheckCircle className="w-4 h-4" />
              Compilation successful
            </div>
          )}

          {compileStatus === 'compiling' && (
            <div className="px-2 py-4 text-xs text-gray-400 text-center flex flex-col items-center gap-1">
              <Loader2 className="w-4 h-4 animate-spin" />
              Compiling...
            </div>
          )}

          {diagnostics.map((d, i) => (
            <DiagnosticItem key={i} diag={d} editorRef={editorRef} />
          ))}
        </div>
      </div>
    </div>
  );
};

// Sub-components

function CompileStatusBadge({
  status,
  count,
}: {
  status: CompileStatus;
  count: number;
}) {
  if (status === 'idle') return null;
  if (status === 'compiling') {
    return (
      <span className="text-xs text-yellow-400 flex items-center gap-1 ml-2">
        <Loader2 className="w-3 h-3 animate-spin" />
      </span>
    );
  }
  if (status === 'success' && count === 0) {
    return (
      <span className="text-xs text-green-400 flex items-center gap-1 ml-2">
        <CheckCircle className="w-3 h-3" />
      </span>
    );
  }
  return (
    <span className="text-xs text-red-400 flex items-center gap-1 ml-2">
      <XCircle className="w-3 h-3" />
      {count}
    </span>
  );
}

function DiagnosticItem({
  diag,
  editorRef,
}: {
  diag: CompileDiagnostic;
  editorRef: React.RefObject<any>;
}) {
  const isSeverityError = diag.severity === 'error';

  return (
    <button
      onClick={() => {
        const editor = editorRef.current;
        if (editor) {
          editor.revealLineInCenter(diag.line);
          editor.setPosition({ lineNumber: diag.line, column: diag.column });
          editor.focus();
        }
      }}
      className="w-full text-left px-2 py-1 text-xs hover:bg-gray-800 flex items-start gap-1.5 border-b border-gray-800"
    >
      {isSeverityError ? (
        <XCircle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
      ) : (
        <AlertTriangle className="w-3 h-3 text-yellow-400 flex-shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <div className={isSeverityError ? 'text-red-300' : 'text-yellow-300'}>
          {diag.message}
        </div>
        <div className="text-gray-500">
          Line {diag.line}, Col {diag.column}
        </div>
      </div>
    </button>
  );
}

export default StEditorPanel;
