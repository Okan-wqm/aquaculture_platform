// SCENARIO: the JSONL tail reader over real and synthetic ledgers.
// EXPECTS: rows parse in order, corrupt lines are counted not thrown, the byte
// cap drops only the partial first line, counts match, folding keeps the last row.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { countJsonlRows, foldLatest, tailJsonl } from '../src/jsonl.ts';

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aria-ui-jsonl-'));
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

test('parses every complete row in file order and counts corrupt lines', async () => {
  const path = await tempFile('a.jsonl', '{"n":1}\nnot json\n{"n":2}\n\n{"n":3}\n');
  const result = await tailJsonl<{ n: number }>(path);
  assert.deepEqual(
    result.rows.map((row) => row.n),
    [1, 2, 3],
  );
  assert.equal(result.corrupt, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.present, true);
});

test('a byte cap drops only the partial leading line', async () => {
  const lines = Array.from({ length: 50 }, (_, index) => JSON.stringify({ n: index, pad: 'x'.repeat(40) }));
  const path = await tempFile('b.jsonl', `${lines.join('\n')}\n`);
  const result = await tailJsonl<{ n: number }>(path, { maxBytes: 300 });
  assert.equal(result.truncated, true);
  assert.equal(result.corrupt, 0);
  assert.ok(result.rows.length >= 3 && result.rows.length < 50);
  assert.equal(result.rows[result.rows.length - 1]?.n, 49);
  for (let index = 1; index < result.rows.length; index += 1) {
    assert.equal(result.rows[index]?.n, (result.rows[index - 1]?.n ?? 0) + 1);
  }
});

test('limit keeps the last rows and a missing file yields an empty, absent result', async () => {
  const path = await tempFile('c.jsonl', '{"n":1}\n{"n":2}\n{"n":3}\n');
  const limited = await tailJsonl<{ n: number }>(path, { limit: 2 });
  assert.deepEqual(
    limited.rows.map((row) => row.n),
    [2, 3],
  );
  const missing = await tailJsonl(join(path, '..', 'nope.jsonl'));
  assert.equal(missing.present, false);
  assert.equal(missing.rows.length, 0);
});

test('countJsonlRows counts trailing rows without a newline and returns null when absent', async () => {
  const path = await tempFile('d.jsonl', '{"n":1}\n{"n":2}');
  assert.equal(await countJsonlRows(path), 2);
  assert.equal(await countJsonlRows(join(path, '..', 'absent.jsonl')), null);
});

test('foldLatest keeps the last row per key in first-seen key order', () => {
  const folded = foldLatest(
    [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'a', v: 2 },
      { id: 'c', v: 0 },
    ],
    (row) => row.id,
  );
  assert.deepEqual([...folded.keys()], ['a', 'b', 'c']);
  assert.equal(folded.get('a')?.v, 2);
});
