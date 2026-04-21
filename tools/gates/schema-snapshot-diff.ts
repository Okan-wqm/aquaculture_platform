#!/usr/bin/env ts-node
/**
 * schema-snapshot-diff — PR gate for Phase 4 of the db-migrate plan.
 * ============================================================================
 *
 * Reads two schema-snapshot JSON files (produced by introspectSchema +
 * JSON.stringify), runs the pure diffSnapshots() function, and exits
 * non-zero when breaking-severity changes are present. Default policy:
 * fail-closed on breaking; emit warnings on expand; ignore neutral.
 *
 * # Inputs
 *
 *   --before <path>   Pre-merge SchemaSnapshot JSON.
 *   --after  <path>   Post-migrate shadow-applied SchemaSnapshot JSON.
 *   --schema <name>   Expected schema name (must match both inputs).
 *   --allow-breaking  Opt-in bypass. Pass only when the PR has an
 *                     @ExpandContract plan-phase marker or equivalent
 *                     authorization. Logged to the findings registry.
 *   --json            Emit machine-readable JSON report on stdout
 *                     instead of the human-readable summary.
 *
 * # Exit codes
 *
 *   0  No breaking changes (or --allow-breaking passed).
 *   1  Breaking change(s) detected and NOT allowed → fail the gate.
 *   2  Input error (missing path, malformed JSON, schema mismatch).
 *
 * # Design
 *
 * Pure orchestration — this script parses CLI args + file IO, then
 * delegates to the library-level diffSnapshots() helper so the gate
 * logic is fully unit-tested via
 * libs/backend-common/src/database/schema-drift/__tests__/diff-snapshots.spec.ts.
 * Do not put diffing logic here.
 */
import { readFileSync } from 'node:fs';

import {
  diffSnapshots,
  partitionBySeverity,
  type SnapshotChange,
} from '../../libs/backend-common/src/database/schema-drift/diff-snapshots';
import type { SchemaSnapshot } from '../../libs/backend-common/src/database/schema-drift/pg-catalog-introspector';

interface CliArgs {
  readonly before: string;
  readonly after: string;
  readonly schema: string;
  readonly allowBreaking: boolean;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let before: string | undefined;
  let after: string | undefined;
  let schema: string | undefined;
  let allowBreaking = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--before':
        before = argv[++i];
        break;
      case '--after':
        after = argv[++i];
        break;
      case '--schema':
        schema = argv[++i];
        break;
      case '--allow-breaking':
        allowBreaking = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!before || !after || !schema) {
    throw new Error(
      'Required: --before <path> --after <path> --schema <name>',
    );
  }
  return { before, after, schema, allowBreaking, json };
}

function readSnapshot(path: string): SchemaSnapshot {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('schema' in parsed) ||
    !('tables' in parsed) ||
    !('enums' in parsed) ||
    !('checkConstraints' in parsed)
  ) {
    throw new Error(
      `[${path}] does not look like a SchemaSnapshot (missing one of: schema, tables, enums, checkConstraints)`,
    );
  }
  return parsed as SchemaSnapshot;
}

function renderHuman(
  changes: readonly SnapshotChange[],
  allowBreaking: boolean,
): string {
  const { breaking, expand, neutral } = partitionBySeverity(changes);
  const lines: string[] = [];
  lines.push(
    `schema-snapshot-diff: ${changes.length} total change(s) — ` +
      `${breaking.length} breaking, ${expand.length} expand, ${neutral.length} neutral`,
  );
  const render = (group: readonly SnapshotChange[], label: string): void => {
    if (group.length === 0) return;
    lines.push('');
    lines.push(`── ${label} ──`);
    for (const c of group) {
      const detail =
        c.details !== undefined
          ? ` ${JSON.stringify(c.details)}`
          : '';
      lines.push(`  ${c.kind}: ${c.subject}${detail}`);
    }
  };
  render(breaking, 'BREAKING');
  render(expand, 'EXPAND');
  render(neutral, 'NEUTRAL');
  if (breaking.length > 0) {
    lines.push('');
    lines.push(
      allowBreaking
        ? '✓ --allow-breaking passed; gate exits 0 despite breaking changes.'
        : '✗ Breaking changes present; gate fails. Pass --allow-breaking with an explicit @ExpandContract authorization to override.',
    );
  }
  return lines.join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(
      `[schema-snapshot-diff] argument error: ${(e as Error).message}\n`,
    );
    return 2;
  }

  let before: SchemaSnapshot;
  let after: SchemaSnapshot;
  try {
    before = readSnapshot(args.before);
    after = readSnapshot(args.after);
  } catch (e) {
    process.stderr.write(
      `[schema-snapshot-diff] input error: ${(e as Error).message}\n`,
    );
    return 2;
  }

  if (before.schema !== args.schema || after.schema !== args.schema) {
    process.stderr.write(
      `[schema-snapshot-diff] schema mismatch — expected '${args.schema}', ` +
        `got before='${before.schema}' after='${after.schema}'\n`,
    );
    return 2;
  }

  const changes = diffSnapshots(before, after);
  const parts = partitionBySeverity(changes);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: args.schema,
          totalChanges: changes.length,
          breakingCount: parts.breaking.length,
          expandCount: parts.expand.length,
          neutralCount: parts.neutral.length,
          allowBreaking: args.allowBreaking,
          changes,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(renderHuman(changes, args.allowBreaking) + '\n');
  }

  if (parts.breaking.length > 0 && !args.allowBreaking) {
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
