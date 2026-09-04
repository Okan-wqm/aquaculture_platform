import { MissingDoubleMemberError, collaborator, stub, stubMember } from '../typed-double';

/**
 * The doubling SSoT is imported by test suites across every service, so a
 * regression here is invisible in the place it breaks and loud everywhere else.
 * What is pinned:
 *
 *   - `stub` keeps `Partial<T>` semantics (unset field → undefined), because a
 *     partially-populated value is exactly what it stands in for;
 *   - `collaborator` throws on an un-modelled member — the whole reason it
 *     exists, and the difference from the `as never` casts it replaces;
 *   - `collaborator` does NOT throw on the property probes the runtime and jest
 *     perform on ordinary objects. That list is the risk surface: a double that
 *     explodes when jest tries to print it, or when it is awaited, would be
 *     worse than the cast it replaces, so each probe class is pinned.
 */

interface Meal {
  id: string;
  notes?: string;
  actualKg: number;
}

interface GrowthApplier {
  applyGrowth(unitId: string, kg: number): Promise<void>;
  lockUnitForGrowth(unitId: string): Promise<string | null>;
}

describe('stub', () => {
  it('returns the fields it was given', () => {
    const meal = stub<Meal>({ id: 'm1', actualKg: 12.5 });

    expect(meal.id).toBe('m1');
    expect(meal.actualKg).toBe(12.5);
  });

  it('reads an unset field as undefined rather than throwing', () => {
    const meal = stub<Meal>({ id: 'm1', actualKg: 0 });

    // `notes` is optional on the real type; a real partially-populated Meal
    // reads it as undefined and so must its stand-in.
    expect(meal.notes).toBeUndefined();
  });

  it('is the same object identity it was handed (no copy, no wrapper)', () => {
    const shape = { id: 'm1', actualKg: 1 };
    expect(stub<Meal>(shape)).toBe(shape);
  });
});

describe('collaborator', () => {
  it('exposes the members it models', async () => {
    const applier = collaborator<GrowthApplier>(
      { applyGrowth: jest.fn().mockResolvedValue(undefined) },
      'GrowthApplier',
    );

    await applier.applyGrowth('unit-1', 3);
    expect(applier.applyGrowth).toHaveBeenCalledWith('unit-1', 3);
  });

  it('throws MissingDoubleMemberError when code touches an un-modelled member', () => {
    const applier = collaborator<GrowthApplier>(
      { applyGrowth: jest.fn() },
      'BiomassGrowthApplierService',
    );

    // This is the drift class: production grows a call the double never
    // modelled. Under `as never` it surfaced as
    // `TypeError: ... is not a function`, several frames from the cause.
    expect(() => applier.lockUnitForGrowth('unit-1')).toThrow(MissingDoubleMemberError);
  });

  it('names the double and the member on the error, not just in the message', () => {
    const applier = collaborator<GrowthApplier>(
      { applyGrowth: jest.fn() },
      'BiomassGrowthApplierService',
    );

    try {
      // `void` because the declared return type is a Promise the double never
      // gets to produce — the proxy throws on member access, before any call.
      void applier.lockUnitForGrowth('unit-1');
      throw new Error('expected the double to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingDoubleMemberError);
      const missing = error as MissingDoubleMemberError;
      expect(missing.doubleLabel).toBe('BiomassGrowthApplierService');
      expect(missing.member).toBe('lockUnitForGrowth');
    }
  });

  it('does not throw for a member that is modelled as undefined on purpose', () => {
    // `in` is the test, not truthiness — a stub that deliberately models a
    // member as absent-valued is still modelling it.
    const applier = collaborator<GrowthApplier>({ applyGrowth: undefined }, 'GrowthApplier');

    expect(applier.applyGrowth).toBeUndefined();
  });

  describe('runtime and framework probes must not be mistaken for drift', () => {
    const double = collaborator<GrowthApplier>({ applyGrowth: jest.fn() }, 'GrowthApplier');

    it('survives being awaited (the thenable probe reads .then)', async () => {
      // Throwing on `.then` would break every `await double` and every double
      // returned from an async stub.
      await expect(Promise.resolve(double)).resolves.toBe(double);
    });

    it('survives being printed (jest renders doubles in failure diffs)', () => {
      expect(() => JSON.stringify(double)).not.toThrow();
      expect(() => String(Object.prototype.toString.call(double))).not.toThrow();
      expect(() => `${typeof double}`).not.toThrow();
    });

    it('survives symbol-keyed protocol probes', () => {
      expect(
        () => (double as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive],
      ).not.toThrow();
      expect(() => (double as { [Symbol.iterator]?: unknown })[Symbol.iterator]).not.toThrow();
      expect(
        () => (double as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag],
      ).not.toThrow();
    });

    it('survives jest equality matchers, which sniff for asymmetric matchers', () => {
      expect(() => expect(double).toEqual(double)).not.toThrow();
    });

    it('still reports its real own-keys, so deep equality stays honest', () => {
      expect(Object.keys(double)).toEqual(['applyGrowth']);
      expect('applyGrowth' in double).toBe(true);
      expect('lockUnitForGrowth' in double).toBe(false);
    });
  });
});

describe('stubMember', () => {
  /** An overload set, the shape `stub`'s Partial<T> cannot accept a jest.fn for. */
  interface Repo {
    save(rows: Meal[]): Promise<Meal[]>;
    save(row: Meal): Promise<Meal>;
    find(): Promise<Meal[]>;
  }

  it('produces a value the enclosing stub accepts for an overloaded member', async () => {
    const saved: Meal[] = [];
    const repo = stub<Repo>({
      // Not `async`: the signature returns a Promise, and an `async` body with
      // nothing to await is a promise wrapper spelled the long way — which is
      // exactly what @typescript-eslint/require-await refuses.
      save: stubMember<Repo['save']>(
        jest.fn((row: Meal) => {
          saved.push(row);
          return Promise.resolve(row);
        }),
      ),
    });

    await repo.save(stub<Meal>({ id: 'm1', actualKg: 4 }));
    expect(saved).toHaveLength(1);
  });

  it('does not weaken the rest of the double — a non-overloaded member stays checked', () => {
    // `find` is passed directly rather than through stubMember, so Partial<Repo>
    // checks it. This test exists to pin that stubMember is scoped to ONE member
    // and is not a way to opt the whole object out.
    const repo = stub<Repo>({
      find: jest.fn(() => Promise.resolve([])),
      save: stubMember<Repo['save']>(jest.fn()),
    });

    expect(typeof repo.find).toBe('function');
  });

  it('returns the same function identity, so jest assertions still work', () => {
    const impl = jest.fn();
    const member = stubMember<Repo['find']>(impl);

    expect(member).toBe(impl);
  });
});
