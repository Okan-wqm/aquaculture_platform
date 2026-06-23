// Ambient augmentation of Jest's `Matchers` interface so TypeScript accepts
// `expect(...).toHaveNoDrift()` (registered by registerDriftMatcher in
// expect-no-drift.ts) without an in-source `declare global` block — which would
// otherwise need an inline no-namespace lint suppression in a runtime module.
// Living in a `.d.ts` keeps the runtime module suppression-free; `.d.ts` files
// are excluded from linting, and the type-only augmentation still ships to every
// spec. The `<R, T = {}>` arity mirrors @types/jest's own
// `interface Matchers<R, T = {}>` so declaration merging applies rather than
// redeclaring a conflicting symbol.
declare global {
  namespace jest {
    interface Matchers<R, T = {}> {
      toHaveNoDrift(): R;
    }
  }
}

export {};
