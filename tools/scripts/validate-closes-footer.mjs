#!/usr/bin/env node
/**
 * Validate that every commit in a PR carrying a `fix()`, `security()`, or
 * `refactor(agentic,phase-*)` conventional-commit prefix has a matching
 * `Closes: docs/reviews/<agent>/<date>-<topic>.md#<FINDING-ID>` trailer, AND
 * that the trailer points to a real finding in the registry.
 *
 * Phase 6 of /root/.claude/plans/abstract-brewing-mochi.md.
 *
 * Usage (local):
 *   node tools/scripts/validate-closes-footer.mjs <baseRef> <headRef>
 *
 * Usage (CI):
 *   node tools/scripts/validate-closes-footer.mjs "$BASE_SHA" "$HEAD_SHA"
 *
 * Exit 0 when all commits in range comply; 1 with a prose report otherwise.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY = resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');

const REQUIRE_CLOSES_TYPES = /^(fix|security|refactor\(agentic,phase-)/;

// Commits created BEFORE the registry landed (Phase 6) can't be expected to
// reference it. Exempt them via content + SHA allowlist.
const PRE_PHASE6_SHAS = new Set([
  // Phase 0 + 0.1 + 4 + 5 commits landed before the registry was seeded.
  // Once Phase 6 is in effect, going-forward this set does not grow.
  '32839e24', 'f931f935', '2dd09f99', 'b907c235',
]);

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
}

function loadRegistryIds() {
  if (!existsSync(REGISTRY)) return new Set();
  const content = readFileSync(REGISTRY, 'utf8').trim();
  if (!content) return new Set();
  const ids = new Set();
  for (const line of content.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (entry.id) ids.add(entry.id);
    } catch {
      // tolerated — integrity invariant catches malformed registry
    }
  }
  return ids;
}

function extractCommits(baseRef, headRef) {
  const range = `${baseRef}..${headRef}`;
  const raw = run(`git log ${range} --format=%H%x09%s%x09%b%x1f`);
  if (!raw) return [];
  return raw
    .split('\u001f')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, subject, ...bodyParts] = chunk.split('\t');
      return { sha, subject: subject ?? '', body: bodyParts.join('\t') };
    });
}

function extractClosesTrailers(body) {
  const results = [];
  const lines = body.split('\n');
  for (const line of lines) {
    const match = line.match(/^Closes:\s+(\S+?)#([A-Z][A-Z0-9]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3})\s*$/);
    if (match) {
      results.push({ path: match[1], findingId: match[2] });
    }
  }
  return results;
}

function main() {
  const [baseRef, headRef] = process.argv.slice(2);
  if (!baseRef || !headRef) {
    console.error('Usage: validate-closes-footer.mjs <baseRef> <headRef>');
    process.exit(2);
  }

  const registryIds = loadRegistryIds();
  const commits = extractCommits(baseRef, headRef);

  if (commits.length === 0) {
    console.log('No commits in range; nothing to validate.');
    return;
  }

  const violations = [];

  for (const commit of commits) {
    const shortSha = commit.sha.substring(0, 8);
    const needsCloses = REQUIRE_CLOSES_TYPES.test(commit.subject);

    if (!needsCloses) continue;
    if (PRE_PHASE6_SHAS.has(shortSha)) continue;

    const trailers = extractClosesTrailers(commit.body);
    if (trailers.length === 0) {
      violations.push({
        sha: shortSha,
        subject: commit.subject,
        reason: 'missing Closes: trailer on fix/security/refactor(agentic,phase-*) commit',
      });
      continue;
    }

    for (const { path, findingId } of trailers) {
      const reviewFile = resolve(REPO_ROOT, path);
      if (!existsSync(reviewFile)) {
        violations.push({
          sha: shortSha,
          subject: commit.subject,
          reason: `Closes: trailer references missing review file: ${path}`,
        });
      }
      if (!registryIds.has(findingId)) {
        violations.push({
          sha: shortSha,
          subject: commit.subject,
          reason: `Closes: trailer references unknown finding ID: ${findingId}`,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error('Closes: trailer validation FAILED:');
    for (const v of violations) {
      console.error(`  ${v.sha}  ${v.subject}`);
      console.error(`    -> ${v.reason}`);
    }
    console.error('');
    console.error('Every fix/security/refactor(agentic,phase-*) commit must carry:');
    console.error('  Closes: docs/reviews/<agent>/<date>-<topic>.md#<FINDING-ID>');
    console.error('Registry: docs/reviews/_registry/findings.jsonl');
    console.error('Phase 6 reference: /root/.claude/plans/abstract-brewing-mochi.md#Phase-6');
    process.exit(1);
  }

  console.log(`All ${commits.length} commit(s) validated.`);
}

main();
