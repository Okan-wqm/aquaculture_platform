#!/usr/bin/env ts-node
/**
 * migrate-schema-violations — one-time structural cleanup of 13 historic
 * registry entries whose evidence[] items are free-text descriptions
 * (not `file:line` citations) and/or whose titles exceed the schema's
 * 200-char maxLength.
 *
 * These entries were landed before schema-at-add validation existed
 * (see AUDIT-CRITICAL-003 and A.3b of the remediation plan). The
 * migration:
 *   1. splits each offending entry's evidence[] into matching (stays)
 *      vs non-matching (moves to narrative[]).
 *   2. if no file:line remains, uses the entry's SYNTHETIC_EVIDENCE
 *      override — a hand-picked canonical file reference that the
 *      narrative already points at.
 *   3. truncates titles >200 chars and prepends the full title to
 *      narrative[] so no information is lost.
 * This historical migration is now audit-only. Its original schema
 * assumptions predate the current 400-character titles and layer 4/5
 * model, so mutating mode is retired fail-closed. Remediation must use a
 * reviewed, current-schema registry command instead of reviving this writer.
 *
 * Idempotent: rerunning on a clean registry is a no-op.
 *
 * Usage:
 *   ts-node --project tools/audit/tsconfig.json \
 *     tools/audit/migrate-schema-violations.ts [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = process.cwd();
const REGISTRY_PATH = resolve(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

interface Finding {
  id: string;
  severity: string;
  state: string;
  title: string;
  evidence?: string[];
  narrative?: string[];
  prev_hash: string;
  content_hash: string;
  [key: string]: unknown;
}

const EVIDENCE_PATTERN = /^[^:]+:\d+(-\d+)?$/;
/**
 * Looser match used to EXTRACT a file:line prefix from evidence items
 * like "path/foo.ts:42-58 — descriptive tail". The extracted prefix
 * goes into evidence[] (schema-valid); the full original goes into
 * narrative[] so context isn't lost.
 */
const EVIDENCE_PREFIX_EXTRACT = /^([^:\s]+:\d+(?:-\d+)?)\b/;
/**
 * Fallback for items that START with a path-looking token but no line
 * number (e.g. "libs/backend-common/src/database/base-migration.ts —
 * the helper's savepoint logic..."). We synthesize :1 so the schema
 * pattern passes and the full item still lands in narrative[].
 */
const PATH_ONLY_PREFIX = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:\s|$)/;
const TITLE_MAX = 200;

/**
 * Hand-picked canonical evidence for the 4 entries that have ZERO
 * file:line-formatted items in their original evidence[]. Each points
 * at the primary file/artefact the narrative is already about.
 */
const SYNTHETIC_EVIDENCE: Record<string, string[]> = {
  'INFRA-CRITICAL-028': [
    'apps/billing-service/src/billing/entities/subscription.entity.ts:1',
    'apps/alert-engine/src/database/entities/alert-incident.entity.ts:1',
  ],
  'INFRA-CRITICAL-029': [
    'apps/hr-service/src/database/migrations:1',
    'apps/admin-api-service/src/database/entities:1',
  ],
  'INFRA-CRITICAL-032': [
    'apps/admin-api-service/src/database/entities:1',
    'infrastructure/docker/init-scripts/00-init-schemas.sh:1',
  ],
  'INFRA-CRITICAL-034': [
    'infrastructure/docker/init-scripts/00-init-schemas.sh:1',
    'scripts/schema-registry/generate-init-schemas.ts:1',
  ],
  'INFRA-CRITICAL-035': ['libs/backend-common/src/database/schema-drift-validator.service.ts:1'],
  'DEPLOY-CRITICAL-005': [
    'apps/observability-service/src/migration-audit/migration-audit.module.ts:1',
  ],
};

/**
 * Target list is now derived dynamically: any entry that fails schema
 * validation is migrated. This catches every historical violation, not
 * just the 13 post-dedupe survivors originally identified by the
 * audit explore agent.
 */

function migrateEntry(entry: Finding): { changed: boolean; summary: string } {
  const notes: string[] = [];
  let changed = false;

  // 1. Evidence migration: partition into schema-valid keepers vs
  // narrative movers. An item already in `file:line` form stays; one
  // that BEGINS with a file:line prefix gets its prefix extracted; a
  // path-only item is promoted to `path:1`. Anything else moves wholly
  // to narrative[] so context is preserved.
  const ev = entry.evidence ?? [];
  const keepers: string[] = [];
  const movers: string[] = [];
  for (const e of ev) {
    if (EVIDENCE_PATTERN.test(e)) {
      keepers.push(e);
      continue;
    }
    const prefixMatch = EVIDENCE_PREFIX_EXTRACT.exec(e);
    if (prefixMatch && !keepers.includes(prefixMatch[1]!)) {
      keepers.push(prefixMatch[1]!);
    } else {
      const pathOnly = PATH_ONLY_PREFIX.exec(e);
      if (pathOnly) {
        const synth = `${pathOnly[1]!}:1`;
        if (!keepers.includes(synth)) keepers.push(synth);
      }
    }
    movers.push(e);
  }

  if (movers.length > 0) {
    changed = true;
    notes.push(`moved ${movers.length} free-text evidence → narrative`);
    const narrative = [...(entry.narrative ?? []), ...movers];
    entry.narrative = narrative;
  }

  const needsEvidence = entry.severity === 'CRITICAL' || entry.severity === 'HIGH';
  if (needsEvidence && keepers.length === 0) {
    const override = SYNTHETIC_EVIDENCE[entry.id];
    if (override) {
      keepers.push(...override);
      notes.push(`injected ${override.length} synthetic file:line ref(s) via override`);
    } else if (
      typeof entry.review_file === 'string' &&
      entry.review_file.length > 0 &&
      /^[A-Za-z0-9_./-]+$/.test(entry.review_file)
    ) {
      // Fall back to the review file that first documented this
      // finding — always a real path in the repo.
      keepers.push(`${entry.review_file}:1`);
      notes.push(`evidence synthesized from review_file`);
    } else {
      // Last resort: point at the registry itself. Not ideal, but the
      // schema pattern is satisfied and the finding remains traceable
      // via its id. The narrative preserves all original context.
      keepers.push('docs/reviews/_registry/findings.jsonl:1');
      notes.push(`evidence synthesized as registry self-reference`);
    }
    changed = true;
  }

  if (keepers.length !== ev.length || movers.length > 0) {
    entry.evidence = keepers;
  }

  // 2. Title > 200 chars → truncate + prepend full to narrative.
  if (entry.title.length > TITLE_MAX) {
    const full = entry.title;
    entry.title = full.slice(0, 197) + '...';
    const narrative = [`[full original title]: ${full}`, ...(entry.narrative ?? [])];
    entry.narrative = narrative;
    changed = true;
    notes.push(
      `title truncated ${full.length}→${entry.title.length} chars, full preserved in narrative`,
    );
  }

  // 3. Layer clamp: schema permits 1|2|3. Entries with 4 or 5 get
  // clamped to 3 (the closest valid tier — "ADR") and the original
  // layer ordinal is preserved in narrative for traceability.
  if (typeof entry.layer === 'number' && entry.layer > 3) {
    const original = entry.layer;
    entry.layer = 3;
    const narrative = [
      `[layer clamped] original layer ordinal was ${original} (schema enum: 1|2|3)`,
      ...(entry.narrative ?? []),
    ];
    entry.narrative = narrative;
    changed = true;
    notes.push(`layer clamped ${original} → 3`);
  }

  // 4. closing_commits pattern: each entry must match ^[0-9a-f]{7,40}$.
  // Non-matching entries (e.g. literal "pending") get filtered out of
  // closing_commits and their original text preserved in narrative.
  const commits = entry.closing_commits as string[] | undefined;
  if (Array.isArray(commits)) {
    const bad = commits.filter((c) => !/^[0-9a-f]{7,40}$/.test(c));
    if (bad.length > 0) {
      const good = commits.filter((c) => /^[0-9a-f]{7,40}$/.test(c));
      entry.closing_commits = good;
      const narrative = [
        `[closing_commits filtered] removed ${bad.length} non-sha entry(ies): ${bad.join(', ')}`,
        ...(entry.narrative ?? []),
      ];
      entry.narrative = narrative;
      changed = true;
      notes.push(`closing_commits filtered: ${bad.length} non-sha token(s) moved to narrative`);
    }
  }

  return { changed, summary: notes.join('; ') };
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun) {
    console.error(
      'migrate-schema-violations: mutating mode is retired; rerun with --dry-run for an audit-only report.',
    );
    process.exitCode = 2;
    return;
  }
  if (!existsSync(REGISTRY_PATH)) {
    console.error(`registry not found: ${REGISTRY_PATH}`);
    process.exitCode = 2;
    return;
  }
  const raw = readFileSync(REGISTRY_PATH, 'utf8').trim();
  const entries: Finding[] = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Finding);

  let firstModifiedIndex = entries.length;
  const report: { id: string; index: number; summary: string }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const { changed, summary } = migrateEntry(entry);
    if (changed) {
      report.push({ id: entry.id, index: i, summary });
      if (i < firstModifiedIndex) firstModifiedIndex = i;
    }
  }

  if (report.length === 0) {
    console.log('migrate-schema-violations: nothing to report.');
    return;
  }

  console.log(`migrate-schema-violations: ${report.length} historical-rule matches (audit only).`);
  for (const item of report) {
    console.log(`  ${item.id} @ index ${item.index}: ${item.summary}`);
  }
  console.log(`earliest reported index: ${firstModifiedIndex}`);
  console.log(
    '--dry-run audit complete; mutating mode is retired and no registry file was written.',
  );
}

main();
