/**
 * setByPointer — RFC 6901 set used to apply operator overrides onto an
 * assembled report body before submission.
 */
import { setByPointer, parsePointer } from '../services/json-pointer.util';

describe('parsePointer', () => {
  it('decodes escaped tokens (~1 -> /, ~0 -> ~)', () => {
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
  });

  it('rejects an empty pointer and a pointer without a leading slash', () => {
    expect(() => parsePointer('')).toThrow();
    expect(() => parsePointer('a/b')).toThrow();
  });
});

describe('setByPointer', () => {
  it('sets a top-level key', () => {
    const target: Record<string, unknown> = {};
    setByPointer(target, '/lusetelling', { voksneHunnlus: 0.3 });
    expect(target).toEqual({ lusetelling: { voksneHunnlus: 0.3 } });
  });

  it('replaces an existing subtree wholesale', () => {
    const target: Record<string, unknown> = { lusetelling: { voksneHunnlus: 1 } };
    setByPointer(target, '/lusetelling', { voksneHunnlus: 0, bevegeligeLus: 0 });
    expect(target.lusetelling).toEqual({ voksneHunnlus: 0, bevegeligeLus: 0 });
  });

  it('creates intermediate objects', () => {
    const target: Record<string, unknown> = {};
    setByPointer(target, '/a/b/c', 5);
    expect(target).toEqual({ a: { b: { c: 5 } } });
  });

  it('creates an array when the next token is an index', () => {
    const target: Record<string, unknown> = {};
    setByPointer(target, '/items/0/qty', 2);
    expect(Array.isArray(target.items)).toBe(true);
    expect(target).toEqual({ items: [{ qty: 2 }] });
  });

  it('sets an existing array index', () => {
    const target: Record<string, unknown> = { items: [{ qty: 1 }, { qty: 2 }] };
    setByPointer(target, '/items/1/qty', 9);
    expect(target.items).toEqual([{ qty: 1 }, { qty: 9 }]);
  });
});
