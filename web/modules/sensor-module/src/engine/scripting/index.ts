/**
 * SCADA Client-Side Scripting Sandbox — Phase 5A
 *
 * Public API surface for the scripting engine. All script execution
 * happens inside Web Worker sandboxes; no user code runs on the main thread.
 */

export type {
  ScriptTrigger,
  TagPrimitive,
  ScadaScript,
  WorkerRequest,
  WorkerResponse,
  ScriptSandboxAPI,
  ScriptExecutionResult,
} from './types';

export { SANDBOX_LIMITS } from './types';
export { getWorkerSource } from './workerScript';
export { ScriptExecutor, isValidScriptUrl, validateScriptCode } from './ScriptExecutor';
export { useScriptEngine } from './useScriptEngine';
