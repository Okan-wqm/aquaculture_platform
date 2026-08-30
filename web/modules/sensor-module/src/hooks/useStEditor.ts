/**
 * useStEditor - Hook for PLC mode Structured Text editor state
 *
 * Manages program list CRUD, compile/validate (mock), dirty tracking,
 * Monaco error markers, keyboard shortcuts (F5, F7, F9, Ctrl+S, Shift+Alt+F),
 * outline tree, problems panel, code formatting, and JSON bundle export/import.
 *
 * Persistence (SENSOR-HIGH-049): in standalone (persist) mode the hook
 * hydrates the program list from the backend AutomationProgram store
 * (ST-type programs) and `save()` writes through create/updateAutomationProgram.
 * Editing a DEPLOYED program never overwrites it — save forks a NEW draft
 * program carrying the edits (the backend rejects in-place DEPLOYED edits).
 * Embedded mode (AutomationProgramEditorPage owns persistence) keeps the
 * local-only dirty tracking.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { graphqlFetch } from '../config/api';
import {
  ST_PROGRAMS_QUERY,
  CREATE_PROGRAM_MUTATION,
  UPDATE_PROGRAM_MUTATION,
} from '../graphql/automation.queries';
import { useStLanguageService } from './useStLanguageService';
import type { STDiagnostic, STOutlineNode } from '../types/st-editor.types';

export interface StProgram {
  id: string;
  name: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  /** Backend AutomationProgram id once persisted (absent = never saved). */
  backendId?: string;
  /** Backend lifecycle status (draft/pending_review/approved/deployed/...). */
  status?: string;
}

export type CompileStatus = 'idle' | 'compiling' | 'success' | 'warning' | 'error';

/** Outline node for the left panel tree view */
export interface OutlineNode {
  name: string;
  kind: 'program' | 'functionBlock' | 'function' | 'method' | 'property' | 'varBlock' | 'variable' | 'type' | 'struct' | 'enum';
  line: number;
  endLine?: number;
  children?: OutlineNode[];
  detail?: string;
}

export interface CompileDiagnostic {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

const DEFAULT_SOURCE = `PROGRAM Main
VAR
    // Declare variables here
END_VAR

// Program logic

END_PROGRAM
`;

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Derive a backend programCode (≤30 chars, uppercase, starts with a letter)
 * from a display name, with a time-based suffix for per-tenant uniqueness —
 * the backend enforces programCode uniqueness, and forking a DEPLOYED program
 * mints a fresh code for the new draft.
 */
function makeProgramCode(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 22);
  const prefixed = /^[A-Z]/.test(base) ? base : `ST_${base}`.slice(0, 22);
  const suffix = Date.now().toString(36).toUpperCase().slice(-5);
  return `${prefixed || 'ST_PROGRAM'}_${suffix}`;
}

/** Shape of one hydrated backend ST program. */
interface BackendStProgram {
  id: string;
  programCode: string;
  programName: string;
  status: string;
  structuredTextCode?: string | null;
  updatedAt: string;
}

/** Map STDiagnostic (WS) → CompileDiagnostic (editor) */
function mapWsDiagnostic(d: STDiagnostic): CompileDiagnostic {
  return {
    line: d.range.startLine + 1, // WS is 0-based, editor is 1-based
    column: d.range.startCol + 1,
    endLine: d.range.endLine + 1,
    endColumn: d.range.endCol + 1,
    message: d.message,
    severity: d.severity === 'hint' ? 'info' : d.severity,
  };
}

/** Map STOutlineNode (WS) → OutlineNode (editor) */
function mapWsOutlineNode(n: STOutlineNode): OutlineNode {
  const iconToKind: Record<string, OutlineNode['kind']> = {
    box: 'program',
    boxes: 'functionBlock',
    function: 'function',
    braces: 'varBlock',
    variable: 'variable',
    type: 'type',
    hash: 'struct',
    list: 'enum',
    wrench: 'method',
    'file-text': 'property',
  };
  return {
    name: n.label,
    kind: iconToKind[n.icon] ?? 'variable',
    line: n.line + 1, // 0-based → 1-based
    children: n.children?.map(mapWsOutlineNode),
    detail: n.detail,
  };
}

export interface UseStEditorOptions {
  /** Initial source code for the first program (overrides DEFAULT_SOURCE) */
  initialSource?: string;
  /** Callback fired when the active program's source changes */
  onSourceChange?: (source: string) => void;
  /**
   * Standalone mode: hydrate from + save to the backend AutomationProgram
   * store. Embedded consumers (which own persistence themselves) leave this
   * off and keep the local-only dirty tracking.
   */
  persist?: boolean;
  /** Deploy action fired by the F9 shortcut (e.g. open the deploy modal). */
  onDeploy?: () => void;
}

export function useStEditor(options?: UseStEditorOptions) {
  const { initialSource, onSourceChange, persist = false, onDeploy } = options ?? {};

  // Stable ref so the keyboard effect does not re-register per render.
  const onDeployRef = useRef(onDeploy);
  useEffect(() => { onDeployRef.current = onDeploy; }, [onDeploy]);

  // Real WebSocket language service (auto-connects on mount)
  const langService = useStLanguageService();

  // Stable ref for onSourceChange to avoid re-renders
  const onSourceChangeRef = useRef(onSourceChange);
  useEffect(() => { onSourceChangeRef.current = onSourceChange; }, [onSourceChange]);

  // Program list
  const [programs, setPrograms] = useState<StProgram[]>(() => {
    const initial: StProgram = {
      id: makeId(),
      name: 'Main',
      source: initialSource ?? DEFAULT_SOURCE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return [initial];
  });

  // Active program
  const [activeProgramId, setActiveProgramId] = useState<string>(
    () => programs[0]?.id ?? '',
  );

  // Ref to avoid stale closure in updateSource
  const activeProgramIdRef = useRef(activeProgramId);
  useEffect(() => { activeProgramIdRef.current = activeProgramId; }, [activeProgramId]);

  const activeProgram = programs.find((p) => p.id === activeProgramId) ?? null;

  // Refs to avoid stale closures and per-keystroke callback churn
  const activeProgramRef = useRef(activeProgram);
  activeProgramRef.current = activeProgram;
  const programsRef = useRef(programs);
  programsRef.current = programs;

  // Dirty flag: tracks if source changed since last save
  const [savedSourceMap, setSavedSourceMap] = useState<Record<string, string>>(
    () => {
      const map: Record<string, string> = {};
      for (const p of programs) map[p.id] = p.source;
      return map;
    },
  );

  const savedSourceMapRef = useRef(savedSourceMap);
  savedSourceMapRef.current = savedSourceMap;

  const isDirty =
    activeProgram != null &&
    activeProgram.source !== (savedSourceMap[activeProgram.id] ?? '');

  // Compile state
  const [compileStatus, setCompileStatus] = useState<CompileStatus>('idle');
  const [diagnostics, setDiagnostics] = useState<CompileDiagnostic[]>([]);

  // Monaco editor ref (set externally)
  // Typed as minimal interface to avoid hard dependency on monaco-editor package
  const editorRef = useRef<{
    getModel: () => { getLineMaxColumn: (line: number) => number } | null;
    revealLineInCenter?: (line: number) => void;
    setPosition?: (pos: { lineNumber: number; column: number }) => void;
    focus?: () => void;
    [key: string]: unknown;
  } | null>(null);
  const monacoRef = useRef<{ editor: { setModelMarkers: (model: unknown, owner: string, markers: unknown[]) => void }; [key: string]: unknown } | null>(null);

  // ---- CRUD ----

  const createProgram = useCallback((name: string) => {
    const prog: StProgram = {
      id: makeId(),
      name,
      source: DEFAULT_SOURCE.replace('Main', name),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setPrograms((prev) => [...prev, prog]);
    setSavedSourceMap((prev) => ({ ...prev, [prog.id]: prog.source }));
    setActiveProgramId(prog.id);
    return prog;
  }, []);

  const deleteProgram = useCallback(
    (id: string) => {
      setPrograms((prev) => {
        if (prev.length <= 1) return prev; // Guard: never delete last program
        const next = prev.filter((p) => p.id !== id);
        if (activeProgramId === id && next.length > 0) {
          setActiveProgramId(next[0].id);
        }
        return next;
      });
    },
    [activeProgramId],
  );

  const renameProgram = useCallback((id: string, name: string) => {
    setPrograms((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p)),
    );
  }, []);

  const updateSource = useCallback((source: string) => {
    const targetId = activeProgramIdRef.current;
    setPrograms((prev) =>
      prev.map((p) =>
        p.id === targetId
          ? { ...p, source, updatedAt: Date.now() }
          : p,
      ),
    );
    // Fire onSourceChange callback if provided
    onSourceChangeRef.current?.(source);
  }, []);

  // ---- Persistence (SENSOR-HIGH-049) ----

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isHydrating, setIsHydrating] = useState(persist);

  // Hydrate the program list from the backend once in persist mode. Without
  // this, every mode switch / reload silently discarded ALL ST programs.
  useEffect(() => {
    if (!persist) return;
    const controller = new AbortController();
    const hydrate = async (): Promise<void> => {
      try {
        const data = await graphqlFetch<{
          automationPrograms: { items: BackendStProgram[] };
        }>(ST_PROGRAMS_QUERY, { limit: 100 });
        if (controller.signal.aborted) return;
        const items = data.automationPrograms.items;
        if (items.length === 0) return; // keep the local default 'Main'
        const hydrated: StProgram[] = items.map((p) => ({
          id: p.id,
          backendId: p.id,
          name: p.programName,
          status: p.status,
          source: p.structuredTextCode ?? '',
          createdAt: Date.parse(p.updatedAt) || Date.now(),
          updatedAt: Date.parse(p.updatedAt) || Date.now(),
        }));
        setPrograms(hydrated);
        setSavedSourceMap(Object.fromEntries(hydrated.map((p) => [p.id, p.source])));
        setActiveProgramId(hydrated[0]!.id);
      } catch (e) {
        if (!controller.signal.aborted) {
          setSaveError(`Programlar yüklenemedi: ${(e as Error).message}`);
        }
      } finally {
        if (!controller.signal.aborted) setIsHydrating(false);
      }
    };
    hydrate();
    return () => controller.abort();
    // persist is fixed for the lifetime of the consumer (standalone vs embedded).
  }, [persist]);

  // ---- Save ----

  /**
   * Persist the active program. Synchronous shape (callers stay unchanged);
   * the async write manages its own success/error state — `saveError` +
   * `isSaving` are the observable outcome, and the dirty flag only clears on
   * a CONFIRMED write. In embedded mode (persist=false) the parent owns
   * persistence and this only updates local dirty tracking, as before.
   *
   * Lifecycle: a DEPLOYED program is immutable — save FORKS a new draft
   * program (fresh programCode) carrying the edits instead of overwriting
   * what runs on the device.
   */
  const save = useCallback(() => {
    const prog = activeProgramRef.current;
    if (!prog) return;

    if (!persist) {
      setSavedSourceMap((prev) => ({ ...prev, [prog.id]: prog.source }));
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    const write = async (): Promise<void> => {
      if (prog.backendId && prog.status !== 'deployed') {
        await graphqlFetch(UPDATE_PROGRAM_MUTATION, {
          id: prog.backendId,
          input: { programName: prog.name, structuredTextCode: prog.source },
        });
        setPrograms((prev) =>
          prev.map((p) => (p.id === prog.id ? { ...p, status: p.status === 'approved' ? 'draft' : p.status } : p)),
        );
      } else {
        // Never-saved program OR a DEPLOYED one being edited → new draft.
        const data = await graphqlFetch<{ createAutomationProgram: { id: string } }>(
          CREATE_PROGRAM_MUTATION,
          {
            input: {
              programCode: makeProgramCode(prog.name),
              programName: prog.name,
              programType: 'ST',
              structuredTextCode: prog.source,
            },
          },
        );
        const newBackendId = data.createAutomationProgram.id;
        setPrograms((prev) =>
          prev.map((p) =>
            p.id === prog.id ? { ...p, backendId: newBackendId, status: 'draft' } : p,
          ),
        );
      }
      setSavedSourceMap((prev) => ({ ...prev, [prog.id]: prog.source }));
    };
    write()
      .catch((e) => {
        setSaveError(`Kaydetme başarısız: ${(e as Error).message}`);
      })
      .finally(() => {
        setIsSaving(false);
      });
  }, [persist]);

  // ---- Compile (WS → mock fallback) ----

  const compileMock = useCallback((src: string): CompileDiagnostic[] => {
    const errors: CompileDiagnostic[] = [];
    const programCount = (src.match(/\bPROGRAM\b/gi) || []).length;
    const endProgramCount = (src.match(/\bEND_PROGRAM\b/gi) || []).length;
    if (programCount > endProgramCount) {
      errors.push({
        line: src.split('\n').length, column: 1,
        message: 'Missing END_PROGRAM', severity: 'error',
      });
    }
    const ifCount = (src.match(/\bIF\b/gi) || []).length;
    const endIfCount = (src.match(/\bEND_IF\b/gi) || []).length;
    if (ifCount > endIfCount) {
      errors.push({
        line: src.split('\n').length, column: 1,
        message: `Missing END_IF (${ifCount - endIfCount} unmatched)`, severity: 'error',
      });
    }
    return errors;
  }, []);

  const compile = useCallback(async () => {
    const prog = activeProgramRef.current;
    if (!prog) return;
    setCompileStatus('compiling');
    setDiagnostics([]);
    setIsAnalyzing(true);

    let errors: CompileDiagnostic[];

    if (langService.isConnected) {
      try {
        const wsDiags = await langService.analyze(prog.source, prog.id);
        errors = wsDiags.map(mapWsDiagnostic);
      } catch {
        // WS failed, fall back to local mock
        errors = compileMock(prog.source);
      }
    } else {
      // WS not connected, use mock
      await new Promise((r) => setTimeout(r, 800));
      errors = compileMock(prog.source);
    }

    setIsAnalyzing(false);
    setDiagnostics(errors);
    const hasErrors = errors.some((e) => e.severity === 'error');
    const hasWarnings = errors.some((e) => e.severity === 'warning');
    setCompileStatus(hasErrors ? 'error' : hasWarnings ? 'warning' : 'success');
    applyMarkers(errors);

    return errors;
   
  }, [langService.isConnected, langService.analyze, compileMock]);

  // ---- Validate (WS → mock fallback) ----

  const validateMock = useCallback((src: string): CompileDiagnostic[] => {
    const warnings: CompileDiagnostic[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/\bGOTO\b/i.test(lines[i])) {
        warnings.push({
          line: i + 1, column: 1,
          message: 'GOTO usage is discouraged', severity: 'warning',
        });
      }
    }
    return warnings;
  }, []);

  const validate = useCallback(async () => {
    const prog = activeProgramRef.current;
    if (!prog) return;
    setCompileStatus('compiling');
    setDiagnostics([]);
    setIsAnalyzing(true);

    let warnings: CompileDiagnostic[];

    if (langService.isConnected) {
      try {
        const wsDiags = await langService.analyze(prog.source, prog.id);
        warnings = wsDiags.map(mapWsDiagnostic);
      } catch {
        warnings = validateMock(prog.source);
      }
    } else {
      await new Promise((r) => setTimeout(r, 400));
      warnings = validateMock(prog.source);
    }

    setIsAnalyzing(false);
    setDiagnostics(warnings);
    const hasErrors = warnings.some((w) => w.severity === 'error');
    const hasWarnings = warnings.some((w) => w.severity === 'warning');
    setCompileStatus(hasErrors ? 'error' : hasWarnings ? 'warning' : 'success');
    applyMarkers(warnings);

    return warnings;
   
  }, [langService.isConnected, langService.analyze, validateMock]);

  // ---- Monaco markers ----

  const applyMarkers = useCallback(
    (items: CompileDiagnostic[]) => {
      const monaco = monacoRef.current;
      const editor = editorRef.current;
      if (!monaco || !editor) return;

      const model = editor.getModel();
      if (!model) return;

      const severityMap: Record<string, number> = {
        error: 8,   // MarkerSeverity.Error
        warning: 4, // MarkerSeverity.Warning
        info: 2,    // MarkerSeverity.Info
      };

      const markers = items.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.endLine ?? d.line,
        endColumn: d.endColumn ?? model.getLineMaxColumn(d.line),
        message: d.message,
        severity: severityMap[d.severity] ?? 8,
      }));

      monaco.editor.setModelMarkers(model, 'st-compiler', markers);
    },
    [],
  );

  const clearMarkers = useCallback(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (model) monaco.editor.setModelMarkers(model, 'st-compiler', []);
    setDiagnostics([]);
    setCompileStatus('idle');
  }, []);

  // ---- Unsaved changes warning ----

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const anyDirty = programsRef.current.some(
        (p) => p.source !== (savedSourceMapRef.current[p.id] ?? ''),
      );
      if (anyDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // ---- Outline (local parse) ----

  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [isProblemsExpanded, setIsProblemsExpanded] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Derive wsConnected from real language service
  const wsConnected = langService.isConnected;

  // Build a simple outline from source code (local parse, no backend needed)
  const buildOutline = useCallback((source: string): OutlineNode[] => {
    const nodes: OutlineNode[] = [];
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      const pouMatch = trimmed.match(/^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)/i);
      if (pouMatch) {
        const kindStr = pouMatch[1].toUpperCase();
        const name = pouMatch[2];
        const nodeKind = kindStr === 'PROGRAM' ? 'program' as const
          : kindStr === 'FUNCTION_BLOCK' ? 'functionBlock' as const
          : 'function' as const;

        const endPattern = new RegExp(`^\\s*END_${kindStr}\\b`, 'i');
        let endLine = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
          if (endPattern.test(lines[j])) { endLine = j + 1; break; }
        }

        const children: OutlineNode[] = [];
        let inVarBlock = false;
        let varBlockName = '';
        let varBlockStartLine = 0;
        let varBlockChildren: OutlineNode[] = [];

        for (let j = i + 1; j < endLine; j++) {
          const vLine = lines[j].trim();
          const varMatch = vLine.match(/^(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL)\b/i);
          if (varMatch) {
            inVarBlock = true;
            varBlockName = varMatch[1].toUpperCase();
            varBlockStartLine = j + 1;
            varBlockChildren = [];
          } else if (/^END_VAR\b/i.test(vLine) && inVarBlock) {
            children.push({
              name: varBlockName, kind: 'varBlock', line: varBlockStartLine,
              endLine: j + 1, children: [...varBlockChildren],
            });
            inVarBlock = false;
          } else if (inVarBlock) {
            const declMatch = vLine.match(/^(\w+)\s*:\s*(\w+)/);
            if (declMatch) {
              varBlockChildren.push({
                name: declMatch[1], kind: 'variable', line: j + 1, detail: ': ' + declMatch[2],
              });
            }
          }
        }

        nodes.push({
          name, kind: nodeKind, line: i + 1, endLine,
          children: children.length > 0 ? children : undefined,
        });
      }
    }
    return nodes;
  }, []);

  // Update outline on source change (debounced, WS-first with local fallback)
  useEffect(() => {
    if (!activeProgram) return;
    const source = activeProgram.source;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      if (langService.isConnected) {
        try {
          const wsNodes = await langService.outline(source, activeProgram.id);
          if (!cancelled) setOutline(wsNodes.map(mapWsOutlineNode));
          return;
        } catch {
          // fall through to local parse
        }
      }
      if (!cancelled) setOutline(buildOutline(source));
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeProgram?.source, activeProgram?.id, buildOutline, langService.isConnected, langService.outline]);

  // ---- Format Code (WS → mock fallback) ----

  const formatCodeLocal = useCallback((src: string): string => {
    const lines = src.split('\n');
    let indent = 0;
    const formatted: string[] = [];
    const incPat = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|IF|FOR|WHILE|REPEAT|CASE|STRUCT|TYPE)\b/i;
    const decPat = /^(END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION|END_METHOD|END_PROPERTY|END_INTERFACE|END_VAR|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_STRUCT|END_TYPE|ELSIF|ELSE)\b/i;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { formatted.push(''); continue; }
      if (decPat.test(trimmed)) indent = Math.max(0, indent - 1);
      formatted.push('    '.repeat(indent) + trimmed);
      if (incPat.test(trimmed) && !/^(ELSIF|ELSE)\b/i.test(trimmed)) indent++;
    }
    return formatted.join('\n');
  }, []);

  const formatCode = useCallback(async () => {
    const prog = activeProgramRef.current;
    if (!prog) return;

    if (langService.isConnected) {
      try {
        const formatted = await langService.format(prog.source, prog.id);
        updateSource(formatted);
        return;
      } catch {
        // fall through to local format
      }
    }
    updateSource(formatCodeLocal(prog.source));
  }, [updateSource, langService.isConnected, langService.format, formatCodeLocal]);

  // ---- Navigate to line ----

  const navigateToLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (editor && typeof editor.revealLineInCenter === 'function') {
      editor.revealLineInCenter(line);
      editor.setPosition?.({ lineNumber: line, column: 1 });
      editor.focus?.();
    }
  }, []);

  // ---- Toggle problems panel ----

  const toggleProblemsPanel = useCallback(() => {
    setIsProblemsExpanded((prev) => !prev);
  }, []);

  // ---- Keyboard shortcuts ----

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S → save. In persist mode save() IS the real backend write
      // (SENSOR-HIGH-049), so the window-level shortcut may safely trigger it
      // when focus is outside Monaco. In embedded mode the PARENT owns
      // persistence (wired through Monaco's own keybinding / onSave), so we
      // only swallow the browser default and let the parent's path handle it.
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        if (persist) save();
        return;
      }
      // F5 → compile
      if (e.key === 'F5') {
        e.preventDefault();
        compile();
        return;
      }
      // F7 → validate
      if (e.key === 'F7') {
        e.preventDefault();
        validate();
        return;
      }
      // F9 → deploy (delegates to the consumer's deploy flow, e.g. the
      // automation deploy modal; a no-op when no flow is wired)
      if (e.key === 'F9') {
        e.preventDefault();
        onDeployRef.current?.();
        return;
      }
      // Shift+Alt+F → format code
      if (e.shiftKey && e.altKey && e.key === 'F') {
        e.preventDefault();
        formatCode();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [save, compile, validate, formatCode, persist]);

  return {
    // Program list
    programs,
    activeProgramId,
    activeProgram,
    setActiveProgramId,
    createProgram,
    deleteProgram,
    renameProgram,
    updateSource,

    // Save / dirty / persistence
    isDirty,
    save,
    isSaving,
    saveError,
    isHydrating,

    // Compile
    compileStatus,
    diagnostics,
    compile,
    validate,
    clearMarkers,

    // Outline & Problems
    outline,
    isProblemsExpanded,
    setIsProblemsExpanded,
    toggleProblemsPanel,

    // WS state (connected to real language service)
    wsConnected,
    isAnalyzing,
    connectionStatus: langService.connectionStatus,

    // New actions
    formatCode,
    navigateToLine,

    // Editor refs (to be set by StEditorPanel on mount)
    editorRef,
    monacoRef,
  };
}
