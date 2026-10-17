/**
 * Strict JSON: a hand-edited file that gates CI is read so that one key means
 * one thing.
 *
 * WHY. `JSON.parse` (and Python's `json.loads`) keep the LAST of two equal
 * keys and drop the first without a word. scripts/ci/affected-target-policy.json
 * carried two `test:integration` blocks for six weeks: whoever read the first
 * one, "STRICT, AND IT MUST STAY THAT WAY", was reading a block no lane
 * applied, and a quarantine written into it would have been ignored while a
 * reviewer saw it in force (deleted by 508b44849; INFRA-MEDIUM-228). Nothing
 * detected it, because every reader parsed the file and saw a valid object.
 *
 * WHAT.
 *   - readStrictJson / parseStrictJson: `JSON.parse`, then refuse the text if
 *     any object in it repeats a key. The reviewed-exception files go through
 *     it (the affected-target policy in the writer and in lint-debt-measure,
 *     the npm audit exceptions in npm-audit-gate), so an ambiguous file fails
 *     the lane that reads it.
 *   - duplicateKeysInFiles: the same check over many files, for
 *     tests/invariants/json-duplicate-keys.spec.ts, which runs it over every
 *     tracked `*.json` on every PR.
 *
 * The scanner runs only on text `JSON.parse` has already accepted, so its
 * structure is known to be valid and a linear pass suffices: it tracks string
 * literals (escapes included), keeps one frame per `{` / `[`, and treats the
 * first string after `{` or after a `,` inside an object as a key. Keys are
 * decoded with `JSON.parse`, so `"\u0061"` and `"a"` collide as they do for
 * every reader.
 */

import { readFileSync } from 'node:fs';

/** Index of the quote that closes the string literal opening at `start`. */
function stringEnd(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '"') return index;
  }
  throw new Error('unterminated string literal');
}

function childPath(frame) {
  if (frame === undefined) return '$';
  return frame.kind === 'object' ? `${frame.path}.${frame.key}` : `${frame.path}[${frame.index}]`;
}

/**
 * Every path whose object repeats a key, e.g. `$.targets.test`.
 *
 * @param {string} text JSON text that `JSON.parse` accepts
 * @returns {string[]} the repeated keys' paths, each once, in document order
 */
export function duplicateKeyPaths(text) {
  const duplicates = new Set();
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const top = stack[stack.length - 1];
    if (char === '"') {
      const end = stringEnd(text, index);
      if (top !== undefined && top.kind === 'object' && top.expectingKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (top.keys.has(key)) duplicates.add(`${top.path}.${key}`);
        top.keys.add(key);
        top.key = key;
        top.expectingKey = false;
      }
      index = end;
    } else if (char === '{') {
      stack.push({
        kind: 'object',
        path: childPath(top),
        keys: new Set(),
        key: '',
        expectingKey: true,
      });
    } else if (char === '[') {
      stack.push({ kind: 'array', path: childPath(top), index: 0 });
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',' && top !== undefined) {
      if (top.kind === 'object') top.expectingKey = true;
      else top.index += 1;
    }
  }
  return [...duplicates];
}

/**
 * `JSON.parse`, refusing text whose objects repeat a key.
 *
 * @param {string} text
 * @param {string} label names the source in the error
 * @returns {unknown}
 * @throws when the text is not JSON or repeats a key
 */
export function parseStrictJson(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const duplicates = duplicateKeyPaths(text);
  if (duplicates.length > 0) {
    throw new Error(
      `${label}: duplicate key(s) ${duplicates.join(', ')}; JSON.parse keeps the last and drops ` +
        'the rest silently, so the file is refused until each key appears once',
    );
  }
  return value;
}

/**
 * @param {string} path
 * @returns {unknown}
 */
export function readStrictJson(path) {
  return parseStrictJson(readFileSync(path, 'utf8'), path);
}

/**
 * The duplicate-key check over many files. A file `JSON.parse` rejects is
 * counted as not strict JSON and skipped: JSONC files (tsconfig and friends)
 * belong to the tools that read them.
 *
 * @param {readonly string[]} paths
 * @returns {{checked: number, notStrictJson: string[], duplicates: string[]}}
 *          `duplicates` holds `<path>: <key path>` lines
 */
export function duplicateKeysInFiles(paths) {
  const report = { checked: 0, notStrictJson: [], duplicates: [] };
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    try {
      JSON.parse(text);
    } catch {
      report.notStrictJson.push(path);
      continue;
    }
    report.checked += 1;
    for (const keyPath of duplicateKeyPaths(text)) report.duplicates.push(`${path}: ${keyPath}`);
  }
  return report;
}
