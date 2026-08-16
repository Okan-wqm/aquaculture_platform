/**
 * Canonical class-constructor shape for metadata/decorator boundaries.
 * `Function` is intentionally not used: it accepts callable objects without
 * a construct signature and erases every useful type guarantee.
 */
export type ClassConstructor<TInstance extends object = object> = abstract new (
  ...args: never[]
) => TInstance;

export function isClassConstructor(value: unknown): value is ClassConstructor {
  return typeof value === 'function';
}
