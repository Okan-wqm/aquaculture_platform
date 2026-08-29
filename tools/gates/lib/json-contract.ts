/** ES2021-compatible own-property predicate shared by repository contract tooling. */
export function hasOwn<Key extends PropertyKey>(
  value: object,
  key: Key,
): value is object & Record<Key, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}
