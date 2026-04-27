// Public surface of the @aqua/cargo executor package.
//
// Executors are resolved by Nx via executors.json -> ./dist/run/executor.
// This index file exists so the package has a deterministic entry for
// downstream callers that import the executor directly (e.g. unit tests).
export { default as cargoRunExecutor } from './run/executor.js';
export type { CargoRunOptions, ExecutorContext } from './run/executor.js';
