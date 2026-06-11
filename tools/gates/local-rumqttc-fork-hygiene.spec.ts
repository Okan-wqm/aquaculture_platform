#!/usr/bin/env ts-node
/**
 * RUST-CVE-001 fork-hygiene gate — crates/local-rumqttc drift detector.
 *
 * The vendored rumqttc 0.25.1 fork is allowed to differ from upstream in
 * EXACTLY two files (Cargo.toml + src/tls.rs — the webpki bump and the
 * rustls-pemfile -> rustls-pki-types swap). Everything else must hash-match
 * the upstream manifest captured at vendoring time, and no file may be
 * added or removed without updating UPSTREAM.md + the manifest in the same
 * reviewed commit. This makes "someone quietly patched the fork" a CI
 * failure instead of a code-review hope.
 *
 * Pattern mirrors the other tools/gates specs (node:test, no new deps;
 * auto-discovered by the husky pre-commit gate runner).
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
})();

const FORK_DIR = resolve(REPO_ROOT, 'crates/local-rumqttc');
const MANIFEST = join(FORK_DIR, 'UPSTREAM-MANIFEST.sha256');

/** Files that legitimately differ from upstream (the fork diff policy in
 *  UPSTREAM.md). Each must carry the LOCAL FORK marker comment. */
const ALLOWED_DIVERGENT = new Set(['./Cargo.toml', './src/tls.rs']);

/** Fork-owned files that do not exist upstream. */
const FORK_OWNED = new Set([
  './UPSTREAM.md',
  './UPSTREAM-MANIFEST.sha256',
  './FORK-EDITS.sha256',
]);

/** Post-fork content pins for the two divergent files (EDGE-HIGH-002):
 *  diverging from UPSTREAM is required, but the divergence itself must be
 *  byte-exact against this manifest — so a regression INSIDE an
 *  allowed-divergent file (e.g. weakening tls.rs) is a gate failure, not
 *  a reviewer hope. Intentional edits update FORK-EDITS.sha256 +
 *  UPSTREAM.md in the same reviewed commit. */
const FORK_EDITS_MANIFEST = join(
  REPO_ROOT,
  'crates/local-rumqttc/FORK-EDITS.sha256',
);

const FORK_MARKER = 'LOCAL FORK (RUST-CVE-001)';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseManifest(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(\.\/.+)$/);
    if (m) entries.set(m[2] as string, m[1] as string);
  }
  return entries;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(`./${relative(FORK_DIR, full)}`);
  }
  return out;
}

test('upstream manifest exists and covers the vendored tree', () => {
  const manifest = parseManifest();
  assert.ok(manifest.size >= 60, `manifest suspiciously small (${manifest.size} entries) — was it truncated?`);

  const onDisk = new Set(walk(FORK_DIR));
  // No unexplained additions: everything on disk is either in the upstream
  // manifest or an explicitly fork-owned file.
  for (const file of onDisk) {
    assert.ok(
      manifest.has(file) || FORK_OWNED.has(file),
      `${file} exists in crates/local-rumqttc but is neither in UPSTREAM-MANIFEST.sha256 nor fork-owned — undocumented addition`,
    );
  }
  // No silent deletions: every manifest entry still exists.
  for (const file of manifest.keys()) {
    assert.ok(onDisk.has(file), `${file} is in UPSTREAM-MANIFEST.sha256 but missing on disk — undocumented deletion`);
  }
});

test('only Cargo.toml and src/tls.rs diverge from upstream hashes', () => {
  const manifest = parseManifest();
  const divergent: string[] = [];
  for (const [file, upstreamHash] of manifest) {
    const actual = sha256(join(FORK_DIR, file));
    if (actual !== upstreamHash) divergent.push(file);
  }
  const unexpected = divergent.filter((f) => !ALLOWED_DIVERGENT.has(f));
  assert.deepEqual(
    unexpected,
    [],
    `files diverge from upstream outside the UPSTREAM.md diff policy: ${unexpected.join(', ')}`,
  );
  // The two policy files MUST diverge — if they match upstream again, the
  // CVE fix has been silently reverted.
  for (const file of ALLOWED_DIVERGENT) {
    assert.ok(divergent.includes(file), `${file} matches upstream byte-for-byte — the RUST-CVE-001 fix was reverted?`);
  }
});

test('every deliberate fork edit carries the LOCAL FORK marker', () => {
  for (const file of ALLOWED_DIVERGENT) {
    const text = readFileSync(join(FORK_DIR, file), 'utf8');
    assert.ok(text.includes(FORK_MARKER), `${file} lost its "${FORK_MARKER}" marker comment`);
  }
});

test('divergent files match the FORK-EDITS content pin byte-for-byte (EDGE-HIGH-002)', () => {
  const pins = new Map<string, string>();
  for (const line of readFileSync(FORK_EDITS_MANIFEST, 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(\.\/.+)$/);
    if (m) pins.set(m[2] as string, m[1] as string);
  }
  assert.deepEqual(
    [...pins.keys()].sort(),
    [...ALLOWED_DIVERGENT].sort(),
    'FORK-EDITS.sha256 must pin exactly the allowed-divergent file set',
  );
  for (const [file, pinned] of pins) {
    const actual = sha256(join(FORK_DIR, file));
    assert.equal(
      actual,
      pinned,
      `${file} drifted from its FORK-EDITS.sha256 content pin — a change inside an allowed-divergent file requires updating the pin + UPSTREAM.md in the same reviewed commit`,
    );
  }
});

test('fork is wired via [patch.crates-io] in both workspaces', () => {
  const root = readFileSync(resolve(REPO_ROOT, 'Cargo.toml'), 'utf8');
  const sens = readFileSync(resolve(REPO_ROOT, 'sens-api-gateway/Cargo.toml'), 'utf8');
  assert.match(root, /\[patch\.crates-io\][\s\S]*rumqttc\s*=\s*\{\s*path\s*=\s*"crates\/local-rumqttc"/, 'root Cargo.toml lost the rumqttc [patch.crates-io] entry');
  assert.match(sens, /\[patch\.crates-io\][\s\S]*rumqttc\s*=\s*\{\s*path\s*=\s*"\.\.\/crates\/local-rumqttc"/, 'sens-api-gateway Cargo.toml lost the rumqttc [patch.crates-io] entry');
});

test('fork Cargo.toml carries the dependency fixes it exists for', () => {
  const toml = readFileSync(join(FORK_DIR, 'Cargo.toml'), 'utf8');
  assert.ok(!/\[dependencies\.rustls-pemfile\]/.test(toml), 'rustls-pemfile dependency reappeared in the fork');
  assert.match(toml, /\[dependencies\.rustls-webpki\]\n[^[]*version = "0\.103"/, 'rustls-webpki is not pinned to the patched 0.103 line');
  assert.match(toml, /publish = false/, 'fork must stay publish = false');
});
