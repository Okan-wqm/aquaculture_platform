import { freezeAuthorityGraphV1 } from './authority-immutability';

describe('freezeAuthorityGraphV1', () => {
  it('recursively freezes one strict JSON data graph in place', () => {
    const graph = { authority: { coordinates: ['one', 'two'] }, enabled: true };
    expect(freezeAuthorityGraphV1(graph)).toBe(graph);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.authority)).toBe(true);
    expect(Object.isFrozen(graph.authority.coordinates)).toBe(true);
    expect(Reflect.set(graph.authority, 'coordinates', [])).toBe(false);
  });

  it.each([
    ['Date', () => ({ value: new Date('2026-08-09T00:00:00.000Z') })],
    ['Map', () => ({ value: new Map([['key', 'value']]) })],
    ['Set', () => ({ value: new Set(['value']) })],
    ['function', () => ({ value: () => undefined })],
    ['symbol', () => ({ value: Symbol('value') })],
    ['bigint', () => ({ value: 1n })],
    [
      'accessor',
      () =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get: () => 'value',
        }),
    ],
    [
      'non-enumerable member',
      () => Object.defineProperty({}, 'value', { enumerable: false, value: 'value' }),
    ],
    [
      'symbol member',
      () => {
        const graph = { value: true } as Record<PropertyKey, unknown>;
        graph[Symbol('hidden')] = true;
        return graph;
      },
    ],
    [
      'sparse array',
      () => {
        const sparse: unknown[] = [];
        sparse.length = 1;
        return sparse;
      },
    ],
    ['proxy', () => new Proxy({ value: true }, {})],
  ])('rejects unsupported %s authority graphs', (_label, graph) => {
    expect(() => freezeAuthorityGraphV1(graph())).toThrow();
  });

  it('rejects cyclic authority graphs before freezing any node', () => {
    const graph: { readonly stable: { value: boolean }; cycle?: unknown } = {
      stable: { value: true },
    };
    graph.cycle = graph;
    expect(() => freezeAuthorityGraphV1(graph)).toThrow('CANONICAL_JSON_CYCLE');
    expect(Object.isFrozen(graph)).toBe(false);
    expect(Object.isFrozen(graph.stable)).toBe(false);
  });
});
