import { useContext } from 'react';
import { ScadaRuntimeContext, type ScadaRuntimeContextValue } from './ScadaRuntime';

export function useScadaRuntime(): ScadaRuntimeContextValue {
  const ctx = useContext(ScadaRuntimeContext);
  if (!ctx) throw new Error('useScadaRuntime must be used within <ScadaRuntime>');
  return ctx;
}
