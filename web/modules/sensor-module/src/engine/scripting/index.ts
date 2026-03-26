/**
 * SCADA Client-Side Scripting Sandbox -- Phase 5A + Phase 9D Extensions
 *
 * Public API surface for the scripting engine. All script execution
 * happens inside Web Worker sandboxes; no user code runs on the main thread.
 */

export type {
  ScriptTrigger,
  TagPrimitive,
  AlarmLevel,
  ScadaScript,
  WorkerRequest,
  WorkerResponse,
  ScriptSandboxAPI,
  ScriptExecutionResult,
} from './types';

export { SANDBOX_LIMITS } from './types';
export { getWorkerSource } from './workerScript';
export {
  ScriptExecutor,
  isValidScriptUrl,
  validateScriptCode,
  isPropertyPathSafe,
} from './ScriptExecutor';
export type { ScriptExecutorCallbacks } from './ScriptExecutor';
export { useScriptEngine } from './useScriptEngine';
