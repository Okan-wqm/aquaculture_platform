import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function skipWhitespace(source, state) {
  while (/\s/u.test(source[state.index] ?? '')) state.index += 1;
}

function scanString(source, state) {
  const start = state.index;
  state.index += 1;
  while (state.index < source.length) {
    const character = source[state.index];
    state.index += 1;
    if (character === '"') return JSON.parse(source.slice(start, state.index));
    if (character !== '\\') continue;
    const escape = source[state.index];
    state.index += 1;
    if (escape === 'u') {
      const digits = source.slice(state.index, state.index + 4);
      if (!/^[0-9a-f]{4}$/iu.test(digits)) throw new Error('invalid Unicode escape');
      state.index += 4;
    }
  }
  throw new Error('unterminated JSON string');
}

function scanPrimitive(source, state) {
  const start = state.index;
  while (state.index < source.length && !/[\s,\]}]/u.test(source[state.index])) state.index += 1;
  const token = source.slice(start, state.index);
  if (!/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(token)) {
    throw new Error(`invalid JSON token: ${token}`);
  }
}

function scanArray(source, state) {
  state.index += 1;
  skipWhitespace(source, state);
  if (source[state.index] === ']') return void (state.index += 1);
  while (state.index < source.length) {
    scanValue(source, state);
    skipWhitespace(source, state);
    if (source[state.index] === ']') return void (state.index += 1);
    if (source[state.index] !== ',') throw new Error('invalid JSON array separator');
    state.index += 1;
    skipWhitespace(source, state);
  }
  throw new Error('unterminated JSON array');
}

function scanObject(source, state) {
  const keys = new Set();
  state.index += 1;
  skipWhitespace(source, state);
  if (source[state.index] === '}') return void (state.index += 1);
  while (state.index < source.length) {
    if (source[state.index] !== '"') throw new Error('JSON object key must be a string');
    const key = scanString(source, state);
    if (keys.has(key)) throw new Error(`duplicate key: ${key}`);
    keys.add(key);
    skipWhitespace(source, state);
    if (source[state.index] !== ':') throw new Error('missing JSON object colon');
    state.index += 1;
    scanValue(source, state);
    skipWhitespace(source, state);
    if (source[state.index] === '}') return void (state.index += 1);
    if (source[state.index] !== ',') throw new Error('invalid JSON object separator');
    state.index += 1;
    skipWhitespace(source, state);
  }
  throw new Error('unterminated JSON object');
}

function scanValue(source, state) {
  skipWhitespace(source, state);
  const character = source[state.index];
  if (character === '{') scanObject(source, state);
  else if (character === '[') scanArray(source, state);
  else if (character === '"') scanString(source, state);
  else scanPrimitive(source, state);
}

function assertUnicodeScalar(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid Unicode scalar');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('invalid Unicode scalar');
  }
}

function validateValue(value) {
  if (typeof value === 'string') return assertUnicodeScalar(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value))
      throw new Error('number must be a safe integer');
    if (Object.is(value, -0)) throw new Error('negative zero is forbidden');
    return;
  }
  if (Array.isArray(value)) return value.forEach(validateValue);
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertUnicodeScalar(key);
      validateValue(child);
    }
  }
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function parseStrictJson(source) {
  const state = { index: 0 };
  scanValue(source, state);
  skipWhitespace(source, state);
  if (state.index !== source.length) throw new Error('trailing JSON content');
  const value = JSON.parse(source);
  validateValue(value);
  return value;
}

export function canonicalJson(value) {
  validateValue(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort(compareCodePoints);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function eventHash(event) {
  const { event_hash: ignored, ...payload } = event;
  return sha256(Buffer.from(canonicalJson(payload), 'utf8'));
}
