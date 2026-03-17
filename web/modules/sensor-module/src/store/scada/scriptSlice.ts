/**
 * scriptSlice — Script management state & actions.
 *
 * Manages SCADA scripts (server-side and client-side), their execution
 * state, and the script console output buffer.
 */
import type { ScadaSliceCreator } from './types';
import { generateId } from './types';
import type { ScadaScript } from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Console output entry                                               */
/* ------------------------------------------------------------------ */

export interface ScriptConsoleEntry {
  scriptId: string;
  message: string;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  Slice Interface                                                     */
/* ------------------------------------------------------------------ */

export interface ScriptSlice {
  // State
  scripts: ScadaScript[];
  scriptConsoleOutput: ScriptConsoleEntry[];
  runningScripts: Set<string>;

  // Actions
  addScript: (script: Omit<ScadaScript, 'id'>) => string;
  updateScript: (id: string, updates: Partial<ScadaScript>) => void;
  removeScript: (id: string) => void;
  setScriptRunning: (id: string, running: boolean) => void;
  addConsoleOutput: (scriptId: string, message: string) => void;
  clearConsoleOutput: (scriptId?: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Slice Creator                                                       */
/* ------------------------------------------------------------------ */

export const createScriptSlice: ScadaSliceCreator<ScriptSlice> = (set) => ({
  // Initial state
  scripts: [],
  scriptConsoleOutput: [],
  runningScripts: new Set<string>(),

  // Actions
  addScript: (script) => {
    const id = generateId();
    set((state) => {
      state.scripts.push({ ...script, id });
    });
    return id;
  },

  updateScript: (id, updates) =>
    set((state) => {
      const script = state.scripts.find((s) => s.id === id);
      if (!script) return;
      Object.assign(script, updates);
    }),

  removeScript: (id) =>
    set((state) => {
      state.scripts = state.scripts.filter((s) => s.id !== id);
      state.runningScripts.delete(id);
      state.scriptConsoleOutput = state.scriptConsoleOutput.filter(
        (entry) => entry.scriptId !== id,
      );
    }),

  setScriptRunning: (id, running) =>
    set((state) => {
      if (running) {
        state.runningScripts.add(id);
      } else {
        state.runningScripts.delete(id);
      }
    }),

  addConsoleOutput: (scriptId, message) =>
    set((state) => {
      state.scriptConsoleOutput.push({
        scriptId,
        message,
        timestamp: Date.now(),
      });
    }),

  clearConsoleOutput: (scriptId) =>
    set((state) => {
      if (scriptId === undefined) {
        state.scriptConsoleOutput = [];
      } else {
        state.scriptConsoleOutput = state.scriptConsoleOutput.filter(
          (entry) => entry.scriptId !== scriptId,
        );
      }
    }),
});
