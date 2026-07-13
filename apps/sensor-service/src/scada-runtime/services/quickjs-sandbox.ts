/**
 * QuickJS-WASM sandbox host.
 *
 * Executes untrusted, tenant-authored SCADA scripts inside a QuickJS
 * interpreter compiled to WebAssembly. Unlike Node's `vm` module — which
 * shares the host V8 heap and object graph and is explicitly NOT a security
 * boundary — QuickJS runs in an isolated linear-memory heap with its own
 * built-ins (`Math`, `JSON`, `Date`, `Promise`, …). The guest has no ambient
 * reference to `process`, `require`, `Buffer`, or any host object, so the
 * prototype-walk / Promise-constructor escapes that defeat `vm` are structurally
 * impossible here rather than defended against with frozen proxies.
 *
 * Bounded execution
 * ─────────────────
 * • CPU: `setInterruptHandler(shouldInterruptAfterDeadline(...))` aborts
 *   synchronous hot loops when the wall-clock deadline passes.
 * • Async hangs: the returned guest promise is raced against the same
 *   deadline; on expiry the whole context is disposed (hard abort).
 * • Memory / stack: `setMemoryLimit` + `setMaxStackSize`.
 *
 * The module is loaded once and cached; every execution gets a FRESH context
 * that is disposed in `finally`, so no state (tenant or otherwise) can leak
 * across runs.
 */

import {
  newQuickJSAsyncWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten';
import type {
  QuickJSAsyncWASMModule,
  QuickJSAsyncContext,
  QuickJSHandle,
} from 'quickjs-emscripten';
// Single-file CommonJS asyncify variant: the `.wasm` is embedded and the module
// is synchronously `require`-able, so it loads identically under the tsc/CJS
// production build and under ts-jest (which cannot service the dynamic `import()`
// the default wasmfile variant uses). ASYNC so host functions can be awaited.
import releaseAsyncVariant from '@jitl/quickjs-singlefile-cjs-release-asyncify';

/* ------------------------------------------------------------------ */
/*  Limits                                                              */
/* ------------------------------------------------------------------ */

/** Resource limits applied to every sandbox execution. */
export interface SandboxLimits {
  /** Wall-clock deadline for the whole execution (sync + async). */
  timeoutMs: number;
  /** Maximum linear-memory heap the guest may allocate. */
  memoryBytes: number;
  /** Maximum guest call-stack size. */
  maxStackBytes: number;
}

/** Default limits: 5 s, 32 MiB heap, 512 KiB stack. */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 5_000,
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
};

/* ------------------------------------------------------------------ */
/*  Bridge surface                                                      */
/* ------------------------------------------------------------------ */

/** A synchronous host function exposed to the guest (e.g. `$getTag`). */
export type SyncBridge = (...args: unknown[]) => unknown;
/** An asynchronous host function exposed to the guest (e.g. `$sendMessage`). */
export type AsyncBridge = (...args: unknown[]) => Promise<unknown>;
/** Console levels forwarded from the guest to the host. */
export type ConsoleLevel = 'log' | 'warn' | 'error';

/**
 * The complete set of host-provided globals a SCADA script may reach. Every
 * key here becomes a global inside the guest; nothing else host-derived is
 * reachable.
 */
export interface SandboxBridges {
  /** Synchronous `$`-prefixed system functions. */
  sync: Record<string, SyncBridge>;
  /** Asynchronous `$`-prefixed system functions (bridged via asyncify). */
  async: Record<string, AsyncBridge>;
  /** `console.log|warn|error` capture. */
  console: Record<ConsoleLevel, (...args: unknown[]) => void>;
  /** Resolved script parameters, injected as the `params` global. */
  params: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Module cache                                                        */
/* ------------------------------------------------------------------ */

let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;

/**
 * Load (once) and cache the async QuickJS WebAssembly module. The `.wasm`
 * binary ships inside the `quickjs-emscripten` package and is resolved from
 * `node_modules` by the loader — no build-step asset copying is required.
 */
export async function loadSandboxModule(): Promise<QuickJSAsyncWASMModule> {
  if (modulePromise === null) {
    modulePromise = newQuickJSAsyncWASMModuleFromVariant(releaseAsyncVariant);
  }
  return modulePromise;
}

/**
 * Drop the cached module so the next execution instantiates a fresh one.
 *
 * Asyncify state lives on the emscripten WASM instance (shared by every context
 * on the module). A run aborted mid-suspension — a host bridge that never
 * settled before the deadline — leaves that state wedged, which would make the
 * next asyncified call fail with "Attempted to suspend". After such an abort we
 * discard the (now unreferenced, GC-eligible) instance; re-instantiation costs
 * a few milliseconds and only happens after a timeout, not on the happy path.
 */
export function invalidateSandboxModule(): void {
  modulePromise = null;
}

/* ------------------------------------------------------------------ */
/*  Marshalling: host value -> guest handle                            */
/* ------------------------------------------------------------------ */

/**
 * Recursively convert a JSON-shaped host value into a guest handle. The caller
 * takes ownership of the returned handle and must dispose it (or transfer it to
 * the guest via `setProp`, which dups the reference).
 *
 * Only JSON-representable values are supported (the shape script params and
 * bridge return values actually carry). Functions, symbols and bigints marshal
 * to `undefined`, keeping non-serialisable host references out of the guest.
 */
function hostToHandle(ctx: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) {
    return ctx.undefined;
  }
  switch (typeof value) {
    case 'number':
      return ctx.newNumber(value);
    case 'string':
      return ctx.newString(value);
    case 'boolean':
      return value ? ctx.true : ctx.false;
    case 'object':
      break;
    default:
      // function | symbol | bigint — not representable, drop to undefined.
      return ctx.undefined;
  }

  if (Array.isArray(value)) {
    const arr = ctx.newArray();
    for (let i = 0; i < value.length; i++) {
      const elem = hostToHandle(ctx, value[i]);
      ctx.setProp(arr, i, elem);
      elem.dispose();
    }
    return arr;
  }

  const obj = ctx.newObject();
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const propHandle = hostToHandle(ctx, val);
    ctx.setProp(obj, key, propHandle);
    propHandle.dispose();
  }
  return obj;
}

/* ------------------------------------------------------------------ */
/*  Bridge binding                                                      */
/* ------------------------------------------------------------------ */

/** Bind a synchronous host function as a guest global. */
function bindSyncBridge(
  ctx: QuickJSAsyncContext,
  name: string,
  fn: SyncBridge,
): void {
  const handle = ctx.newFunction(name, (...argHandles) => {
    try {
      const args = argHandles.map((h) => ctx.dump(h));
      const result = fn(...args);
      return hostToHandle(ctx, result);
    } catch (err) {
      return { error: ctx.newError((err as Error).message) };
    }
  });
  ctx.setProp(ctx.global, name, handle);
  handle.dispose();
}

/**
 * Bind an asynchronous host function as a guest global via asyncify. The guest
 * `await`s the call transparently; the VM stack unwinds while the host promise
 * settles and is restored with the marshalled result. The host implementation
 * never re-enters the VM, so the asyncify "no nested asyncified calls"
 * restriction cannot be violated.
 */
function bindAsyncBridge(
  ctx: QuickJSAsyncContext,
  name: string,
  fn: AsyncBridge,
): void {
  const handle = ctx.newAsyncifiedFunction(name, async (...argHandles) => {
    try {
      const args = argHandles.map((h) => ctx.dump(h));
      const result = await fn(...args);
      return hostToHandle(ctx, result);
    } catch (err) {
      return { error: ctx.newError((err as Error).message) };
    }
  });
  ctx.setProp(ctx.global, name, handle);
  handle.dispose();
}

/** Bind the `console` object (log/warn/error) as a guest global. */
function bindConsole(
  ctx: QuickJSAsyncContext,
  console: SandboxBridges['console'],
): void {
  const consoleObj = ctx.newObject();
  for (const level of ['log', 'warn', 'error'] as const) {
    const fnHandle = ctx.newFunction(level, (...argHandles) => {
      const args = argHandles.map((h) => ctx.dump(h));
      console[level](...args);
      return ctx.undefined;
    });
    ctx.setProp(consoleObj, level, fnHandle);
    fnHandle.dispose();
  }
  ctx.setProp(ctx.global, 'console', consoleObj);
  consoleObj.dispose();
}

/* ------------------------------------------------------------------ */
/*  Execution                                                           */
/* ------------------------------------------------------------------ */

/** Wrap user code so top-level `await` works and a `return` value is captured. */
function wrapUserCode(code: string): string {
  return `(async function __scadaScript__() {\n${code}\n})()`;
}

/**
 * Execute untrusted script `code` inside a fresh QuickJS context with the given
 * bridges and limits. Returns the guest's return value marshalled to a host
 * value, or throws an `Error` describing a compile error, a runtime exception,
 * or a deadline/limit breach. The context is always disposed before returning.
 */
export async function runInSandbox(
  code: string,
  bridges: SandboxBridges,
  limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
): Promise<unknown> {
  const mod = await loadSandboxModule();
  const ctx = mod.newContext();
  const deadline = Date.now() + limits.timeoutMs;

  try {
    ctx.runtime.setMemoryLimit(limits.memoryBytes);
    ctx.runtime.setMaxStackSize(limits.maxStackBytes);
    ctx.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

    // Inject the full host surface. Everything else the guest sees (Math, JSON,
    // Date, Promise, Array, …) is QuickJS's own isolated built-in.
    for (const [name, fn] of Object.entries(bridges.sync)) {
      bindSyncBridge(ctx, name, fn);
    }
    for (const [name, fn] of Object.entries(bridges.async)) {
      bindAsyncBridge(ctx, name, fn);
    }
    bindConsole(ctx, bridges.console);

    const paramsHandle = hostToHandle(ctx, bridges.params);
    ctx.setProp(ctx.global, 'params', paramsHandle);
    paramsHandle.dispose();

    // The whole evaluation — including `evalCodeAsync` itself — is raced against
    // the wall-clock deadline. This matters for asyncify: when the guest awaits
    // a never-settling host bridge, the VM stack unwinds and `evalCodeAsync`
    // stays suspended, so the interrupt handler (which only fires while the VM
    // is running) cannot end it. The deadline race + `finally` dispose is the
    // hard-abort path for that async-hang case.
    const execution = (async (): Promise<unknown> => {
      const evalResult = await ctx.evalCodeAsync(wrapUserCode(code), 'scada-script.js');
      const returnHandle = ctx.unwrapResult(evalResult);
      const settledPromise = ctx.resolvePromise(returnHandle);
      returnHandle.dispose();
      ctx.runtime.executePendingJobs();
      const raced = ctx.unwrapResult(await settledPromise);
      const value = ctx.dump(raced);
      raced.dispose();
      return value;
    })();

    // If the deadline wins, `execution` is abandoned mid-suspension and the
    // context is disposed in `finally`. Should a wedged host bridge resolve
    // afterwards, the resume would touch the disposed context and reject — swallow
    // that here so it never surfaces as an unhandled rejection.
    let settled = false;
    execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      return await raceDeadline(execution, deadline);
    } finally {
      // A run that did not settle before the deadline was abandoned mid-flight
      // and may have wedged the shared module's asyncify state — discard the
      // cached instance so the next execution starts clean.
      if (!settled) {
        invalidateSandboxModule();
      }
    }
  } finally {
    // Disposing the context tears down the entire guest heap, aborting any
    // still-pending guest work (the async-hang hard-abort path).
    ctx.dispose();
  }
}

/**
 * Race a settling promise against the execution deadline. On expiry, reject so
 * the caller (and the `finally` that disposes the context) can abort a guest
 * that is stuck on a never-resolving `await`.
 */
async function raceDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Script execution timed out');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Script execution timed out')),
      remaining,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
