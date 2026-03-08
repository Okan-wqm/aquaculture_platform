/**
 * Simulation module barrel exports.
 *
 * Re-exports the ST parser, interpreter, and React hook so consumers
 * can import everything from a single entry point:
 *
 *   import { useSimulation, parseST, StInterpreter } from '../simulation';
 */
export { parseST } from './st-parser-lite';
export { StInterpreter } from './st-interpreter';
export type { SimValue, VariableInfo } from './st-interpreter';
export { useSimulation } from './useSimulation';
export type { SimulationState, UseSimulationReturn } from './useSimulation';
