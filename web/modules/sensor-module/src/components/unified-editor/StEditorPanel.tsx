/**
 * StEditorPanel - Full IDE panel for PLC mode Structured Text editing
 *
 * Layout (Flexbox):
 *   ┌────────────────────────────────────────────────────────────────────────┐
 *   │ Toolbar: [+ New] | [Compile F5] [Validate F7] | [Deploy F9]          │
 *   │          [Save] [Format] | [Export JSON] [Import JSON]                │
 *   ├────────────┬──────────────────────────────────────────┬────────────────┤
 *   │ Left (w-48)│  Monaco Editor (flex-1)                  │ Right (w-64)   │
 *   │ PROGRAMS   │                                          │ OUTPUT         │
 *   │ OUTLINE    │                                          │                │
 *   ├────────────┴──────────────────────────────────────────┴────────────────┤
 *   │ PROBLEMS  [errors] [warnings]                              [collapse] │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Resizable height (200px - 60vh), collapse/expand with Ctrl+J.
 */

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
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
  Save,
  AlignLeft,
  Download,
} from 'lucide-react';
import { useStEditor, CompileDiagnostic, CompileStatus } from '../../hooks/useStEditor';
import {
  ST_LANGUAGE_ID,
  stLanguageConfig,
  stTokensProvider,
} from './st-language-enhanced';
import { createStCompletionProvider, setTags } from './StCompletionProvider';
import { useEditorModeStore } from '../../store/editorModeStore';
import { useScadaPackageStore } from '../../store/scada';
import StOutlineTree from './StOutlineTree';
import StProblemsPanel, { type Diagnostic } from './StProblemsPanel';
import ExportDialog from './json-bundle/ExportDialog';
import ImportDialog from './json-bundle/ImportDialog';
import type { STBundle, STBundleProgram } from '../../types/st-editor.types';
import type { editor as monacoEditor, languages as monacoLanguages } from 'monaco-editor';

/** Diagnostic item returned by validation */
export interface DiagnosticItem {
  message: string;
  line?: number;
  column?: number;
  severity?: string;
}

export interface StEditorPanelProps {
  /** Embedded mode: controlled source from parent */
  value?: string;
  /** Embedded mode: bubble changes to parent */
  onChange?: (value: string) => void;
  /** Embedded mode: fill available height instead of using resize handle */
  embedded?: boolean;
  /** Embedded mode: hide toolbar items that parent handles (Save, Deploy) */
  hideActions?: ('save' | 'deploy')[];
  /** Embedded mode: callback for Ctrl+S save */
  onSave?: () => void;
  /** Embedded mode: callback for validate button */
  onValidate?: () => void;
  /** Deploy action (F9 / Deploy button) — e.g. open the automation deploy modal */
  onDeploy?: () => void;
  /** Validation results from parent */
  validationResult?: {
    errors: DiagnosticItem[];
    warnings: DiagnosticItem[];
    infos: DiagnosticItem[];
  } | null;
}

const MonacoEditor = React.lazy(() => import('@monaco-editor/react'));

const MIN_HEIGHT = 200;
const MAX_HEIGHT_RATIO = 0.6;

/** C5: Module-level constant for Monaco editor options (avoids re-creation every render) */
const MONACO_EDITOR_OPTIONS: monacoEditor.IStandaloneEditorConstructionOptions = {
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
};

const StEditorPanel: React.FC<StEditorPanelProps> = ({
  value,
  onChange,
  embedded = false,
  hideActions = [],
  onSave,
  onValidate,
  onDeploy,
  validationResult,
}) => {
  // Standalone mode: use editor mode store for collapse/expand
  const isBottomPanelOpen = useEditorModeStore((s) => s.isBottomPanelOpen);
  const toggleBottomPanel = useEditorModeStore((s) => s.toggleBottomPanel);
  const setBottomPanelOpen = useEditorModeStore((s) => s.setBottomPanelOpen);

  // Auto-open panel on mount in standalone mode so the editor is visible
  useEffect(() => {
    if (!embedded) {
      setBottomPanelOpen(true);
    }
  }, [embedded, setBottomPanelOpen]);

  const {
    programs,
    activeProgramId,
    activeProgram,
    setActiveProgramId,
    createProgram,
    deleteProgram,
    updateSource: internalUpdateSource,
    isDirty,
    save,
    isSaving,
    saveError,
    compileStatus,
    diagnostics,
    compile,
    validate,
    clearMarkers,
    editorRef,
    monacoRef,
    // New from extended hook
    outline,
    isProblemsExpanded,
    toggleProblemsPanel,
    formatCode,
    navigateToLine,
  } = useStEditor({
    initialSource: embedded && value != null ? value : undefined,
    onSourceChange: embedded ? onChange : undefined,
    // Standalone (PLC mode): programs hydrate from + save to the backend
    // AutomationProgram store. Embedded consumers own persistence themselves.
    persist: !embedded,
    onDeploy,
  });

  // In embedded mode with controlled value, sync external value -> internal state
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (embedded && value != null && value !== prevValueRef.current) {
      prevValueRef.current = value;
      internalUpdateSource(value);
    }
  }, [embedded, value, internalUpdateSource]);

  // Wrapper for updateSource that also calls onChange in embedded mode
  const updateSource = useCallback(
    (source: string) => {
      prevValueRef.current = source;
      internalUpdateSource(source);
    },
    [internalUpdateSource],
  );

  // Wire device tags to completion provider (standalone mode only)
  const targetDeviceId = useScadaPackageStore((s) => s.targetDeviceId);
  const screens = useScadaPackageStore((s) => s.screens);
  const trendTags = useScadaPackageStore((s) => s.trendConfig.tags);

  useEffect(() => {
    if (embedded) return; // Skip SCADA tag wiring in embedded mode
    if (!targetDeviceId) {
      setTags([]);
      return;
    }
    const tagSet = new Set<string>(trendTags);
    for (const screen of screens) {
      for (const widget of screen.widgets) {
        const cfg = widget.config;
        if (cfg?.tagName) tagSet.add(cfg.tagName as string);
        if (Array.isArray(cfg?.tags)) {
          for (const t of cfg.tags) {
            if (typeof t === 'string') tagSet.add(t);
            else if (t?.name) tagSet.add(t.name);
          }
        }
      }
    }
    setTags(
      Array.from(tagSet).map((name) => ({
        name,
        ioType: 'AI',
        dataType: 'REAL',
      })),
    );
  }, [embedded, targetDeviceId, screens, trendTags]);

  // Determine whether to hide specific actions
  const hideSave = hideActions.includes('save');
  const hideDeploy = hideActions.includes('deploy');

  // Panel height (resizable)
  const [panelHeight, setPanelHeight] = useState(420);
  const resizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // New program dialog
  const [showNewInput, setShowNewInput] = useState(false);
  const [newProgramName, setNewProgramName] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);

  // Export/Import dialogs
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

  // Track cursor line for outline highlighting
  const [cursorLine, setCursorLine] = useState(1);

  // Ref to keep onSave callback current for Monaco keybinding
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  // H32: Store cursor listener disposable for cleanup
  const cursorDisposableRef = useRef<{ dispose(): void } | null>(null);

  // Cleanup cursor listener on unmount
  useEffect(() => {
    return () => {
      cursorDisposableRef.current?.dispose();
      cursorDisposableRef.current = null;
    };
  }, []);

  // Ctrl+J toggle (standalone mode only)
  useEffect(() => {
    if (embedded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'j') {
        e.preventDefault();
        toggleBottomPanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [embedded, toggleBottomPanel]);

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
    (editor: monacoEditor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
      (editorRef as any).current = editor;
      (monacoRef as any).current = monaco;

      // Check Monaco's own language registry to avoid duplicates on HMR
      const registeredLanguages = monaco.languages.getLanguages();
      const alreadyRegistered = registeredLanguages.some(
        (l: monacoLanguages.ILanguageExtensionPoint) => l.id === ST_LANGUAGE_ID,
      );

      if (!alreadyRegistered) {
        monaco.languages.register({ id: ST_LANGUAGE_ID });
        monaco.languages.setMonarchTokensProvider(ST_LANGUAGE_ID, stTokensProvider);
        monaco.languages.setLanguageConfiguration(ST_LANGUAGE_ID, stLanguageConfig);
        monaco.languages.registerCompletionItemProvider(
          ST_LANGUAGE_ID,
          createStCompletionProvider(),
        );
      }

      // H32: Dispose previous listener if any, then track cursor position
      cursorDisposableRef.current?.dispose();
      cursorDisposableRef.current = editor.onDidChangeCursorPosition(
        (e: monacoEditor.ICursorPositionChangedEvent) => {
          setCursorLine(e.position.lineNumber);
        },
      );

      // Ctrl+S keybinding: trigger parent save (embedded) or internal save (standalone)
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (onSaveRef.current) {
          onSaveRef.current();
        } else {
          save();
        }
      });

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

  // Handle outline navigation
  const handleOutlineNavigate = useCallback(
    (line: number) => {
      navigateToLine(line);
    },
    [navigateToLine],
  );

  // Handle problems panel navigation
  const handleProblemNavigate = useCallback(
    (line: number) => {
      navigateToLine(line);
    },
    [navigateToLine],
  );

  // Convert compile diagnostics to problems panel format
  const problemsDiagnostics: Diagnostic[] = useMemo(
    () =>
      diagnostics.map((d, i) => ({
        range: {
          startLine: d.line,
          startCol: d.column,
          endLine: d.endLine ?? d.line,
          endCol: d.endColumn ?? 999,
        },
        severity: d.severity,
        message: d.message,
        code: `ST${String(i + 1).padStart(3, '0')}`,
        source: 'st-compiler',
      })),
    [diagnostics],
  );

  // Export dialog data
  const exportProgram: STBundleProgram | null = useMemo(() => {
    if (!activeProgram) return null;
    return {
      programCode: activeProgram.name.toUpperCase().replace(/\s+/g, '_'),
      programName: activeProgram.name,
      programType: 'ST',
      executionMode: 'CYCLIC',
      scanCycleMs: 100,
      structuredTextCode: activeProgram.source,
    };
  }, [activeProgram]);

  // Import handler
  const handleImport = useCallback(
    (bundle: STBundle) => {
      const name = bundle.program.programName || 'Imported';
      createProgram(name);
      // The createProgram already sets it active, now update the source
      updateSource(bundle.program.structuredTextCode || '');
    },
    [createProgram, updateSource],
  );

  // M5: Stable onChange handler for Monaco editor
  const handleMonacoChange = useCallback(
    (val: string | undefined) => updateSource(val || ''),
    [updateSource],
  );

  const panelStyle = useMemo(() => (embedded ? undefined : { height: panelHeight }), [embedded, panelHeight]);

  // Standalone collapsed state
  if (!embedded && !isBottomPanelOpen) {
    return (
      <button
        onClick={() => setBottomPanelOpen(true)}
        className="w-full h-7 bg-gray-800 border-t border-gray-700 flex items-center justify-center gap-1 text-xs text-gray-500 hover:text-gray-200 hover:bg-gray-750 transition-colors"
      >
        <ChevronUp className="w-3.5 h-3.5" />
        ST Editor (Ctrl+J)
      </button>
    );
  }

  return (
    <div
      className={`flex flex-col bg-gray-900 ${embedded ? 'flex-1 min-h-0' : 'border-t border-gray-700'}`}
      style={panelStyle}
    >
      {/* Resize handle (standalone mode only) */}
      {!embedded && (
        <div
          onMouseDown={handleResizeStart}
          className="h-1 bg-gray-700 hover:bg-cyan-600 cursor-row-resize flex-shrink-0"
        />
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-gray-800 border-b border-gray-700 flex-shrink-0 flex-wrap">
        {/* New */}
        <button
          onClick={() => {
            setShowNewInput(true);
            setTimeout(() => newInputRef.current?.focus(), 50);
          }}
          className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1"
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
          className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1 disabled:opacity-50"
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
          onClick={() => {
            if (onValidate) onValidate();
            else validate();
          }}
          disabled={compileStatus === 'compiling'}
          className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1 disabled:opacity-50"
          title="Validate (F7)"
        >
          <CheckCircle className="w-3.5 h-3.5" />
          Validate
        </button>

        {!hideDeploy && (
          <>
            <div className="w-px h-4 bg-gray-600 mx-1" />

            {/* Deploy — opens the parent-owned deploy flow (UI-004: this
                button used to render with NO onClick, an inert control). */}
            <button
              onClick={onDeploy}
              disabled={!onDeploy}
              className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1 disabled:opacity-50"
              title={onDeploy ? 'Deploy (F9)' : 'Deploy is not available here'}
            >
              <Upload className="w-3.5 h-3.5" />
              Deploy
            </button>
          </>
        )}

        {!hideSave && (
          <>
            <div className="w-px h-4 bg-gray-600 mx-1" />

            {/* Save */}
            <button
              onClick={save}
              disabled={isSaving}
              className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1 disabled:opacity-50"
              title="Save (Ctrl+S)"
            >
              <Save className={`w-3.5 h-3.5 ${isSaving ? 'animate-pulse' : ''}`} />
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}

        {/* Format */}
        <button
          onClick={formatCode}
          className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1"
          title="Format (Shift+Alt+F)"
        >
          <AlignLeft className="w-3.5 h-3.5" />
          Format
        </button>

        <div className="w-px h-4 bg-gray-600 mx-1" />

        {/* Export JSON */}
        <button
          onClick={() => setShowExportDialog(true)}
          className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1"
          title="Export JSON Bundle"
        >
          <Download className="w-3.5 h-3.5" />
          Export
        </button>

        {/* Import JSON */}
        <button
          onClick={() => setShowImportDialog(true)}
          className="px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded flex items-center gap-1"
          title="Import JSON Bundle"
        >
          <Upload className="w-3.5 h-3.5" />
          Import
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Save error — the write is async; this is its observable failure */}
        {saveError && (
          <span className="text-xs text-red-400 max-w-64 truncate" title={saveError}>
            {saveError}
          </span>
        )}

        {/* Program name + dirty */}
        <span className="text-xs text-gray-500 flex items-center gap-1">
          <FileText className="w-3.5 h-3.5" />
          {activeProgram?.name ?? '(no program)'}
          {isDirty && <span className="text-yellow-400">*</span>}
        </span>

        {/* Compile status badge */}
        <CompileStatusBadge status={compileStatus} count={diagnostics.length} />

        {/* Collapse (standalone mode only) */}
        {!embedded && (
          <button
            onClick={toggleBottomPanel}
            className="px-1.5 py-1 text-gray-500 hover:text-white hover:bg-gray-700 rounded"
            title="Collapse (Ctrl+J)"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Main content: 3 columns + bottom problems panel */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Three-column area */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Program list + Outline */}
          <div className="w-48 border-r border-gray-700 flex flex-col flex-shrink-0 overflow-hidden bg-gray-850">
            {/* Programs section */}
            <div className="flex flex-col flex-shrink-0">
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
                    className="flex-1 bg-gray-700 text-xs text-white px-1.5 py-0.5 rounded border border-gray-600 focus:border-cyan-500 outline-hidden"
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
                      : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'
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

            {/* Outline section */}
            <div className="flex flex-col flex-1 min-h-0 border-t border-gray-700 mt-1">
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                Outline
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">
                <StOutlineTree
                  outline={outline}
                  onNavigate={handleOutlineNavigate}
                  activeLineNumber={cursorLine}
                />
              </div>
            </div>
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
                onChange={handleMonacoChange}
                onMount={handleEditorMount}
                options={MONACO_EDITOR_OPTIONS}
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
                  className="text-gray-500 hover:text-gray-500 text-[10px]"
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
              <div className="px-2 py-4 text-xs text-gray-500 text-center flex flex-col items-center gap-1">
                <Loader2 className="w-4 h-4 animate-spin" />
                Compiling...
              </div>
            )}

            {diagnostics.map((d, i) => (
              <DiagnosticItem key={i} diag={d} editorRef={editorRef as any} />
            ))}
          </div>
        </div>

        {/* Bottom: Problems panel */}
        <StProblemsPanel
          diagnostics={problemsDiagnostics}
          onNavigate={handleProblemNavigate}
          isExpanded={isProblemsExpanded}
          onToggleExpand={toggleProblemsPanel}
        />
      </div>

      {/* Export Dialog */}
      {exportProgram && (
        <ExportDialog
          open={showExportDialog}
          onClose={() => setShowExportDialog(false)}
          program={exportProgram}
          variables={[]}
          steps={[]}
          transitions={[]}
          exportedBy="user@local"
        />
      )}

      {/* Import Dialog */}
      <ImportDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onImport={handleImport}
      />
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
  if (status === 'warning') {
    return (
      <span className="text-xs text-yellow-400 flex items-center gap-1 ml-2">
        <AlertTriangle className="w-3 h-3" />
        {count}
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
  editorRef: React.RefObject<{
    revealLineInCenter?: (line: number) => void;
    setPosition?: (pos: { lineNumber: number; column: number }) => void;
    focus?: () => void;
    [key: string]: unknown;
  } | null>;
}) {
  const isSeverityError = diag.severity === 'error';

  return (
    <button
      onClick={() => {
        const editor = editorRef.current;
        if (editor) {
          editor.revealLineInCenter?.(diag.line);
          editor.setPosition?.({ lineNumber: diag.line, column: diag.column });
          editor.focus?.();
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
