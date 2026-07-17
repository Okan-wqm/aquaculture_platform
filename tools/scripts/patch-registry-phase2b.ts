#!/usr/bin/env ts-node
/**
 * Phase 2b patcher — fixes the two registry entries flagged by
 * finding-registry-integrity.spec.ts + three-store-invariants.spec.ts
 * on the agentic branch prior to 2026-04-18:
 *
 *   FE-CRITICAL-001 — evidence[0] anchor form fails the file:line pattern
 *   PROC-MEDIUM-005 — layer: 4 not in schema enum; evidence items not
 *                      file:line; closing_commits=["pending"] invalid SHA
 *
 * Mutates the entries in place, then rechains prev_hash + content_hash
 * from the first mutated position through the tail using the same
 * canonical-JSON algorithm as tools/gates/finding-registry.ts.
 *
 * Idempotent: re-running after a successful patch is a no-op.
 *
 * Usage:
 *   npx ts-node --project tools/gates/tsconfig.json tools/scripts/patch-registry-phase2b.ts [--dry-run]
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveGitFindingAllocationAuthority } from '../gates/finding-registry';
import { atomicWriteRegistryFile, withRegistryFileLock } from '../gates/finding-registry-store';

const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY = resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');
const ZERO_HASH = '0'.repeat(64);

interface RegistryEntry {
  id: string;
  evidence: string[];
  closing_commits: string[];
  layer?: number;
  prev_hash?: string;
  content_hash?: string;
  [key: string]: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function rechain(all: RegistryEntry[], startIndex: number): void {
  let prev = startIndex === 0 ? ZERO_HASH : (all[startIndex - 1]?.content_hash ?? ZERO_HASH);
  for (let i = startIndex; i < all.length; i++) {
    const entry = all[i];
    if (!entry) continue;
    entry.prev_hash = prev;
    const { content_hash: _ignore, ...forHash } = entry;
    entry.content_hash = sha256hex(canonicalJson(forHash));
    prev = entry.content_hash;
  }
}

const dryRun = process.argv.includes('--dry-run');
const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);

withRegistryFileLock(
  REGISTRY,
  (lease) => {
    const raw = readFileSync(REGISTRY, 'utf8').trim();
    const entries: RegistryEntry[] = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RegistryEntry);

    let firstMutatedIndex = entries.length;
    let changed = 0;

    const fe = entries.findIndex((e) => e.id === 'FE-CRITICAL-001');
    if (fe !== -1) {
      const entry = entries[fe];
      if (entry) {
        // The anchor form fails the file:line regex. The real audit file is
        // docs/reviews/_audit/2026-04-W16-frontend-react.md; the finding's
        // section anchor is at line 88.
        const badEvidence = 'docs/reviews/_audit/2026-04-W16-frontend-react.md#FE-CRITICAL-001';
        const goodEvidence = 'docs/reviews/_audit/2026-04-W16-frontend-react.md:88';
        if (entry.evidence.includes(badEvidence)) {
          entry.evidence = entry.evidence.map((e) => (e === badEvidence ? goodEvidence : e));
          firstMutatedIndex = Math.min(firstMutatedIndex, fe);
          changed++;
          console.log(`Patched FE-CRITICAL-001 evidence[0] → ${goodEvidence}`);
        } else {
          console.log('FE-CRITICAL-001: evidence already patched (no-op).');
        }
      }
    }

    const proc = entries.findIndex((e) => e.id === 'PROC-MEDIUM-005');
    if (proc !== -1) {
      const entry = entries[proc];
      if (entry) {
        let mutated = false;

        // (1) layer: 4 is not in schema enum [1,2,3]. PROC-MEDIUM-005 is a
        // process finding — no layer fits. Drop the field entirely (schema
        // makes it optional).
        if (entry.layer === 4) {
          delete entry.layer;
          mutated = true;
          console.log('Patched PROC-MEDIUM-005: removed invalid layer: 4.');
        }

        // (2) Evidence items must match file:line regex. Current values are
        // a filter-name selector + a GitHub Actions run reference; rewrite
        // to point at the real ci-affected.yml + commit ref (already exists).
        const badEvidence1 = '.github/workflows/ci-affected.yml:detect-changes.filters';
        const badEvidence2Prefix = 'GitHub Actions run';
        if (entry.evidence.some((e) => e === badEvidence1 || e.startsWith(badEvidence2Prefix))) {
          entry.evidence = [
            // The detect-changes filter block; line range covers the added
            // tools/eslint-rules, tools/gates, tools/scripts patterns in the
            // remediation commit 50df8342.
            '.github/workflows/ci-affected.yml:10-60',
            // The config file whose missing coverage caused the recursive
            // chicken-egg — tools/eslint-rules tsconfig that 5f3280c4 fixed
            // without CI-Affected validating the change.
            'tools/eslint-rules/tsconfig.json:1',
          ];
          mutated = true;
          console.log('Patched PROC-MEDIUM-005: evidence items rewritten to file:line form.');
        }

        // (3) closing_commits=["pending"] violates SHA regex. The real
        // closer is 50df8342 (strict "Closes: …#PROC-MEDIUM-005" trailer
        // already present in commit message, verified via git log).
        if (entry.closing_commits.length === 1 && entry.closing_commits[0] === 'pending') {
          entry.closing_commits = ['50df8342'];
          mutated = true;
          console.log('Patched PROC-MEDIUM-005: closing_commits set to 50df8342.');
        }

        if (mutated) {
          firstMutatedIndex = Math.min(firstMutatedIndex, proc);
          changed++;
        } else {
          console.log('PROC-MEDIUM-005: already patched (no-op).');
        }
      }
    }

    if (changed === 0) {
      console.log('Nothing to patch. Exiting.');
      return;
    }

    if (dryRun) {
      console.log(
        `DRY RUN: would patch ${changed} entries and rechain from position ${firstMutatedIndex}.`,
      );
      return;
    }

    rechain(entries, firstMutatedIndex);

    const out = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    atomicWriteRegistryFile(REGISTRY, out, lease);

    console.log(`Patched ${changed} entries; rechained from position ${firstMutatedIndex}.`);
    const tip = entries[entries.length - 1];
    if (tip) console.log(`Chain tip: ${tip.content_hash}`);
  },
  { lockPath: authority.lockPath },
);
