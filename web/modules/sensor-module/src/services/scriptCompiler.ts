type CompiledScadaScript = (...args: unknown[]) => Promise<unknown>;

type AsyncFunctionConstructor = new (
  ...args: string[]
) => CompiledScadaScript;

const AsyncFunction = Object.getPrototypeOf(
  async function scadaScriptCompilerProbe(): Promise<void> {
    return undefined;
  },
).constructor as AsyncFunctionConstructor;

export function compileScadaScript(
  bridgeNames: readonly string[],
  code: string,
): CompiledScadaScript {
  return new AsyncFunction(
    ...bridgeNames,
    'params',
    `"use strict";
${code}`,
  );
}
