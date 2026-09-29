import type { JsonValue } from './strict-json';

export function deepFreezeJson(value: JsonValue): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  const children = Array.isArray(value) ? value : Object.values(value);
  children.forEach(deepFreezeJson);
  Object.freeze(value);
}
