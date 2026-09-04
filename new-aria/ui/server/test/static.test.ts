// SCENARIO: root-bounded path resolution and asset cache classification.
// EXPECTS: traversal outside the root is refused with a 400 HttpError; hashed
// Vite assets are immutable, index.html is not.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../src/errors.ts';
import { resolveInside } from '../src/fsafe.ts';
import { contentTypeFor, isImmutableAsset } from '../src/static.ts';

test('resolveInside refuses traversal and accepts children', () => {
  assert.throws(() => resolveInside('/srv/static', '../etc/passwd'), HttpError);
  assert.throws(() => resolveInside('/srv/static', './assets/../../x'), HttpError);
  assert.equal(resolveInside('/srv/static', './assets/app.js'), '/srv/static/assets/app.js');
  assert.equal(resolveInside('/srv/static', '.'), '/srv/static');
});

test('hashed assets are immutable, entry documents are not', () => {
  assert.equal(isImmutableAsset('/assets/index-BgEI6LxR.js'), true);
  assert.equal(isImmutableAsset('/assets/index-IhGGrDcI.css'), true);
  assert.equal(isImmutableAsset('/index.html'), false);
  assert.equal(isImmutableAsset('/assets/logo.svg'), false);
});

test('content types cover the bundle and fall back to octet-stream', () => {
  assert.equal(contentTypeFor('/x/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('/x/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('/x/font.bin'), 'application/octet-stream');
});
