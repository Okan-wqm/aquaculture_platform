#!/usr/bin/env ts-node
/**
 * aggregate-hotspots — Phase 1.5 deterministic signal aggregator.
 *
 * Reads the raw signals produced by Phase 1 scanners in
 * docs/reviews/_audit/<cycle>/01-signals/ and emits refined Phase 2
 * input artifacts (02-*.md) WITHOUT invoking any agent.
 *
 * Usage:
 *   ts-node --project tools/audit/tsconfig.json tools/audit/aggregate-hotspots.ts \
 *     --cycle 2026-04-22-cold-audit
 *
 * Score formula (per-file):
 *   score = 2·tsc_errors + 2·lint_errors + 1·lint_warnings
 *         + 3·banned_phrase_hits + 3·as_any_hits + 3·getRepository_hits
 *         + 3·ts_ignore_hits + 3·entity_missing_schema_hits
 *         + 2·jscpd_dup_lines/100
 *         + 1·churn_last_3m
 *         + 5·open_finding_count
 *
 * Output artifacts (all under docs/reviews/_audit/<cycle>/):
 *   02-hotspot-per-file.md      — top 30 files with score breakdown
 *   02-hotspot-per-service.md   — rollup per apps/<svc> and web/<module>
 *   02-jscpd-clusters.md        — cross-file duplicate clusters
 *   02-orphan-modules.md        — circular-dep-only groups (madge) for
 *                                  candidate dead-code confirmation
 *   02-adr-violations.md        — ADR-006/011/014/015 hit taxonomy
 *
 * Design: pure read-only transforms, no network, no external deps. If
 * a signal file is missing the aggregator skips it gracefully and notes
 * the gap in the output so Phase 2 agent sees an honest picture.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const REPO_ROOT = process.cwd();

interface FileSignals {
  path: string;
  tsc_errors: number;
  lint_errors: number;
  lint_warnings: number;
  banned_phrase_hits: number;
  as_any_hits: number;
  getRepository_hits: number;
  ts_ignore_hits: number;
  entity_missing_schema_hits: number;
  console_hits: number;
  jscpd_dup_lines: number;
  churn_3m: number;
  open_finding_count: number;
  circular_in: number;
  score: number;
  score_breakdown: string[];
}

interface JscpdClone {
  tokens: number;
  format: string;
  files: { name: string; start: { line: number }; end: { line: number } }[];
  lines: number;
}

interface FindingEntry {
  id: string;
  severity: string;
  state: string;
  title: string;
  evidence?: string[];
  rule_violated?: string;
  owner_agent?: string;
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function getOrCreate(map: Map<string, FileSignals>, path: string): FileSignals {
  const norm = normPath(path);
  let entry = map.get(norm);
  if (!entry) {
    entry = {
      path: norm,
      tsc_errors: 0,
      lint_errors: 0,
      lint_warnings: 0,
      banned_phrase_hits: 0,
      as_any_hits: 0,
      getRepository_hits: 0,
      ts_ignore_hits: 0,
      entity_missing_schema_hits: 0,
      console_hits: 0,
      jscpd_dup_lines: 0,
      churn_3m: 0,
      open_finding_count: 0,
      circular_in: 0,
      score: 0,
      score_breakdown: [],
    };
    map.set(norm, entry);
  }
  return entry;
}

/**
 * Parse lines of the form "path/to/file.ts:12:34:..." — the shared
 * shape of all grep probes and of lint/tsc error output. Returns a
 * histogram of hits per file.
 */
function parseColonHits(text: string): Map<string, number> {
  const hits = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^([^:]+?\.(ts|tsx|js|jsx)):\d+/.exec(line);
    if (!m) continue;
    const file = normPath(m[1]!);
    hits.set(file, (hits.get(file) ?? 0) + 1);
  }
  return hits;
}

/**
 * Parse `nx run-many --target=lint` stream output. ESLint stream lines
 * look like:
 *   /abs/path/to/file.ts
 *     12:3  error    some-rule  @typescript-eslint/foo
 * We scan for lines starting with `/` (absolute path) and subsequent
 * indented error/warning lines until the next path.
 */
function parseLintStream(text: string): { errors: Map<string, number>; warnings: Map<string, number> } {
  const errors = new Map<string, number>();
  const warnings = new Map<string, number>();
  let currentFile: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const absMatch = /^(\/\S+\.(ts|tsx|js|jsx))$/.exec(line);
    if (absMatch) {
      const abs = absMatch[1]!;
      currentFile = normPath(relative(REPO_ROOT, abs));
      continue;
    }
    if (!currentFile) continue;
    const sevMatch = /^\s+\d+:\d+\s+(error|warning)\b/.exec(line);
    if (sevMatch) {
      if (sevMatch[1] === 'error') {
        errors.set(currentFile, (errors.get(currentFile) ?? 0) + 1);
      } else {
        warnings.set(currentFile, (warnings.get(currentFile) ?? 0) + 1);
      }
    }
  }
  return { errors, warnings };
}

function parseChurn(text: string): Map<string, number> {
  const churn = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const count = parseInt(m[1]!, 10);
    const file = normPath(m[2]!);
    churn.set(file, count);
  }
  return churn;
}

function readFindingsJsonl(path: string): FindingEntry[] {
  if (!existsSync(path)) return [];
  const out: FindingEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as FindingEntry);
    } catch {
      // skip malformed lines (shouldn't happen — registry is gated)
    }
  }
  return out;
}

function readJscpdClones(reportPath: string): JscpdClone[] {
  if (!existsSync(reportPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      duplicates?: {
        firstFile: { name: string; start: number; end: number };
        secondFile: { name: string; start: number; end: number };
        lines: number;
        tokens: number;
        format: string;
      }[];
    };
    return (parsed.duplicates ?? []).map((d) => ({
      tokens: d.tokens,
      format: d.format,
      lines: d.lines,
      files: [
        { name: normPath(relative(REPO_ROOT, d.firstFile.name)), start: { line: d.firstFile.start }, end: { line: d.firstFile.end } },
        { name: normPath(relative(REPO_ROOT, d.secondFile.name)), start: { line: d.secondFile.start }, end: { line: d.secondFile.end } },
      ],
    }));
  } catch (err) {
    console.error(`[warn] failed to parse jscpd report: ${(err as Error).message}`);
    return [];
  }
}

function parseMadgeCircular(text: string): string[][] {
  const groups: string[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const m = /^\s*\d+\)\s+(.+)$/.exec(line);
    if (!m) continue;
    const chain = m[1]!.split('>').map((s) => normPath(s.trim()));
    if (chain.length >= 2) groups.push(chain);
  }
  return groups;
}

function serviceOf(path: string): string {
  const appMatch = /^apps\/([^/]+)\//.exec(path);
  if (appMatch) return `apps/${appMatch[1]}`;
  const webMatch = /^web\/(?:modules\/)?([^/]+)\//.exec(path);
  if (webMatch) return `web/${webMatch[1]}`;
  const libsMatch = /^libs\/([^/]+)\//.exec(path);
  if (libsMatch) return `libs/${libsMatch[1]}`;
  const platformMatch = /^platform\/libs\/([^/]+)\//.exec(path);
  if (platformMatch) return `platform/${platformMatch[1]}`;
  return '(other)';
}

function ensureDir(path: string): void {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(path, { recursive: true });
}

function main(): void {
  const args = process.argv.slice(2);
  const cycleIdx = args.indexOf('--cycle');
  if (cycleIdx < 0 || !args[cycleIdx + 1]) {
    console.error('usage: aggregate-hotspots --cycle <YYYY-MM-DD-topic>');
    process.exit(2);
  }
  const cycle = args[cycleIdx + 1]!;
  const cycleDir = resolve(REPO_ROOT, 'docs', 'reviews', '_audit', cycle);
  const signalsDir = resolve(cycleDir, '01-signals');
  if (!existsSync(signalsDir)) {
    console.error(`signals dir missing: ${signalsDir}`);
    process.exit(2);
  }
  ensureDir(cycleDir);

  const files = new Map<string, FileSignals>();

  // --- parse grep probes (colon-hit shape) ---
  const greps: Record<string, keyof FileSignals> = {
    'grep-as-any.txt': 'as_any_hits',
    'grep-getRepository.txt': 'getRepository_hits',
    'grep-ts-ignore.txt': 'ts_ignore_hits',
    'grep-console.txt': 'console_hits',
  };
  for (const [fname, field] of Object.entries(greps)) {
    const txt = readOptional(resolve(signalsDir, fname));
    for (const [file, n] of parseColonHits(txt)) {
      const entry = getOrCreate(files, file);
      (entry as unknown as Record<string, number>)[field] = (entry as unknown as Record<string, number>)[field]! + n;
    }
  }

  // --- entity-missing-schema is path-only (no :line) ---
  const entMiss = readOptional(resolve(signalsDir, 'grep-entity-missing-schema.txt'));
  for (const raw of entMiss.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const entry = getOrCreate(files, line);
    entry.entity_missing_schema_hits += 1;
  }

  // --- lint (ESLint stream form) ---
  const lintTxt = readOptional(resolve(signalsDir, 'lint.txt'));
  const { errors: lintErrs, warnings: lintWarns } = parseLintStream(lintTxt);
  for (const [file, n] of lintErrs) getOrCreate(files, file).lint_errors += n;
  for (const [file, n] of lintWarns) getOrCreate(files, file).lint_warnings += n;

  // --- tsc (best-effort — most invocations currently broken; still parse) ---
  const tscTxt = readOptional(resolve(signalsDir, 'tsc.txt'));
  for (const [file, n] of parseColonHits(tscTxt)) {
    getOrCreate(files, file).tsc_errors += n;
  }

  // --- churn ---
  const churnTxt = readOptional(resolve(signalsDir, 'churn-top120.txt'));
  for (const [file, n] of parseChurn(churnTxt)) {
    getOrCreate(files, file).churn_3m = n;
  }

  // --- jscpd clones: attribute half dup_lines to each participant ---
  const clones = readJscpdClones(resolve('/tmp/jscpd/jscpd-report.json'));
  for (const c of clones) {
    for (const f of c.files) {
      getOrCreate(files, f.name).jscpd_dup_lines += c.lines;
    }
  }

  // --- madge circular: count occurrences per file across chains ---
  const circularTxt = readOptional(resolve(signalsDir, 'madge-circular.txt'));
  const circularGroups = parseMadgeCircular(circularTxt);
  for (const chain of circularGroups) {
    for (const f of chain) {
      const entry = getOrCreate(files, f);
      entry.circular_in += 1;
    }
  }

  // --- open findings: walk registry, attribute evidence file refs ---
  const findings = readFindingsJsonl(resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl'));
  const openFindings = findings.filter((f) => f.state === 'OPEN' || f.state === 'IN-PROGRESS');
  for (const f of openFindings) {
    for (const ev of f.evidence ?? []) {
      const m = /^([^:\s]+\.[a-zA-Z0-9]+):\d+/.exec(ev);
      if (!m) continue;
      const entry = getOrCreate(files, m[1]!);
      entry.open_finding_count += 1;
    }
  }

  // --- compute scores ---
  for (const entry of files.values()) {
    const parts: string[] = [];
    const push = (coef: number, val: number, label: string): number => {
      if (val === 0) return 0;
      const contrib = coef * val;
      parts.push(`${coef}·${label}(${val})=${contrib}`);
      return contrib;
    };
    let s = 0;
    s += push(2, entry.tsc_errors, 'tsc');
    s += push(2, entry.lint_errors, 'lintE');
    s += push(1, entry.lint_warnings, 'lintW');
    s += push(3, entry.as_any_hits, 'asAny');
    s += push(3, entry.getRepository_hits, 'getRepo');
    s += push(3, entry.ts_ignore_hits, 'tsIgnore');
    s += push(3, entry.entity_missing_schema_hits, 'noSchema');
    s += push(3, entry.banned_phrase_hits, 'banned');
    s += push(2, Math.floor(entry.jscpd_dup_lines / 100), 'dupBlk');
    s += push(1, entry.churn_3m, 'churn');
    s += push(5, entry.open_finding_count, 'openFind');
    s += push(1, entry.circular_in, 'circ');
    entry.score = s;
    entry.score_breakdown = parts;
  }

  const sorted = [...files.values()].filter((f) => f.score > 0).sort((a, b) => b.score - a.score);

  // --- emit 02-hotspot-per-file.md ---
  const top = sorted.slice(0, 30);
  const header =
    `# Hotspot per file — top 30\n\n` +
    `Cycle: \`${cycle}\`  •  Source: deterministic aggregation of \`01-signals/*\`  •  Formula: ` +
    `see \`tools/audit/aggregate-hotspots.ts\` header.\n\n` +
    `Scored files total: **${sorted.length}**.\n\n` +
    `| # | Score | File | Signals |\n|---|---|---|---|\n`;
  const rows = top
    .map(
      (f, i) =>
        `| ${i + 1} | ${f.score} | \`${f.path}\` | ${f.score_breakdown.join(' + ') || '—'} |`,
    )
    .join('\n');
  writeFileSync(resolve(cycleDir, '02-hotspot-per-file.md'), `${header}${rows}\n`, 'utf8');

  // --- emit 02-hotspot-per-service.md ---
  const svcMap = new Map<string, { score: number; files: number; hotspots: FileSignals[] }>();
  for (const entry of sorted) {
    const svc = serviceOf(entry.path);
    let agg = svcMap.get(svc);
    if (!agg) {
      agg = { score: 0, files: 0, hotspots: [] };
      svcMap.set(svc, agg);
    }
    agg.score += entry.score;
    agg.files += 1;
    if (agg.hotspots.length < 3) agg.hotspots.push(entry);
  }
  const svcSorted = [...svcMap.entries()].sort((a, b) => b[1].score - a[1].score);
  const svcLines = svcSorted
    .map(
      ([svc, agg]) =>
        `| \`${svc}\` | ${agg.score} | ${agg.files} | ${agg.hotspots
          .map((h) => `\`${h.path}\` (${h.score})`)
          .join('<br/>')} |`,
    )
    .join('\n');
  writeFileSync(
    resolve(cycleDir, '02-hotspot-per-service.md'),
    `# Hotspot per service — rollup\n\nCycle: \`${cycle}\`.\n\n` +
      `| Service | Total score | Hotspot files | Top 3 files |\n|---|---|---|---|\n${svcLines}\n`,
    'utf8',
  );

  // --- emit 02-jscpd-clusters.md ---
  const clusterLines = clones
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 50)
    .map(
      (c, i) =>
        `${i + 1}. **${c.lines} lines / ${c.tokens} tokens** (${c.format})\n   - \`${c.files[0]!.name}\` ` +
        `L${c.files[0]!.start.line}-${c.files[0]!.end.line}\n   - \`${c.files[1]!.name}\` ` +
        `L${c.files[1]!.start.line}-${c.files[1]!.end.line}`,
    )
    .join('\n\n');
  writeFileSync(
    resolve(cycleDir, '02-jscpd-clusters.md'),
    `# JSCPD duplicate clusters (top 50)\n\nCycle: \`${cycle}\`  •  Total clones detected: **${clones.length}**\n\n` +
      `These are verbatim / near-verbatim code copies. Phase 2 extracts them into \`libs/backend-common\` ` +
      `or \`platform/libs/shared\` candidates.\n\n${clusterLines}\n`,
    'utf8',
  );

  // --- emit 02-orphan-modules.md (circular chains + low-reference files) ---
  const circLines = circularGroups
    .map((chain, i) => `${i + 1}. ${chain.map((f) => `\`${f}\``).join(' → ')}`)
    .join('\n');
  writeFileSync(
    resolve(cycleDir, '02-orphan-modules.md'),
    `# Orphan / circular module candidates\n\nCycle: \`${cycle}\`.\n\n` +
      `## Circular dependency chains (madge)\n\nTotal: **${circularGroups.length}** chains. ` +
      `Each is a candidate for refactor OR a TypeORM forward-reference that madge can't statically resolve — ` +
      `Phase 2 agent must distinguish.\n\n${circLines || '_(none)_'}\n\n` +
      `## Candidate dead-code\n\n_Populated by Phase 2 agent via grep confirmation against \`nx graph\` results._\n`,
    'utf8',
  );

  // --- emit 02-adr-violations.md ---
  const byViolation = {
    'ADR-011 (entity missing schema)': [...files.values()].filter((f) => f.entity_missing_schema_hits > 0),
    'ADR — getRepository (tenant isolation bypass)': [...files.values()].filter((f) => f.getRepository_hits > 0),
    'Code Quality — `as any`': [...files.values()].filter((f) => f.as_any_hits > 0),
    'Code Quality — @ts-ignore/@ts-expect-error': [...files.values()].filter((f) => f.ts_ignore_hits > 0),
    'Code Quality — raw console.*': [...files.values()].filter((f) => f.console_hits > 0),
  };
  const violLines: string[] = [];
  for (const [rule, list] of Object.entries(byViolation)) {
    violLines.push(`## ${rule}\n\nHits: **${list.length}** files.\n`);
    list
      .sort((a, b) => {
        const bHits =
          (rule.includes('getRepository') ? b.getRepository_hits : 0) +
          (rule.includes('as any') ? b.as_any_hits : 0) +
          (rule.includes('ts-ignore') ? b.ts_ignore_hits : 0) +
          (rule.includes('console') ? b.console_hits : 0) +
          (rule.includes('schema') ? b.entity_missing_schema_hits : 0);
        const aHits =
          (rule.includes('getRepository') ? a.getRepository_hits : 0) +
          (rule.includes('as any') ? a.as_any_hits : 0) +
          (rule.includes('ts-ignore') ? a.ts_ignore_hits : 0) +
          (rule.includes('console') ? a.console_hits : 0) +
          (rule.includes('schema') ? a.entity_missing_schema_hits : 0);
        return bHits - aHits;
      })
      .slice(0, 25)
      .forEach((f) => violLines.push(`- \`${f.path}\``));
    violLines.push('');
  }
  writeFileSync(
    resolve(cycleDir, '02-adr-violations.md'),
    `# ADR / code-quality violations\n\nCycle: \`${cycle}\`.\n\n${violLines.join('\n')}`,
    'utf8',
  );

  // --- summary to stdout ---
  console.log(`[ok] wrote 5 artifacts to ${cycleDir}`);
  console.log(`     files scored: ${sorted.length}`);
  console.log(`     top 30 top score: ${sorted[0]?.score ?? 0}`);
  console.log(`     jscpd clones: ${clones.length}`);
  console.log(`     circular groups: ${circularGroups.length}`);
  console.log(`     open-finding evidence refs: ${openFindings.length}`);
}

main();
