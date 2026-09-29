const remotePrefix = 'refs/remotes/';
const gitForbidden = new Set(['~', '^', ':', '?', '*', '[', '\\']);

function hasForbiddenCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code === undefined || code <= 0x20 || code > 0x7e || gitForbidden.has(character);
  });
}

function invalidComponent(component: string): boolean {
  return (
    component.length === 0 ||
    component.startsWith('.') ||
    component.endsWith('.') ||
    component.endsWith('.lock')
  );
}

export function requireCanonicalReviewedRef(value: unknown, label: string): string {
  const components =
    typeof value === 'string' && value.startsWith(remotePrefix)
      ? value.slice(remotePrefix.length).split('/')
      : [];
  if (
    typeof value !== 'string' ||
    !value.startsWith(remotePrefix) ||
    components.length < 2 ||
    components.some(invalidComponent) ||
    value.includes('..') ||
    value.includes('@{') ||
    hasForbiddenCharacter(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
