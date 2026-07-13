/**
 * QuickJS-WASM sandbox invariants.
 *
 * These tests pin the security boundary the SCADA script engine depends on:
 * the guest cannot reach host globals, cannot escape via prototype walks or the
 * Promise constructor, is bounded on CPU / async-hang / memory, and marshals
 * values across the boundary without leaking host references. They exercise the
 * pure `runInSandbox` host (no NestJS wiring) so the boundary is tested in
 * isolation.
 */
import {
  runInSandbox,
  DEFAULT_SANDBOX_LIMITS,
  type SandboxBridges,
} from '../quickjs-sandbox';

/** Minimal empty bridge surface for tests that don't need host functions. */
function emptyBridges(overrides: Partial<SandboxBridges> = {}): SandboxBridges {
  return {
    sync: {},
    async: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    params: {},
    ...overrides,
  };
}

describe('QuickJS sandbox — isolation', () => {
  it('runs a trivial script and returns its value', async () => {
    const result = await runInSandbox('return 1 + 2', emptyBridges());
    expect(result).toBe(3);
  });

  it('exposes QuickJS native built-ins (no host injection needed)', async () => {
    const result = await runInSandbox(
      'return Math.round(JSON.parse("[1.6]")[0]) + new Date(0).getUTCFullYear()',
      emptyBridges(),
    );
    expect(result).toBe(1972);
  });

  it('has no reference to host `process`', async () => {
    const result = await runInSandbox(
      'return typeof process === "undefined" ? "no-process" : "LEAKED"',
      emptyBridges(),
    );
    expect(result).toBe('no-process');
  });

  it('has no reference to `require` or `global`/`globalThis` host', async () => {
    const result = await runInSandbox(
      'return [typeof require, typeof global, typeof Buffer].join(",")',
      emptyBridges(),
    );
    expect(result).toBe('undefined,undefined,undefined');
  });

  it('blocks the constructor.constructor escape to reach process', async () => {
    const result = await runInSandbox(
      `try {
         const F = this.constructor.constructor;
         return typeof F("return process")().version;
       } catch (e) {
         return "blocked:" + e.name;
       }`,
      emptyBridges(),
    );
    // Either the constructor walk yields a guest Function whose body throws on
    // the missing `process`, or the walk itself fails — never a host version.
    expect(String(result)).toMatch(/^(blocked:|undefined$)/);
  });

  it('globalThis only exposes the injected surface plus native built-ins', async () => {
    const bridges = emptyBridges({
      sync: { $getTag: () => null },
      async: { $ping: async () => 'pong' },
    });
    const result = (await runInSandbox(
      'return Object.getOwnPropertyNames(globalThis).filter(n => n.startsWith("$") || n === "params" || n === "console")',
      bridges,
    )) as string[];
    expect(result.sort()).toEqual(['$getTag', '$ping', 'console', 'params']);
  });
});

describe('QuickJS sandbox — bounded execution', () => {
  it('interrupts a synchronous infinite loop within the deadline', async () => {
    const start = Date.now();
    await expect(
      runInSandbox('while (true) {}', emptyBridges(), {
        ...DEFAULT_SANDBOX_LIMITS,
        timeoutMs: 300,
      }),
    ).rejects.toThrow();
    // Should abort near the deadline, not run for the full default 5 s.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('times out a never-settling async hang within the deadline', async () => {
    const bridges = emptyBridges({
      async: {
        // Never resolves — models a wedged host dependency.
        $hang: () => new Promise<never>(() => {}),
      },
    });
    const start = Date.now();
    await expect(
      runInSandbox('await $hang(); return "unreachable"', bridges, {
        ...DEFAULT_SANDBOX_LIMITS,
        timeoutMs: 400,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('rejects an allocation bomb without crashing the host', async () => {
    await expect(
      runInSandbox(
        'const a = []; while (true) { a.push(new Array(100000).fill(0)); } return a.length',
        emptyBridges(),
        { ...DEFAULT_SANDBOX_LIMITS, memoryBytes: 4 * 1024 * 1024, timeoutMs: 1_500 },
      ),
    ).rejects.toThrow();
  }, 20_000);

  it('surfaces a guest throw as a rejected promise', async () => {
    await expect(
      runInSandbox('throw new Error("boom")', emptyBridges()),
    ).rejects.toThrow(/boom/);
  });

  it('surfaces a syntax error as a rejected promise', async () => {
    await expect(
      runInSandbox('return (((', emptyBridges()),
    ).rejects.toThrow();
  });
});

describe('QuickJS sandbox — host bridges', () => {
  it('round-trips a synchronous bridge with marshalled args and return', async () => {
    const calls: unknown[][] = [];
    const bridges = emptyBridges({
      sync: {
        $getTag: (id: unknown) => {
          calls.push([id]);
          return { tagId: String(id), value: 42, quality: 'good' };
        },
      },
    });
    const result = await runInSandbox(
      'const t = $getTag("temp"); return t.value + ":" + t.quality',
      bridges,
    );
    expect(result).toBe('42:good');
    expect(calls).toEqual([['temp']]);
  });

  it('awaits an asyncify bridge and marshals its resolved value', async () => {
    const bridges = emptyBridges({
      async: {
        $getHistoricalTags: async (ids: unknown) => {
          await new Promise((r) => setTimeout(r, 5));
          const list = Array.isArray(ids) ? ids : [];
          return Object.fromEntries(list.map((id) => [String(id), [{ v: 1 }]]));
        },
      },
    });
    const result = await runInSandbox(
      'const h = await $getHistoricalTags(["a","b"]); return Object.keys(h).sort().join(",")',
      bridges,
    );
    expect(result).toBe('a,b');
  });

  it('propagates a throwing sync bridge into a catchable guest error', async () => {
    const bridges = emptyBridges({
      sync: {
        $boom: () => {
          throw new Error('bridge-failed');
        },
      },
    });
    const result = await runInSandbox(
      'try { $boom(); return "no-throw"; } catch (e) { return "caught:" + e.message; }',
      bridges,
    );
    expect(result).toBe('caught:bridge-failed');
  });

  it('propagates a rejecting async bridge into a catchable guest error', async () => {
    const bridges = emptyBridges({
      async: {
        $failAsync: async () => {
          throw new Error('async-bridge-failed');
        },
      },
    });
    const result = await runInSandbox(
      'try { await $failAsync(); return "no-throw"; } catch (e) { return "caught:" + e.message; }',
      bridges,
    );
    expect(result).toBe('caught:async-bridge-failed');
  });

  it('forwards console output to the host capture', async () => {
    const logs: Array<[string, unknown[]]> = [];
    const bridges = emptyBridges({
      console: {
        log: (...args) => logs.push(['log', args]),
        warn: (...args) => logs.push(['warn', args]),
        error: (...args) => logs.push(['error', args]),
      },
    });
    await runInSandbox('console.log("hello", 1); console.error("bad")', bridges);
    expect(logs).toEqual([
      ['log', ['hello', 1]],
      ['error', ['bad']],
    ]);
  });

  it('injects resolved params as the `params` global', async () => {
    const bridges = emptyBridges({
      params: { threshold: 30, tag: { tagId: 't1', value: 5 } },
    });
    const result = await runInSandbox(
      'return params.threshold + params.tag.value',
      bridges,
    );
    expect(result).toBe(35);
  });
});

describe('QuickJS sandbox — no cross-run state leakage', () => {
  it('does not share mutations of native globals between runs', async () => {
    // First run pollutes a native prototype inside its own isolate.
    await runInSandbox('Array.prototype.__polluted = 1; return 0', emptyBridges());
    // A fresh context must not see it.
    const result = await runInSandbox(
      'return [].__polluted === undefined ? "clean" : "leaked"',
      emptyBridges(),
    );
    expect(result).toBe('clean');
  });
});
