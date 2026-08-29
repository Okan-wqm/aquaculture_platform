import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  applyErrorCauseOptions,
  defineErrorCause,
  errorFromUnknown,
  errorWithCause,
} from './error-cause';

const TOOLS_ROOT = resolve(__dirname, '..', '..');
const ERROR_CAUSE_AUTHORITY = 'gates/lib/error-cause.ts';

function typescriptSources(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return typescriptSources(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

void describe('ES2021 error-cause authority', () => {
  void it('defines the native descriptor shape without changing Error identity', () => {
    const cause = Object.freeze({ code: 'FAULT' });
    const error = new TypeError('governed');
    assert.equal(defineErrorCause(error, cause), error);
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'cause'), {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: true,
    });
    assert.equal(
      Object.getOwnPropertyDescriptor(errorWithCause('wrapped', cause), 'cause')?.value,
      cause,
    );
  });

  void it('distinguishes absent options from an explicitly undefined cause', () => {
    const absent = applyErrorCauseOptions(new Error('absent'));
    const nullOptions = applyErrorCauseOptions(new Error('null'), null);
    const explicit = applyErrorCauseOptions(new Error('explicit'), { cause: undefined });
    assert.equal(Object.hasOwn(absent, 'cause'), false);
    assert.equal(Object.hasOwn(nullOptions, 'cause'), false);
    assert.equal(Object.hasOwn(explicit, 'cause'), true);
    assert.equal(Object.getOwnPropertyDescriptor(explicit, 'cause')?.value, undefined);
  });

  void it('normalizes non-Error throws while preserving real Error identity', () => {
    const existing = new TypeError('existing');
    assert.equal(errorFromUnknown('ignored for real errors', existing), existing);

    const rawCause = Object.freeze({ code: 'NON_ERROR_THROW' });
    const normalized = errorFromUnknown('governed boundary failed', rawCause);
    assert.equal(normalized.message, 'governed boundary failed');
    assert.deepEqual(Object.getOwnPropertyDescriptor(normalized, 'cause'), {
      configurable: true,
      enumerable: false,
      value: rawCause,
      writable: true,
    });
  });

  void it('keeps raw cause descriptors behind one source authority', () => {
    const rawDescriptor = /Object\.defineProperty\(\s*[^,]+,\s*['"]cause['"]/;
    const authorities = typescriptSources(TOOLS_ROOT)
      .filter((path) => rawDescriptor.test(readFileSync(path, 'utf8')))
      .map((path) => relative(TOOLS_ROOT, path))
      .sort();
    assert.deepEqual(authorities, [ERROR_CAUSE_AUTHORITY]);
  });
});
