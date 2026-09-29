const portableIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !portableIdentifier.test(value)) {
    throw new TypeError(`${label} must be a portable ASCII identifier`);
  }
  return value;
}
