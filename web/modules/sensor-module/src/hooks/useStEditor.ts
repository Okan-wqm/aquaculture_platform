/**
 * useStEditor - Hook for PLC mode Structured Text editor state
 *
 * Manages program list CRUD, compile/validate (mock), dirty tracking,
 * Monaco error markers, keyboard shortcuts (F5, F7, F9, Ctrl+S, Shift+Alt+F),
 * outline tree, problems panel, code formatting, and JSON bundle export/import.
 */
import { useState, useCallback, useRef, useEffect } from 'react';

export interface StProgram {
  id: string;
  name: string;
  source: string;
  createdAt: number;
  updatedAt: number;
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

export interface UseStEditorOptions {
  /** Initial source code for the first program (overrides DEFAULT_SOURCE) */
  initialSource?: string;
  /** Callback fired when the active program's source changes */
  onSourceChange?: (source: string) => void;
}

export function useStEditor(options?: UseStEditorOptions) {
  const { initialSource, onSourceChange } = options ?? {};

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
  const editorRef = useRef<{ getModel: () => { getLineMaxColumn: (line: number) => number } | null; [key: string]: unknown } | null>(null);
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

  // ---- Save ----

  const save = useCallback(() => {
    const prog = activeProgramRef.current;
    if (!prog) return;
    setSavedSourceMap((prev) => ({
      ...prev,
      [prog.id]: prog.source,
    }));
    // TODO: persist to backend via GraphQL mutation
  }, []);

  // ---- Compile (mock) ----

  const compile = useCallback(async () => {
    const prog = activeProgramRef.current;
    if (!prog) return;
    setCompileStatus('compiling');
    setDiagnostics([]);

    // Mock compile delay
    await new Promise((r) => setTimeout(r, 800));

    // Simple mock validation: check for unmatched PROGRAM/END_PROGRAM
    const src = prog.source;
    const errors: CompileDiagnostic[] = [];

    const programCount = (src.match(/\bPROGRAM\b/gi) || []).length;
    const endProgramCount = (src.match(/\bEND_PROGRAM\b/gi) || []).length;
    if (programCount > endProgramCount) {
      errors.push({
        line: src.split('\n').length,
        column: 1,
        message: 'Missing END_PROGRAM',
        severity: 'error',
      });
    }

    const ifCount = (src.match(/\bIF\b/gi) || []).length;
    const endIfCount = (src.match(/\bEND_IF\b/gi) || []).length;
    if (ifCount > endIfCount) {
      errors.push({
        line: src.split('\n').length,
        column: 1,
        message: `Missing END_IF (${ifCount - endIfCount} unmatched)`,
        severity: 'error',
      });
    }

    setDiagnostics(errors);
    setCompileStatus(errors.length > 0 ? 'error' : 'success');

    // Set Monaco markers
    applyMarkers(errors);

    return errors;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Validate (mock) ----

  const validate = useCallback(async () => {
    const prog = activeProgramRef.current;
    if (!prog) return;
    setCompileStatus('compiling');
    setDiagnostics([]);

    await new Promise((r) => setTimeout(r, 400));

    const warnings: CompileDiagnostic[] = [];
    const lines = prog.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/\bGOTO\b/i.test(lines[i])) {
        warnings.push({
          line: i + 1,
          column: 1,
          message: 'GOTO usage is discouraged',
          severity: 'warning',
        });
      }
    }

    setDiagnostics(warnings);
    setCompileStatus(warnings.length > 0 ? 'warning' : 'success');
    applyMarkers(warnings);

    return warnings;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const [wsConnected, setWsConnected] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

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

  // Update outline on source change (debounced to avoid per-keystroke work)
  useEffect(() => {
    if (!activeProgram) return;
    const source = activeProgram.source;
    const timer = setTimeout(() => {
      setOutline(buildOutline(source));
    }, 300);
    return () => clearTimeout(timer);
  }, [activeProgram?.source, buildOutline]);

  // ---- Format Code ----

  const formatCode = useCallback(() => {
    const prog = activeProgramRef.current;
    if (!prog) return;

    const lines = prog.source.split('\n');
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
    updateSource(formatted.join('\n'));
  }, [updateSource]);

  // ---- Navigate to line ----

  const navigateToLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (editor && typeof (editor as any).revealLineInCenter === 'function') {
      (editor as any).revealLineInCenter(line);
      (editor as any).setPosition({ lineNumber: line, column: 1 });
      (editor as any).focus();
    }
  }, []);

  // ---- Toggle problems panel ----

  const toggleProblemsPanel = useCallback(() => {
    setIsProblemsExpanded((prev) => !prev);
  }, []);

  // ---- Keyboard shortcuts ----

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S → save
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        save();
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
      // F9 → deploy (placeholder)
      if (e.key === 'F9') {
        e.preventDefault();
        // TODO: deploy action
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
  }, [save, compile, validate, formatCode]);

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

    // Save / dirty
    isDirty,
    save,

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

    // WS state (placeholder for future backend integration)
    wsConnected,
    setWsConnected,
    isAnalyzing,
    setIsAnalyzing,

    // New actions
    formatCode,
    navigateToLine,

    // Editor refs (to be set by StEditorPanel on mount)
    editorRef,
    monacoRef,
  };
}
