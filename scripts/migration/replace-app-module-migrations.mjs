#!/usr/bin/env node
/**
 * replace-app-module-migrations — Faz 6 production cutover recovery.
 *
 * Two services (admin-api-service, messaging-service) embed their migration
 * class imports directly in app.module.ts rather than going through manifest.ts.
 * Post-baseline-reset, the archived migration files no longer exist on disk —
 * imports fail at TS compile time, breaking the GHA build matrix.
 *
 * This script:
 *   1. Removes every `import { … } from '(./database)?/migrations/…'` line.
 *   2. Adds a single `import { Baseline1800000000000 } from '<correct-path>/1800000000000-Baseline'`.
 *   3. Replaces the `migrations: [...]` array body with `[Baseline1800000000000]`.
 *
 * Idempotent — marker-based detection prevents double-edit.
 *
 * Usage: node scripts/migration/replace-app-module-migrations.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TARGETS = [
  { svc: 'admin-api-service', migPath: './migrations' },
  { svc: 'messaging-service', migPath: './migrations' },
];

function processFile({ svc, migPath }) {
  const p = resolve(REPO_ROOT, 'apps', svc, 'src', 'app.module.ts');
  if (!existsSync(p)) {
    console.error(`[skip] ${svc}: app.module.ts not found`);
    return;
  }
  let src = readFileSync(p, 'utf8');

  // Skip if already migrated (marker check).
  if (src.includes('// Baseline1800000000000 — only migration after day-one reset')) {
    console.log(`[skip] ${svc}: already migrated to Baseline-only`);
    return;
  }

  // 1. Find all migration imports.
  const importRe = /^import\s+\{[^}]+\}\s+from\s+'(\.\/(?:database\/)?migrations\/[0-9]+[^']+)';\s*$/gm;
  const matches = [...src.matchAll(importRe)];
  if (matches.length === 0) {
    console.log(`[noop] ${svc}: no migration imports detected`);
    return;
  }

  // Capture class names to remove from migrations: [...] arrays.
  const classNames = matches
    .map((m) => {
      const inner = m[0].match(/\{\s*([^}]+?)\s*\}/);
      return inner ? inner[1].split(',').map((s) => s.trim()) : [];
    })
    .flat();

  // 2. Strip imports — replace with a single Baseline import after the last removed line.
  const firstImport = matches[0].index;
  const lastImportEnd = matches[matches.length - 1].index + matches[matches.length - 1][0].length;
  const before = src.slice(0, firstImport);
  const after = src.slice(lastImportEnd);
  src = `${before}// Baseline1800000000000 — only migration after day-one reset (ADR-030).\nimport { Baseline1800000000000 } from '${migPath}/1800000000000-Baseline';${after}`;

  // 3. Replace migrations array — multiline-aware.
  const classSet = new Set(classNames);
  let replacedArrays = 0;
  src = src.replace(/migrations:\s*\[([\s\S]*?)\]/g, (full, arrBody) => {
    const refs = arrBody
      .split(',')
      .map((s) => s.trim().replace(/[\n\r]/g, '').replace(/\/\/.*/, '').trim())
      .filter(Boolean);
    const archivedRefs = refs.filter((r) => classSet.has(r));
    if (archivedRefs.length === 0) return full;
    replacedArrays++;
    return 'migrations: [Baseline1800000000000]';
  });

  writeFileSync(p, src, 'utf8');
  console.log(
    `[ok]   ${svc}: removed ${matches.length} import(s), rewrote ${replacedArrays} migration array(s)`,
  );
}

for (const t of TARGETS) {
  processFile(t);
}
