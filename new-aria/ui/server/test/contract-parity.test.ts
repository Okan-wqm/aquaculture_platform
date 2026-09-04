// SCENARIO: the console's ledger source table against the kernel's own sources.
// EXPECTS: every file the console reads is a name the kernel writes — the
// basename appears verbatim in aria-kernel/aria_kernel/*.py — so a renamed
// ledger breaks this test before it breaks the console.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEDGER_SOURCES } from '../../shared/api-contract.ts';
import { LEGAL_ARTIFACT_FILES, LEGAL_ARTIFACT_ROOT } from '../../shared/legal-contract.ts';

const NEW_ARIA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KERNEL_DIR = resolve(NEW_ARIA_ROOT, 'aria-kernel', 'aria_kernel');

async function kernelSourceText(): Promise<string> {
  const names = (await readdir(KERNEL_DIR)).filter((name) => name.endsWith('.py'));
  const chunks = await Promise.all(names.map((name) => readFile(resolve(KERNEL_DIR, name), 'utf8')));
  return chunks.join('\n');
}

test('every ledger file the console reads is named in the kernel sources', async () => {
  const source = await kernelSourceText();
  const missing: string[] = [];
  for (const [name, relativePath] of Object.entries(LEDGER_SOURCES)) {
    if (!relativePath.endsWith('.json') && !relativePath.endsWith('.jsonl')) continue;
    if (!source.includes(basename(relativePath))) missing.push(`${name} -> ${relativePath}`);
  }
  assert.deepEqual(missing, []);
});

test('directory sources and the kill switch sentinel are kernel vocabulary', async () => {
  const source = await kernelSourceText();
  for (const relativePath of [LEDGER_SOURCES.human_required_dir, LEDGER_SOURCES.breakers_dir, LEDGER_SOURCES.discovery_dir, LEDGER_SOURCES.plans_dir, LEDGER_SOURCES.kill_switch]) {
    assert.ok(source.includes(`"${relativePath}"`) || source.includes(`'${relativePath}'`) || source.includes(`/ "${relativePath}"`), `${relativePath} not found in kernel sources`);
  }
});

test('the legal artifact layout matches the pack adapter golden output', async () => {
  const adapter = await readFile(resolve(NEW_ARIA_ROOT, 'packs', 'legal', 'adapters', 'legal-records.ts'), 'utf8');
  assert.ok(adapter.includes(LEGAL_ARTIFACT_ROOT), 'artifact root drifted between the console and the pack');
  // The adapter's golden output is what it really writes; every file the console
  // reads must be one of those names, and every golden must be known to the console.
  const goldens = (await readdir(resolve(NEW_ARIA_ROOT, 'packs', 'legal', 'fixtures', 'expected'))).filter((name) => name.endsWith('.json') && name !== 'stdout.json').sort();
  assert.deepEqual(goldens, [...Object.values(LEGAL_ARTIFACT_FILES)].sort());
});
