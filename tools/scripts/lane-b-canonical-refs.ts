#!/usr/bin/env ts-node
/**
 * Lane-B Canonical References injector — Phase 5 of
 * /root/.claude/plans/synthetic-dazzling-hippo.md.
 *
 * Adds the `## Canonical References (READ via the Read tool before
 * starting)` section to each non-DEPRECATED, non-meta Lane-B agent
 * file, placed between the title block and the first existing `##`
 * heading.
 *
 * Per-file layer-1 shard selection by domain group:
 *
 *   UI auditors (UI-only or mostly-UI)          → core + react + layer-2 + layer-3 + _shared
 *   Roundtrip auditors (UI ↔ backend)           → core + react + nestjs + typeorm + layer-2 + layer-3 + _shared
 *   Backend-surface auditors                     → core + nestjs + typeorm + layer-2 + layer-3 + _shared
 *   Edge auditor                                 → core + rust + layer-2 + layer-3 + _shared
 *
 * Skipped files (handled separately in Phase 5):
 *   - README.md, INVOCATION-PACK.md (exempt)
 *   - orchestrator.md, context-manager.md, architectural-arbiter.md (meta; manual port)
 *   - gdpr-compliance-auditor.md, soc2-readiness-auditor.md,
 *     ai-tool-execution-auditor.md, contract-parity-auditor.md (DEPRECATED → status header only)
 *
 * Idempotent: if a file already has `## Canonical References`, the
 * injection is skipped.
 *
 * Usage:
 *   npx ts-node --project tools/gates/tsconfig.json tools/scripts/lane-b-canonical-refs.ts [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LANE_B = resolve(REPO_ROOT, '.claude', 'test-agents');
const SSOT_PREAMBLE = `Cross-cutting knowledge lives in SSoT files. The \`@\` prefix on each line below is
a READER BOOKMARK — Claude Code does NOT auto-import agent body content (only
\`CLAUDE.md\` honors \`@\`-includes). Use the Read tool to load each file at the
start of every invocation. See \`.claude/README.md\` § Runtime invocation paths.`;

const COMMON_SHARED: readonly string[] = [
  '@.claude/knowledge/layer-2-patterns.md          (CQRS, Outbox, tenant isolation)',
  '@.claude/knowledge/layer-3-adrs.md              (ADR index)',
  '@.claude/shared/operating-modes.md',
  '@.claude/shared/output-format.md',
];

const GROUP_UI: readonly string[] = [
  '@.claude/knowledge/layer-1-core.md              (TS + Nx + Jest base)',
  '@.claude/knowledge/layer-1-react.md             (React, TanStack Query, Module Federation)',
  ...COMMON_SHARED,
];

const GROUP_ROUNDTRIP: readonly string[] = [
  '@.claude/knowledge/layer-1-core.md              (TS + Nx + Jest base)',
  '@.claude/knowledge/layer-1-react.md             (React, TanStack Query, Module Federation)',
  '@.claude/knowledge/layer-1-nestjs.md            (NestJS guards/DTOs/controllers)',
  '@.claude/knowledge/layer-1-typeorm.md           (TypeORM entities, TenantScopedRepository)',
  ...COMMON_SHARED,
];

const GROUP_BACKEND: readonly string[] = [
  '@.claude/knowledge/layer-1-core.md              (TS + Nx + Jest base)',
  '@.claude/knowledge/layer-1-nestjs.md            (NestJS guards/DTOs/controllers)',
  '@.claude/knowledge/layer-1-typeorm.md           (TypeORM entities, TenantScopedRepository)',
  ...COMMON_SHARED,
];

const GROUP_EDGE: readonly string[] = [
  '@.claude/knowledge/layer-1-core.md              (TS + Nx + Jest base)',
  '@.claude/knowledge/layer-1-rust.md              (Rust 1.83, Tokio, FFI discipline)',
  ...COMMON_SHARED,
];

const GROUPS: Record<string, readonly string[]> = {
  // UI auditors — UI-only or mostly-UI
  'accessibility-auditor': GROUP_UI,
  'button-action-auditor': GROUP_UI,
  'chart-widget-auditor': GROUP_UI,
  'list-visibility-auditor': GROUP_UI,
  'mobile-app-auditor': GROUP_UI,
  'ui-action-mapper': GROUP_UI,
  // Roundtrip auditors — UI ↔ backend
  'form-write-auditor': GROUP_ROUNDTRIP,
  'data-readback-auditor': GROUP_ROUNDTRIP,
  'table-grid-auditor': GROUP_ROUNDTRIP,
  'workflow-state-auditor': GROUP_ROUNDTRIP,
  'realtime-sync-auditor': GROUP_ROUNDTRIP,
  'file-transfer-auditor': GROUP_ROUNDTRIP,
  // Backend-surface auditors
  'schema-surface-parity-auditor': GROUP_BACKEND,
  'webhook-ingress-auditor': GROUP_BACKEND,
  'job-queue-auditor': GROUP_BACKEND,
  'tenant-isolation-auditor': GROUP_BACKEND,
  'access-boundary-auditor': GROUP_BACKEND,
  'billing-reconciliation-auditor': GROUP_BACKEND,
  // Edge auditor
  'edge-industrial-auditor': GROUP_EDGE,
};

const SKIP = new Set<string>([
  'README.md',
  'INVOCATION-PACK.md',
  'orchestrator.md',
  'context-manager.md',
  'architectural-arbiter.md',
  'gdpr-compliance-auditor.md',
  'soc2-readiness-auditor.md',
  'ai-tool-execution-auditor.md',
  'contract-parity-auditor.md',
]);

const dryRun = process.argv.includes('--dry-run');

function buildSection(refs: readonly string[]): string {
  return (
    '## Canonical References (READ via the Read tool before starting)\n\n' +
    SSOT_PREAMBLE +
    '\n\n' +
    refs.map((r) => `- ${r}`).join('\n') +
    '\n\n'
  );
}

function injectAfterTitle(content: string, section: string): string {
  // Locate the first `##` heading; insert `section` immediately before it.
  // Expected shape: frontmatter → blank → `# Title` → blank → intro lines → `## Operating Mode`
  const firstH2 = content.indexOf('\n## ');
  if (firstH2 === -1) {
    throw new Error('No `## ` heading found — file shape not matching Lane-B convention.');
  }
  // Include the leading newline in the insertion point.
  return content.slice(0, firstH2 + 1) + section + content.slice(firstH2 + 1);
}

let processed = 0;
let skipped = 0;

for (const entry of readdirSync(LANE_B)) {
  if (SKIP.has(entry)) continue;
  if (!entry.endsWith('.md')) continue;

  const bareName = entry.replace(/\.md$/, '');
  const refs = GROUPS[bareName];
  if (!refs) {
    console.warn(`No group mapping for ${entry} — skipping.`);
    continue;
  }

  const file = join(LANE_B, entry);
  const content = readFileSync(file, 'utf8');

  if (content.includes('## Canonical References')) {
    console.log(`skip (already present): ${entry}`);
    skipped++;
    continue;
  }

  const updated = injectAfterTitle(content, buildSection(refs));

  if (dryRun) {
    console.log(`would update: ${entry} (${content.length} → ${updated.length} bytes)`);
  } else {
    writeFileSync(file, updated, 'utf8');
    console.log(`updated: ${entry} (${content.length} → ${updated.length} bytes)`);
  }
  processed++;
}

console.log(`\nDone. ${processed} processed, ${skipped} already-present.`);
