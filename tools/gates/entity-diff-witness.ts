#!/usr/bin/env ts-node
/**
 * entity-diff-witness — Faz 1.3 of the day-one baseline reset.
 * ============================================================================
 *
 * # Purpose
 *
 * Catches the silent-regression class where an `@Entity()` file is edited
 * (new column, dropped column, type change, nullability flip, FK addition,
 * @Check() change, enum label addition) WITHOUT a matching migration
 * landing in the same PR. The validator's drift class (`schema-drift-
 * validator.service.ts`) catches this at runtime; this gate catches it at
 * PR time — before any deploy.
 *
 * # The regression class this prevents
 *
 * The 2026-04 incident family ("Align*EntitySurface" / "Heal*Drift" /
 * "Replay*" migrations across farm/sensor/hr/admin) was driven by entity
 * edits landing without matching migrations. Drift accumulated silently
 * for weeks; once `SchemaDriftValidator` strict mode caught up, 14 services
 * needed coordinated repair migrations.
 *
 * Faz 1.3 closes the upstream gate: an entity diff must come with a new
 * migration in the same PR. The migration can be empty / no-op (rare —
 * e.g. a rename that PostgreSQL handles transparently), but it must exist
 * so the author has reviewed and acknowledged the diff.
 *
 * # Algorithm
 *
 *   1. `git diff --name-status <base>..<head>` — list every M/A/D/R entry.
 *   2. Group by service (the `apps/<svc>/` segment of each path).
 *   3. For each service with a changed `.entity.ts` file:
 *        - witness (a): the same diff contains at least ONE new migration
 *          (A status) under `apps/<svc>/src/migrations/` or
 *          `apps/<svc>/src/database/migrations/` with a numeric timestamp
 *          prefix.
 *        - witness (b): the PR body (env PR_BODY) contains a line
 *          `ENTITY-DIFF-OK: <reason>` mentioning the service.
 *   4. If neither (a) nor (b) holds, fail loudly with the unaccounted-for
 *      entity edits.
 *
 * # Exit codes
 *
 *   0 — every entity-edited service either ships a new migration or is
 *       waived in the PR body.
 *   1 — at least one service edited an entity without a witness.
 *   2 — invocation error (cannot resolve diff base, etc.).
 *
 * # Invocation
 *
 *   ts-node tools/gates/entity-diff-witness.ts --diff-base origin/main
 *   ts-node tools/gates/entity-diff-witness.ts --diff-base HEAD~1
 *
 * Local pre-commit chain wires this after migration-deletion-witness.
 * GHA workflow `db-migration-check.yml` adds a parallel job.
 */

/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface Args {
  readonly diffBase: string;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  let diffBase = 'origin/main';
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (!arg) continue;
    const next = raw[i + 1];
    if (arg === '--diff-base' && next) {
      diffBase = next;
      i++;
    } else if (arg.startsWith('--diff-base=')) {
      const value = arg.slice('--diff-base='.length);
      if (value) diffBase = value;
    }
  }
  return { diffBase };
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const stderr = e.stderr?.toString() ?? '';
    console.error(`[entity-diff-witness] git ${cmd} failed: ${stderr}`);
    process.exit(2);
  }
}

interface DiffEntry {
  readonly status: string; // M, A, D, R, etc.
  readonly path: string;
}

function listDiff(base: string): readonly DiffEntry[] {
  // --diff-filter excludes nothing; we want to see additions too.
  const out = git(`diff --name-status ${base}...HEAD`);
  const entries: DiffEntry[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0];
    if (!status) continue;
    // For renames "R100\tsrc/old\tsrc/new" — record the new path with M status
    // (the file effectively MOVED; if the entity body changed too, the M will
    // show up as MM in subsequent runs, but the rename alone implies edit).
    const path = status.startsWith('R') && parts[2] ? parts[2] : parts[1];
    if (!path) continue;
    entries.push({ status: status.charAt(0), path });
  }
  return entries;
}

const ENTITY_FILE_RE = /^apps\/([^/]+)\/src\/.*\.entity\.ts$/;
const MIGRATION_FILE_RE =
  /^apps\/([^/]+)\/src\/(?:migrations|database\/migrations)\/(?:[^/]+\/)?[0-9]+-[^/]+\.ts$/;

interface ServiceState {
  readonly entitiesEdited: string[];
  readonly newMigrations: string[];
}

function groupByService(entries: readonly DiffEntry[]): Map<string, ServiceState> {
  const services = new Map<string, { entitiesEdited: string[]; newMigrations: string[] }>();
  for (const e of entries) {
    const entityMatch = ENTITY_FILE_RE.exec(e.path);
    if (entityMatch) {
      const svc = entityMatch[1];
      if (!svc) continue;
      // Edits, additions, renames all count as "entity touched". Pure deletions
      // (D) are NOT a drift class — the migration for the dropped entity should
      // also be in the diff (covered by migration-deletion-witness).
      if (e.status === 'M' || e.status === 'A' || e.status === 'R') {
        const cur =
          services.get(svc) ?? { entitiesEdited: [], newMigrations: [] };
        cur.entitiesEdited.push(e.path);
        services.set(svc, cur);
      }
      continue;
    }
    const migrationMatch = MIGRATION_FILE_RE.exec(e.path);
    if (migrationMatch && e.status === 'A') {
      const svc = migrationMatch[1];
      if (!svc) continue;
      const cur =
        services.get(svc) ?? { entitiesEdited: [], newMigrations: [] };
      cur.newMigrations.push(e.path);
      services.set(svc, cur);
    }
  }
  return services as Map<string, ServiceState>;
}

const WAIVER_RE = /ENTITY-DIFF-OK:\s*([\w-]+)\s*(?:—|-)?\s*(.+)?/g;

function readWaiveredServices(): Set<string> {
  const body = process.env.PR_BODY ?? '';
  const waived = new Set<string>();
  if (!body) return waived;
  let match: RegExpExecArray | null;
  WAIVER_RE.lastIndex = 0;
  while ((match = WAIVER_RE.exec(body)) !== null) {
    const service = match[1];
    if (service) waived.add(service);
  }
  return waived;
}

function main(): void {
  const { diffBase } = parseArgs();
  const entries = listDiff(diffBase);
  if (entries.length === 0) {
    console.log('[entity-diff-witness] empty diff — nothing to verify');
    process.exit(0);
  }

  const services = groupByService(entries);
  if (services.size === 0) {
    console.log('[entity-diff-witness] no entity or migration changes — pass');
    process.exit(0);
  }

  const waivered = readWaiveredServices();

  type Failure = { service: string; entities: string[] };
  const failures: Failure[] = [];

  for (const [svc, state] of services) {
    if (state.entitiesEdited.length === 0) continue;
    if (state.newMigrations.length > 0) {
      console.log(
        `[entity-diff-witness] ${svc}: ${state.entitiesEdited.length} entity edit(s) + ${state.newMigrations.length} new migration(s) — pass`,
      );
      continue;
    }
    if (waivered.has(svc)) {
      console.log(
        `[entity-diff-witness] ${svc}: ${state.entitiesEdited.length} entity edit(s) + PR-body waiver (ENTITY-DIFF-OK: ${svc}) — pass`,
      );
      continue;
    }
    failures.push({ service: svc, entities: state.entitiesEdited });
  }

  if (failures.length > 0) {
    console.error('[entity-diff-witness] FAILED — entity edits without matching migration:');
    for (const f of failures) {
      console.error(`  - apps/${f.service}/`);
      for (const e of f.entities) {
        console.error(`      ${e}`);
      }
    }
    console.error('');
    console.error('Resolution:');
    console.error('  1. Generate a migration via typeorm migration:generate against');
    console.error('     apps/<svc>/src/database/data-source.ts and include the file');
    console.error('     in the same PR. The migration MAY be empty/no-op if the entity');
    console.error('     edit produces no schema delta (rare).');
    console.error('  2. Otherwise, document the no-migration reason in the PR body:');
    console.error('       ENTITY-DIFF-OK: <service> — <reason>');
    console.error('     (e.g. ENTITY-DIFF-OK: farm-service — typing fix only, no DDL impact)');
    console.error('  3. CODEOWNERS review for the PR-body waiver lives with');
    console.error('     database-reviewer.');
    process.exit(1);
  }

  console.log(
    `[entity-diff-witness] all ${services.size} service(s) with diff carry valid witness — pass`,
  );
  process.exit(0);
}

main();
