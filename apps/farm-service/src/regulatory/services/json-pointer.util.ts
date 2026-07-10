/**
 * Minimal RFC 6901 JSON-pointer set — used to apply operator overrides
 * (keyed by the same pointers the field-meta uses, e.g. `/lusetelling`) onto
 * the assembled report body before submission.
 *
 * Only `set` is needed: an override replaces the whole value at its pointer.
 * Intermediate objects are created as needed; a numeric token against an array
 * addresses that index. A pointer of `` (empty) is rejected — an override never
 * replaces the entire document.
 */
function unescapeToken(token: string): string {
  // Order matters: ~1 → "/" then ~0 → "~" (RFC 6901 §4).
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Parse a JSON pointer (`/a/b/0`) into its decoded reference tokens. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') {
    throw new Error('JSON pointer must not be empty');
  }
  if (!pointer.startsWith('/')) {
    throw new Error(`JSON pointer must start with "/": ${pointer}`);
  }
  return pointer.slice(1).split('/').map(unescapeToken);
}

/**
 * Set `value` at `pointer` within `target`, mutating it. Missing intermediate
 * containers are created (object by default, array when the next token is a
 * pure integer). Returns the same target for chaining.
 */
export function setByPointer(
  target: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  const tokens = parsePointer(pointer);
  const lastToken = tokens[tokens.length - 1];
  if (lastToken === undefined) {
    // Unreachable: parsePointer guarantees a non-empty token list.
    throw new Error(`JSON pointer produced no tokens: ${pointer}`);
  }

  let node: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    const nextToken = tokens[i + 1];
    if (token === undefined || nextToken === undefined) continue;
    const child = getChild(node, token);
    if (isContainer(child)) {
      node = child;
    } else {
      const created: Record<string, unknown> | unknown[] = /^\d+$/.test(nextToken) ? [] : {};
      setChild(node, token, created);
      node = created;
    }
  }

  setChild(node, lastToken, value);
  return target;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function getChild(node: Record<string, unknown> | unknown[], token: string): unknown {
  if (Array.isArray(node)) {
    return node[Number(token)];
  }
  return node[token];
}

function setChild(node: Record<string, unknown> | unknown[], token: string, value: unknown): void {
  if (Array.isArray(node)) {
    node[Number(token)] = value;
  } else {
    node[token] = value;
  }
}
