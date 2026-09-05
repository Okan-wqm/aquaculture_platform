/**
 * Typed test doubles — the SSoT for standing something in for a real type.
 *
 * ## The hole this closes
 *
 * CLAUDE.md's Code Quality Standards ban the four usual type escape hatches — the
 * blanket cast, the double cast through `unknown`, and the two compiler-suppression
 * comments — and `tools/gates/banned-construct.ts` refuses all four at commit time.
 * `as never` was not on that list, so it became the escape hatch people reached
 * for instead:
 * 403 code-level uses across 102 files, 100 of them spec files. Every one of them
 * is a value being forced into a type the compiler was never allowed to check.
 *
 * Meanwhile the same three lines were hand-copied into 33 separate spec files:
 *
 *     function mock<T>(impl: Partial<T>): T { return impl as T; }
 *
 * — byte-identical in all 33, and strictly better than `as never` because
 * `Partial<T>` checks the NAMES and SIGNATURES of everything the double does
 * define. That idiom belonged here, in the library whose stated purpose is
 * "centralizes mock factories that were duplicated across 15+ service test
 * files", not re-declared once per suite.
 *
 * ## Why `as never` is worse than untyped — it is silently WRONG
 *
 * `x as never` type-checks nothing at all, so a double drifts away from the type
 * it stands in for and keeps compiling. Production renames a method, adds a
 * collaborator call, changes sync to async — the double is frozen at the old
 * shape and the suite stays green for the wrong reason, or dies at runtime with
 * `TypeError: <thing> is not a function`. That exact failure has already been hit
 * in this repository. The compiler could have caught it; the cast is what stopped it.
 *
 * ## The two doubles, and why one helper cannot serve both
 *
 * A stand-in is one of two things, and they want opposite behaviour for a member
 * nobody defined:
 *
 *   - `stub<T>()` — a VALUE (entity, DTO, row, event payload). Reading an unset
 *     optional field must yield `undefined`, because that is what the real value
 *     does. Compile-time checking only.
 *
 *   - `collaborator<T>()` — a BEHAVIOUR (injected service, repository, manager).
 *     Reading a member nobody defined means the code under test is calling
 *     something this double does not model. That is the drift bug above, and it
 *     should fail loudly AT the access, naming the type and the member, instead
 *     of surfacing as `undefined is not a function` three frames away.
 *
 * Collapsing them into one helper would force one of the two to be wrong, so both
 * exist and the choice is made by the name at the call site.
 *
 * @see tools/gates/banned-construct.ts — the `as never` rule that makes this the
 *      cheaper path (tier-2: the correct behaviour is the zero-effort default).
 */

/**
 * Thrown when code under test touches a member a `collaborator()` double never
 * defined. Carries the pieces separately so a spec can assert on them without
 * matching prose.
 */
export class MissingDoubleMemberError extends Error {
  public readonly doubleLabel: string;
  public readonly member: string;

  constructor(doubleLabel: string, member: string) {
    super(
      `Test double "${doubleLabel}" has no member "${member}", but the code under ` +
        `test accessed it. Either the double has drifted from the real type (a ` +
        `collaborator call was added or renamed in production), or the double is ` +
        `missing a stub it now needs. Add "${member}" to the collaborator() shape — ` +
        `Partial<T> will type-check the signature for you.`,
    );
    this.name = 'MissingDoubleMemberError';
    this.doubleLabel = doubleLabel;
    this.member = member;
  }
}

/**
 * String keys a `collaborator()` double answers with `undefined` instead of
 * throwing, because the runtime and the test framework probe them on ordinary
 * objects and a throw there would be a false failure, not a caught bug:
 *
 *   - `then`/`catch`/`finally` — the thenable probe every `await` and every
 *     promise resolution performs. Throwing here breaks `await double` and any
 *     double returned from an async stub.
 *   - `toJSON`/`inspect`/`constructor`/`valueOf`/`toString` — serialization and
 *     printing, which jest does when it renders a failure diff. A double must be
 *     printable while a DIFFERENT assertion is failing.
 *   - `asymmetricMatch`/`$$typeof`/`nodeType`/`tagName` — jest matcher and
 *     React/DOM element sniffing.
 *
 * Symbol keys are never thrown for at all (see the `get` trap): every one of them
 * is a language- or tooling-level protocol probe (`Symbol.toStringTag`,
 * `Symbol.iterator`, `nodejs.util.inspect.custom`, …), never a collaborator call.
 */
const RUNTIME_PROBE_KEYS: ReadonlySet<string> = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'inspect',
  'constructor',
  'valueOf',
  'toString',
  'asymmetricMatch',
  '$$typeof',
  'nodeType',
  'tagName',
]);

/**
 * A stand-in VALUE: entity, DTO, row, event payload, GraphQL input.
 *
 * `Partial<T>` is the whole point — it type-checks the name and the type of every
 * field the fixture DOES set against the real `T`, so a renamed or retyped column
 * breaks the fixture at compile time. Fields the fixture omits read as `undefined`,
 * which is what a partially-populated real value does.
 *
 * Replaces `{ ... } as never` — and the double-cast-through-unknown form — at
 * every fixture site.
 *
 * @example
 *   const meal = stub<FeedingMeal>({ id: 'm1', status: MealStatus.SCHEDULED });
 */
export function stub<T>(shape: Partial<T>): T {
  return shape as T;
}

/**
 * A stand-in BEHAVIOUR: an injected service, repository, EntityManager, bus —
 * anything whose methods the code under test calls.
 *
 * Same compile-time checking as {@link stub}, plus a runtime guard: touching a
 * member this double does not define throws {@link MissingDoubleMemberError}
 * naming the double and the member. That converts the drift class — production
 * grows a collaborator call the double never modelled — from a green suite or a
 * bare `TypeError` into a failure that says exactly what is missing.
 *
 * @param shape  the members this double models; type-checked against `T`
 * @param label  what this double stands in for, used in the failure message.
 *               Use the real type's name (`'BiomassGrowthApplierService'`).
 *
 * @example
 *   const applier = collaborator<BiomassGrowthApplierService>(
 *     { applyGrowth: jest.fn() },
 *     'BiomassGrowthApplierService',
 *   );
 *   // production later calls applier.lockUnitForGrowth(...) →
 *   // MissingDoubleMemberError: Test double "BiomassGrowthApplierService" has no
 *   // member "lockUnitForGrowth" …
 */
export function collaborator<T extends object>(shape: Partial<T>, label: string): T {
  return new Proxy(shape, {
    get(target: Partial<T>, property: string | symbol, receiver: unknown): unknown {
      if (typeof property === 'symbol') {
        return Reflect.get(target, property, receiver);
      }
      if (property in target || RUNTIME_PROBE_KEYS.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new MissingDoubleMemberError(label, property);
    },
  }) as T;
}

/**
 * A double for ONE member whose declared type is an overload set or a generic
 * signature — `Repository.save`, `Repository.create`, `EntityManager.getRepository`.
 *
 * TypeScript cannot check a single-signature `jest.fn` against an overload set:
 * assignability requires the source to satisfy EVERY overload, and a mock that
 * models the one call the test makes never does. That is a real limitation, not
 * a missing annotation, and it is why these members were the last redoubt of the
 * blanket cast.
 *
 * So the cast lives here, once, instead of at each call site — and the call site
 * still has to NAME the member type it is standing in for:
 *
 *     stub<Repository<ProtocolAssignment>>({
 *       save: stubMember<Repository<ProtocolAssignment>['save']>(jest.fn(...)),
 *     })
 *
 * which keeps two checks a blanket cast on the enclosing object throws away:
 * `save` must still exist on `Repository`, and every OTHER member of the double
 * is still checked against the real type. Reach for it only for the overloaded
 * or generic member — a plain member belongs in the {@link stub} shape directly,
 * where it is fully checked.
 */
export function stubMember<Fn>(impl: (...args: never[]) => unknown): Fn {
  return impl as unknown as Fn;
}
