/**
 * useStEditor - Hook for PLC mode Structured Text editor state
 *
 * Manages program list CRUD, compile/validate (mock), dirty tracking,
 * Monaco error markers, keyboard shortcuts (F5, F7, F9, Ctrl+S, Shift+Alt+F),
 * outline tree, problems panel, code formatting, and JSON bundle export/import.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useStLanguageService } from './useStLanguageService';
import type { STDiagnostic, STOutlineNode } from '../types/st-editor.types';

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
}

export function useStEditor(options?: UseStEditorOptions) {
  const { initialSource, onSourceChange } = options ?? {};

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
      // Ctrl+S → save (internal dirty tracking only; parent handleSave is
      // triggered by Monaco's own keybinding when the editor has focus)
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        // Only update dirty-tracking map; do NOT call save() here because
        // the parent component's onSave callback (wired through Monaco
        // keybinding in StEditorPanel) is the one that triggers the actual
        // GraphQL mutation.  Calling save() from this window-level handler
        // would skip the real persist and confuse users into thinking their
        // code was saved when it was only marked clean in-memory.
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
