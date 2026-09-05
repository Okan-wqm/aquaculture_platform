// SCENARIO: the instance template and every ARIA derived from it.
// EXPECTS: every aria.manifest.json validates against arias/instance.schema.json, the
// isolation invariants hold (namespace == id, no cross-namespace access, unique ports,
// unique ledger roots), every enabled pack and every declared policy file exists, and the
// template actually derives into a valid instance.
//
// WHY a hand-rolled validator: the instance layer must stay dependency-free so a derived
// ARIA can be checked in a fresh repository with nothing installed. The subset implemented
// here is exactly what the schema uses: required, const, enum, pattern, type, minItems.

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { derive } from './derive.mjs';

const ARIAS_ROOT = dirname(fileURLToPath(import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Minimal draft-2020-12 subset: enough for instance.schema.json, no dependency. */
function validate(schema, value, path = '$', errors = []) {
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${schema.enum.join('|')}`);
  const type = schema.type;
  if (type === 'object' || schema.properties !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return errors;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(schema.properties ?? {})[key]) errors.push(`${path}.${key}: not allowed`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(sub, value[key], `${path}.${key}`, errors);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return errors;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    value.forEach((item, index) => validate(schema.items ?? {}, item, `${path}[${index}]`, errors));
  } else if (type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: expected string`);
    else {
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: ${JSON.stringify(value)} fails ${schema.pattern}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    }
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
    else {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
    }
  } else if (type === 'number') {
    if (typeof value !== 'number') errors.push(`${path}: expected number`);
    else {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
    }
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
  }
  return errors;
}

async function instanceDirs() {
  const entries = await readdir(ARIAS_ROOT, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

test('every instance directory carries a manifest that validates against the schema', async () => {
  const schema = await readJson(join(ARIAS_ROOT, 'instance.schema.json'));
  const dirs = await instanceDirs();
  assert.ok(dirs.includes('_template'), 'the template must exist: every instance derives from it');
  assert.ok(dirs.length >= 2, 'at least one instance derived from the template');
  for (const dir of dirs) {
    const manifestPath = join(ARIAS_ROOT, dir, 'aria.manifest.json');
    assert.ok(await exists(manifestPath), `${dir}/aria.manifest.json missing`);
    const errors = validate(schema, await readJson(manifestPath));
    assert.deepEqual(errors, [], `${dir} manifest: ${errors.join('; ')}`);
  }
});

test('isolation invariants hold across instances', async () => {
  const dirs = await instanceDirs();
  const ports = new Map();
  const ledgers = new Map();
  for (const dir of dirs) {
    const manifest = await readJson(join(ARIAS_ROOT, dir, 'aria.manifest.json'));
    assert.equal(manifest.memory.namespace, manifest.id, `${dir}: namespace must equal the instance id`);
    assert.equal(manifest.memory.cross_namespace_access, false, `${dir}: cross-namespace access is never allowed`);
    if (dir !== '_template') assert.equal(manifest.id, dir, `${dir}: manifest id must match its directory`);
    const port = manifest.surface.console.port;
    assert.ok(!ports.has(port), `port ${port} claimed by both ${ports.get(port)} and ${dir}`);
    ports.set(port, dir);
    const tools = manifest.runtime.tools_dir;
    assert.ok(!ledgers.has(tools), `ledger root ${tools} claimed by both ${ledgers.get(tools)} and ${dir}`);
    ledgers.set(tools, dir);
    assert.ok(manifest.non_goals.length >= 1, `${dir}: non_goals must not be empty`);
  }
});

test('declared policy files and enabled packs exist inside the instance', async () => {
  for (const dir of await instanceDirs()) {
    const root = join(ARIAS_ROOT, dir);
    const manifest = await readJson(join(root, 'aria.manifest.json'));
    for (const key of ['approval', 'budget']) {
      const path = join(root, manifest.policies[key]);
      assert.ok(await exists(path), `${dir}: policies.${key} points at a missing file (${manifest.policies[key]})`);
    }
    assert.ok(await exists(join(root, manifest.surface.console.branding)), `${dir}: branding file missing`);
    // The evaluation corpus the manifest's release thresholds are measured
    // against must exist and be labelled; a threshold nobody can measure is a
    // sentence in a file. The template carries no corpus by design.
    if (dir !== '_template') {
      assert.ok(await exists(join(root, manifest.evaluations.corpus, 'corpus.json')), `${dir}: evaluations.corpus (${manifest.evaluations.corpus}) has no labelled corpus.json`);
    }
    for (const pack of manifest.packs) {
      assert.ok(!pack.path.includes('..'), `${dir}/${pack.id}: a pack never reaches outside its instance (law S-2)`);
      if (!pack.enabled) continue;
      assert.ok(await exists(join(root, pack.path, 'pack.json')), `${dir}: enabled pack ${pack.id} has no pack.json at ${pack.path}`);
      for (const dependency of pack.depends_on ?? []) {
        assert.ok(manifest.packs.some((candidate) => candidate.id === dependency), `${dir}/${pack.id}: depends on ${dependency}, which this instance does not declare`);
      }
    }
  }
});

test('the template derives into a valid instance', async () => {
  const schema = await readJson(join(ARIAS_ROOT, 'instance.schema.json'));
  const out = await mkdtemp(join(tmpdir(), 'aria-derive-'));
  try {
    const result = await derive('finance', 'Finans ARIA denemesi', { port: 8499, out });
    const manifest = await readJson(join(result.target, 'aria.manifest.json'));
    assert.deepEqual(validate(schema, manifest), []);
    assert.equal(manifest.id, 'finance');
    assert.equal(manifest.memory.namespace, 'finance');
    assert.equal(manifest.status, 'draft');
    assert.equal(manifest.surface.console.port, 8499);
    assert.equal(manifest.runtime.tools_dir, '/data/finance/aria-tools');
    const compose = await readFile(join(result.target, 'docker', 'compose.profile.yml'), 'utf8');
    assert.match(compose, /finance-ui:/);
    assert.match(compose, /FINANCE_UI_TOKEN/);
    assert.doesNotMatch(compose, /template/i, 'no template identifier may survive derivation');
    await assert.rejects(derive('finance', 'ikinci kez', { port: 8499, out }), /refusing to overwrite/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
