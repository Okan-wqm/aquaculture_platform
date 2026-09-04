#!/usr/bin/env node
// Derive a new ARIA instance from the template.
//
// WHY: "one core, many bodies" only holds if starting a body is one command. Hand-copying
// a folder is how two instances silently diverge in the parts nobody re-reads: the memory
// namespace, the port, the ledger root. This script rewrites exactly those, so a derived
// instance is correct by construction and the reviewer only reads the domain content.
// WHAT: copies arias/_template into arias/<id>, replaces the template identifiers, and
// leaves every domain decision (packs, corpus, non_goals, TANIM.md) for a human to fill.
//
//   node arias/derive.mjs <id> "<display name>" [--port 8482] [--out <root>]
//
// It refuses to overwrite an existing instance: deriving twice over live config would
// discard whatever the operator wrote there.

import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARIAS_ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(ARIAS_ROOT, '_template');
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--port' || token === '--out') {
      flags[token.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** The four identifiers that must differ between any two instances. */
function rewrite(text, id, displayName, port) {
  const upper = id.toUpperCase().replace(/-/g, '_');
  return text
    .replace(/\bTEMPLATE_/g, `${upper}_`)
    .replace(/template-ui/g, `${id}-ui`)
    .replace(/template-data/g, `${id}-data`)
    .replace(/\/data\/template\//g, `/data/${id}/`)
    .replace(/arias\/template\//g, `arias/${id}/`)
    .replace(/"id": "template"/g, `"id": "${id}"`)
    .replace(/"namespace": "template"/g, `"namespace": "${id}"`)
    .replace(/"display_name": "[^"]*"/g, `"display_name": ${JSON.stringify(displayName)}`)
    .replace(/"status": "template"/g, '"status": "draft"')
    .replace(/"port": 8490/g, `"port": ${port}`)
    .replace(/:-8490}/g, `:-${port}}`)
    .replace(/template-foundation/g, `${id}-foundation`);
}

export async function derive(id, displayName, { port = 8490, out = ARIAS_ROOT } = {}) {
  if (!ID_PATTERN.test(id)) throw new Error(`instance id must match ${ID_PATTERN}: ${id}`);
  if (id === '_template') throw new Error('the template cannot derive over itself');
  if (!displayName || displayName.trim().length < 3) throw new Error('a display name is required');
  const target = join(out, id);
  if (await exists(target)) throw new Error(`instance already exists, refusing to overwrite: ${target}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(TEMPLATE, target, { recursive: true });
  const written = [];
  for (const file of await walk(target)) {
    const original = await readFile(file, 'utf8');
    const next = rewrite(original, id, displayName, port);
    if (next !== original) {
      await writeFile(file, next, 'utf8');
      written.push(file.slice(target.length + 1));
    }
  }
  return { target, rewritten: written.sort() };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [id, displayName] = positional;
  if (!id || !displayName) {
    process.stderr.write('usage: node arias/derive.mjs <id> "<display name>" [--port 8482] [--out <root>]\n');
    process.exit(2);
  }
  const port = flags.port === undefined ? 8490 : Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`--port must be an integer port: ${String(flags.port)}\n`);
    process.exit(2);
  }
  const result = await derive(id, displayName, { port, out: flags.out ? resolve(flags.out) : ARIAS_ROOT });
  process.stdout.write(`derived ${result.target}\n`);
  process.stdout.write(`rewritten: ${result.rewritten.join(', ')}\n`);
  process.stdout.write('next: fill docs/TANIM.md, declare the packs, set corpus.kind and non_goals\n');
}
