#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './lib/canonical.mjs';
import { materializeVerifiedNode } from './lib/private-node.mjs';

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-private-node-'));
try {
  const source = join(ownerRoot, 'source-node');
  const runtimeRoot = join(ownerRoot, 'runtime');
  const bytes = Buffer.from('signed node fixture');
  writeFileSync(source, bytes, { mode: 0o500 });
  mkdirSync(runtimeRoot);
  const facts = {
    logical_name: 'node',
    version: process.version,
    executable_sha256: sha256(bytes),
    environment_policy: 'new-aria-hermetic-node-v1',
  };
  const privateNode = materializeVerifiedNode(source, runtimeRoot, facts);
  assert.deepEqual(readFileSync(privateNode), bytes);
  writeFileSync(source, 'tampered node fixture', { mode: 0o500 });
  assert.deepEqual(readFileSync(privateNode), bytes, 'private Node reread its mutable source');
  assert.throws(
    () => materializeVerifiedNode(source, join(ownerRoot, 'rejected'), facts),
    /digest mismatch/u,
  );
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS private-node copy=verified tamper=denied\n');
