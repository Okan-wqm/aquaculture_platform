/**
 * useStEditor - Hook for PLC mode Structured Text editor state
 *
 * Manages program list CRUD, compile/validate (mock), dirty tracking,
 * Monaco error markers, and keyboard shortcuts (F5, F7, Ctrl+S).
 */
import { useState, useCallback, useRef, useEffect } from 'react';

export interface StProgram {
  id: string;
  name: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export type CompileStatus = 'idle' | 'compiling' | 'success' | 'error';

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

export function useStEditor() {
  // Program list
  const [programs, setPrograms] = useState<StProgram[]>(() => {
    const initial: StProgram = {
      id: makeId(),
      name: 'Main',
      source: DEFAULT_SOURCE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return [initial];
  });

  // Active program
  const [activeProgramId, setActiveProgramId] = useState<string>(
    () => programs[0]?.id ?? '',
  );

  const activeProgram = programs.find((p) => p.id === activeProgramId) ?? null;

  // Dirty flag: tracks if source changed since last save
  const [savedSourceMap, setSavedSourceMap] = useState<Record<string, string>>(
    () => {
      const map: Record<string, string> = {};
      for (const p of programs) map[p.id] = p.source;
      return map;
    },
  );

  const isDirty =
    activeProgram != null &&
    activeProgram.source !== (savedSourceMap[activeProgram.id] ?? '');

  // Compile state
  const [compileStatus, setCompileStatus] = useState<CompileStatus>('idle');
  const [diagnostics, setDiagnostics] = useState<CompileDiagnostic[]>([]);

  // Monaco editor ref (set externally)
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

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
    setPrograms((prev) =>
      prev.map((p) =>
        p.id === activeProgramId
          ? { ...p, source, updatedAt: Date.now() }
          : p,
      ),
    );
  }, [activeProgramId]);

  // ---- Save ----

  const save = useCallback(() => {
    if (!activeProgram) return;
    setSavedSourceMap((prev) => ({
      ...prev,
      [activeProgram.id]: activeProgram.source,
    }));
    // TODO: persist to backend via GraphQL mutation
  }, [activeProgram]);

  // ---- Compile (mock) ----

  const compile = useCallback(async () => {
    if (!activeProgram) return;
    setCompileStatus('compiling');
    setDiagnostics([]);

    // Mock compile delay
    await new Promise((r) => setTimeout(r, 800));

    // Simple mock validation: check for unmatched PROGRAM/END_PROGRAM
    const src = activeProgram.source;
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
  }, [activeProgram]);

  // ---- Validate (mock) ----

  const validate = useCallback(async () => {
    if (!activeProgram) return;
    setCompileStatus('compiling');
    setDiagnostics([]);

    await new Promise((r) => setTimeout(r, 400));

    const warnings: CompileDiagnostic[] = [];
    const lines = activeProgram.source.split('\n');
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
    setCompileStatus(warnings.length > 0 ? 'error' : 'success');
    applyMarkers(warnings);

    return warnings;
  }, [activeProgram]);

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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [save, compile, validate]);

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

    // Editor refs (to be set by StEditorPanel on mount)
    editorRef,
    monacoRef,
  };
}
